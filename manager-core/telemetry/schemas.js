"use strict";

// Response validators for the telemetry API (docs/overhaul/04-telemetry.md
// §11). They are deliberately light: every documented field must be there
// with the documented type, and unknown extra fields are allowed so a later
// package can add one without breaking the fixtures. The route tests check
// real answers against them, and TEL-19 checks the console fixtures with the
// same functions, so a stub cannot drift from the API.
//
//   validate("summary", body) -> { ok, errors: ["current.requests: expected an integer"] }
//   assertValid("summary", body)   throws a TypeError listing the first errors
//
// TEL-13 and TEL-19 add the alert and audit shapes next to these.

// --- a tiny combinator set ----------------------------------------------------

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

const string = (path, value) => (typeof value === "string" ? [] : [`${path}: expected a string, got ${describe(value)}`]);
const number = (path, value) => (typeof value === "number" && Number.isFinite(value) ? [] : [`${path}: expected a number, got ${describe(value)}`]);
const integer = (path, value) => (Number.isInteger(value) ? [] : [`${path}: expected an integer, got ${describe(value)}`]);
const boolean = (path, value) => (typeof value === "boolean" ? [] : [`${path}: expected a boolean, got ${describe(value)}`]);
const iso = (path, value) => (typeof value === "string" && ISO.test(value) ? [] : [`${path}: expected an ISO 8601 UTC time, got ${describe(value)}`]);
const decimal = (path, value) => (typeof value === "string" && /^-?\d+$/.test(value) ? [] : [`${path}: expected a decimal string`]);
const any = () => [];

function nullable(check) {
  return (path, value) => (value === null ? [] : check(path, value));
}

function optional(check) {
  return { check, optional: true };
}

function oneOf(...values) {
  return (path, value) => (values.includes(value) ? [] : [`${path}: expected one of ${values.join(", ")}`]);
}

function arrayOf(check, { max } = {}) {
  return (path, value) => {
    if (!Array.isArray(value)) return [`${path}: expected an array, got ${describe(value)}`];
    const errors = [];
    if (max !== undefined && value.length > max) errors.push(`${path}: expected at most ${max} items, got ${value.length}`);
    value.slice(0, 50).forEach((item, index) => errors.push(...check(`${path}[${index}]`, item)));
    return errors;
  };
}

function object(shape) {
  return (path, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path}: expected an object, got ${describe(value)}`];
    const errors = [];
    for (const [key, spec] of Object.entries(shape)) {
      const check = typeof spec === "function" ? spec : spec.check;
      const isOptional = typeof spec !== "function" && spec.optional;
      if (!(key in value) || value[key] === undefined) {
        if (!isOptional) errors.push(`${path ? `${path}.` : ""}${key}: is missing`);
        continue;
      }
      errors.push(...check(path ? `${path}.${key}` : key, value[key]));
    }
    return errors;
  };
}

function record(check) {
  return (path, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path}: expected an object, got ${describe(value)}`];
    return Object.entries(value).flatMap(([key, item]) => check(`${path}.${key}`, item));
  };
}

const numberOrNull = nullable(number);
const isoOrNull = nullable(iso);
const stringOrNull = nullable(string);
const localized = object({ zh: string, en: string });

// --- shapes -------------------------------------------------------------------

const live = object({
  ok: boolean,
  at: iso,
  windowSeconds: integer,
  gateway: object({
    inflight: integer,
    requestsPerMin: number,
    outputTokensPerSec: number,
    errorRate5m: numberOrNull,
    ttftP95Ms5m: numberOrNull,
    clientAborts5m: integer,
  }),
  instances: arrayOf(object({
    fleetId: string,
    engineId: stringOrNull,
    model: stringOrNull,
    state: string,
    idle: nullable(boolean),
    running: numberOrNull,
    waiting: numberOrNull,
    kvUsage: numberOrNull,
    outputTps: numberOrNull,
    vramReservationMb: numberOrNull,
    sampleAt: isoOrNull,
  })),
  gpus: arrayOf(object({
    index: integer,
    util: numberOrNull,
    memUsedMb: numberOrNull,
    memTotalMb: numberOrNull,
    tempC: numberOrNull,
    powerW: numberOrNull,
    powerLimitW: numberOrNull,
    throttle: arrayOf(string),
  })),
  alerts: object({ firing: integer, critical: integer }),
  collectors: object({ recorder: string, runtime: string, gpu: string, events: string, store: string }),
});

