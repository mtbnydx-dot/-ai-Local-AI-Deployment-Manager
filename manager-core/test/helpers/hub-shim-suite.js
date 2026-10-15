"use strict";

// The shared body of {vllm,llama}-manager/test/hub-shim.test.js (03 §20,
// HUB-13a). Each manager's real app runs against a fake hub (fake-hub.js) that
// verifies every signature with internal-auth.js. The AI root, the trust token
// and every port are temporary; no real service is called and nothing is
// spawned.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { startFakeHub } = require("./fake-hub");

const HUB_JOB_ID = "dl_7k2m4q9x3c5vb8np";
const LEGACY_HUB_JOB_ID = "dl_2b3c4d5e6f7g2h3j";

function hubJob(id, managerId, overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    legacyIds: [],
    createdAt: "2026-10-14T08:00:00.000Z",
    updatedAt: "2026-10-14T08:05:00.000Z",
    finishedAt: null,
    origin: { kind: "manager-shim", managerId },
    ownerManagerId: managerId,
    state: "downloading",
    priority: "normal",
    artifact: { provider: "huggingface", repo: "org/Model-GGUF", quant: "Q4_K_M", companions: [], files: [{ path: "m.gguf", size: 100 }], totalBytes: 100 },
    target: { rootId: "r1", rootLabel: "Models", outputName: "org-Model-GGUF", localDir: "X:\\models\\org-Model-GGUF", volume: "X:" },
    transfer: { engine: "cli", options: { source: "huggingface", endpoint: "https://huggingface.co", xet: "default", tokenRef: "dlt_abcdefghijklmnop" } },
    progress: { bytesDone: 40, bytesTotal: 100, percent: 40, speedBps: 10, speedEmaBps: 9, etaSeconds: 6, filesDone: 0, filesTotal: 1, files: [], updatedAt: "2026-10-14T08:05:00.000Z" },
    retry: { count: 0, max: 3, nextAt: null },
    error: null,
    ...overrides,
  };
}

async function readSseEvents(response, { until, timeoutMs = 5000 }) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), Math.max(1, deadline - Date.now()))),
      ]);
      if (chunk.timeout || chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event) events.push({ event, data: data ? JSON.parse(data) : null });
      }
      if (until(events)) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return events;
}

