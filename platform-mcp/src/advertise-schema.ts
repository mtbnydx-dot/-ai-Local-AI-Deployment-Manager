/**
 * Controls how much of an output schema the server advertises in `tools/list`.
 *
 * The sixteen tools' fully expanded output schemas were 44,985 of the
 * manifest's 77,433 characters — 58% of what every session pays before a
 * single tool is called, for a document most clients never validate against.
 * `local_ai_get_overview` spent 5,381 characters on its output schema against
 * a 309-character description.
 *
 * In `compact` mode the envelope and the direct fields of `data` stay visible,
 * each deeper level collapses to its type, and `additionalProperties: false`
 * is dropped below the root so the advertised schema stays permissive: a
 * client that does validate `structuredContent` against it still passes.
 * `full` mode advertises the complete schema for clients that want it.
 */

/**
 * The slice of the Standard Schema contract this module needs. The MCP SDK
 * accepts any schema exposing `~standard` with both a validator and a JSON
 * Schema converter; it does not re-export the interface, so it is restated
 * here rather than reaching into the SDK's bundled declarations.
 */
type StandardSchemaV1 = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => unknown;
    readonly jsonSchema: {
      readonly input: (options: { target: string }) => Record<string, unknown>;
      readonly output: (options: { target: string }) => Record<string, unknown>;
    };
  };
};

export type OutputSchemaDetail = "compact" | "full";

/** Levels kept with their properties intact. 0 is the envelope, 1 is `data`. */
const COMPACT_DEPTH = 1;
/** Enum lists longer than this collapse to their base type. */
const MAX_ENUM_CHARS = 160;

type JsonSchema = Record<string, unknown>;

/**
 * Re-advertises `schema` with a pruned JSON Schema while keeping its real
 * validator, so incoming and outgoing data are still checked against the full
 * definition.
 */
export function advertise<T extends StandardSchemaV1>(schema: T, detail: OutputSchemaDetail): T {
  if (detail === "full") return schema;
  const memoized = wrapped.get(schema);
  if (memoized) return memoized as T;
  const standard = (schema as unknown as { "~standard": StandardJsonProps })["~standard"];
  const props = {
    ...standard,
    // The pruned document is the same every time, and the server is rebuilt
    // per request in stateless mode, so neither conversion is repeated.
    jsonSchema: {
      input: memoize((options: { target: string }) => compactJsonSchema(standard.jsonSchema.input(options))),
      output: memoize((options: { target: string }) => compactJsonSchema(standard.jsonSchema.output(options))),
    },
  } as StandardJsonProps;
  // Only the advertised document changes; `validate` is the original.
  const proxy = new Proxy(schema as object, {
    get: (target, property, receiver) =>
      property === "~standard" ? props : Reflect.get(target, property, receiver),
  }) as T;
  wrapped.set(schema, proxy);
  return proxy;
}

/** One wrapper per schema, so repeated registrations reuse it. */
const wrapped = new WeakMap<StandardSchemaV1, StandardSchemaV1>();
const shapes = new WeakMap<StandardSchemaV1, string>();

function memoize<R>(convert: (options: { target: string }) => R): (options: { target: string }) => R {
  const byTarget = new Map<string, R>();
  return (options) => {
    const hit = byTarget.get(options.target);
    if (hit !== undefined) return hit;
    const value = convert(options);
    byTarget.set(options.target, value);
    return value;
  };
}

/**
 * A one-line summary of the payload's top-level shape, for descriptions that
 * do not already state it. In compact mode this is what replaces the nested
 * schema — the same orientation for about fifty characters instead of five
 * thousand.
 */
export function describeDataShape(schema: StandardSchemaV1): string {
  const memoized = shapes.get(schema);
  if (memoized !== undefined) return memoized;
  const standard = (schema as unknown as { "~standard": StandardJsonProps })["~standard"];
  const json = standard.jsonSchema.output({ target: "draft-2020-12" });
  const data = asRecord(asRecord(json.properties)?.data);
  const keys = Object.keys(asRecord(data?.properties) ?? {});
  const shape = keys.length ? `Returns data={${keys.join(",")}}.` : "";
  shapes.set(schema, shape);
  return shape;
}

function compactJsonSchema(schema: JsonSchema): JsonSchema {
  return prune(schema, 0) as JsonSchema;
}

function prune(node: unknown, depth: number): unknown {
  if (!node || typeof node !== "object" || Array.isArray(node)) return node;
  const source = node as JsonSchema;
  const output: JsonSchema = {};
  if (depth === 0 && typeof source.$schema === "string") output.$schema = source.$schema;

  const nullableType = collapseNullable(source);
  if (nullableType) {
    output.type = nullableType;
    if (typeof source.description === "string") output.description = source.description;
    return output;
  }

  if (source.type !== undefined) output.type = source.type;
  if (Array.isArray(source.enum) && JSON.stringify(source.enum).length <= MAX_ENUM_CHARS) {
    output.enum = source.enum;
  }
  if (typeof source.description === "string" && depth <= COMPACT_DEPTH) {
    output.description = source.description;
  }

  const beyondDetail = depth > COMPACT_DEPTH;
  if (source.properties && typeof source.properties === "object") {
    if (beyondDetail) {
      // The type alone is kept; the caller learns the shape from the
      // description and from the data it gets back.
      if (output.type === undefined) output.type = "object";
    } else {
      const properties: JsonSchema = {};
      for (const [key, value] of Object.entries(source.properties as JsonSchema)) {
        properties[key] = prune(value, depth + 1);
      }
      output.properties = properties;
      if (Array.isArray(source.required)) output.required = source.required;
      // Only the envelope's key set is fixed. Leaving the deeper levels open
      // keeps a validating client from rejecting a payload that gained a
      // field this document no longer spells out.
      if (depth === 0 && source.additionalProperties === false) output.additionalProperties = false;
    }
  }

  if (source.items !== undefined) {
    output.items = beyondDetail ? stub(source.items) : prune(source.items, depth + 1);
  }
  for (const combinator of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = source[combinator];
    if (!Array.isArray(branches)) continue;
    output[combinator] = branches.map((branch) => prune(branch, depth + 1));
  }
  return output;
}

/** Turns `anyOf: [{type:"number"},{type:"null"}]` into `type: ["number","null"]`. */
function collapseNullable(source: JsonSchema): string[] | null {
  const branches = source.anyOf;
  if (!Array.isArray(branches) || branches.length !== 2) return null;
  if (source.type !== undefined || source.properties !== undefined) return null;
  const types = branches.map((branch) => {
    const record = asRecord(branch);
    if (!record || Object.keys(record).length !== 1) return null;
    return typeof record.type === "string" ? record.type : null;
  });
  if (types.some((type) => type === null)) return null;
  if (!types.includes("null")) return null;
  return types as string[];
}

function stub(node: unknown): JsonSchema {
  const record = asRecord(node);
  const type = record && typeof record.type === "string" ? record.type : "object";
  return { type };
}

function asRecord(value: unknown): JsonSchema | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonSchema : null;
}

type StandardJsonProps = StandardSchemaV1["~standard"];
