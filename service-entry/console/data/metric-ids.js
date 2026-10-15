// Metric ids of GET /api/telemetry/timeseries (04 §11.1, `query.js METRICS`),
// grouped by family. The console never invents an id: charts, URLs and the
// i18n gate all read this list. Labels live in the telemetry area as
// `obs.metric.<id>` (04 §19.1); metricLabelKey() only builds the key, so the
// i18n gate's literal scan does not see a lookup here.

const FAMILIES = {
  req: [
    "req.count", "req.rate_per_min", "req.error_rate", "req.errors", "req.client_abort_rate",
    "tok.prompt", "tok.cached", "tok.output", "tok.output_per_s", "tok.cached_share",
    "lat.ttft_p50", "lat.ttft_p95", "lat.ttft_p99",
    "lat.duration_p50", "lat.duration_p95", "lat.duration_p99",
    "lat.decode_tps_p50", "lat.decode_tps_p10",
    "req.length_share", "usage.estimated_share", "lat.ttft_hist",
  ],
  rt: [
    "rt.prompt_tps", "rt.output_tps", "rt.rpm", "rt.running", "rt.running_max", "rt.waiting", "rt.waiting_max",
    "rt.kv_usage", "rt.kv_usage_max", "rt.prefix_hit", "rt.spec_accept",
    "rt.ttft_p50", "rt.ttft_p95", "rt.ttft_p99", "rt.e2e_p50", "rt.e2e_p95", "rt.itl_p50", "rt.itl_p95",
    "rt.tpot_p50", "rt.queue_p95", "rt.idle_share",
  ],
  gpu: [
    "gpu.util", "gpu.util_max", "gpu.mem_used_mb", "gpu.mem_used_pct", "gpu.temp_c", "gpu.temp_max",
    "gpu.power_w", "gpu.power_ratio", "gpu.sm_clock_mhz", "gpu.throttle_seconds", "gpu.energy_wh", "energy.cost",
  ],
};

export const METRIC_FAMILIES = Object.freeze(Object.fromEntries(Object.entries(FAMILIES).map(([name, ids]) => [name, Object.freeze([...ids])])));
export const METRIC_IDS = Object.freeze(Object.values(FAMILIES).flat());

/** The request limit of one timeseries call (04 §11.1: `metrics=a,b` ≤ 6). */
export const MAX_METRICS_PER_QUERY = 6;
/** Metrics whose points are histograms, not numbers (a heatmap, not a line). */
export const HISTOGRAM_METRICS = Object.freeze(["lat.ttft_hist"]);

const KNOWN = new Set(METRIC_IDS);

export function isMetricId(id) {
  return KNOWN.has(id);
}

/** "req", "rt" or "gpu" for a known id; null otherwise. */
export function metricFamily(id) {
  for (const [name, ids] of Object.entries(FAMILIES)) if (ids.includes(id)) return name;
  return null;
}

/** The catalog key of a metric's label (telemetry area, 04 §19.1). */
export function metricLabelKey(id) {
  return `obs.metric.${id}`;
}