const summaryPeriod = object({
  requests: integer,
  errorRate: numberOrNull,
  clientAbortRate: numberOrNull,
  ttftP95Ms: numberOrNull,
  durationP95Ms: numberOrNull,
  decodeTpsP50: numberOrNull,
  promptTokens: number,
  cachedTokens: number,
  outputTokens: number,
  activeKeys: optional(integer),
  gpuUtilAvg: numberOrNull,
  vramPeakMb: numberOrNull,
  energyKwh: numberOrNull,
  energyCost: numberOrNull,
  currency: string,
  billedMicrocredits: optional(nullable(decimal)),
});

const summary = object({
  ok: boolean,
  from: iso,
  to: iso,
  current: summaryPeriod,
  previous: optional(summaryPeriod),
  coverage: numberOrNull,
  source: string,
  viewer: optional(boolean),
});

const point = (path, value) => {
  if (!Array.isArray(value) || value.length !== 2) return [`${path}: expected a [time, value] pair`];
  const errors = integer(`${path}[0]`, value[0]);
  const second = value[1];
  if (second !== null && typeof second !== "number" && !Array.isArray(second)) errors.push(`${path}[1]: expected a number, null or a bucket array`);
  return errors;
};

const timeseries = object({
  ok: boolean,
  from: iso,
  to: iso,
  step: integer,
  source: string,
  tzOffsetMinutes: integer,
  series: arrayOf(object({
    metric: string,
    unit: string,
    group: record(any),
    points: arrayOf(point, { max: 600 }),
  })),
  annotations: arrayOf(object({
    at: number,
    type: string,
    title: string,
    fleetId: optional(stringOrNull),
    eventId: optional(integer),
  })),
  otherGroups: integer,
  le: optional(arrayOf(any)),
});

const breakdown = object({
  ok: boolean,
  dim: string,
  rows: arrayOf(object({
    key: string,
    label: localized,
    requests: integer,
    share: number,
    firstSeen: isoOrNull,
    lastSeen: isoOrNull,
    sampleRequestIds: optional(arrayOf(string)),
    spark: optional(arrayOf(number)),
  })),
  total: object({ requests: integer }),
});

const requestRow = object({
  id: integer,
  requestId: string,
  clientRequestId: stringOrNull,
  managerRequestId: stringOrNull,
  ingress: string,
  receivedAt: iso,
  endedAt: iso,
  managerId: stringOrNull,
  fleetId: stringOrNull,
  engineId: stringOrNull,
  runtimeId: stringOrNull,
  launchId: stringOrNull,
  protocol: string,
  op: string,
  route: stringOrNull,
  method: string,
  path: string,
  modelRequested: stringOrNull,
  modelResolved: stringOrNull,
  stream: boolean,
  keyId: stringOrNull,
  customerId: stringOrNull,
  sourceProgram: string,
  status: integer,
  terminalState: oneOf("completed", "failed", "client_abort", "timeout", "rejected"),
  errorClass: string,
  errorCode: stringOrNull,
  durationMs: number,
  ttftMs: numberOrNull,
  decodeTps: numberOrNull,
  promptTokens: numberOrNull,
  cachedTokens: numberOrNull,
  outputTokens: numberOrNull,
  usageSource: stringOrNull,
  finishReason: stringOrNull,
  extra: record(any),
});

const requests = object({
  ok: boolean,
  rows: arrayOf(requestRow),
  nextCursor: stringOrNull,
  facets: optional(record(record(integer))),
  facetsTruncated: optional(boolean),
});

const billing = nullable(object({
  usage: object({
    usageId: string,
    chargedMicrocredits: decimal,
    projectedMicrocredits: decimal,
    usageSource: stringOrNull,
    terminalState: stringOrNull,
    decisionCode: stringOrNull,
  }),
  reservation: nullable(object({ enforcementMode: string, decisionCode: stringOrNull, reservationMicrocredits: decimal })),
}));

const requestDetail = object({
  ok: boolean,
  request: requestRow,
  timeline: arrayOf(object({ mark: string, at: optional(iso), offsetMs: optional(number) })),
  billing,
  instance: nullable(object({
    fleetId: string,
    engineId: stringOrNull,
    runtimeId: stringOrNull,
    launchId: stringOrNull,
    recipeId: stringOrNull,
    launch: nullable(object({ readyAt: iso, summary: record(any) })),
    nearestSample: nullable(object({ at: iso, running: numberOrNull, waiting: numberOrNull, kvUsage: numberOrNull })),
  })),
  events: arrayOf(object({ id: integer, type: string, at: iso })),
  audit: object({ unlocked: boolean, linkable: boolean, chatId: stringOrNull, candidates: arrayOf(any) }),
});

