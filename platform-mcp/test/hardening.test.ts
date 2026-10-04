import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { advertise, describeDataShape } from "../src/advertise-schema.js";
import { classifyToolError, ToolRateLimitError } from "../src/errors.js";
import { formatToolPayload } from "../src/format.js";
import { UpstreamRequestError } from "../src/http-client.js";
import { applyResponseBudget } from "../src/response-budget.js";
import { UpstreamCache } from "../src/upstream-cache.js";
import { OPS_TOOL_NAMES, TOOL_NAMES, WEB_TOOL_NAMES, toolsForProfile } from "../src/constants.js";
import { JobsOutputSchema, OverviewOutputSchema } from "../src/schemas.js";
import { fixtureGpu } from "./fixtures.js";

function jobsPayload(count: number, titleLength = 20) {
  const jobs = Array.from({ length: count }, (_, index) => ({
    engine: "vllm" as const,
    id: `job-${index}`,
    type: "serve",
    title: "t".repeat(titleLength),
    status: "success",
    created_at: "2026-08-15T00:00:00.000Z",
    updated_at: "2026-08-15T00:00:00.000Z",
    finished_at: null,
    progress_percent: 100,
    error: null,
  }));
  return {
    ok: true,
    partial: false,
    generated_at: "2026-08-15T00:00:00.000Z",
    warnings: [] as string[],
    truncated: undefined as boolean | undefined,
    data: {
      engine_filter: "all" as const,
      status_filter: "all",
      type_filter: "all",
      total: count,
      count: count,
      offset: 0,
      has_more: false,
      next_offset: null as number | null,
      jobs,
    },
  };
}

describe("response budget", () => {
  it("leaves a payload that already fits completely alone", () => {
    const payload = jobsPayload(3);
    const result = applyResponseBudget(payload, 25000);
    assert.equal(result.truncated, false);
    assert.equal(result.overBudget, false);
    assert.equal(result.payload, payload, "an unchanged payload is not copied");
    assert.equal(result.payload.truncated, undefined);
  });

  it("brings the payload itself inside the limit, not only the rendered text", () => {
    const result = applyResponseBudget(jobsPayload(200), 4000);
    assert.equal(result.truncated, true);
    assert.equal(result.overBudget, false);
    assert.ok(result.chars <= 4000, `serialized to ${result.chars} characters`);
    assert.ok(JSON.stringify(result.payload).length <= 4000);
    assert.ok(result.payload.data.jobs.length < 200);
  });

  it("keeps the pagination counters describing what was actually returned", () => {
    const result = applyResponseBudget(jobsPayload(200), 4000);
    const data = result.payload.data;
    assert.equal(data.count, data.jobs.length, "count must match the records returned");
    assert.equal(data.has_more, true);
    assert.equal(data.next_offset, data.offset + data.jobs.length, "the caller can resume without skipping records");
    assert.equal(data.total, 200, "total still describes the full match set");
  });

  it("still satisfies the published output schema after trimming", () => {
    const result = applyResponseBudget(jobsPayload(200), 4000);
    assert.doesNotThrow(() => JobsOutputSchema.parse(result.payload));
  });

  it("names the trimmed field and the record counts in warnings", () => {
    const result = applyResponseBudget(jobsPayload(200), 4000);
    const note = result.payload.warnings.find((warning) => warning.startsWith("Response budget"));
    assert.ok(note, "a trim is reported in warnings");
    assert.match(note!, /data\.jobs holds \d+ of 200 records/);
    assert.equal(result.payload.truncated, true);
  });

  it("shortens a dominant string rather than dropping the records holding it", () => {
    // Four records whose text is the whole payload: dropping three would take
    // their identities with them, so the text is shortened instead.
    const result = applyResponseBudget(jobsPayload(4, 4000), 6000);
    assert.equal(result.truncated, true);
    assert.ok(result.chars <= 6000);
    assert.equal(result.payload.data.jobs.length, 4, "every record is kept");
    assert.ok(
      result.payload.warnings.some((warning) => /was cut to \d+ of \d+ characters/.test(warning)),
      "a shortened string is reported as such",
    );
  });

  it("drops records instead when no single string dominates", () => {
    // Short titles: halving hundreds of them would never reach the budget,
    // and pagination can resume from where the trim stopped.
    const result = applyResponseBudget(jobsPayload(200, 30), 4000);
    assert.ok(result.payload.data.jobs.length < 200);
    assert.ok(result.payload.data.jobs.every((job) => job.title.length === 30), "titles are left intact");
  });

  it("says so instead of pretending, when the floor still exceeds the limit", () => {
    // Below this size the payload is required scalar fields only; dropping
    // those would break the schema the server publishes.
    const result = applyResponseBudget(jobsPayload(1, 4000), 600);
    assert.equal(result.overBudget, true);
    assert.equal(result.payload.truncated, true);
    const note = result.payload.warnings.find((warning) => /could not be trimmed further/.test(warning));
    assert.ok(note, "the unmet limit is stated rather than hidden");
    assert.match(note!, /against a 600-character limit/);
  });

  it("does not mutate the payload it was given", () => {
    const payload = jobsPayload(200);
    applyResponseBudget(payload, 4000);
    assert.equal(payload.data.jobs.length, 200);
    assert.deepEqual(payload.warnings, []);
  });
});

