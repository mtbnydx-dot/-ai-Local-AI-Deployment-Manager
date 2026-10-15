"use strict";

// Deploy template renderer (05-public.md section 14, PUB-20).
//
// renderTemplates({ topology, baseUrl, config }) -> [{ name, content }] turns the
// tracked templates under deploy/cloudflare and deploy/public into the files an
// owner runs by hand. It is pure: the same input always gives the same files, and
// it starts nothing. Placeholders are ${NAME} (compose, cloudflared) and {$NAME}
// (Caddy) and only the allowlist below is substituted; any other placeholder
// throws, except the internal-app key, which compose reads at run time and which
// is never rendered. Lines between "# @if NAME" and "# @end" are kept only when
// NAME is set for the chosen topology.
//
// writeTemplateFiles() puts the files under <AI_ROOT>/config/public/ and nowhere
// else, and refuses to replace an existing file unless asked.

const fs = require("node:fs");
const path = require("node:path");

const TOPOLOGIES = Object.freeze(["cloudflared-token", "cloudflared-config", "caddy", "lan"]);
const PUBLIC_CONFIG_REL = "config/public";
// Same rule as scripts/setup-public.ps1.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// A tag, not a digest: the digest is the owner's to pin (deploy/cloudflare/README.md).
const DEFAULT_CLOUDFLARED_IMAGE = "cloudflare/cloudflared:2025.8.1";
// Compose reads these when the owner runs it; the renderer leaves them alone.
const RUNTIME_PLACEHOLDERS = Object.freeze(["MODEL_GATEWAY_API_KEY"]);
const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:[-?][^}]*)?\}|\{\$([A-Za-z_][A-Za-z0-9_]*)\}/g;
const MARKER_RE = /^\s*# @(if|end)(?:\s+([a-z]+))?\s*$/;

class TemplateError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "TemplateError";
    this.code = code;
    this.status = status;
  }
}

/** The tracked template sources, read from the repository checkout. */
function loadTemplates(root = path.join(__dirname, "..", "..")) {
  // A checkout may hold CRLF in the text=auto files; the templates are LF.
  const read = (rel) => fs.readFileSync(path.join(root, ...rel.split("/")), "utf8").replace(/\r\n/g, "\n");
  return {
    caddyfile: read("deploy/public/Caddyfile"),
    openwebuiCompose: read("deploy/public/openwebui.compose.yaml"),
    cloudflaredCompose: read("deploy/cloudflare/compose.yaml"),
    cloudflaredConfig: read("deploy/cloudflare/config.yml.template"),
    cloudflaredEnvExample: read("deploy/cloudflare/cloudflared.env.example"),
  };
}

function hostnameOf(value, field) {
  let parsed;
  try {
    parsed = new URL(String(value ?? "").includes("://") ? String(value) : `https://${value}`);
  } catch {
    throw new TemplateError("invalid_domain", `${field} must be a bare hostname such as models.example.com.`);
  }
  const host = parsed.hostname.toLowerCase();
  const bare = parsed.pathname === "/" && !parsed.search && !parsed.hash && !parsed.port && !parsed.username;
  if (!bare || !DOMAIN_RE.test(host)) throw new TemplateError("invalid_domain", `${field} must be a bare hostname such as models.example.com.`);
  return host;
}

