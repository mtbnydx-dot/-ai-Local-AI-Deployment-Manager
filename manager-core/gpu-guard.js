"use strict";
// GPU temperature and power-wall guard shared by both managers.
//
// Warn-only by design: the managers create an automation job with the finding
// so it shows up in the job list and can trigger the download-complete
// notification channel, but nothing is throttled or unloaded automatically.
// Each finding kind has its own cooldown so a hot card does not hide a card
// that is pinned at its power limit.

const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_POWER_LIMIT_PCT = 97;

function cooledDown(lastAt, now, cooldownMs) {
  return !Number.isFinite(lastAt) || now - lastAt >= cooldownMs;
}

function evaluateGpuGuards(gpu, settings = {}, state = {}, now = Date.now()) {
  const findings = [];
  const gpus = Array.isArray(gpu?.gpus) ? gpu.gpus : [];
  if (!gpus.length) return findings;
  const cooldownMs = Number(settings.guardCooldownMs) > 0 ? Number(settings.guardCooldownMs) : DEFAULT_COOLDOWN_MS;

  if (settings.tempGuardEnabled) {
    const temps = gpus.map((item) => Number(item.temp)).filter(Number.isFinite);
    const limitC = Number(settings.tempLimitC);
    if (temps.length && Number.isFinite(limitC)) {
      const hottest = Math.max(...temps);
      if (hottest >= limitC && cooledDown(state.lastTempWarnAt, now, cooldownMs)) {
        state.lastTempWarnAt = now;
        findings.push({
          kind: "temperature",
          title: "GPU temperature warning",
          data: { tempC: hottest, limitC },
          message: `GPU 温度 ${hottest}°C 已达到告警阈值 ${limitC}°C。请检查散热、降低功耗上限或减小并发。`,
        });
      }
    }
  }

  const powerEnabled = settings.powerGuardEnabled ?? settings.tempGuardEnabled;
  if (powerEnabled) {
    const pct = Number(settings.powerLimitPct) > 0 ? Number(settings.powerLimitPct) : DEFAULT_POWER_LIMIT_PCT;
    const pinned = gpus
      .filter((item) => Number.isFinite(Number(item.powerWatts)) && Number(item.powerLimitWatts) > 0)
      .map((item) => ({ id: item.id ?? item.index, watts: Number(item.powerWatts), limit: Number(item.powerLimitWatts), ratio: Number(item.powerWatts) / Number(item.powerLimitWatts) }))
      .filter((item) => item.ratio * 100 >= pct);
    if (pinned.length && cooledDown(state.lastPowerWarnAt, now, cooldownMs)) {
      state.lastPowerWarnAt = now;
      const worst = pinned.sort((a, b) => b.ratio - a.ratio)[0];
      findings.push({
        kind: "power",
        title: "GPU power limit warning",
        data: { gpu: String(worst.id), powerWatts: worst.watts, powerLimitWatts: worst.limit, percent: Math.round(worst.ratio * 100), thresholdPct: pct },
        message: `GPU ${worst.id} 功耗 ${Math.round(worst.watts)}W 已达到功耗墙 ${Math.round(worst.limit)}W 的 ${Math.round(worst.ratio * 100)}%。持续贴着功耗墙运行会触发降频，建议降低并发、限制 max_num_seqs 或用 nvidia-smi -pl 设置更低的功耗上限。`,
      });
    }
  }
  return findings;
}

module.exports = {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_POWER_LIMIT_PCT,
  evaluateGpuGuards,
};
