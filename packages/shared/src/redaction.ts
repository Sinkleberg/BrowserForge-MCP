export const REDACTED = '[REDACTED]';

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-access-token',
  'x-session-id',
  'x-amz-security-token',
]);

const SENSITIVE_KEY_RE =
  /(pass(word|wd)?|secret|token|api[-_]?key|apikey|auth(orization)?|session|cookie|credential|private[-_]?key|csrf|xsrf|bearer|jwt|signature|otp|pin|ssn|card(number)?|cvv|cvc)/i;

const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*\b/g;
const BEARER_RE = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const LONG_SECRET_RE = /\b(sk|pk|ghp|gho|xox[abpr]|AKIA|AIza)[-_A-Za-z0-9]{12,}\b/g;

export function isSensitiveHeader(name: string): boolean {
  const n = name.toLowerCase();
  return SENSITIVE_HEADERS.has(n) || /token|secret|api[-_]?key|session/.test(n);
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

export interface Header {
  name: string;
  value: string;
}

export function redactHeaders(headers: Header[]): Header[] {
  return headers.map((h) => (isSensitiveHeader(h.name) ? { name: h.name, value: REDACTED } : { name: h.name, value: redactString(h.value) }));
}

/** Redact secret-looking substrings inside free text (JWTs, bearer tokens, well-known key prefixes). */
export function redactString(s: string): string {
  return s.replace(JWT_RE, REDACTED).replace(BEARER_RE, (_m, scheme: string) => `${scheme} ${REDACTED}`).replace(LONG_SECRET_RE, REDACTED);
}

/** Redact sensitive query parameters in a URL; leaves non-URL strings processed by redactString. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = REDACTED;
      u.password = '';
    }
    for (const key of [...new Set(u.searchParams.keys())]) {
      if (isSensitiveKey(key)) u.searchParams.set(key, REDACTED);
    }
    return redactString(u.toString().replace(/%5BREDACTED%5D/g, REDACTED));
  } catch {
    return redactString(url);
  }
}

/** Deep-redact JSON-like values by key name and by value pattern. */
export function redactJson(value: unknown, depth = 0): unknown {
  if (depth > 20) return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactJson(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) && (typeof v === 'string' || typeof v === 'number') ? REDACTED : redactJson(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Redact a request/response body given its (optional) content type. */
export function redactBody(body: string | undefined, contentType?: string): string | undefined {
  if (body === undefined) return undefined;
  const ct = (contentType ?? '').toLowerCase();
  const trimmed = body.trimStart();
  if (ct.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(redactJson(JSON.parse(body)));
    } catch {
      /* fall through */
    }
  }
  if (ct.includes('x-www-form-urlencoded')) {
    const params = new URLSearchParams(body);
    for (const key of [...new Set(params.keys())]) if (isSensitiveKey(key)) params.set(key, REDACTED);
    return redactString(params.toString().replace(/%5BREDACTED%5D/g, REDACTED));
  }
  return redactString(body);
}

/** Detects whether text still contains anything that looks like a secret (used by output scanners/tests). */
export function containsSecretLike(text: string): boolean {
  JWT_RE.lastIndex = 0;
  LONG_SECRET_RE.lastIndex = 0;
  return JWT_RE.test(text) || LONG_SECRET_RE.test(text) || /Bearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{8,}/i.test(text);
}

/** Stricter, low-false-positive check (JWTs and well-known key prefixes only) for scanning source code and docs. */
export function containsStrongSecret(text: string): boolean {
  JWT_RE.lastIndex = 0;
  LONG_SECRET_RE.lastIndex = 0;
  return JWT_RE.test(text) || LONG_SECRET_RE.test(text);
}
