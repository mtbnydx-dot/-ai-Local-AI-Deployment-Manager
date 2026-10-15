// The pure part of Observability › Settings (04 §20, §11.7): which fields the
// form edits, how the loaded settings become a draft, how a draft becomes the
// partial patch of `PUT /api/telemetry/settings` (only what changed), and how
// the writer's `errors[]` map back to fields. Nothing here touches the DOM.

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The edited fields: path (also the catalog key suffix `obs.set.<path>`), kind, unit and the range the writer enforces. */
export const SETTING_FIELDS = Object.freeze([
  Object.freeze({ path: "enabled", kind: "bool", restart: true }),
  Object.freeze({ path: "sampleIntervalMs", kind: "int", min: 5000, max: 60000, unit: "ms" }),
  Object.freeze({ path: "timezoneOffsetMinutes", kind: "int", min: -720, max: 840, step: 60, unit: "min" }),
  Object.freeze({ path: "keepJsonlAccessLog", kind: "bool" }),
  Object.freeze({ path: "maxDbMb", kind: "int", min: 256, max: 65536, unit: "MB" }),
  Object.freeze({ path: "exportMaxRows", kind: "int", min: 1000, max: 1000000 }),
  Object.freeze({ path: "retention.requestsDays", kind: "int", min: 1, unit: "d" }),
  Object.freeze({ path: "retention.ipDays", kind: "int", min: 0, unit: "d" }),
  Object.freeze({ path: "retention.samplesHours", kind: "int", min: 1, unit: "h" }),
  Object.freeze({ path: "retention.minuteDays", kind: "int", min: 1, unit: "d" }),
  Object.freeze({ path: "retention.hourDays", kind: "int", min: 1, max: 400, unit: "d" }),
  Object.freeze({ path: "retention.eventsDays", kind: "int", min: 1, max: 400, unit: "d" }),
  Object.freeze({ path: "energy.pricePerKwh", kind: "price" }),
  Object.freeze({ path: "energy.currency", kind: "currency" }),
  Object.freeze({ path: "energy.hostBaselineWatts", kind: "int", min: 0, max: 2000, unit: "W" }),
]);

export const SETTING_GROUPS = Object.freeze([
  Object.freeze({ id: "sampling", paths: ["enabled", "sampleIntervalMs", "timezoneOffsetMinutes", "keepJsonlAccessLog"] }),
  Object.freeze({ id: "retention", paths: ["retention.requestsDays", "retention.ipDays", "retention.samplesHours", "retention.minuteDays", "retention.hourDays", "retention.eventsDays", "maxDbMb", "exportMaxRows"] }),
  Object.freeze({ id: "energy", paths: ["energy.pricePerKwh", "energy.currency", "energy.hostBaselineWatts"] }),
]);

/** The telemetry import sources of 04 §18 (the ids POST /api/telemetry/import accepts). */
export const IMPORT_SOURCES = Object.freeze(["metrics-history", "stats-ledger", "access-logs", "service-usage", "jobs-ledger", "process-exit", "audit-manifests", "benchmarks", "mcp-audit"]);

function read(source, path) {
  return path.split(".").reduce((value, name) => (isObject(value) ? value[name] : undefined), source);
}

function text(value) {
  return value === null || value === undefined ? "" : String(value);
}

/** The form state of loaded settings: every field as text (a checkbox as boolean), tariffs as rows of text. */
export function settingsDraft(settings) {
  const draft = { tariffs: [] };
  for (const field of SETTING_FIELDS) {
    const value = read(settings, field.path);
    draft[field.path] = field.kind === "bool" ? Boolean(value) : text(value);
  }
  const tariffs = Array.isArray(settings?.energy?.tariffs) ? settings.energy.tariffs : [];
  draft.tariffs = tariffs.filter(isObject).map((row) => ({ from: text(row.from), to: text(row.to), pricePerKwh: text(row.pricePerKwh) }));
  return draft;
}

function number(textValue) {
  const value = String(textValue ?? "").trim();
  if (!value || !/^-?\d+(\.\d+)?$/.test(value)) return null;
  return Number(value);
}

