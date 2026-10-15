const MODULES = [
  "./common-utils",
  "./single-flight-cache",
  "./sse-hub",
  "./network",
  "./connection-guide",
  "./compatibility-utils",
  "./health",
  "./secrets",
  "./secret-redactor",
  "./runtime-secret-store",
  "./gateway-trust",
  "./billing-client",
  "./billing-pending-queue",
  "./legacy-key-forwarder",
  "./gateway-utils",
  "./access-log",
  "./prometheus-utils",
  "./stats-utils",
  "./stats-ledger-store",
  "./metrics-history-store",
  "./benchmark-history-store",
  "./idle-unload",
  "./file-utils",
  "./docker-utils",
  "./docker-runtime",
  "./container-replacement",
  "./gpu-runtime",
  "./gpu-admission",
  "./gpu-guard",
  "./download-utils",
  "./download-checksums",
  "./download-precheck",
  "./download-resume-check",
  "./download-throughput",
  "./gguf-variants",
  "./precision-variants",
  "./remote-model-config",
  "./repo-mirrors",
  "./mirror-probe",
  "./proxy-fetch",
  "./download-job-controller",
  "./job-utils",
  "./jobs-ledger-store",
  "./ledger-scrub",
  "./process-job-runner",
  "./remote-model-utils",
  "./gguf-metadata",
  "./memory-estimator",
  "./claude-bridge",
  "./claude-compression",
  "./claude-routes",
  "./service-policy",
  "./service-exposure-store",
  "./service-clients-store",
  "./service-usage-store",
  "./service-policy-routes",
  "./job-routes",
  "./audit-store",
  "./audit-routes",
  "./tools-routes",
  "./benchmark-runner",
  "./manager-routes",
  "./operational-snapshot",
  "./manager-security",
  "./manager-lifecycle",
  "./process-exit-log",
  "./auth-failure-guard",
  "./settings-stores",
  "./manager-backup",
  "./model-routes",
  "./model-filesystem-store",
  "./model-storage",
  "./model-migration",
  "./model-storage-routes",
  "./runtime-routes",
  "./runtime-request-utils",
  "./runtime-control",
  "./runtime-instance-utils",
  "./runtime-wait",
  "./runtime-log-summary",
  "./integration-routes",
  "./reference-data",
  "./runtime-manifest",
  "./model-capability-matrix",
  "./openwebui-audit-exporter",
];

function mergeExports(moduleNames) {
  const merged = {};
  const owners = {};
  for (const moduleName of moduleNames) {
    const exports = require(moduleName);
    for (const [key, value] of Object.entries(exports)) {
      if (Object.hasOwn(merged, key) && merged[key] !== value) {
        process.emitWarning(
          `manager-core export "${key}" from ${moduleName} overrides ${owners[key]}.`,
          { code: "MANAGER_CORE_EXPORT_COLLISION" },
        );
      }
      merged[key] = value;
      owners[key] = moduleName;
    }
  }
  return merged;
}

module.exports = mergeExports(MODULES);
module.exports.MODULES = MODULES.slice();
module.exports.mergeExports = mergeExports;

// core.platform (06 §2.1, 00 §9.17): the ops modules as one namespace, loaded
// on first use so a manager that never reads platform config pays nothing.
// Each module is core.platform.<name>; config's functions (readSection,
// writeSection, loadPlatformConfig...), version's (getBuildId, readVersion,
// computeLiveDrift...) and the registry's (loadComponentRegistry,
// resolveComponent, startOrder...) are also on the namespace itself.
const PLATFORM_MODULES = Object.freeze({
  components: "./platform/components",
  config: "./platform/config",
  control: "./platform/control",
  doctor: "./platform/doctor",
  doctorCli: "./platform/doctor-cli",
  doctorFix: "./platform/doctor-fix",
  entryClient: "./platform/entry-client",
  idle: "./platform/idle",
  launcher: "./platform/launcher",
  logs: "./platform/logs",
  messages: "./platform/messages",
  schedules: "./platform/schedules",
  semver: "./platform/semver",
  status: "./platform/status",
  supervisor: "./platform/supervisor",
  version: "./platform/version",
  winproc: "./platform/winproc",
});
let platformNamespace = null;

function loadPlatformNamespace() {
  if (platformNamespace) return platformNamespace;
  const namespace = { ...require(PLATFORM_MODULES.config), ...require(PLATFORM_MODULES.version), ...require(PLATFORM_MODULES.components) };
  for (const [name, file] of Object.entries(PLATFORM_MODULES)) {
    Object.defineProperty(namespace, name, { enumerable: true, get: () => require(file) });
  }
  platformNamespace = Object.freeze(namespace);
  return platformNamespace;
}

Object.defineProperty(module.exports, "platform", { enumerable: true, configurable: true, get: loadPlatformNamespace });

// Internal auth is a namespace, not flat names (00 §9.17): callers use
// core.internalAuth.createInternalClient(...) or require("./internal-auth").
module.exports.internalAuth = require("./internal-auth");
// New subsystems are namespaces, never spread into the flat list (00 §9.17).
module.exports.engines = require("./engines");
// core.telemetry (04 §3): the telemetry pieces that run inside the managers.
// The stats sampler's functions are on the namespace itself
// (core.telemetry.createStatsSampler, applyStatsWindows...) and its module is
// core.telemetry.statsSampler.
const statsSampler = require("./telemetry/collectors/manager-stats-sampler");
module.exports.telemetry = Object.freeze({ ...statsSampler, statsSampler });
// The single secret store (06 OPS-3b); runtime-secret-store.js stays flat as its facade.
module.exports.secrets = require("./secret-store");
// The ModelCard v1 local inspector (02 MOD-3); a namespace like engines and secrets.
module.exports.models = require("./model-inspector");
// Manager routes of the model inspector (02 MOD-5, GET /api/knowledge/status). It is
// registered by name instead of through MODULES, which must not list model-inspector files.
module.exports.registerModelInspectorRoutes = require("./model-inspector-routes").registerModelInspectorRoutes;
