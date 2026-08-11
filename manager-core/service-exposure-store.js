const {
  normalizeCsvList,
  normalizeExposureMode,
  normalizeServiceExposureSecret,
  normalizeServiceExposureSettings,
  normalizeUrlText,
  redactServiceExposureSettings,
} = require("./service-policy");

function createServiceExposureSettingsStore(options = {}) {
  const file = options.file;
  const readJsonFile = options.readJsonFile;
  const writeJsonFile = options.writeJsonFile;
  const normalizeOptions = options.normalizeOptions || {};
  let cache = null;

  async function getServiceExposureSettings() {
    if (cache) return cache;
    const raw = await readJsonFile(file, {});
    cache = normalize(raw);
    if (raw && typeof raw === "object" && raw.apiKey) {
      await writeJsonFile(file, cache).catch(() => {});
    }
    return cache;
  }

  async function saveServiceExposureSettings(value = {}, previous = {}) {
    cache = normalize(value, previous);
    await writeJsonFile(file, cache);
    return cache;
  }

  function normalize(value = {}, previous = {}) {
    return normalizeServiceExposureSettings(value, previous, normalizeOptions);
  }

  return {
    getServiceExposureSettings,
    saveServiceExposureSettings,
    normalizeServiceExposureSettings: normalize,
    normalizeServiceExposureSecret,
    normalizeExposureMode,
    normalizeCsvList,
    normalizeUrlText,
    redactServiceExposureSettings,
  };
}

module.exports = {
  createServiceExposureSettingsStore,
};
