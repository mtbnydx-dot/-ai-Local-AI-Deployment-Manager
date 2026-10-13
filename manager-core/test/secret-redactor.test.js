"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const core = require("..");
const {
  REDACTED,
  SECRET_PATTERNS,
  createSecretRedactor,
  redactSecrets,
  redactValue,
} = require("../secret-redactor");

// Fake key shapes are assembled at runtime so no secret-shaped literal sits in
// the source (the release privacy scan looks for them).
const FAKE_SK = ["sk", "fake0test0key0for0redaction"].join("-");
const FAKE_HF = ["hf", "FAKEtoken0for0redaction0tests"].join("_");
const FAKE_RUNTIME_KEY = "fake-runtime-key-0123456789";

test("the redactor is exported through the manager-core barrel with one marker", () => {
  assert.equal(REDACTED, "<redacted>");
  assert.equal(core.REDACTED, REDACTED);
  assert.equal(core.redactSecrets, redactSecrets);
  assert.equal(core.redactValue, redactValue);
  assert.equal(core.createSecretRedactor, createSecretRedactor);
  assert.equal(SECRET_PATTERNS.length, 6);
  assert.ok(Object.isFrozen(SECRET_PATTERNS));
});

test("the manager-core barrel merges without export-name collisions", () => {
  const warnings = [];
  const original = process.emitWarning;
  process.emitWarning = (message, options) => warnings.push({ message, code: options?.code });
  try {
    core.mergeExports(core.MODULES);
  } finally {
    process.emitWarning = original;
  }
  assert.deepEqual(warnings.filter((item) => item.code === "MANAGER_CORE_EXPORT_COLLISION"), []);
  assert.ok(core.MODULES.includes("./secret-redactor"));
});

test("pattern 1 keeps CLI secret flags and drops their values", () => {
  assert.equal(redactSecrets("docker run img --api-key abcdef123 --port 8000"), "docker run img --api-key <redacted> --port 8000");
  assert.equal(redactSecrets("--hf-token=abcdef123"), "--hf-token=<redacted>");
  assert.equal(redactSecrets("serve --token \"two words\" --x 1"), "serve --token <redacted> --x 1");
  assert.equal(redactSecrets("serve --admin-api-key 'quoted value'"), "serve --admin-api-key <redacted>");
  // Flags that merely start with "token" are not secret flags.
  assert.equal(redactSecrets("--max-total-tokens 262144 --token-budget 5"), "--max-total-tokens 262144 --token-budget 5");
});

test("pattern 2 keeps key names in key=value and JSON forms", () => {
  assert.equal(redactSecrets("api_key=abc12345"), "api_key=<redacted>");
  assert.equal(redactSecrets("{\"apiKey\":\"abc12345\",\"model\":\"m\"}"), "{\"apiKey\":\"<redacted>\",\"model\":\"m\"}");
  assert.equal(redactSecrets("hf-token: abc12345"), "hf-token: <redacted>");
  assert.equal(redactSecrets("access-token: 'abc12345'"), "access-token: '<redacted>'");
  assert.equal(redactSecrets("x-api-key: abc12345"), "x-api-key: <redacted>");
  // The auth scheme stays and the credential behind it goes.
  assert.equal(redactSecrets("Authorization: Bearer abc12345xyz"), "Authorization: Bearer <redacted>");
  assert.equal(redactSecrets("authorization=Basic dXNlcjpwYXNz"), "authorization=Basic <redacted>");
  // Field names that only start with a key name are not secrets.
  assert.equal(redactSecrets("apiKeyHash: 0123abcd apiKeyRef=ref-1"), "apiKeyHash: 0123abcd apiKeyRef=ref-1");
});

test("pattern 3 removes bearer credentials anywhere", () => {
  assert.equal(redactSecrets("curl -H 'X: Bearer abcdefgh.ijk-lmn'"), "curl -H 'X: Bearer <redacted>'");
  assert.equal(redactSecrets("Bearer short"), "Bearer short");
});

test("pattern 4 keeps environment variable names and leaves name-only -e flags readable", () => {
  assert.equal(redactSecrets("GITHUB_TOKEN=abc123 MY_SERVICE_SECRET=xyz"), "GITHUB_TOKEN=<redacted> MY_SERVICE_SECRET=<redacted>");
  assert.equal(redactSecrets("env OTHER_API_KEY=abc123"), "env OTHER_API_KEY=<redacted>");
  assert.equal(redactSecrets("docker run -e VLLM_API_KEY -e HF_TOKEN image"), "docker run -e VLLM_API_KEY -e HF_TOKEN image");
});

test("patterns 5 and 6 remove sk- and hf_ tokens but not ordinary words", () => {
  assert.equal(redactSecrets(`key ${FAKE_SK} end`), "key <redacted> end");
  assert.equal(redactSecrets(`token ${FAKE_HF} end`), "token <redacted> end");
  const words = "pip install sk-learn; from huggingface_hub import hf_hub_download; task-sk-short";
  assert.equal(redactSecrets(words), words);
});

