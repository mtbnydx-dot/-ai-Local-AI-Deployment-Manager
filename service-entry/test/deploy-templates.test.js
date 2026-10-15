"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const templates = require("../lib/deploy-templates");
const { parseTunnelTargets } = require("../lib/exposure-scan");

// Deploy templates (05 §14, PUB-20). The renderer is pure, so each topology is
// compared with a golden; the writer runs against a temp root only.

const ROOT = path.join(__dirname, "..", "..");
const GOLDEN = path.join(__dirname, "golden", "deploy-templates");
const BASE_URL = "https://models.example.com";
const WEBUI = "chat.example.com";

const CASES = {
  "caddy": { topology: "caddy", baseUrl: BASE_URL, config: {} },
  "caddy-webui": { topology: "caddy", baseUrl: BASE_URL, config: { webuiDomain: WEBUI } },
  "cloudflared-token": { topology: "cloudflared-token", baseUrl: BASE_URL, config: {} },
  "cloudflared-config-webui": { topology: "cloudflared-config", baseUrl: BASE_URL, config: { webuiDomain: WEBUI } },
  "lan": { topology: "lan", baseUrl: "", config: {} },
};

function checkGolden(relative, text) {
  const file = path.join(GOLDEN, ...relative.split("/"));
  if (process.env.UPDATE_GOLDEN === "1") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  assert.equal(text, fs.readFileSync(file, "utf8"), `golden ${relative}`);
}

for (const [name, input] of Object.entries(CASES)) {
  test(`${name}: the rendered files and commands match the goldens`, () => {
    const plan = templates.planTemplates(input);
    for (const file of plan.files) checkGolden(`${name}/${file.name}`, file.content);
    checkGolden(`${name}/plan.json`, `${JSON.stringify({ files: plan.files.map((file) => file.name), commands: plan.commands }, null, 2)}\n`);
    assert.deepEqual(templates.renderTemplates(input), plan.files, "renderTemplates is the files of the plan");
  });
}

