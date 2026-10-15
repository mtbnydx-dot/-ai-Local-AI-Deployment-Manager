"use strict";

// Network checks (06 §7.2). They consume facts only: listeners, process rows
// and Windows facts come through probes. Fix entries are metadata; killing a
// process or restarting a manager happens in the fix runner after the rules of
// §7.3, never here.
const path = require("node:path");
const { chooseUpstream, CONTAINER_HOST } = require("../hooks/search-gateway");

const WILDCARDS = new Set(["0.0.0.0", "::", "[::]", "*"]);
const LOOPBACKS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const LEGACY_PROXY_SCRIPT = "claude-vllm-anthropic-proxy.py";
const LEGACY_PROXY_RUN_VALUE = "ClaudeVllmProxy";
const SCRIPT_HOSTS = /^(?:node|pwsh|powershell|python|pythonw|py|cmd)(?:\.exe)?$/i;
const SEARCH_DEFAULTS = Object.freeze({ "listeners.public.enabled": true, "listeners.public.port": 5186, "listeners.admin.port": 5176, "managers.vllm.port": 5177 });
const MANAGERS = Object.freeze([
  { id: "vllm", componentId: "vllm-manager", defaultPort: 5177 },
  { id: "llama", componentId: "llama-manager", defaultPort: 5178 },
]);

function title(zh, en) { return { "zh-CN": zh, "en-US": en }; }
function lower(value) { return String(value || "").replace(/\\/g, "/").toLowerCase(); }
function baseName(value) { return path.win32.basename(String(value || "")).toLowerCase(); }
function isWildcard(address) { return WILDCARDS.has(String(address || "").trim()); }
function isLoopback(address) { return LOOPBACKS.has(String(address || "").trim().toLowerCase()); }