function publicHost(baseUrl) {
  const text = String(baseUrl ?? "").trim();
  if (!text) throw new TemplateError("public_base_url_required", "Set listeners.public.baseUrl to the public https address first.");
  if (!/^https:\/\//i.test(text)) throw new TemplateError("invalid_base_url", "The public base URL must start with https://.");
  try {
    return hostnameOf(text, "The public base URL");
  } catch (error) {
    throw new TemplateError("invalid_base_url", error.message);
  }
}

function applyBlocks(text, flags) {
  const out = [];
  let open = null;
  for (const line of text.split("\n")) {
    const marker = MARKER_RE.exec(line.replace(/\r$/, ""));
    if (!marker) {
      if (!open || open.keep) out.push(line);
      continue;
    }
    if (marker[1] === "if") {
      if (open || !marker[2]) throw new TemplateError("template_invalid", "Template blocks cannot be nested.", 500);
      open = { keep: flags.has(marker[2]) };
    } else {
      if (!open) throw new TemplateError("template_invalid", "A template block is closed but never opened.", 500);
      open = null;
    }
  }
  if (open) throw new TemplateError("template_invalid", "A template block is never closed.", 500);
  return out.join("\n");
}

function substitute(text, values) {
  return text.replace(PLACEHOLDER_RE, (whole, composeName, _modifier, caddyName) => {
    const name = composeName || caddyName;
    if (Object.prototype.hasOwnProperty.call(values, name)) return values[name];
    if (composeName && RUNTIME_PLACEHOLDERS.includes(name)) return whole;
    throw new TemplateError("template_placeholder_unknown", `The template uses a placeholder that is not allowed: ${name}.`, 500);
  });
}

function renderOne(source, flags, values) {
  const text = String(source ?? "").replace(/\r\n/g, "\n");
  return substitute(applyBlocks(text, flags), values);
}

function planFor(topology) {
  if (topology === "cloudflared-token") return { flags: ["token"], files: ["cloudflared.compose.yaml", "cloudflared.env.example"] };
  if (topology === "cloudflared-config") return { flags: ["config"], files: ["cloudflared.compose.yaml", "config.yml"] };
  if (topology === "caddy") return { flags: [], files: ["Caddyfile"] };
  return { flags: [], files: [] };
}

function commandsFor(topology, baseUrl, hasWebui) {
  const url = baseUrl ? `https://${publicHost(baseUrl)}` : "";
  const commands = ["cd <AI_ROOT>\\config\\public"];
  const setUrl = `platform config set listeners.public.baseUrl ${url}`;
  if (topology === "caddy") {
    commands.push(
      "caddy validate --config Caddyfile --adapter caddyfile",
      "caddy run --config Caddyfile",
      setUrl,
      "platform config set trustedProxies.clientIpHeader x-forwarded-for",
      "platform config set trustedProxies.cidrs 127.0.0.1/32",
    );
  } else if (topology === "cloudflared-token") {
    commands.push(
      "# paste TUNNEL_TOKEN into cloudflared.env yourself; the platform never creates it",
      "Copy-Item cloudflared.env.example cloudflared.env",
      "docker compose -f cloudflared.compose.yaml up -d",
      setUrl,
      "platform config set trustedProxies.clientIpHeader cf-connecting-ip",
    );
  } else if (topology === "cloudflared-config") {
    commands.push(
      "# edit config.yml (tunnel id) and put the tunnel credentials in credentials.json",
      "docker compose -f cloudflared.compose.yaml up -d",
      setUrl,
      "platform config set trustedProxies.clientIpHeader cf-connecting-ip",
    );
  } else {
    commands.push("platform config set listeners.public.host 0.0.0.0");
  }
  if (hasWebui) commands.push("docker compose --env-file .env -f openwebui.compose.yaml up -d");
  return commands;
}

/**
 * planTemplates({ topology, baseUrl, config, templates }) -> { files, commands }
 * config: { webuiDomain?, cloudflaredImage? }. lan needs no base URL and renders
 * no files. Throws TemplateError (400) for an unknown topology or a bad domain.
 */
function planTemplates({ topology, baseUrl, config = {}, templates } = {}) {
  if (!TOPOLOGIES.includes(topology)) throw new TemplateError("invalid_topology", `topology must be one of ${TOPOLOGIES.join(", ")}.`);
  const sources = templates || loadTemplates();
  if (topology === "lan") return { files: [], commands: commandsFor("lan", "", false) };

  const modelHost = publicHost(baseUrl);
  const webuiHost = config.webuiDomain ? hostnameOf(config.webuiDomain, "webuiDomain") : "";
  if (webuiHost && webuiHost === modelHost) throw new TemplateError("invalid_domain", "webuiDomain must differ from the model API domain.");
  const image = String(config.cloudflaredImage || DEFAULT_CLOUDFLARED_IMAGE);
  if (!/^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?(@sha256:[0-9a-f]{64})?$/.test(image)) {
    throw new TemplateError("invalid_image", "cloudflaredImage is not a valid image reference.");
  }
  const values = { MODEL_API_DOMAIN: modelHost, CLOUDFLARED_IMAGE: image, PUBLIC_CONFIG_DIR: "." };
  if (webuiHost) values.WEBUI_DOMAIN = webuiHost;

  const plan = planFor(topology);
  const flags = new Set([...plan.flags, ...(webuiHost ? ["webui"] : [])]);
  const sourceOf = {
    Caddyfile: sources.caddyfile,
    "cloudflared.compose.yaml": sources.cloudflaredCompose,
    "cloudflared.env.example": sources.cloudflaredEnvExample,
    "config.yml": sources.cloudflaredConfig,
  };
  const files = plan.files.map((name) => ({ name, content: renderOne(sourceOf[name], flags, values) }));
  // The token file is a copy of the example and carries no value; the rendered
  // OpenWebUI compose keeps the internal-app key as a run-time variable.
  if (webuiHost) files.push({ name: "openwebui.compose.yaml", content: renderOne(sources.openwebuiCompose, flags, values) });
  return { files, commands: commandsFor(topology, baseUrl, Boolean(webuiHost)) };
}

/** renderTemplates({ topology, baseUrl, config }) -> [{ name, content }] (pure). */
function renderTemplates(options) {
  return planTemplates(options).files;
}

/**
 * writeTemplateFiles({ aiRoot, files, overwrite, fsApi }) -> { written: [relPath] }
 * Writes only <aiRoot>/config/public/<name>. Without overwrite an existing file
 * makes the whole call fail with 409 template_exists and nothing is written.
 */
async function writeTemplateFiles({ aiRoot, files, overwrite = false, fsApi = fs.promises } = {}) {
  if (!aiRoot) throw new TemplateError("ai_root_unavailable", "The platform root is not known.", 503);
  const names = (files || []).map((file) => file.name);
  for (const name of names) {
    if (!FILE_NAME_RE.test(name)) throw new TemplateError("invalid_file_name", "A template file name is not allowed.", 500);
  }
  const dir = path.join(aiRoot, ...PUBLIC_CONFIG_REL.split("/"));
  if (!names.length) return { written: [] };
  await fsApi.mkdir(dir, { recursive: true });
  const existing = [];
  for (const name of names) {
    let stat = null;
    try {
      stat = await fsApi.lstat(path.join(dir, name));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (stat && stat.isSymbolicLink()) throw new TemplateError("template_target_unsafe", `${name} is a link; the platform will not write through it.`, 409);
    if (stat) existing.push(name);
  }
  if (existing.length && !overwrite) {
    const error = new TemplateError("template_exists", "Some files already exist; pass overwrite to replace them.", 409);
    error.existing = existing;
    throw error;
  }
  const written = [];
  for (const file of files) {
    await fsApi.writeFile(path.join(dir, file.name), file.content, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
    written.push(`${PUBLIC_CONFIG_REL}/${file.name}`);
  }
  return { written };
}

module.exports = {
  DEFAULT_CLOUDFLARED_IMAGE,
  DOMAIN_RE,
  PUBLIC_CONFIG_REL,
  TOPOLOGIES,
  TemplateError,
  loadTemplates,
  planTemplates,
  renderTemplates,
  writeTemplateFiles,
};