async function waitFor(check, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

function runHubShimSuite({ managerId, serverPath, express }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hub-shim-${managerId}-`));
  let hub;
  let manager;
  let server;
  let base;

  test.before(async () => {
    hub = await startFakeHub({
      jobs: [
        hubJob(HUB_JOB_ID, managerId, { createdAt: "2026-10-14T08:00:00.000Z" }),
        hubJob(LEGACY_HUB_JOB_ID, managerId, {
          legacyIds: ["job-legacy-1"],
          createdAt: "2026-10-12T08:00:00.000Z",
          state: "failed",
          finishedAt: "2026-10-12T09:00:00.000Z",
          error: { code: "hf_login_required", baseCode: "hf_auth_invalid", retryable: false, title: { zh: "需要登录", en: "Login required" }, hint: { zh: "先登录。", en: "Sign in first." } },
        }),
        hubJob("dl_aaaaaaaaaaaaaaaa", managerId === "llama" ? "vllm" : "llama"),
      ],
      logs: { [HUB_JOB_ID]: ["hub line 1", "hub line 2"] },
    });
    // The manager reads the hub flag, the entry port and the trust token from
    // this temporary AI root only.
    fs.writeFileSync(path.join(root, ".gateway-trust.json"), JSON.stringify({ token: hub.token }));
    process.env.AI_ROOT = root;
    process.env.AI_REFERENCE_DATA_DIR = root;
    process.env.SERVICE_ENTRY_PORT = String(hub.port);
    delete process.env.AI_HUB_DOWNLOADS_OWNER;
    delete process.env.AI_FRONTEND_SMOKE;
    delete process.env.SERVICE_GATEWAY_TRUST_TOKEN;
    manager = require(serverPath);
    assert.ok(manager.hubShim, "hub mode registers the shim");
    const at = (iso) => iso;
    manager.jobs.set("serve-1", { id: "serve-1", type: "serve", title: "Launch", status: "success", createdAt: at("2026-10-13T08:00:00.000Z"), updatedAt: at("2026-10-13T08:00:00.000Z"), logs: [] });
    manager.jobs.set("job-legacy-1", { id: "job-legacy-1", type: "download", title: "old", status: "failed", createdAt: at("2026-10-12T08:00:00.000Z"), logs: [] });
    manager.jobs.set("job-legacy-2", { id: "job-legacy-2", type: "download", title: "done", status: "success", createdAt: at("2026-10-11T08:00:00.000Z"), logs: [] });
    manager.jobs.set("job-legacy-3", { id: "job-legacy-3", type: "download", title: "paused", status: "paused", createdAt: at("2026-10-10T08:00:00.000Z"), logs: ["kept"] });
    server = await new Promise((resolve) => {
      const listening = manager.app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  test.after(async () => {
    manager?.hubShim?.close();
    server?.closeAllConnections?.();
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    await hub?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test.beforeEach(() => {
    hub.state.mode = "ok";
  });

  test("the fake hub rejects unsigned requests, including a bare x-hub-shim header", async () => {
    const before = hub.state.requests.length;
    const unsigned = await fetch(`${hub.baseUrl}/api/hub/downloads`);
    assert.equal(unsigned.status, 401);
    const marker = await fetch(`${hub.baseUrl}/api/hub/downloads/${HUB_JOB_ID}/pause`, { method: "POST", headers: { "x-hub-shim": managerId }, body: "{}" });
    assert.equal(marker.status, 401);
    assert.equal(hub.state.requests.length, before, "no unsigned request reached a route");
  });

  test("GET /api/jobs merges local jobs with this manager's hub downloads, newest first", async () => {
    const start = hub.state.requests.length;
    const response = await fetch(`${base}/api/jobs?fields=summary`, { headers: { "x-request-id": "client-req-1" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-hub-unavailable"), null);
    const list = await response.json();
    assert.deepEqual(list.map((job) => job.id), [HUB_JOB_ID, "serve-1", LEGACY_HUB_JOB_ID, "job-legacy-3"]);
    const [download] = list;
    assert.equal(download.type, "download");
    assert.equal(download.status, "running");
    assert.equal(download.meta.transfer.tokenRef, null);
    assert.deepEqual(Object.keys(download).sort(), ["createdAt", "error", "exitCode", "finishedAt", "id", "logCount", "logs", "logsTruncated", "meta", "progress", "status", "title", "type", "updatedAt"]);
    assert.equal(list[2].meta.errorCode, "hf_login_required");
    assert.deepEqual(list[2].meta.errorHint, { zh: "先登录。", en: "Sign in first." });
    // One signed list read, owner-filtered, with the caller's request id.
    const reads = hub.state.requests.slice(start);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].url, `/api/hub/downloads?owner=${managerId}&include=terminal&limit=60`);
    assert.equal(reads[0].principal, `system:hub-shim:${managerId}`);
    assert.equal(reads[0].requestId, "client-req-1");

    const full = await (await fetch(`${base}/api/jobs`)).json();
    assert.deepEqual(full.map((job) => job.id), list.map((job) => job.id));
    assert.deepEqual(full.find((job) => job.id === "job-legacy-3").logs, ["kept"]);
    assert.match(hub.state.requests.at(-1).requestId, /^mgr_[a-z2-7]{20}$/);
  });

  test("x-hub-unavailable: a down hub or a rejected signature leaves the local jobs only", async () => {
    for (const mode of ["hub-down", "reject"]) {
      hub.state.mode = mode;
      const response = await fetch(`${base}/api/jobs?fields=summary`);
      assert.equal(response.status, 200, mode);
      assert.equal(response.headers.get("x-hub-unavailable"), "1", mode);
      const ids = (await response.json()).map((job) => job.id);
      assert.deepEqual(ids, ["serve-1", "job-legacy-3"], mode);
    }
    hub.state.mode = "reject";
    const job = await fetch(`${base}/api/jobs/${HUB_JOB_ID}`);
    assert.equal(job.status, 503);
    assert.equal((await job.json()).code, "hub_auth_failed");
    hub.state.mode = "hub-down";
    const down = await fetch(`${base}/api/jobs/${HUB_JOB_ID}/pause`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(down.status, 503);
    const body = await down.json();
    assert.equal(body.code, "hub_unavailable");
    assert.match(body.error, /service-entry is not running/);
    // A legacy id the hub cannot be asked about stays with the manager.
    const local = await fetch(`${base}/api/jobs/job-legacy-1`);
    assert.equal(local.status, 200);
    assert.equal((await local.json()).id, "job-legacy-1");
  });

  test("/api/jobs/:id routes dl_ ids and hub legacyIds to the hub, everything else to the manager", async () => {
    const start = hub.state.requests.length;
    const detail = await (await fetch(`${base}/api/jobs/${HUB_JOB_ID}`)).json();
    assert.equal(detail.id, HUB_JOB_ID);
    assert.deepEqual(detail.logs, ["hub line 1", "hub line 2"]);
    assert.equal(detail.logCount, 2);

    const logs = await (await fetch(`${base}/api/jobs/${HUB_JOB_ID}/logs`)).json();
    assert.deepEqual(logs, { id: HUB_JOB_ID, logs: ["hub line 1", "hub line 2"], logCount: 2 });

    const check = await (await fetch(`${base}/api/jobs/${HUB_JOB_ID}/resume-check`)).json();
    assert.deepEqual(check, { ok: true, id: HUB_JOB_ID, status: "running", complete: false, bytesRemaining: 10, outputName: "org-Model-GGUF" });

    const legacy = await (await fetch(`${base}/api/jobs/job-legacy-1`)).json();
    assert.equal(legacy.id, LEGACY_HUB_JOB_ID, "a claimed legacy id answers with the hub job");
    assert.equal(legacy.status, "failed");

    const paused = await fetch(`${base}/api/jobs/job-legacy-1/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.deepEqual(await paused.json(), { ok: true, id: LEGACY_HUB_JOB_ID, status: "queued" });
    const pause = await fetch(`${base}/api/jobs/${HUB_JOB_ID}/pause`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.deepEqual(await pause.json(), { ok: true, id: HUB_JOB_ID, status: "paused" });
    const again = await fetch(`${base}/api/jobs/${HUB_JOB_ID}/pause`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(again.status, 409);
    assert.deepEqual(await again.json(), { error: "The download is already paused.", code: "invalid_state" });
    const cancel = await fetch(`${base}/api/jobs/${HUB_JOB_ID}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.deepEqual(await cancel.json(), { ok: true, id: HUB_JOB_ID, status: "cancelled" });

    const missing = await fetch(`${base}/api/jobs/dl_zzzzzzzzzzzzzzzz`);
    assert.equal(missing.status, 404);

    const viaHub = hub.state.requests.slice(start).map((item) => `${item.method} ${item.url}`);
    // A local non-download job never reaches the hub; an unclaimed local
    // download is asked once and then served locally.
    const serve = await (await fetch(`${base}/api/jobs/serve-1`)).json();
    assert.equal(serve.id, "serve-1");
    const unclaimed = await (await fetch(`${base}/api/jobs/job-legacy-3`)).json();
    assert.equal(unclaimed.id, "job-legacy-3");
    const after = hub.state.requests.slice(start).map((item) => `${item.method} ${item.url}`);
    assert.deepEqual(after.slice(viaHub.length), ["GET /api/hub/downloads/job-legacy-3"]);
    assert.ok(viaHub.includes("POST /api/hub/downloads/job-legacy-1/resume"));

    // Writes carry the signed origin; nothing else of the caller's body.
    const write = hub.state.requests.find((item) => item.url === `/api/hub/downloads/${HUB_JOB_ID}/pause`);
    assert.deepEqual(write.body, { origin: { kind: "manager-shim", managerId, clientLocal: true } });
    assert.ok(hub.state.requests.every((item) => item.principal === `system:hub-shim:${managerId}`), "every request was signed");
  });

  test("a downloads event triggers one signed re-read and a jobs re-broadcast", async () => {
    const events = await fetch(`${base}/api/events`);
    assert.equal(events.status, 200);
    manager.hubShim.startRelay();
    assert.ok(await waitFor(() => hub.state.streams.size === 1), "the manager holds one upstream stream");
    const upstream = hub.state.requests.find((item) => item.url === "/api/events?types=downloads");
    assert.equal(upstream.principal, `system:hub-shim:${managerId}`);
    const listReads = () => hub.state.requests.filter((item) => item.url.startsWith("/api/hub/downloads?")).length;
    // The (re)connect itself re-reads once; wait for it and the throttle.
    await waitFor(() => false, 800);
    const before = listReads();
    hub.state.jobs[0].state = "verifying";
    hub.push("downloads", { kind: "job" });
    const received = await readSseEvents(events, {
      until: (list) => list.some((item) => item.event === "jobs" && item.data.some((job) => job.id === HUB_JOB_ID && job.meta.phase === "verifying")),
    });
    const snapshot = received.filter((item) => item.event === "jobs").at(-1);
    assert.ok(snapshot, "a jobs snapshot was broadcast");
    assert.deepEqual(snapshot.data.map((job) => job.id), [HUB_JOB_ID, "serve-1", LEGACY_HUB_JOB_ID, "job-legacy-3"]);
    assert.equal(snapshot.data[0].status, "running");
    assert.equal(listReads() - before, 1, "one re-read per trigger");
  });

  test("a LAN caller's hfToken is never forwarded, and bursts of triggers are throttled", async () => {
    const app = express();
    app.use(express.json());
    const { createHubClient } = require("../../model-hub/client");
    const { registerHubShimRoutes } = require("../../model-hub/shim");
    const client = createHubClient({ baseUrl: hub.baseUrl, managerId, readKey: () => hub.token });
    let snapshots = 0;
    const shim = registerHubShimRoutes(app, { managerId, client, isLocalRequest: () => false, onSnapshot: () => { snapshots += 1; }, relayThrottleMs: 700 });
    const lan = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const url = `http://127.0.0.1:${lan.address().port}/api/jobs/${HUB_JOB_ID}/resume`;
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential: { hfToken: "hf_fake_token_for_tests_only" }, refreshTransferOptions: true }) });
      assert.equal(response.status, 200);
      const forwarded = hub.state.requests.at(-1);
      assert.deepEqual(forwarded.body, { origin: { kind: "manager-shim", managerId, clientLocal: false }, refreshTransferOptions: true });

      const reads = () => hub.state.requests.filter((item) => item.url.startsWith("/api/hub/downloads?")).length;
      await waitFor(() => false, 750);
      const before = reads();
      shim.refreshJobs();
      shim.refreshJobs();
      shim.refreshJobs();
      await waitFor(() => false, 300);
      assert.equal(reads() - before, 1, "a burst inside the window reads once at once");
      assert.ok(await waitFor(() => reads() - before === 2, 1500), "and once more at the end of the window");
      await waitFor(() => false, 200);
      assert.equal(reads() - before, 2);
      assert.ok(snapshots >= 2);
    } finally {
      shim.close();
      lan.closeAllConnections?.();
      await new Promise((resolve) => lan.close(resolve));
    }
  });

  test("an unreachable entry is hub_unavailable without a fallback queue", async () => {
    const { createHubClient, HubClientError } = require("../../model-hub/client");
    const closed = await startFakeHub();
    const deadUrl = closed.baseUrl;
    await closed.close();
    const client = createHubClient({ baseUrl: deadUrl, managerId, readKey: () => "fake-key" });
    await assert.rejects(client.listJobs(), (error) => error instanceof HubClientError && error.code === "hub_unavailable" && error.status === 503);
    const noKey = createHubClient({ baseUrl: hub.baseUrl, managerId, readKey: () => "" });
    const before = hub.state.requests.length + hub.state.rejected.length;
    await assert.rejects(noKey.request("GET", "/api/hub/downloads"), (error) => error.code === "hub_unavailable");
    assert.equal(hub.state.requests.length + hub.state.rejected.length, before, "nothing is sent without a key");
  });
}

module.exports = { runHubShimSuite };
