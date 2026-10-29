import type { JsonSchema } from './types.js';

const RE_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_URI = /^https?:\/\/\S+$/;

function stringFormat(s: string): string | undefined {
  if (RE_DATETIME.test(s)) return 'date-time';
  if (RE_DATE.test(s)) return 'date';
  if (RE_EMAIL.test(s)) return 'email';
  if (RE_UUID.test(s)) return 'uuid';
  if (RE_URI.test(s)) return 'uri';
  return undefined;
}

/** Infer a schema from a single JSON value. */
export function inferSchema(v: unknown, depth = 0): JsonSchema {
  if (v === null) return { type: 'null' };
  if (Array.isArray(v)) {
    if (depth > 8 || v.length === 0) return { type: 'array' };
    return { type: 'array', items: v.slice(0, 50).map((x) => inferSchema(x, depth + 1)).reduce((a, b) => mergeSchemas(a, b)) };
  }
  switch (typeof v) {
    case 'boolean': return { type: 'boolean' };
    case 'number': return { type: Number.isInteger(v) ? 'integer' : 'number' };
    case 'string': {
      const f = stringFormat(v);
      return f ? { type: 'string', format: f } : { type: 'string' };
    }
    case 'object': {
      if (depth > 8) return { type: 'object' };
      const props: Record<string, JsonSchema> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) props[k] = inferSchema(x, depth + 1);
      return { type: 'object', properties: props, required: Object.keys(props) };
    }
    default: return {};
  }
}

const typesOf = (s: JsonSchema): string[] => (s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type]);

/** Merge two observed schemas: union of types, properties required only if present in both. */
export function mergeSchemas(a: JsonSchema, b: JsonSchema): JsonSchema {
  const ta = typesOf(a), tb = typesOf(b);
  let types = [...new Set([...ta, ...tb])];
  // integer ⊂ number
  if (types.includes('integer') && types.includes('number')) types = types.filter((t) => t !== 'integer');
  const out: JsonSchema = {};
  const nonNull = types.filter((t) => t !== 'null');
  if (types.includes('null')) out.nullable = true;
  if (nonNull.length === 1) out.type = nonNull[0];
  else if (nonNull.length > 1) out.type = nonNull;
  else if (types.length) out.type = 'null';
  if (a.format && a.format === b.format) out.format = a.format;
  if (a.properties || b.properties) {
    const keys = new Set([...Object.keys(a.properties ?? {}), ...Object.keys(b.properties ?? {})]);
    out.properties = {};
    for (const k of keys) {
      const pa = a.properties?.[k], pb = b.properties?.[k];
      out.properties[k] = pa && pb ? mergeSchemas(pa, pb) : (pa ?? pb)!;
    }
    const ra = new Set(a.required ?? Object.keys(a.properties ?? {}));
    const rb = new Set(b.required ?? Object.keys(b.properties ?? {}));
    // A property absent from an object that has other properties is optional; an absent whole-object side keeps the other's requirements.
    const aHas = a.properties !== undefined, bHas = b.properties !== undefined;
    out.required = [...keys].filter((k) => (aHas ? ra.has(k) : true) && (bHas ? rb.has(k) : true));
  }
  if (a.items || b.items) out.items = a.items && b.items ? mergeSchemas(a.items, b.items) : (a.items ?? b.items);
  return out;
}

export function inferFromSamples(samples: unknown[]): JsonSchema | undefined {
  if (samples.length === 0) return undefined;
  return samples.map((s) => inferSchema(s)).reduce((a, b) => mergeSchemas(a, b));
}

/** Truncate big arrays/strings so examples stay small. */
export function shrinkExample(v: unknown, maxChars = 1500): unknown {
  const cut = (x: unknown, d: number): unknown => {
    if (typeof x === 'string') return x.length > 120 ? x.slice(0, 120) + '…' : x;
    if (Array.isArray(x)) return x.slice(0, 2).map((y) => cut(y, d + 1));
    if (x && typeof x === 'object' && d < 6) return Object.fromEntries(Object.entries(x).slice(0, 25).map(([k, y]) => [k, cut(y, d + 1)]));
    return x;
  };
  const r = cut(v, 0);
  return JSON.stringify(r).length > maxChars ? undefined : r;
}
