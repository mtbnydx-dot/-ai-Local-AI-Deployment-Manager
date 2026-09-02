const fs = require("fs");
const path = require("path");
const { execFile, execFileSync } = require("child_process");

function createHfAuthService({
  hfCli,
  hfHome,
  execFileImpl = execFile,
  execFileSyncImpl = execFileSync,
  platform = process.platform,
  baseEnv = process.env,
} = {}) {
  const cli = String(hfCli || "hf");
  const home = String(hfHome || "");

  function buildEnv(extra = {}) {
    return {
      ...baseEnv,
      ...(home ? { HF_HOME: home } : {}),
      HF_ENDPOINT: "https://huggingface.co",
      ...extra,
    };
  }

  function run(args, options = {}) {
    return new Promise((resolve, reject) => {
      execFileImpl(cli, args, {
        env: buildEnv(options.env),
        timeout: options.timeout || 30000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }, (error, stdout = "", stderr = "") => {
        if (error) {
          error.stdout = String(stdout || "");
          error.stderr = String(stderr || "");
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
      });
    });
  }

  function hasCachedToken() {
    if (!home) return false;
    try {
      return fs.statSync(path.join(home, "token")).size > 0;
    } catch {
      return false;
    }
  }

  async function getStatus(options = {}) {
    const token = String(options.token || "").trim();
    try {
      const result = await run(["auth", "whoami", "--format", "json"], {
        env: token ? { HF_TOKEN: token } : {},
        timeout: 15000,
      });
      const data = parseJsonOutput(result.stdout);
      return {
        connected: true,
        username: String(data?.user || data?.name || data?.username || "").trim() || null,
        orgs: normalizeOrgs(data?.orgs),
        source: token ? "temporary" : (baseEnv.HF_TOKEN ? "environment" : "local-cli"),
      };
    } catch (error) {
      return {
        connected: false,
        username: null,
        orgs: [],
        source: null,
        reason: classifyAuthError(error),
      };
    }
  }

  async function checkRepoAccess(model, options = {}) {
    const repoId = String(model || "").trim();
    if (!repoId || !repoId.includes("/")) {
      const error = new Error("需要 owner/model 形式的 Hugging Face 仓库 ID。");
      error.status = 400;
      throw error;
    }
    const token = String(options.token || "").trim();
    const identity = await getStatus({ token });
    if (!identity.connected) {
      return {
        granted: false,
        status: identity.reason === "invalid_token" ? "invalid_token" : "login_required",
        username: null,
      };
    }
    const probeFile = String(options.probeFile || "config.json").trim() || "config.json";
    try {
      await run(["download", repoId, probeFile, "--dry-run", "--format", "json"], {
        env: token ? { HF_TOKEN: token } : {},
        timeout: 30000,
      });
      return {
        granted: true,
        status: "granted",
        username: identity.username,
      };
    } catch (error) {
      return {
        granted: false,
        status: classifyRepoAccessError(error),
        username: identity.username,
      };
    }
  }

  function launchLogin() {
    if (platform !== "win32") {
      const error = new Error(`请在本机终端运行：HF_HOME=${home || "<HF_HOME>"} hf auth login --force`);
      error.status = 501;
      error.code = "hf_login_terminal_required";
      throw error;
    }
    const title = "Hugging Face 登录（本机安全窗口）";
    const command = [
      `$Host.UI.RawUI.WindowTitle = ${quotePowerShell(title)}`,
      `$env:HF_HOME = ${quotePowerShell(home)}`,
      "$env:HF_ENDPOINT = 'https://huggingface.co'",
      "Remove-Item Env:HF_TOKEN -ErrorAction SilentlyContinue",
      "Write-Host '请在 Hugging Face Token 页面创建 read 或 fine-grained read token，然后粘贴到这里。' -ForegroundColor Cyan",
      "Write-Host 'Token 只交给官方 hf CLI，不会经过管理平台网页或日志。' -ForegroundColor DarkGray",
      `& ${quotePowerShell(cli)} auth login --force`,
      "if ($LASTEXITCODE -eq 0) { Write-Host 'Hugging Face 登录成功，本窗口将自动关闭。' -ForegroundColor Green; Start-Sleep -Seconds 3; exit 0 } else { Write-Host '登录未完成；可在本窗口重新运行 hf auth login --force。' -ForegroundColor Yellow }",
    ].join("; ");
    const encodedCommand = Buffer.from(command, "utf16le").toString("base64");
    const launcher = `$ErrorActionPreference = 'Stop'; Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo','-NoProfile','-NoExit','-ExecutionPolicy','Bypass','-EncodedCommand',${quotePowerShell(encodedCommand)}) -WindowStyle Normal`;
    execFileSyncImpl("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      launcher,
    ], {
      stdio: "ignore",
      windowsHide: true,
      env: buildEnv(),
      timeout: 10000,
    });
    return {
      launched: true,
      tokenUrl: "https://huggingface.co/settings/tokens",
    };
  }

  return {
    hasCachedToken,
    getStatus,
    checkRepoAccess,
    launchLogin,
  };
}

function parseJsonOutput(text) {
  const value = String(text || "").trim();
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    const line = value.split(/\r?\n/).findLast((item) => item.trim().startsWith("{"));
    return line ? JSON.parse(line) : {};
  }
}

function normalizeOrgs(value) {
  if (Array.isArray(value)) return value.map((item) => String(item?.name || item || "").trim()).filter(Boolean);
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function errorText(error) {
  return `${error?.message || ""}\n${error?.stdout || ""}\n${error?.stderr || ""}`.toLowerCase();
}

function classifyAuthError(error) {
  const text = errorText(error);
  if (/invalid|unauthorized|401|token.*expired|token.*revoked/.test(text)) return "invalid_token";
  return "not_logged_in";
}

function classifyRepoAccessError(error) {
  const text = errorText(error);
  if (/invalid|unauthorized|401|token.*expired|token.*revoked/.test(text)) return "invalid_token";
  if (/access denied|requires approval|gated|403|forbidden/.test(text)) return "approval_required";
  if (/not found|404|repository not found/.test(text)) return "not_found";
  return "check_failed";
}

function quotePowerShell(value) {
  return `'${String(value || "").replaceAll("'", "''")}'`;
}

module.exports = {
  classifyAuthError,
  classifyRepoAccessError,
  createHfAuthService,
  parseJsonOutput,
  quotePowerShell,
};
