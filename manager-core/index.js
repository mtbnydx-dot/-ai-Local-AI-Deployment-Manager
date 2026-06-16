const MODULES = [
  "./common-utils",
  "./network",
  "./connection-guide",
  "./compatibility-utils",
  "./health",
  "./secrets",
  "./gateway-utils",
  "./access-log",
  "./prometheus-utils",
  "./stats-utils",
  "./stats-ledger-store",
  "./file-utils",
  "./docker-utils",
  "./docker-runtime",
  "./gpu-runtime",
  "./download-utils",
  "./download-job-controller",
  "./job-utils",
  "./jobs-ledger-store",
  "./process-job-runner",
  "./remote-model-utils",
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
  "./manager-security",
  "./manager-lifecycle",
  "./settings-stores",
  "./model-routes",
  "./model-filesystem-store",
  "./runtime-routes",
  "./runtime-request-utils",
  "./runtime-control",
  "./runtime-wait",
  "./runtime-log-summary",
  "./integration-routes",
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
