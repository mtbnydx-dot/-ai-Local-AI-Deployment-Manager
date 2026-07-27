const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PROVIDERS = Object.freeze({
  codex: { id: "codex", label: "OpenAI / Codex", flag: "-codex-login" },
  claude: { id: "claude", label: "Claude", flag: "-claude-login" },
  kimi: { id: "kimi", label: "Kimi", flag: "-kimi-login" },
  xai: { id: "xai", label: "xAI", flag: "-xai-login" },
  antigravity: { id: "antigravity", label: "Antigravity", flag: "-antigravity-login" },
});

const UNSAFE_KEY_PATTERNS = [
  /^your-api-key-\d+$/i,
  /^replace[-_ ]?with/i,
  /^change[-_ ]?me$/i,
  /^example/i,
  /^test[-_ ]?key/i,
];

function stripYamlScalar(value) {
  const trimmed = String(value || "").trim().replace(/\s+#.*$/, "").trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const inner = trimmed.slice(1, -1);
    if (trimmed.startsWith('"')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return inner;
      }
    }
    return inner.replace(/''/g, "'");
  }
  return trimmed;
}

function findTopLevelYamlBlock(lines, key) {
  const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = lines.findIndex((line) => new RegExp(`^${escaped}:\\s*(?:#.*)?$`).test(line));
  if (start < 0) return { start: -1, end: -1 };
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[A-Za-z0-9_-]+:\s*/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function isUnsafeApiKey(value) {
  const key = String(value || "").trim();
  return !key || UNSAFE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function inspectCliProxyConfig(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const apiKeysBlock = findTopLevelYamlBlock(lines, "api-keys");
  const apiKeys = apiKeysBlock.start < 0
    ? []
    : lines
      .slice(apiKeysBlock.start + 1, apiKeysBlock.end)
      .map((line) => line.match(/^\s*-\s*(.+?)\s*$/)?.[1])
      .filter(Boolean)
      .map(stripYamlScalar)
      .filter(Boolean);
  const readScalar = (key) => {
    const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const line = lines.find((item) => new RegExp(`^${escaped}:\\s*`).test(item));
    return line ? stripYamlScalar(line.replace(new RegExp(`^${escaped}:\\s*`), "")) : "";
  };
  const safeApiKeyCount = apiKeys.filter((key) => !isUnsafeApiKey(key)).length;
  const unsafeApiKeyCount = apiKeys.length - safeApiKeyCount;
  const host = readScalar("host");
  const port = Number(readScalar("port")) || 8317;
  const authDir = readScalar("auth-dir");
  return {
    host,
    port,
    authDir,
    loopbackOnly: ["127.0.0.1", "localhost", "::1"].includes(host),
    apiKeyCount: apiKeys.length,
    safeApiKeyCount,
    unsafeApiKeyCount,
    safeApiKeyConfigured: safeApiKeyCount > 0,
    apiKeys,
  };
}

function updateCliProxyApiKeys(text, newKey) {
  const key = String(newKey || "").trim();
  if (key.length < 24 || /\s/.test(key)) {
    throw new Error("Generated CLIProxyAPI key is invalid.");
  }
  const hadCrLf = /\r\n/.test(String(text || ""));
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (trailingNewline) lines.pop();
  const existing = inspectCliProxyConfig(normalized).apiKeys
    .filter((value) => !isUnsafeApiKey(value));
  const keys = [...new Set([...existing, key])];
  const replacement = [
    "api-keys:",
    ...keys.map((value) => `  - ${JSON.stringify(value)}`),
  ];
  const block = findTopLevelYamlBlock(lines, "api-keys");
  if (block.start < 0) {
    if (lines.length && lines.at(-1) !== "") lines.push("");
    lines.push(...replacement);
  } else {
    lines.splice(block.start, block.end - block.start, ...replacement);
  }
  const newline = hadCrLf ? "\r\n" : "\n";
  return `${lines.join(newline)}${trailingNewline ? newline : ""}`;
}

function expandUserPath(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return path.resolve(input);
}

async function isFile(filePath) {
  if (!filePath) return false;
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function readFirstLine(filePath) {
  try {
    return String(await fs.readFile(filePath, "utf8")).split(/\r?\n/, 1)[0].trim();
  } catch {
    return "";
  }
}

function findCommandOnPath(command, env = process.env) {
  const value = String(command || "").trim();
  if (!value) return "";
  if (path.isAbsolute(value) || value.includes("/") || value.includes("\\")) {
    return fsSync.existsSync(value) ? path.resolve(value) : "";
  }
  const extensions = process.platform === "win32"
    ? String(env.PATHEXT || ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const directory of String(env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${value}${extension}`);
      try {
        if (fsSync.statSync(candidate).isFile()) return candidate;
      } catch {
        // Continue searching.
      }
    }
  }
  return "";
}

async function resolveCliProxyExecutable(options = {}) {
  const root = options.root || path.dirname(__dirname);
  const runtimeFile = path.join(__dirname, ".subscription-proxy-runtime", "cliproxy.executable");
  const recorded = await readFirstLine(runtimeFile);
  const candidates = [
    options.executable,
    options.env?.CLIPROXY_EXE,
    process.env.CLIPROXY_EXE,
    recorded,
    path.join(root, "cli-proxy-api"),
    path.join(root, "cliproxyapi"),
    path.join(root, "cli-proxy-api.exe"),
    path.join(root, "cliproxyapi.exe"),
    path.join(root, "CLIProxyAPI", "cli-proxy-api"),
    path.join(root, "CLIProxyAPI", "cli-proxy-api.exe"),
    "/opt/homebrew/opt/cliproxyapi/bin/cliproxyapi",
    "/usr/local/opt/cliproxyapi/bin/cliproxyapi",
    "cliproxyapi",
    "cli-proxy-api",
  ];
  for (const candidate of candidates) {
    const resolved = findCommandOnPath(candidate, options.env || process.env);
    if (resolved) return resolved;
  }
  return "";
}

async function resolveCliProxyConfigPath(options = {}) {
  const root = options.root || path.dirname(__dirname);
  const executable = options.executable || await resolveCliProxyExecutable(options);
  const executableDir = executable ? path.dirname(executable) : "";
  const candidates = [
    options.configPath,
    options.env?.CLIPROXY_CONFIG,
    process.env.CLIPROXY_CONFIG,
    "/opt/homebrew/etc/cliproxyapi.conf",
    "/usr/local/etc/cliproxyapi.conf",
    path.join(root, "config.yaml"),
    path.join(root, "config.yml"),
    path.join(root, "cliproxyapi.conf"),
    executableDir && path.join(executableDir, "config.yaml"),
    executableDir && path.join(executableDir, "config.yml"),
    path.join(os.homedir(), ".cli-proxy-api", "config.yaml"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = expandUserPath(candidate);
    if (await isFile(resolved)) return resolved;
  }
  return "";
}

function resolveAuthDirectory(configPath, authDir) {
  const value = String(authDir || "").trim();
  if (!value) return "";
  if (value.startsWith("~")) return expandUserPath(value);
  if (path.isAbsolute(value)) return value;
  return path.resolve(path.dirname(configPath), value);
}

async function countAuthFiles(directory) {
  if (!directory) return 0;
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json")).length;
  } catch {
    return 0;
  }
}

async function writeFileAtomically(filePath, content) {
  const stat = await fs.stat(filePath);
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(5).toString("hex")}`;
  try {
    await fs.writeFile(tempPath, content, { encoding: "utf8", mode: stat.mode });
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function sanitizeLoginSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    provider: session.provider,
    providerLabel: session.providerLabel,
    status: session.status,
    message: session.message,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt || null,
    authUrl: session.status === "waiting" ? session.authUrl || null : null,
  };
}

function createSubscriptionSetupController(options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const now = options.now || (() => new Date());
  let activeSession = null;
  let lastSession = null;

  async function getStatus() {
    const executablePath = await resolveCliProxyExecutable(options);
    const configPath = await resolveCliProxyConfigPath({ ...options, executable: executablePath });
    let config = null;
    let authFiles = 0;
    let authDirectoryConfigured = false;
    if (configPath) {
      const parsed = inspectCliProxyConfig(await fs.readFile(configPath, "utf8"));
      const authDirectory = resolveAuthDirectory(configPath, parsed.authDir);
      authDirectoryConfigured = Boolean(authDirectory);
      authFiles = await countAuthFiles(authDirectory);
      config = {
        found: true,
        path: configPath,
        host: parsed.host || "(全部接口)",
        port: parsed.port,
        loopbackOnly: parsed.loopbackOnly,
        apiKeyCount: parsed.apiKeyCount,
        safeApiKeyCount: parsed.safeApiKeyCount,
        unsafeApiKeyCount: parsed.unsafeApiKeyCount,
        safeApiKeyConfigured: parsed.safeApiKeyConfigured,
      };
    }
    return {
      ok: true,
      localOnly: true,
      executable: {
        found: Boolean(executablePath),
        path: executablePath || "",
      },
      config: config || {
        found: false,
        path: "",
        host: "",
        port: 8317,
        loopbackOnly: false,
        apiKeyCount: 0,
        safeApiKeyCount: 0,
        unsafeApiKeyCount: 0,
        safeApiKeyConfigured: false,
      },
      auth: {
        directoryConfigured: authDirectoryConfigured,
        accountFiles: authFiles,
      },
      providers: Object.values(PROVIDERS).map(({ id, label }) => ({ id, label })),
      loginSession: sanitizeLoginSession(activeSession || lastSession),
    };
  }

  async function generateApiKey() {
    const executablePath = await resolveCliProxyExecutable(options);
    const configPath = await resolveCliProxyConfigPath({ ...options, executable: executablePath });
    if (!configPath) {
      const error = new Error("未找到 CLIProxyAPI 配置文件；请先完成安装，或设置 CLIPROXY_CONFIG。");
      error.status = 409;
      throw error;
    }
    const original = await fs.readFile(configPath, "utf8");
    const apiKey = `sk-proxy-${crypto.randomBytes(32).toString("base64url")}`;
    const updated = updateCliProxyApiKeys(original, apiKey);
    await writeFileAtomically(configPath, updated);
    const config = inspectCliProxyConfig(updated);
    return {
      ok: true,
      apiKey,
      configPath,
      safeApiKeyCount: config.safeApiKeyCount,
      message: "新的客户端 API Key 已写入 CLIProxyAPI 配置；该值只在本次响应中显示。",
    };
  }

  async function startLogin(providerId) {
    const provider = PROVIDERS[String(providerId || "").toLowerCase()];
    if (!provider) {
      const error = new Error("不支持的订阅登录类型。");
      error.status = 400;
      throw error;
    }
    if (activeSession && ["starting", "waiting"].includes(activeSession.status)) {
      const error = new Error(`已有 ${activeSession.providerLabel} 登录正在进行。`);
      error.status = 409;
      throw error;
    }
    const executablePath = await resolveCliProxyExecutable(options);
    const configPath = await resolveCliProxyConfigPath({ ...options, executable: executablePath });
    if (!executablePath || !configPath) {
      const error = new Error("未找到 CLIProxyAPI 可执行文件或配置文件。");
      error.status = 409;
      throw error;
    }
    const session = {
      id: crypto.randomUUID(),
      provider: provider.id,
      providerLabel: provider.label,
      status: "starting",
      message: "正在启动登录流程…",
      startedAt: now().toISOString(),
      finishedAt: null,
      authUrl: "",
      child: null,
    };
    activeSession = session;
    const child = spawnImpl(executablePath, ["-config", configPath, provider.flag], {
      cwd: path.dirname(configPath),
      env: options.env || process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    session.child = child;
    const captureLoginState = (chunk) => {
      const text = String(chunk || "");
      const url = text.match(/https?:\/\/[^\s"'<>]+/)?.[0] || "";
      if (url && /auth|oauth|login|account|openai|anthropic|moonshot|kimi|x\.ai/i.test(url)) {
        session.authUrl = url.replace(/[),.;]+$/, "");
      }
      if (/success|logged in|authentication complete|authenticated/i.test(text)) {
        session.message = "登录已完成，正在保存授权…";
      } else if (/open|browser|visit|authorize|waiting/i.test(text)) {
        session.message = "请在浏览器中完成授权；如果没有自动打开，请使用下方登录链接。";
      }
    };
    child.stdout?.on("data", captureLoginState);
    child.stderr?.on("data", captureLoginState);
    child.once("spawn", () => {
      session.status = "waiting";
      session.message = "登录窗口已启动，请在浏览器中完成授权。";
    });
    child.once("error", (error) => {
      session.status = "failed";
      session.message = `无法启动登录流程：${error.message}`;
      session.finishedAt = now().toISOString();
      lastSession = session;
      if (activeSession === session) activeSession = null;
    });
    child.once("exit", (code, signal) => {
      if (session.status === "failed") return;
      session.status = code === 0 ? "succeeded" : "failed";
      session.message = code === 0
        ? "登录完成，CLIProxyAPI 已保存授权。"
        : `登录未完成（退出码 ${code ?? signal ?? "unknown"}）。`;
      session.finishedAt = now().toISOString();
      session.authUrl = "";
      lastSession = session;
      if (activeSession === session) activeSession = null;
    });
    const timeout = setTimeout(() => {
      if (activeSession !== session || !["starting", "waiting"].includes(session.status)) return;
      session.status = "failed";
      session.message = "登录等待超过 10 分钟，已结束本次流程。";
      session.finishedAt = now().toISOString();
      session.authUrl = "";
      child.kill();
      lastSession = session;
      activeSession = null;
    }, options.loginTimeoutMs || 10 * 60 * 1000);
    timeout.unref?.();
    child.once("exit", () => clearTimeout(timeout));
    child.once("error", () => clearTimeout(timeout));
    return sanitizeLoginSession(session);
  }

  return {
    generateApiKey,
    getStatus,
    startLogin,
  };
}

module.exports = {
  PROVIDERS,
  createSubscriptionSetupController,
  findCommandOnPath,
  findTopLevelYamlBlock,
  inspectCliProxyConfig,
  isUnsafeApiKey,
  resolveCliProxyConfigPath,
  resolveCliProxyExecutable,
  stripYamlScalar,
  updateCliProxyApiKeys,
};
