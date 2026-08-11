(function () {
  function fmtBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = Number(bytes || 0);
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  function fmtNumber(value) {
    const number = Number(value || 0);
    if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
    if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
    return String(number);
  }

  function fmtPct(value) {
    const number = Number(value || 0);
    return `${(number * 100).toFixed(number >= 0.1 ? 1 : 2)}%`;
  }

  function fmtRate(value, suffix = "/s") {
    const number = Number(value || 0);
    return `${number.toFixed(number >= 10 ? 1 : 2)}${suffix}`;
  }

  function fmtMoney(value) {
    return `$${Number(value || 0).toFixed(value >= 10 ? 2 : 4)}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replaceAll("`", "&#096;");
  }

  window.VllmFormat = {
    fmtBytes,
    fmtNumber,
    fmtTokens: (value) => fmtNumber(Math.round(Number(value || 0))),
    fmtPct,
    fmtRate,
    fmtMoney,
    escapeHtml,
    escapeAttr,
  };
})();