describe("response text channel", () => {
  const payload = jobsPayload(2);

  it("serializes compactly, because indentation is paid for in both channels", () => {
    const text = formatToolPayload("Jobs", payload, "json", 25000);
    assert.equal(text, JSON.stringify(payload));
    assert.ok(!text.includes("\n  "), "no indentation");
  });

  it("sends the payload once when the caller asks for the structured channel", () => {
    const text = formatToolPayload("Local AI Jobs", payload, "structured", 25000);
    assert.equal(text, "Local AI Jobs: see structuredContent for the full result.");
    assert.ok(text.length < 100);
  });

  it("states plainly that the text was cut and the structured channel is complete", () => {
    const text = formatToolPayload("Jobs", payload, "markdown", 300);
    assert.equal(text.length, 300);
    assert.match(text, /structuredContent carries the complete bounded payload/);
  });
});

describe("tool error classification", () => {
  const cases: Array<[string, unknown, string, boolean]> = [
    ["a timeout", new UpstreamRequestError("vLLM Manager", "timed out", 0, "timeout"), "timeout", true],
    ["an unreachable service", new UpstreamRequestError("vLLM Manager", "down", 0, "unreachable"), "upstream_unavailable", true],
    ["an oversized reply", new UpstreamRequestError("vLLM Manager", "too big", 200, "too_large"), "response_too_large", false],
    ["invalid JSON", new UpstreamRequestError("vLLM Manager", "bad json", 200, "bad_shape"), "upstream_contract", false],
    ["a 429", new UpstreamRequestError("search gateway", "HTTP 429", 429), "rate_limited", true],
    ["a 404", new UpstreamRequestError("search gateway", "HTTP 404", 404), "not_found", false],
    ["a 400", new UpstreamRequestError("search gateway", "HTTP 400", 400), "upstream_rejected", false],
    ["a 503", new UpstreamRequestError("llama.cpp Manager", "HTTP 503", 503), "upstream_unavailable", true],
    ["a missing configuration", new Error("Web search is not configured for MCP."), "not_configured", false],
    ["an unknown fault", new Error("something else"), "unknown", false],
  ];

  for (const [label, error, category, retryable] of cases) {
    it(`separates ${label} from the rest`, () => {
      const classified = classifyToolError(error);
      assert.equal(classified.category, category);
      assert.equal(classified.retryable, retryable);
      assert.ok(classified.guidance.length > 20, "every category carries advice the caller can act on");
    });
  }

  it("carries the retry delay for a rate limit so the caller can wait rather than hammer", () => {
    const classified = classifyToolError(new ToolRateLimitError("slow down", 42));
    assert.equal(classified.category, "rate_limited");
    assert.equal(classified.retryable, true);
    assert.equal(classified.retryAfterSeconds, 42);
  });

  it("recognizes a schema validation failure as a contract mismatch, not a transient fault", () => {
    const failure = OverviewOutputSchema.safeParse({ ok: true });
    assert.equal(failure.success, false);
    const classified = classifyToolError(failure.error);
    assert.equal(classified.category, "upstream_contract");
    assert.equal(classified.retryable, false);
  });

  it("gives each category its own advice", () => {
    const guidance = new Set(cases.map(([, error]) => classifyToolError(error).guidance));
    assert.equal(guidance.size, new Set(cases.map(([, , category]) => category)).size);
  });
});