test("Caddy and cloudflared target the PUBLIC listener (5186) and nothing else", () => {
  const portsOf = (text) => [...new Set(parseTunnelTargets(text).map((target) => target.port))];
  const find = (name, fileName) => templates.renderTemplates(CASES[name]).find((file) => file.name === fileName).content;
  assert.deepEqual(portsOf(find("caddy", "Caddyfile")), [5186]);
  assert.deepEqual(portsOf(find("cloudflared-config-webui", "config.yml")), [5186]);
  assert.deepEqual(portsOf(find("cloudflared-token", "cloudflared.compose.yaml")), []);
  // The only other upstream is the optional OpenWebUI site, which has its own domain.
  assert.deepEqual(portsOf(find("caddy-webui", "Caddyfile")).sort(), [3000, 5186]);
  const sources = templates.loadTemplates();
  for (const forbidden of [5176, 5177, 5178, 5180, 5190, 7000]) {
    for (const text of Object.values(sources)) assert.doesNotMatch(text, new RegExp(`:${forbidden}\\b`));
  }
  assert.match(sources.caddyfile, /^\s*reverse_proxy 127\.0\.0\.1:5186 \{$/m, "all paths, no path matcher");
  assert.doesNotMatch(sources.caddyfile, /@gateway|handle |respond /);
  assert.match(sources.caddyfile, /flush_interval -1/);
  assert.match(sources.caddyfile, /Strict-Transport-Security/);
  assert.equal((sources.caddyfile.match(/30m/g) || []).length >= 6, true, "30 minute timeouts");
});

test("the cloudflared compose follows the section 14 shape in both modes", () => {
  const find = (name) => templates.renderTemplates(CASES[name]).find((file) => file.name === "cloudflared.compose.yaml").content;
  const token = find("cloudflared-token");
  assert.match(token, /command: tunnel --no-autoupdate --metrics 0\.0\.0\.0:2000 run\n/);
  assert.match(token, /env_file:\n\s+- \.\/cloudflared\.env\n/);
  assert.doesNotMatch(token, /volumes:|--config/);
  const config = find("cloudflared-config-webui");
  assert.match(config, /--config \/etc\/cloudflared\/config\.yml run/);
  assert.doesNotMatch(config, /env_file/);
  for (const text of [token, config]) {
    assert.match(text, /"127\.0\.0\.1:20241:2000"/);
    assert.match(text, /host\.docker\.internal:host-gateway/);
    assert.match(text, /restart: unless-stopped/);
    assert.doesNotMatch(text, /\$\{/, "every placeholder is rendered");
  }
});

test("rendered files hold no secret: the token file is the empty example and the internal key stays a run-time variable", () => {
  const files = templates.renderTemplates(CASES["cloudflared-token"]);
  assert.equal(files.find((file) => file.name === "cloudflared.env.example").content.includes("TUNNEL_TOKEN=\n"), true);
  assert.equal(files.some((file) => file.name === "cloudflared.env"), false, "the platform never creates the token file");
  const webui = templates.renderTemplates(CASES["caddy-webui"]).find((file) => file.name === "openwebui.compose.yaml").content;
  assert.match(webui, /\$\{MODEL_GATEWAY_API_KEY:\?[^}]+\}/);
  assert.match(webui, /OPENAI_API_BASE_URL: "http:\/\/host\.docker\.internal:5186\/v1"/);
  assert.match(webui, /ENABLE_SIGNUP: "false"/);
  assert.match(webui, /DEFAULT_USER_ROLE: "pending"/);
  assert.match(webui, /ENABLE_FORWARD_USER_INFO_HEADERS: "true"/);
});

test("tracked deploy files contain only example domains, no secrets and no machine paths", () => {
  const files = [
    "deploy/cloudflare/README.md", "deploy/cloudflare/compose.yaml", "deploy/cloudflare/config.yml.template", "deploy/cloudflare/cloudflared.env.example",
    "deploy/public/Caddyfile", "deploy/public/openwebui.compose.yaml", "deploy/public/README.md", "deploy/public/.env.example",
  ];
  const credential = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, /\bsk-[A-Za-z0-9_-]{20,}\b/, /\beyJ[A-Za-z0-9_-]{20,}/];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(ROOT, ...rel.split("/")), "utf8");
    for (const pattern of credential) assert.doesNotMatch(text, pattern, rel);
    assert.doesNotMatch(text, /[A-Za-z]:\\(?:Users|AI)\\|\/Users\/|\/home\/\w+/, `${rel}: no absolute machine path`);
    assert.doesNotMatch(text, /[\w.-]+@[\w-]+\.(?:com|net|org)\b/, `${rel}: no e-mail address`);
    for (const host of text.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ai|dev)\b/g) || []) {
      assert.match(host, /(?:^|\.)example\.com$|^ghcr\.io$|^claude\.com$/, `${rel}: ${host} is not an example domain`);
    }
    if (rel.endsWith("cloudflared.env.example")) assert.match(text, /^TUNNEL_TOKEN=$/m);
  }
});

test("bad input is refused with a code before anything is rendered", () => {
  const refuse = (input, code) => assert.throws(() => templates.renderTemplates(input), (error) => error.code === code && error instanceof templates.TemplateError, code);
  refuse({ topology: "nginx", baseUrl: BASE_URL }, "invalid_topology");
  refuse({ topology: "caddy", baseUrl: "" }, "public_base_url_required");
  refuse({ topology: "caddy", baseUrl: "http://models.example.com" }, "invalid_base_url");
  refuse({ topology: "caddy", baseUrl: "https://models.example.com/v1" }, "invalid_base_url");
  refuse({ topology: "caddy", baseUrl: "https://models.example.com:8443" }, "invalid_base_url");
  refuse({ topology: "caddy", baseUrl: "https://localhost" }, "invalid_base_url");
  refuse({ topology: "caddy", baseUrl: "https://a_b.example.com" }, "invalid_base_url");
  refuse({ topology: "caddy", baseUrl: BASE_URL, config: { webuiDomain: "chat.example.com/x" } }, "invalid_domain");
  refuse({ topology: "caddy", baseUrl: BASE_URL, config: { webuiDomain: "models.example.com" } }, "invalid_domain");
  refuse({ topology: "cloudflared-token", baseUrl: BASE_URL, config: { cloudflaredImage: "x y" } }, "invalid_image");
  assert.equal(templates.renderTemplates({ topology: "lan" }).length, 0);
});