function createChecks(ctx) {
  const descriptor = (id, zh, en, run, extra = {}) => ({ id, group: "network", title: title(zh, en), run, ...extra });
  const manual = (id, zh, en, extra = {}) => ctx.fix(id, `${id.replace(/^net\./, "")}-docs`, "manual", zh, en, "/docs/troubleshooting.md#network", extra);
  const root = lower(ctx.aiRoot);

  // Docker-managed (compose, external) and grouped workers are owned by other
  // processes, so only node/process components and their listeners are judged.
  const OWNED_KINDS = new Set(["node", "process", "listener"]);
  async function registryPorts() {
    const components = await ctx.probe("resolvedComponents"), rows = [];
    for (const component of components) {
      if (component.disabled || component.detectOnly || !OWNED_KINDS.has(component.kind)) continue;
      const owner = component.kind === "listener" ? components.find((item) => item.id === component.parent) || component : component;
      for (const port of component.ports || []) if (port.enabled !== false && Number(port.port) > 0) rows.push({ componentId: component.id, ownerId: owner.id, name: port.name, port: Number(port.port), bind: port.bind, component: owner });
    }
    return rows;
  }

  // Who owns a socket: the component's own process, another process of this
  // platform (its command line references AI_ROOT), or a foreign program.
  // Without a supervisor identity record a legacy launcher's process still
  // matches by its working folder, or by the same executable and script.
  function classify(owner, row, records) {
    if (!owner) return "unknown";
    if (records.some((item) => item.id === row.ownerId && item.pid === owner.pid)) return "expected";
    const line = lower(owner.commandLine), cwd = row.component.cwd ? lower(row.component.cwd) : null;
    if (cwd && line.includes(cwd)) return "expected";
    const script = lower(row.component.args?.[0] || "");
    if (script && baseName(owner.exe) === baseName(row.component.command) && line.includes(script)) return "expected";
    return root && line.includes(root) ? "platform" : "foreign";
  }

  return [
    descriptor("net.ports", "端口占用", "Port ownership", async () => {
      if (ctx.platform !== "win32") return { status: "skip", detail: "Port ownership is a Windows-only check.", data: { reason: "unsupported_platform" } };
      const [rows, listeners, processes, records] = await Promise.all([registryPorts(), ctx.probe("listeners"), ctx.probe("processes"), ctx.probe("identityRecords")]);
      const pids = [...new Set(listeners.map((item) => item.pid))];
      const images = processes.length ? {} : await ctx.probe("imageNames", pids);
      const problems = [], ports = [];
      for (const row of rows) {
        const found = listeners.filter((item) => item.port === row.port);
        if (!found.length) continue;
        for (const listener of found) {
          const owner = processes.find((item) => item.pid === listener.pid) || null;
          const state = classify(owner, row, records);
          const entry = { componentId: row.componentId, port: row.port, address: listener.address, pid: listener.pid, image: owner ? baseName(owner.exe) || images[listener.pid] || null : images[listener.pid] || null, owner: state };
          ports.push(entry);
          if (state === "platform" || state === "foreign") problems.push({ ...entry, processCreatedAt: owner?.processCreatedAt || null, exe: owner?.exe || "" });
        }
      }
      if (!problems.length) return { status: "ok", detail: ports.length ? "Every registered port that is in use belongs to its own component." : "No registered port is in use by another program.", data: { ports } };
      const fixable = problems.filter((item) => item.owner === "platform");
      const fixes = fixable.map((item) => ctx.fix("net.ports", `stop-orphan:${item.port}`, "confirm", `停止占用端口 ${item.port} 的旧进程`, `Stop the stale process on port ${item.port}`, "/docs/troubleshooting.md#network", { port: item.port, target: { pid: item.pid, processCreatedAt: item.processCreatedAt, exe: item.exe } }));
      const fix = fixes[0] || manual("net.ports", "释放被占用的端口", "Free the occupied port");
      return { status: "fail", detail: `Port ${problems.map((item) => item.port).join(", ")} is held by a process that is not the registered component.`, data: { ports, conflicts: problems.map((item) => ({ componentId: item.componentId, port: item.port, pid: item.pid, image: item.image, owner: item.owner })), fixes }, fix, actions: fixes.length ? fixes.map((item) => item.id) : [fix.id] };
    }),
    descriptor("net.orphans", "遗留进程", "Orphan processes", async () => {
      if (ctx.platform !== "win32") return { status: "skip", detail: "Orphan detection is a Windows-only check.", data: { reason: "unsupported_platform" } };
      const [rows, listeners, processes, records] = await Promise.all([registryPorts(), ctx.probe("listeners"), ctx.probe("processes"), ctx.probe("identityRecords")]);
      const ownPorts = new Set(rows.map((row) => row.port));
      const portPids = new Set(listeners.filter((item) => ownPorts.has(item.port)).map((item) => item.pid));
      const known = new Set([...portPids, ...records.map((item) => item.pid), process.pid, process.ppid]);
      const orphans = processes.filter((item) => {
        if (known.has(item.pid) || !SCRIPT_HOSTS.test(baseName(item.exe))) return false;
        const line = lower(item.commandLine);
        // The doctor and the CLI themselves reference AI_ROOT scripts.
        return Boolean(root) && line.includes(root) && !/platformctl|doctor/.test(line.split(root).join(""));
      });
      const alive = new Set(processes.map((item) => item.pid));
      const stale = records.filter((item) => !alive.has(item.pid)).map((item) => ({ id: item.id, pid: item.pid }));
      if (!orphans.length && !stale.length) return { status: "ok", detail: "No orphan platform processes or stale pid files were found.", data: { orphans: [], stalePidFiles: [] } };
      const targets = orphans.map((item) => ({ pid: item.pid, processCreatedAt: item.processCreatedAt, exe: item.exe }));
      return {
        status: "warn",
        detail: `${orphans.length} orphan process(es) and ${stale.length} stale pid file(s) were found.`,
        data: { orphans: orphans.map((item) => ({ pid: item.pid, image: baseName(item.exe), processCreatedAt: item.processCreatedAt })), stalePidFiles: stale },
        fix: ctx.fix("net.orphans", "stop-orphan", "confirm", "停止遗留进程并清理 pid 记录", "Stop orphan processes and clear stale pid records", "/docs/troubleshooting.md#network", { targets, stale }),
      };
    }),
    descriptor("net.legacy-proxy", "旧版 Claude 代理", "Legacy Claude proxy", async () => {
      if (ctx.platform !== "win32") return { status: "skip", detail: "The legacy proxy check is Windows-only.", data: { reason: "unsupported_platform" } };
      const [listeners, processes, runKeys] = await Promise.all([ctx.probe("listeners"), ctx.probe("processes"), ctx.probe("runKeys")]);
      const owner = listeners.filter((item) => item.port === 8001).map((item) => processes.find((row) => row.pid === item.pid)).find((row) => row && row.commandLine.includes(LEGACY_PROXY_SCRIPT)) || null;
      const runValue = Object.hasOwn(runKeys || {}, LEGACY_PROXY_RUN_VALUE);
      if (!owner && !runValue) return { status: "ok", detail: "The deprecated Claude proxy is not running and has no logon entry.", data: { running: false, runValue: false } };
      return {
        status: "warn",
        detail: "The deprecated Claude proxy is present; it bypasses the gateway's authentication.",
        data: { running: Boolean(owner), pid: owner?.pid || null, runValue },
        fix: manual("net.legacy-proxy", "移除旧版代理自启动项", "Remove the legacy proxy autostart entry", { command: `reg delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v ${LEGACY_PROXY_RUN_VALUE}` }),
      };
    }),
    descriptor("net.firewall", "防火墙入站规则", "Firewall inbound rule", async () => {
      const lan = ctx.value("listeners.admin.lan", false) === true || ctx.value("listeners.public.lan", false) === true;
      if (!lan) return { status: "skip", detail: "LAN access is off, so no inbound firewall rule is needed.", data: { reason: "lan_off" } };
      if (ctx.platform !== "win32") return { status: "skip", detail: "The firewall check is Windows-only.", data: { reason: "unsupported_platform" } };
      const rules = await ctx.probe("firewall");
      const ports = [ctx.value("listeners.admin.lan", false) === true ? Number(ctx.value("listeners.admin.port", 5176)) : null, ctx.value("listeners.public.lan", false) === true ? Number(ctx.value("listeners.public.port", 5186)) : null].filter(Boolean);
      const covers = (port) => rules.some((rule) => /private|any|all|^-?\d+$/i.test(rule.profile || "Any") && /^(?:tcp|any|6)$/i.test(rule.protocol || "tcp") && String(rule.localPort).split(",").some((value) => value.trim() === String(port)))
        || rules.some((rule) => /(?:^|[\\/])node(?:\.exe)?$/i.test(rule.program || ""));
      const uncovered = ports.filter((port) => !covers(port));
      if (!uncovered.length) return { status: "ok", detail: "An inbound allow rule covers the LAN-facing ports.", data: { ports } };
      const port = uncovered[0];
      return { status: "warn", detail: `No enabled inbound rule allows TCP ${uncovered.join(", ")} on the Private profile.`, data: { ports, uncovered }, fix: manual("net.firewall", "手动添加防火墙入站规则（需管理员）", "Add the firewall rule manually (administrator)", { command: `New-NetFirewallRule -DisplayName "Local AI Platform ${port}" -Direction Inbound -Protocol TCP -LocalPort ${port} -Profile Private -Action Allow` }) };
    }),
    descriptor("net.manager-bind", "管理器监听地址", "Manager bind address", async () => {
      if (ctx.platform !== "win32") return { status: "skip", detail: "The bind check reads Windows listeners only.", data: { reason: "unsupported_platform" } };
      const listeners = await ctx.probe("listeners");
      const rows = MANAGERS.map((manager) => {
        const port = Number(ctx.value(`managers.${manager.id}.port`, manager.defaultPort));
        const configured = String(ctx.value(`managers.${manager.id}.host`, ctx.value("managers.bindHost", "127.0.0.1")));
        const addresses = listeners.filter((item) => item.port === port).map((item) => item.address);
        const wildcard = addresses.some(isWildcard);
        const state = !addresses.length ? "stopped" : wildcard && !isWildcard(configured) ? "stale-wildcard" : wildcard ? "chosen-wildcard" : "bound";
        return { manager: manager.id, componentId: manager.componentId, port, configuredHost: configured, addresses, state };
      });
      const stale = rows.filter((row) => row.state === "stale-wildcard"), chosen = rows.filter((row) => row.state === "chosen-wildcard");
      const fixes = stale.map((row) => ctx.fix("net.manager-bind", `restart:${row.componentId}`, "confirm", `重启 ${row.componentId}（空闲时）`, `Restart ${row.componentId} when idle`, "/docs/troubleshooting.md#network", { componentId: row.componentId, when: "idle" }));
      if (stale.length) return { status: "warn", detail: `${stale.map((row) => row.manager).join(", ")} listens on all interfaces although its configured host is ${stale[0].configuredHost}; this is usually a stale process from an old launcher.`, data: { managers: rows, fixes }, fix: fixes[0], actions: fixes.map((fix) => fix.id) };
      if (chosen.length) return { status: "info", detail: `${chosen.map((row) => row.manager).join(", ")} deliberately listens on all interfaces (managers.bindHost).`, data: { managers: rows } };
      if (rows.every((row) => row.state === "stopped")) return { status: "skip", detail: "Neither manager is listening.", data: { managers: rows, reason: "managers_stopped" } };
      return { status: "ok", detail: "Both managers listen only on their configured host.", data: { managers: rows } };
    }),
    descriptor("net.search-upstream", "搜索网关上游", "Search gateway upstream", async () => {
      const components = await ctx.probe("resolvedComponents");
      const component = components.find((item) => item.id === "search-gateway");
      if (!component || component.disabled) return { status: "skip", detail: "The search gateway is not part of this platform.", data: { reason: "component_absent" } };
      const names = await ctx.probe("secretNames").catch(() => []);
      const config = { get: (key) => ctx.value(key, SEARCH_DEFAULTS[key]) };
      const upstream = chooseUpstream({ config, component: { env: {} }, secrets: { has: (namespace, name) => (names || []).some((item) => item.namespace === namespace && item.name === name) } });
      if (!upstream) return { status: "warn", detail: "No search upstream is reachable from the search container; the gateway stays blocked (search-upstream-unreachable).", data: { source: null, reason: "search-upstream-unreachable" }, fix: manual("net.search-upstream", "配置搜索上游（search.upstreamBaseUrl）或启用公共监听器与上游密钥", "Set search.upstreamBaseUrl, or enable the public listener with an upstream key") };
      const data = { source: upstream.source, url: upstream.url };
      if (!ctx.deep) return { status: "ok", detail: `The search gateway will call the upstream chosen from ${upstream.source}.`, data };
      const target = new URL(upstream.url);
      const probe = await ctx.probe("searchUpstream", { host: CONTAINER_HOST, port: Number(target.port) || 80 });
      const detail = { ...data, container: probe };
      if (probe.reachable === true) return { status: "ok", detail: "The search container reaches the chosen upstream.", data: detail };
      if (probe.reachable === null) return { status: "info", detail: "The search container is not running, so reachability was not probed.", data: detail };
      return { status: "warn", detail: "The search container cannot reach the chosen upstream through host.docker.internal.", data: detail, fix: manual("net.search-upstream", "检查搜索上游监听地址与防火墙", "Check the upstream bind address and firewall") };
    }),
  ];
}

module.exports = { createChecks, isWildcard, isLoopback };
