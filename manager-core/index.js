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
// Internal auth is a namespace, not flat names (00 §9.17): callers use
// core.internalAuth.createInternalClient(...) or require("./internal-auth").
module.exports.internalAuth = require("./internal-auth");