describe("upstream cache", () => {
  it("serves a second read of the same endpoint without touching the manager", async () => {
    let calls = 0;
    const cache = new UpstreamCache({ ttlMs: 1000, now: () => 0 });
    const load = async () => { calls += 1; return { value: calls }; };
    assert.deepEqual(await cache.run("a", load), { value: 1 });
    assert.deepEqual(await cache.run("a", load), { value: 1 });
    assert.equal(calls, 1);
    assert.equal(cache.stats().hits, 1);
  });

  it("collapses concurrent reads of one endpoint into a single request", async () => {
    let calls = 0;
    const cache = new UpstreamCache({ ttlMs: 0 });
    const load = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { value: calls };
    };
    const [first, second, third] = await Promise.all([cache.run("a", load), cache.run("a", load), cache.run("a", load)]);
    assert.equal(calls, 1);
    assert.deepEqual([first, second, third], [{ value: 1 }, { value: 1 }, { value: 1 }]);
    assert.equal(cache.stats().coalesced, 2);
  });

  it("hands every caller its own copy, so one tool cannot corrupt another's data", async () => {
    const cache = new UpstreamCache({ ttlMs: 1000, now: () => 0 });
    const first = await cache.run("a", async () => ({ nested: { list: [1, 2] } }));
    (first as { nested: { list: number[] } }).nested.list.push(3);
    const second = await cache.run("a", async () => ({ nested: { list: [9] } }));
    assert.deepEqual(second, { nested: { list: [1, 2] } });
  });

  it("never caches a failure, so a manager coming back up is visible at once", async () => {
    let calls = 0;
    const cache = new UpstreamCache({ ttlMs: 60_000, now: () => 0 });
    await assert.rejects(() => cache.run("a", async () => {
      calls += 1;
      throw new Error("manager down");
    }));
    assert.deepEqual(await cache.run("a", async () => { calls += 1; return { ok: true }; }), { ok: true });
    assert.equal(calls, 2);
  });

  it("re-reads once the entry is older than the configured lifetime", async () => {
    let now = 0;
    let calls = 0;
    const cache = new UpstreamCache({ ttlMs: 2000, now: () => now });
    const load = async () => { calls += 1; return { value: calls }; };
    await cache.run("a", load);
    now = 1999;
    await cache.run("a", load);
    assert.equal(calls, 1);
    now = 2000;
    await cache.run("a", load);
    assert.equal(calls, 2);
  });

  it("goes straight to the manager when caching is switched off", async () => {
    let calls = 0;
    const cache = new UpstreamCache({ ttlMs: 0 });
    const load = async () => { calls += 1; return { value: calls }; };
    await cache.run("a", load);
    await cache.run("a", load);
    assert.equal(calls, 2);
  });

  it("stays bounded, so a long session cannot grow it without limit", async () => {
    const cache = new UpstreamCache({ ttlMs: 60_000, maxEntries: 4, now: () => 0 });
    for (let index = 0; index < 10; index += 1) {
      await cache.run(`key-${index}`, async () => ({ index }));
    }
    assert.equal(cache.stats().entries, 4);
  });
});

