function parsePrometheusMetrics(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const match = line.match(/^([^\s{]+)(?:\{([^}]*)\})?\s+([-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?|NaN|\+Inf|-Inf)/i);
      if (!match) return null;
      return {
        name: match[1],
        labels: parsePrometheusLabels(match[2] || ""),
        value: Number(match[3]),
      };
    })
    .filter((metric) => metric && Number.isFinite(metric.value));
}

function parsePrometheusLabels(text) {
  const labels = {};
  const regex = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g;
  let match;
  while ((match = regex.exec(text))) {
    labels[match[1]] = match[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return labels;
}

function firstMetricValue(metrics, name, predicate = null) {
  const item = metrics.find((metric) => metric.name === name && (!predicate || predicate(metric)));
  return item ? item.value : null;
}

function sumMetric(metrics, name, predicate = null) {
  return metrics
    .filter((metric) => metric.name === name && (!predicate || predicate(metric)))
    .reduce((sum, metric) => sum + metric.value, 0);
}

function sumByLabel(metrics, name, label) {
  const result = {};
  for (const metric of metrics) {
    if (metric.name !== name) continue;
    const key = metric.labels[label] || "unknown";
    result[key] = (result[key] || 0) + metric.value;
  }
  return result;
}

function histogramAverage(metrics, baseName) {
  const sum = sumMetric(metrics, `${baseName}_sum`);
  const count = sumMetric(metrics, `${baseName}_count`);
  return count ? sum / count : null;
}

function tokensPerSecondFromSeconds(secondsPerToken) {
  return secondsPerToken ? 1 / secondsPerToken : 0;
}

function weightedAverage(items, valueFn, weightFn) {
  let total = 0;
  let weight = 0;
  for (const item of items) {
    const value = valueFn(item);
    const itemWeight = weightFn(item);
    if (value === null || value === undefined || !itemWeight) continue;
    total += value * itemWeight;
    weight += itemWeight;
  }
  return weight ? total / weight : null;
}

module.exports = {
  parsePrometheusMetrics,
  parsePrometheusLabels,
  firstMetricValue,
  sumMetric,
  sumByLabel,
  histogramAverage,
  tokensPerSecondFromSeconds,
  weightedAverage,
};