const events = object({
  ok: boolean,
  rows: arrayOf(object({
    id: integer,
    at: iso,
    type: string,
    severity: oneOf("info", "warning", "critical"),
    source: string,
    managerId: optional(stringOrNull),
    fleetId: optional(stringOrNull),
    launchId: optional(stringOrNull),
    requestId: optional(stringOrNull),
    title: string,
    data: optional(any),
  })),
  nextCursor: stringOrNull,
});

const energy = object({
  ok: boolean,
  groupBy: string,
  rows: arrayOf(object({
    key: string,
    energyWh: number,
    idleWh: number,
    cost: numberOrNull,
    outputTokens: numberOrNull,
    costPerMOutputTokens: numberOrNull,
  })),
  currency: string,
  tariffApplied: oneOf("current"),
  priceConfigured: boolean,
});

const lifecycle = object({
  ok: boolean,
  instances: arrayOf(object({
    fleetId: string,
    model: stringOrNull,
    engineId: stringOrNull,
    intervals: arrayOf(object({ from: iso, to: iso, state: oneOf("loading", "ready", "sleeping", "crashed"), launchId: stringOrNull })),
  })),
});

const launches = object({
  ok: boolean,
  rows: arrayOf(object({
    key: string,
    started: integer,
    ready: integer,
    failed: integer,
    readyP50Seconds: numberOrNull,
    readyP95Seconds: numberOrNull,
    topFailures: arrayOf(object({ signature: string, count: integer })),
  })),
});

const baseline = object({
  ok: boolean,
  rows: arrayOf(object({
    managerId: string,
    model: string,
    firstSeen: isoOrNull,
    lastSeen: isoOrNull,
    promptTokens: numberOrNull,
    outputTokens: numberOrNull,
    requests: numberOrNull,
    source: string,
  })),
});

const collectorStatus = object({ state: string, lastOkAt: isoOrNull, lastError: nullable(any), intervalMs: numberOrNull });

const status = object({
  ok: boolean,
  schemaVersion: nullable(integer),
  dbBytes: numberOrNull,
  walBytes: numberOrNull,
  rows: record(number),
  collectors: object({ recorder: collectorStatus, runtime: collectorStatus, gpu: collectorStatus, events: collectorStatus, store: collectorStatus }),
  recorder: object({ inflight: integer, buffered: integer, dropped: integer }),
  rollup: object({ watermark1m: nullable(any), dirty: integer }),
  retention: object({ lastRunAt: isoOrNull, deleted: nullable(any) }),
  imports: arrayOf(any),
  degraded: arrayOf(string),
});

const settings = object({
  ok: boolean,
  etag: string,
  enabled: optional(boolean),
  energy: object({ pricePerKwh: numberOrNull, currency: string, tariffs: arrayOf(object({ from: string, to: string, pricePerKwh: number })), hostBaselineWatts: number }),
  retention: object({ requestsDays: integer, ipDays: integer, samplesHours: integer, minuteDays: integer, hourDays: integer, eventsDays: integer }),
  sampleIntervalMs: integer,
  keepJsonlAccessLog: boolean,
  alerts: object({
    webhooks: arrayOf(object({
      id: string,
      format: string,
      url: string,
      minSeverity: string,
      secret: object({ set: boolean }),
    })),
  }),
});

const settingsWrite = object({
  ok: boolean,
  etag: string,
  changed: arrayOf(string),
  restartRequired: arrayOf(any),
});

// 00 §4.2
const error = object({
  ok: oneOf(false),
  error: object({ code: string, message: string, hint: optional(string) }),
  errors: optional(arrayOf(object({ field: string, code: string }))),
});

const SCHEMAS = Object.freeze({
  live,
  summary,
  timeseries,
  breakdown,
  requests,
  requestDetail,
  events,
  energy,
  lifecycle,
  launches,
  baseline,
  status,
  settings,
  settingsWrite,
  error,
});

function validate(name, body) {
  const schema = SCHEMAS[name];
  if (!schema) throw new RangeError(`Unknown telemetry schema: ${name}`);
  const errors = schema("", body).map((line) => line.replace(/^: /, ""));
  return { ok: errors.length === 0, errors };
}

function assertValid(name, body) {
  const result = validate(name, body);
  if (!result.ok) throw new TypeError(`${name} does not match its schema:\n  ${result.errors.slice(0, 8).join("\n  ")}`);
  return body;
}

module.exports = { SCHEMAS, assertValid, validate };