describe("advertised output schemas", () => {
  const options = { target: "draft-2020-12" };
  const full = (OverviewOutputSchema as never as { "~standard": { jsonSchema: { output: (o: unknown) => unknown } } })
    ["~standard"].jsonSchema.output(options);
  const compact = (advertise(OverviewOutputSchema, "compact") as never as {
    "~standard": { jsonSchema: { output: (o: unknown) => unknown } };
  })["~standard"].jsonSchema.output(options);

  it("costs a fraction of the full schema", () => {
    const fullChars = JSON.stringify(full).length;
    const compactChars = JSON.stringify(compact).length;
    assert.ok(compactChars < fullChars / 3, `${compactChars} against ${fullChars}`);
  });

  it("keeps the envelope and the names of the data fields", () => {
    const properties = (compact as { properties: Record<string, unknown> }).properties;
    assert.deepEqual(Object.keys(properties).sort(), ["data", "generated_at", "ok", "partial", "truncated", "warnings"]);
    const data = properties.data as { properties: Record<string, unknown> };
    assert.deepEqual(
      Object.keys(data.properties).sort(),
      ["gateway_base", "gpu", "managers", "running_model_count", "search", "service_entry"],
    );
  });

  it("stays permissive below the envelope, so a validating client still accepts real payloads", () => {
    const data = (compact as { properties: { data: Record<string, unknown> } }).properties.data;
    assert.equal(data.additionalProperties, undefined, "nested levels must not forbid fields they no longer list");
    const entry = (data as { properties: { service_entry: Record<string, unknown> } }).properties.service_entry;
    assert.deepEqual(entry, { type: "object" });
  });

  it("keeps validating against the real schema", () => {
    const wrapped = advertise(OverviewOutputSchema, "compact");
    assert.doesNotThrow(() => wrapped.parse({
      ok: true,
      partial: false,
      generated_at: "2026-08-15T00:00:00.000Z",
      warnings: [],
      data: {
        service_entry: { online: true, uptime_seconds: 1, bind_host: "127.0.0.1", port: 5176 },
        managers: [],
        running_model_count: 0,
        gpu: fixtureGpu,
        gateway_base: null,
        search: { online: true, healthy: true, mode: null, auth_required: null, max_results: null, error: null },
      },
    }));
    assert.throws(() => wrapped.parse({ ok: true }));
  });

  it("returns the schema untouched in full mode", () => {
    assert.equal(advertise(OverviewOutputSchema, "full"), OverviewOutputSchema);
  });

  it("summarizes the payload shape in one line for the description", () => {
    assert.equal(
      describeDataShape(OverviewOutputSchema),
      "Returns data={service_entry,managers,running_model_count,gpu,gateway_base,search}.",
    );
    assert.ok(describeDataShape(OverviewOutputSchema).length < 120);
  });
});

describe("tool profiles", () => {
  it("splits every tool into exactly one group", () => {
    assert.equal(OPS_TOOL_NAMES.length + WEB_TOOL_NAMES.length, TOOL_NAMES.length);
    const overlap = OPS_TOOL_NAMES.filter((name) => (WEB_TOOL_NAMES as readonly string[]).includes(name));
    assert.deepEqual(overlap, []);
  });

  it("keeps the registration order within each group", () => {
    for (const profile of ["all", "ops", "web"] as const) {
      const selected = toolsForProfile(profile);
      const positions = selected.map((name) => TOOL_NAMES.indexOf(name));
      assert.deepEqual(positions, [...positions].sort((left, right) => left - right), profile);
    }
  });

  it("puts every web-reaching tool in the web group", () => {
    assert.deepEqual(
      [...WEB_TOOL_NAMES].sort(),
      TOOL_NAMES.filter((name) => /search|web|page|result/.test(name)).sort(),
    );
  });
});