test("a placeholder outside the allowlist, or a broken block, throws instead of leaking through", () => {
  const base = templates.loadTemplates();
  const render = (caddyfile) => templates.renderTemplates({ topology: "caddy", baseUrl: BASE_URL, templates: { ...base, caddyfile } });
  assert.throws(() => render("{$SECRET_THING} {\n}\n"), (error) => error.code === "template_placeholder_unknown");
  assert.throws(() => render("# @if webui\nx\n"), (error) => error.code === "template_invalid");
  assert.throws(() => render("# @end\n"), (error) => error.code === "template_invalid");
  // A domain placeholder without a domain (no webui) is an error too, not an empty string.
  assert.throws(() => render("{$WEBUI_DOMAIN} {\n}\n"), (error) => error.code === "template_placeholder_unknown");
});

test("the writer stays under config/public and never overwrites unless asked", async (t) => {
  const aiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-templates-"));
  t.after(() => fs.rmSync(aiRoot, { recursive: true, force: true }));
  const files = templates.renderTemplates(CASES["caddy-webui"]);
  const first = await templates.writeTemplateFiles({ aiRoot, files });
  assert.deepEqual(first.written, ["config/public/Caddyfile", "config/public/openwebui.compose.yaml"]);
  const dir = path.join(aiRoot, "config", "public");
  assert.equal(fs.readFileSync(path.join(dir, "Caddyfile"), "utf8"), files[0].content);
  assert.deepEqual(fs.readdirSync(aiRoot), ["config"], "nothing outside config/public");

  fs.writeFileSync(path.join(dir, "Caddyfile"), "owner edit\n");
  await assert.rejects(templates.writeTemplateFiles({ aiRoot, files }), (error) => error.code === "template_exists" && error.status === 409 && error.existing.includes("Caddyfile"));
  assert.equal(fs.readFileSync(path.join(dir, "Caddyfile"), "utf8"), "owner edit\n");

  fs.rmSync(path.join(dir, "openwebui.compose.yaml"));
  await assert.rejects(templates.writeTemplateFiles({ aiRoot, files }), (error) => error.code === "template_exists");
  assert.equal(fs.existsSync(path.join(dir, "openwebui.compose.yaml")), false, "a refused call writes none of its files");

  const again = await templates.writeTemplateFiles({ aiRoot, files, overwrite: true });
  assert.equal(again.written.length, 2);
  assert.equal(fs.readFileSync(path.join(dir, "Caddyfile"), "utf8"), files[0].content);

  await assert.rejects(templates.writeTemplateFiles({ aiRoot, files: [{ name: "..\\evil.txt", content: "x" }] }), (error) => error.code === "invalid_file_name");
  await assert.rejects(templates.writeTemplateFiles({ aiRoot, files: [{ name: "../evil.txt", content: "x" }] }), (error) => error.code === "invalid_file_name");
  await assert.rejects(templates.writeTemplateFiles({ aiRoot: "", files }), (error) => error.code === "ai_root_unavailable");
  assert.deepEqual((await templates.writeTemplateFiles({ aiRoot, files: [] })).written, []);
});

test("the writer refuses to write through a link", async (t) => {
  const aiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-templates-link-"));
  t.after(() => fs.rmSync(aiRoot, { recursive: true, force: true }));
  const dir = path.join(aiRoot, "config", "public");
  fs.mkdirSync(dir, { recursive: true });
  const outside = path.join(aiRoot, "outside.txt");
  fs.writeFileSync(outside, "keep\n");
  try {
    fs.symlinkSync(outside, path.join(dir, "Caddyfile"));
  } catch {
    t.skip("symbolic links are not available here");
    return;
  }
  await assert.rejects(templates.writeTemplateFiles({ aiRoot, files: templates.renderTemplates(CASES.caddy), overwrite: true }), (error) => error.code === "template_target_unsafe");
  assert.equal(fs.readFileSync(outside, "utf8"), "keep\n");
});
