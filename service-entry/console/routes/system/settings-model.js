// /system/settings model (06 §4.6, §10.2; 07 §4.5 config mode): the pure half
// of the settings page.
//
// GET /api/platform/config answers describeEffectiveConfig(): {etag, groups:
// [{id, title, items}], errors, warnings, overrideErrors}. An item is {key,
// type, enum?, source, envNames, restartRequired, title, description, value,
// default} and a secret leaf has {secret: {set, source}} instead of a value.
// The functions below turn that into the catalog and plan SchemaForm draws in
// `config` mode, and the form's edits into the PUT body (only changed leaves;
// secrets in their own map and never echoed). Nothing here touches the DOM,
// the cache or the network.

import { sameValue } from "../../lib/schema-form-model.js";

/** 06 §4.4: where a leaf's effective value comes from. A source outside the list shows no badge. */
export const SOURCES = Object.freeze(["env", "file", "default", "derived", "runtime"]);

const ALL_COMPONENTS = "*";
const RUNNING = new Set(["ready", "unhealthy", "backoff", "starting"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A source the catalog has a badge for, else null. */
export function knownSource(source) {
  return SOURCES.includes(source) ? source : null;
}

/** SchemaForm's type name for a config leaf's JSON-schema type (`["integer","null"]` is an int that may be cleared). */
export function paramType(item) {
  if (item?.secret) return "string";
  if (Array.isArray(item?.enum) && item.enum.length) return "enum";
  const kinds = [].concat(item?.type ?? []).filter((kind) => kind !== "null");
  switch (kinds[0]) {
    case "boolean": return "bool";
    case "integer": return "int";
    case "number": return "float";
    case "array": return "list";
    case "object": return "json";
    default: return "string";
  }
}

/** The leaves of a description, flat, in group order. */
export function itemsOf(description) {
  const groups = Array.isArray(description?.groups) ? description.groups : [];
  return groups.flatMap((group) => (Array.isArray(group?.items) ? group.items.filter((item) => isPlainObject(item) && typeof item.key === "string") : []));
}

/** key -> item. */
export function indexOf(description) {
  return new Map(itemsOf(description).map((item) => [item.key, item]));
}

/** SchemaForm's catalog over a config description. Every leaf is "basic": the page shows them all and searches. */
export function buildCatalog(description) {
  const groups = Array.isArray(description?.groups) ? description.groups : [];
  const params = [];
  for (const group of groups) {
    for (const item of Array.isArray(group?.items) ? group.items : []) {
      if (!isPlainObject(item) || typeof item.key !== "string") continue;
      params.push({
        id: item.key,
        group: group.id,
        type: paramType(item),
        label: item.title,
        summary: item.description,
        level: "basic",
        flag: item.key,
        secret: Boolean(item.secret),
        set: item.secret ? item.secret.set === true : undefined,
        choices: Array.isArray(item.enum) ? item.enum.slice() : undefined,
      });
    }
  }
  return { engineId: "platform", groups: groups.map((group) => ({ id: group.id, label: group.title })), params };
}

/** SchemaForm's plan: every leaf's effective value and where it came from. */
export function buildPlan(description) {
  const values = {};
  for (const item of itemsOf(description)) {
    const source = knownSource(item.secret ? item.secret.source : item.source);
    values[item.key] = { value: item.secret ? null : item.value ?? null, source };
  }
  return { values, errors: [], warnings: [] };
}

/** The saved values SchemaForm shows in its controls: every non-secret leaf that has one. */
export function currentValues(description) {
  const out = {};
  for (const item of itemsOf(description)) if (!item.secret && item.value !== null && item.value !== undefined) out[item.key] = item.value;
  return out;
}

/**
 * The values the form shows: the saved ones, with the person's edits on top.
 * An edit is a new value, a secret's new text (or null for Clear), or null on
 * a plain leaf for "use the default".
 */
export function overlayValues(description, edits = {}) {
  return { ...currentValues(description), ...edits };
}

/**
 * What a Save sends. A plain leaf whose edit equals the saved value is not a
 * change. A null edit on a leaf set in the config file unsets it (back to the
 * default); on a leaf set anywhere else there is nothing to unset.
 * @returns {{ set, unset, secrets, count, body }} body is the PUT body, or null when nothing changed
 */
export function collectChanges(description, edits = {}) {
  const index = indexOf(description);
  const set = {};
  const secrets = {};
  const unset = [];
  for (const [key, value] of Object.entries(edits)) {
    const item = index.get(key);
    if (!item) continue;
    if (item.secret) {
      if (value === null) secrets[key] = null;
      else if (typeof value === "string" && value) secrets[key] = value;
    } else if (value === null) {
      if (item.source === "file") unset.push(key);
    } else if (!sameValue(value, item.value)) {
      set[key] = value;
    }
  }
  const count = Object.keys(set).length + unset.length + Object.keys(secrets).length;
  const body = {
    ...(Object.keys(set).length ? { set } : {}),
    ...(unset.length ? { unset } : {}),
    ...(Object.keys(secrets).length ? { secrets } : {}),
  };
  return { set, unset, secrets, count, body: count ? body : null };
}

/** A value as the DiffTable shows it. */
export function displayValue(value) {
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) return value.join(", ");
  if (isPlainObject(value)) return JSON.stringify(value);
  return String(value);
}

/**
 * The rows of the conflict view after a 409 config_conflict: each leaf the
 * person edited (current value on disk -> their edit) and each leaf someone
 * else changed since the page loaded (old -> new).
 * @param mine the leaves being saved ({set, unset})
 * @param base the description the form was built from
 * @param fresh the description reloaded after the conflict
 */
export function conflictRows(mine, base, fresh, { pick = (value) => value, mineLabel = "", theirsLabel = "" } = {}) {
  const before = indexOf(base);
  const now = indexOf(fresh);
  const label = (item, key) => (isPlainObject(item?.title) ? pick(item.title) : "") || key;
  const rows = [];
  for (const [key, value] of Object.entries(mine.set || {})) {
    const item = now.get(key);
    rows.push({ key, label: label(item, key), from: displayValue(item?.value), to: displayValue(value), source: mineLabel });
  }
  for (const key of mine.unset || []) {
    const item = now.get(key);
    rows.push({ key, label: label(item, key), from: displayValue(item?.value), to: displayValue(item?.default), source: mineLabel });
  }
  for (const [key, item] of now) {
    const old = before.get(key);
    if (!old || item.secret || sameValue(old.value, item.value)) continue;
    if (Object.hasOwn(mine.set || {}, key)) continue;
    rows.push({ key, label: label(item, key), from: displayValue(old.value), to: displayValue(item.value), source: theirsLabel });
  }
  return rows;
}

/** The component ids to restart for a list of `restartRequired` ids: "*" means every running component. */
export function expandRestart(ids, runningIds = []) {
  const out = new Set();
  for (const id of ids || []) {
    if (id === ALL_COMPONENTS) {
      for (const running of runningIds.length ? runningIds : ["entry"]) out.add(running);
    } else if (typeof id === "string" && id) {
      out.add(id);
    }
  }
  return [...out];
}

/** Ids of the platform-status rows that are up. */
export function runningIds(rows) {
  return (rows || []).filter((row) => RUNNING.has(row.state)).map((row) => row.id);
}

/** Merges component ids into a pending list, keeping the order they arrived in. */
export function mergePending(current, ids) {
  return [...new Set([...(current || []), ...(ids || [])])];
}
