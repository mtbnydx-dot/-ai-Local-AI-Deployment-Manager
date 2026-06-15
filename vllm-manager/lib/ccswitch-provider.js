const fs = require("fs");
const path = require("path");

const CCSWITCH_PROVIDER_SCRIPT = String.raw`
import base64, json, pathlib, shutil, sqlite3, sys, time

def safe_json(value, fallback):
    try:
        return json.loads(value) if value else fallback
    except Exception:
        return fallback

cfg = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
db = pathlib.Path(cfg["dbPath"])
backup_dir = db.parent / "backups"
backup_dir.mkdir(parents=True, exist_ok=True)
backup = backup_dir / ("db_backup_claude_setup_" + time.strftime("%Y%m%d_%H%M%S") + ".db")
shutil.copy2(db, backup)

con = sqlite3.connect(str(db), timeout=10)
con.row_factory = sqlite3.Row
provider = con.execute(
    "select * from providers where app_type='claude-desktop' and is_current=1 and id!='claude-desktop-official' limit 1"
).fetchone()
if provider is None:
    provider = con.execute(
        "select * from providers where app_type='claude-desktop' and id!='claude-desktop-official' order by sort_index is null, sort_index limit 1"
    ).fetchone()

now_ms = int(time.time() * 1000)
if provider is None:
    provider_id = "local-vllm-claude"
    con.execute(
        "insert or ignore into providers (id, app_type, name, settings_config, category, created_at, is_current, meta, provider_type) values (?, 'claude-desktop', 'Local vLLM Claude', '{}', 'custom', ?, 0, '{}', 'anthropic')",
        (provider_id, now_ms),
    )
    provider = con.execute("select * from providers where id=? and app_type='claude-desktop'", (provider_id,)).fetchone()

provider_id = provider["id"]
settings = safe_json(provider["settings_config"], {})
env = settings.setdefault("env", {})
env["ANTHROPIC_BASE_URL"] = cfg["baseUrl"]
env["ANTHROPIC_AUTH_TOKEN"] = cfg["apiKey"]

meta = safe_json(provider["meta"], {})
meta["claudeDesktopMode"] = "direct"
meta["apiFormat"] = "anthropic"
meta["claudeDesktopModelRoutes"] = {
    item["name"]: {"model": item["name"], "labelOverride": item.get("labelOverride") or "local"}
    for item in cfg["aliases"]
}

con.execute("update providers set is_current=0 where app_type='claude-desktop'")
con.execute(
    "update providers set name=?, settings_config=?, meta=?, provider_type='anthropic', is_current=1 where id=? and app_type='claude-desktop'",
    ("Local vLLM Claude", json.dumps(settings, ensure_ascii=False), json.dumps(meta, ensure_ascii=False), provider_id),
)
con.execute("delete from provider_endpoints where provider_id=? and app_type='claude-desktop'", (provider_id,))
con.execute(
    "insert into provider_endpoints (provider_id, app_type, url, added_at) values (?, 'claude-desktop', ?, ?)",
    (provider_id, cfg["messagesUrl"], now_ms),
)
con.execute(
    "insert into provider_health (provider_id, app_type, is_healthy, consecutive_failures, last_success_at, last_failure_at, last_error, updated_at) values (?, 'claude-desktop', 1, 0, datetime('now'), null, null, datetime('now')) on conflict(provider_id, app_type) do update set is_healthy=1, consecutive_failures=0, last_success_at=datetime('now'), last_failure_at=null, last_error=null, updated_at=datetime('now')",
    (provider_id,),
)
con.commit()
con.close()
print(json.dumps({"ok": True, "providerId": provider_id, "dbPath": str(db), "backupPath": str(backup), "endpoint": cfg["messagesUrl"]}, ensure_ascii=False))
`;

function createCcSwitchProviderTools(deps = {}) {
  const {
    ccSwitchDir,
    pythonExe,
    execFileAsync,
    parseJsonSafe = parseJsonFallback,
    fetchImpl = globalThis.fetch,
  } = deps;

  function getCcSwitchDbPath() {
    return path.join(ccSwitchDir, "cc-switch.db");
  }

  async function configureCcSwitchProvider(config) {
    const dbPath = getCcSwitchDbPath();
    if (!fs.existsSync(dbPath)) {
      return { ok: false, skipped: true, reason: "cc-switch.db not found", dbPath };
    }
    const payload = Buffer.from(JSON.stringify({
      dbPath,
      baseUrl: config.baseUrl,
      messagesUrl: config.messagesUrl,
      apiKey: config.apiKey,
      aliases: config.aliases,
    }), "utf8").toString("base64");
    const { stdout } = await execFileAsync(pythonExe, ["-c", CCSWITCH_PROVIDER_SCRIPT, payload], { timeout: 15000, maxBuffer: 1024 * 1024 });
    return parseJsonSafe(stdout.trim(), { ok: false, stdout: stdout.trim(), dbPath });
  }

  async function getCcSwitchHealth() {
    const url = "http://127.0.0.1:15721/health";
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(2000) });
      const text = await response.text();
      return { ok: response.ok, status: response.status, url, body: parseJsonSafe(text, text) };
    } catch (error) {
      return { ok: false, url, error: error.message };
    }
  }

  return {
    configureCcSwitchProvider,
    getCcSwitchDbPath,
    getCcSwitchHealth,
  };
}

function parseJsonFallback(text, fallback = null) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

module.exports = {
  CCSWITCH_PROVIDER_SCRIPT,
  createCcSwitchProviderTools,
};