function sameTariffs(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The partial patch of a draft against the settings it was made from.
 * @returns {{ patch: object, errors: Record<string, string>, changed: boolean }}
 *   errors maps a field path (or `energy.tariffs[i].from|to|pricePerKwh`) to a
 *   code: required, invalid, range, time, order. A draft with errors has no patch worth sending.
 */
export function settingsPatch(settings, draft) {
  const patch = {};
  const errors = {};
  const put = (path, value) => {
    const names = path.split(".");
    let target = patch;
    for (const name of names.slice(0, -1)) {
      target[name] = isObject(target[name]) ? target[name] : {};
      target = target[name];
    }
    target[names[names.length - 1]] = value;
  };

  for (const field of SETTING_FIELDS) {
    const before = read(settings, field.path);
    const raw = draft[field.path];
    if (field.kind === "bool") {
      if (Boolean(raw) !== Boolean(before)) put(field.path, Boolean(raw));
      continue;
    }
    if (field.kind === "currency") {
      const value = String(raw ?? "").trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(value)) errors[field.path] = "invalid";
      else if (value !== before) put(field.path, value);
      continue;
    }
    const value = number(raw);
    if (field.kind === "price") {
      if (String(raw ?? "").trim() === "") {
        if (before !== null && before !== undefined) put(field.path, null);
      } else if (value === null || value < 0) {
        errors[field.path] = "invalid";
      } else if (value !== before) {
        put(field.path, value);
      }
      continue;
    }
    if (String(raw ?? "").trim() === "") {
      errors[field.path] = "required";
    } else if (value === null || !Number.isInteger(value)) {
      errors[field.path] = "invalid";
    } else if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
      errors[field.path] = "range";
    } else if (value !== before) {
      put(field.path, value);
    }
  }

  const retentionNow = { ...(isObject(settings?.retention) ? settings.retention : {}) };
  for (const name of Object.keys(isObject(patch.retention) ? patch.retention : {})) retentionNow[name] = patch.retention[name];
  if (!errors["retention.ipDays"] && !errors["retention.requestsDays"] && Number(retentionNow.ipDays) > Number(retentionNow.requestsDays)) errors["retention.ipDays"] = "order";

  const rows = [];
  (draft.tariffs || []).forEach((row, index) => {
    const price = number(row.pricePerKwh);
    if (!TIME.test(String(row.from).trim())) errors[`energy.tariffs[${index}].from`] = "time";
    if (!TIME.test(String(row.to).trim())) errors[`energy.tariffs[${index}].to`] = "time";
    if (price === null || price < 0) errors[`energy.tariffs[${index}].pricePerKwh`] = "invalid";
    rows.push({ from: String(row.from).trim(), to: String(row.to).trim(), pricePerKwh: price });
  });
  const before = Array.isArray(settings?.energy?.tariffs) ? settings.energy.tariffs.map((row) => ({ from: row.from, to: row.to, pricePerKwh: row.pricePerKwh })) : [];
  if (!sameTariffs(rows, before)) put("energy.tariffs", rows);

  return { patch, errors, changed: Object.keys(patch).length > 0 };
}

/** Whether a patch asks for an energy price: tariffs or a price. */
export function hasPrice(settings) {
  const energy = settings?.energy;
  return Boolean(energy && ((energy.pricePerKwh !== null && energy.pricePerKwh !== undefined) || (Array.isArray(energy.tariffs) && energy.tariffs.length)));
}

/** The writer's `errors[]` (400 invalid_request) as `{ path: code }`; unmatched ones keep their text. */
export function serverFieldErrors(errors) {
  const byPath = {};
  const other = [];
  for (const item of Array.isArray(errors) ? errors : []) {
    if (!isObject(item)) continue;
    const field = typeof item.field === "string" ? item.field : "";
    const known = field && (SETTING_FIELDS.some((entry) => entry.path === field) || /^energy\.tariffs\[\d+\]\.(from|to|pricePerKwh)$/.test(field));
    if (known) byPath[field] = typeof item.code === "string" ? item.code : "invalid";
    else other.push({ field, code: typeof item.code === "string" ? item.code : "invalid", message: typeof item.message === "string" ? item.message : "" });
  }
  return { byPath, other };
}

/** The sources of a run request: the selected ones in the importer's order. */
export function selectedSources(selection) {
  return IMPORT_SOURCES.filter((id) => selection?.[id]);
}

/** Whether a live import may start: the last dry run finished for exactly these sources. */
export function importAllowed(dryRun, sources) {
  if (!dryRun || dryRun.state !== "done" || !Array.isArray(dryRun.sources)) return false;
  return JSON.stringify([...dryRun.sources].sort()) === JSON.stringify([...sources].sort()) && sources.length > 0;
}