test("exact secrets are removed inside docker Command failed text, longest first", () => {
  const text = `Command failed: docker run --rm -e LABEL=${FAKE_RUNTIME_KEY} image serve ${FAKE_RUNTIME_KEY}-suffix`;
  const output = redactSecrets(text, { secrets: [FAKE_RUNTIME_KEY, `${FAKE_RUNTIME_KEY}-suffix`] });
  assert.equal(output, "Command failed: docker run --rm -e LABEL=<redacted> image serve <redacted>");
  assert.equal(output.includes(FAKE_RUNTIME_KEY), false);
  // Iterables and nullish entries are accepted as secret lists.
  assert.equal(redactSecrets(`x ${FAKE_RUNTIME_KEY}`, { secrets: new Set([undefined, null, FAKE_RUNTIME_KEY]) }), "x <redacted>");
});

test("minSecretLength protects short values and the legacy floor of 6 still works", () => {
  assert.equal(redactSecrets("replicas 1 port 1", { secrets: ["1"] }), "replicas 1 port 1");
  assert.equal(redactSecrets("key=abc123 other", { secrets: ["abc123"], patterns: false }), "key=abc123 other");
  assert.equal(redactSecrets("value abc123 other", { secrets: ["abc123"], patterns: false, minSecretLength: 6 }), "value <redacted> other");
});

test("patterns:false keeps sk- model ids and still removes exact secrets", () => {
  const modelId = `org/${FAKE_SK}`;
  const output = redactSecrets(`model ${modelId} served with ${FAKE_RUNTIME_KEY}`, { secrets: [FAKE_RUNTIME_KEY], patterns: false });
  assert.equal(output, `model ${modelId} served with <redacted>`);
});

test("redaction is idempotent and produces only the <redacted> marker", () => {
  const samples = [
    `docker run --api-key ${FAKE_RUNTIME_KEY} -e HF_TOKEN=${FAKE_HF} image`,
    "Authorization: Bearer abcdefgh12345 api_key='x' GITHUB_TOKEN=y",
    `{"apiKey":"${FAKE_SK}","note":"--token \\"a b\\""}`,
    "plain text without secrets",
  ];
  for (const sample of samples) {
    const once = redactSecrets(sample, { secrets: [FAKE_RUNTIME_KEY] });
    assert.equal(redactSecrets(once, { secrets: [FAKE_RUNTIME_KEY] }), once);
    assert.equal(once.includes("***"), false);
    assert.equal(once.includes(FAKE_RUNTIME_KEY), false);
    assert.equal(once.includes(FAKE_HF), false);
    assert.equal(once.includes(FAKE_SK), false);
  }
  // A secret that is part of the marker would otherwise grow on each pass.
  assert.equal(redactSecrets("redacted <redacted>", { secrets: ["redacted"] }), "redacted <redacted>");
});

test("non-strings are returned unchanged", () => {
  for (const value of [undefined, null, 42, true, ""]) assert.equal(redactSecrets(value), value);
  const object = { apiKey: "x" };
  assert.equal(redactSecrets(object), object);
});

test("redactValue deep-redacts strings without mutating the input", () => {
  const input = {
    command: `docker run --api-key ${FAKE_RUNTIME_KEY}`,
    nested: { list: ["clean", `token ${FAKE_HF}`], count: 3, flag: true },
    untouched: { a: "b" },
  };
  const snapshot = structuredClone(input);
  const output = redactValue(input, { secrets: [FAKE_RUNTIME_KEY] });
  assert.deepEqual(input, snapshot);
  assert.notEqual(output, input);
  assert.equal(output.command, "docker run --api-key <redacted>");
  assert.deepEqual(output.nested.list, ["clean", "token <redacted>"]);
  assert.equal(output.nested.count, 3);
  // Unchanged branches keep their identity, so callers can detect changes.
  assert.equal(output.untouched, input.untouched);
  const clean = { a: ["b", { c: "d" }] };
  assert.equal(redactValue(clean), clean);
  const date = new Date(0);
  assert.equal(redactValue(date), date);
});

test("createSecretRedactor reads secrets on every call so rotated keys are covered", () => {
  let current = ["first-secret-value"];
  let calls = 0;
  const redactor = createSecretRedactor({ getSecrets: () => { calls += 1; return current; } });
  assert.equal(redactor.redact("a first-secret-value b"), "a <redacted> b");
  current = ["second-secret-value"];
  assert.equal(redactor.redact("a first-secret-value second-secret-value"), "a first-secret-value <redacted>");
  assert.deepEqual(redactor.redactValue({ k: ["second-secret-value"] }), { k: ["<redacted>"] });
  assert.equal(calls, 3);

  const failing = createSecretRedactor({ getSecrets: () => { throw new Error("store unreadable"); } });
  assert.equal(failing.redact("api_key=abc123"), "api_key=<redacted>");
  const exactOnly = createSecretRedactor({ getSecrets: () => ["first-secret-value"], patterns: false });
  assert.equal(exactOnly.redact("api_key=abc123 first-secret-value"), "api_key=abc123 <redacted>");
});
