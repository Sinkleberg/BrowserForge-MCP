import { REDACTED, isSensitiveKey, redactJson, redactString } from '@browserforge/shared';
import { hostMatches, type CapturedRequest } from '@browserforge/network-inspector';
import { inferFromSamples, shrinkExample } from './schema.js';
import type { AnalysisReport, AnalyzeOptions, AuthInfo, Basis, BodyInfo, Claim, Confidence, Endpoint, PaginationInfo, ParamInfo, PathParamInfo, ResponseInfo } from './types.js';

const STATIC_MIME = /^(text\/(html|css|javascript|plain)|application\/(javascript|x-javascript|wasm)|image\/|font\/|audio\/|video\/)/i;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_VERSION = /^v(\d+(\.\d+)?)$/i;

const hdr = (headers: { name: string; value: string }[], name: string) => headers.find((h) => h.name.toLowerCase() === name)?.value;
const ctOf = (r: CapturedRequest) => (r.mimeType ?? hdr(r.responseHeaders, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase();
const reqCt = (r: CapturedRequest) => (hdr(r.requestHeaders, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase();

function confidenceFor(samples: number, consistent = true): Confidence {
  if (!consistent) return 'low';
  return samples >= 5 ? 'high' : samples >= 2 ? 'medium' : 'low';
}
const claim = (basis: Basis, samples: number, evidence: string[], consistent = true): Claim => ({ basis, confidence: confidenceFor(samples, consistent), evidence: evidence.slice(0, 10) });

/** Conservative categorical guesses: repeated labels, not identifiers, credentials or free-form inputs. */
function queryEnum(name: string, values: string[], ids: string[]): Pick<ParamInfo, 'enum' | 'enumClaim'> {
  const evidence = [...new Set(ids)];
  const key = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  const freeOrId = /(^|_)(id|ids|uid|uuid|guid|key|code|nonce|challenge|verifier|hash|digest|user|username|account|customer|cursor|after|before|offset|page|name|email|phone|url|uri|path|slug|q|query|search|text|message|note|notes|description|comment|comments|title)(_|$)/;
  if (evidence.length < 5 || isSensitiveKey(name) || freeOrId.test(key)) return {};
  const support = new Map<string, Set<string>>();
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    // Lowercase categorical labels only. Numbers, UUIDs, opaque IDs and text with spaces/punctuation are deliberately excluded.
    if (!/^[a-z][a-z-]{1,31}$/.test(value) || isIdSegment(value) || redactString(value) !== value) return {};
    const requests = support.get(value) ?? support.set(value, new Set()).get(value)!;
    if (support.size > 3) return {};
    requests.add(ids[i]!);
  }
  if (support.size < 2 || support.size > 3 || [...support.values()].some((requests) => requests.size < 2)) return {};
  return { enum: [...support.keys()], enumClaim: { ...claim('hypothesis', evidence.length, evidence), confidence: 'low' } };
}

function isIdSegment(seg: string): boolean {
  return /^\d+$/.test(seg) || RE_UUID.test(seg) || /^[a-z]{2,10}_[A-Za-z0-9]{1,}$/.test(seg) && /\d/.test(seg) || /^[0-9a-f]{12,}$/i.test(seg) || /^[A-Za-z0-9_-]{20,}$/.test(seg) && /\d/.test(seg);
}
function idType(seg: string): 'integer' | 'string' | 'uuid' {
  return /^\d+$/.test(seg) ? 'integer' : RE_UUID.test(seg) ? 'uuid' : 'string';
}
const singular = (w: string) => w.replace(/ies$/, 'y').replace(/(ss|us)$/, '$1').replace(/s$/, '');
const camel = (s: string) => s.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ''));

interface Sample {
  r: CapturedRequest;
  url: URL;
  segs: string[];
  body?: unknown;
  resJson?: unknown;
  gql?: { operationName?: string; query?: string; variables?: Record<string, unknown> };
}

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

function parseBody(r: CapturedRequest): unknown {
  if (!r.requestBody) return undefined;
  const ct = reqCt(r);
  if (ct.includes('json') || r.requestBody.trimStart().startsWith('{') || r.requestBody.trimStart().startsWith('[')) return parseJson(r.requestBody);
  if (ct.includes('x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(r.requestBody));
  return undefined;
}

function looksApi(r: CapturedRequest, s: Sample): boolean {
  const mime = ctOf(r);
  if (mime.includes('json') || mime.includes('graphql') || mime.includes('xml') && !mime.includes('html')) return true;
  if (s.body !== undefined && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method)) return true;
  const t = (r.resourceType ?? '').toLowerCase();
  if (['xmlhttprequest', 'xhr', 'fetch'].includes(t) && !STATIC_MIME.test(mime)) return true;
  return false;
}

function templatePath(segs: string[]): { template: string; params: { name: string; value: string }[] } {
  const params: { name: string; value: string }[] = [];
  const used = new Map<string, number>();
  const out = segs.map((seg, i) => {
    if (i > 0 && isIdSegment(seg) && !RE_VERSION.test(seg)) {
      let base = camel(singular(segs[i - 1]!)) + 'Id';
      if (isIdSegment(segs[i - 1]!)) base = 'id';
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      const name = n > 1 ? `${base}${n}` : base;
      params.push({ name, value: seg });
      return `{${name}}`;
    }
    return seg;
  });
  return { template: '/' + out.join('/'), params };
}

function detectAuth(samples: Sample[]): AuthInfo[] {
  const out: AuthInfo[] = [];
  const n = samples.length;
  const count = (pred: (s: Sample) => boolean) => samples.filter(pred);
  const bearer = count((s) => /^bearer\s/i.test(hdr(s.r.requestHeaders, 'authorization') ?? ''));
  const basic = count((s) => /^basic\s/i.test(hdr(s.r.requestHeaders, 'authorization') ?? ''));
  if (bearer.length) out.push({ kind: 'bearer', ...claim('observed', bearer.length, bearer.map((s) => s.r.id)), requiredBy: bearer.length === n ? 'all-samples' : 'some-samples' });
  if (basic.length) out.push({ kind: 'basic', ...claim('observed', basic.length, basic.map((s) => s.r.id)), requiredBy: basic.length === n ? 'all-samples' : 'some-samples' });
  const keyNames = new Map<string, Sample[]>();
  for (const s of samples) for (const h of s.r.requestHeaders) {
    const l = h.name.toLowerCase();
    if (l !== 'authorization' && l !== 'cookie' && /^(x-)?(api[-_]?key|auth[-_]?token|access[-_]?token)$/.test(l)) (keyNames.get(h.name) ?? keyNames.set(h.name, []).get(h.name)!).push(s);
  }
  for (const [name, ss] of keyNames) out.push({ kind: 'apiKeyHeader', name, ...claim('observed', ss.length, ss.map((s) => s.r.id)), requiredBy: ss.length === n ? 'all-samples' : 'some-samples' });
  const cookieNames = new Set<string>();
  const withCookie = count((s) => {
    const c = hdr(s.r.requestHeaders, 'cookie');
    if (c) c.split(';').forEach((p) => cookieNames.add(p.split('=')[0]!.trim()));
    return Boolean(c);
  });
  if (withCookie.length) out.push({ kind: 'cookie', name: [...cookieNames].filter(Boolean).slice(0, 5).join(','), ...claim('observed', withCookie.length, withCookie.map((s) => s.r.id)), requiredBy: withCookie.length === n ? 'all-samples' : 'some-samples' });
  return out;
}

const PAGE_PARAMS = ['page', 'pageNumber', 'page_number', 'p'];
const SIZE_PARAMS = ['per_page', 'perPage', 'page_size', 'pageSize', 'limit', 'size', 'count', 'take'];
const OFFSET_PARAMS = ['offset', 'skip', 'start'];
const CURSOR_PARAMS = ['cursor', 'after', 'before', 'next', 'page_token', 'pageToken', 'starting_after'];
const NEXT_FIELDS = /^(next|next_page|nextPage|next_cursor|nextCursor|next_page_token|nextPageToken|has_more|hasMore|total|total_count|totalCount|total_pages|totalPages|count|page|per_page)$/;

function detectPagination(samples: Sample[], paramNames: Set<string>): PaginationInfo | undefined {
  const reqParams = [...paramNames];
  const has = (list: string[]) => reqParams.filter((p) => list.includes(p));
  const fields = new Set<string>();
  for (const s of samples) if (s.resJson && typeof s.resJson === 'object' && !Array.isArray(s.resJson)) for (const k of Object.keys(s.resJson as object)) if (NEXT_FIELDS.test(k)) fields.add(k);
  const link = samples.some((s) => /rel="?next"?/.test(hdr(s.r.responseHeaders, 'link') ?? ''));
  const ev = samples.map((s) => s.r.id);
  const sizeParam = has(SIZE_PARAMS)[0];
  const respFields = [...fields];
  if (has(CURSOR_PARAMS).length && (respFields.some((f) => /cursor|token|next/i.test(f)) || samples.length > 1))
    return { style: 'cursor', requestParams: has(CURSOR_PARAMS), responseFields: respFields, pageSizeParam: sizeParam, ...claim(respFields.length ? 'inferred' : 'hypothesis', samples.length, ev, respFields.length > 0) };
  if (has(PAGE_PARAMS).length)
    return { style: 'page', requestParams: has(PAGE_PARAMS), responseFields: respFields, pageSizeParam: sizeParam, ...claim(respFields.length || samples.length > 1 ? 'inferred' : 'hypothesis', samples.length, ev, respFields.length > 0 || samples.length > 1) };
  if (has(OFFSET_PARAMS).length)
    return { style: 'offset', requestParams: has(OFFSET_PARAMS), responseFields: respFields, pageSizeParam: sizeParam, ...claim('inferred', samples.length, ev) };
  if (link) return { style: 'link-header', requestParams: [], responseFields: [], ...claim('observed', samples.length, ev) };
  return undefined;
}

function analyzeGroup(key: { method: string; scheme: string; host: string; template: string; op?: string }, samples: Sample[], opts: AnalyzeOptions, paramSamples: Map<string, { name: string; value: string }[]>): Endpoint {
  const ev = samples.map((s) => s.r.id);
  const n = samples.length;
  const maxEx = opts.maxExampleChars ?? 1500;

  // path params
  const pathParams: PathParamInfo[] = [];
  const names = new Set<string>();
  for (const s of samples) for (const p of paramSamples.get(s.r.id) ?? []) names.add(p.name);
  for (const name of names) {
    const vals = samples.flatMap((s) => (paramSamples.get(s.r.id) ?? []).filter((p) => p.name === name).map((p) => p.value));
    pathParams.push({ name, type: idType(vals[0]!), examples: [...new Set(vals)].slice(0, 3), ...claim('inferred', vals.length, ev, vals.length > 1) });
  }

  // query params (GraphQL endpoints carry query in body)
  const qNames = new Map<string, { values: string[]; ids: string[] }>();
  for (const s of samples) for (const [k, v] of s.url.searchParams) {
    const e = qNames.get(k) ?? qNames.set(k, { values: [], ids: [] }).get(k)!;
    e.values.push(v);
    e.ids.push(s.r.id);
  }
  const query: ParamInfo[] = [...qNames].map(([name, e]) => {
    const distinct = new Set(e.values);
    const occ = new Set(e.ids).size;
    const type = e.values.every((v) => /^-?\d+$/.test(v)) ? 'integer' : e.values.every((v) => /^-?\d*\.\d+$/.test(v)) ? 'number' : e.values.every((v) => /^(true|false)$/.test(v)) ? 'boolean' : 'string';
    const always = occ === n;
    return {
      name, type, required: always && n >= 2, occurrences: occ, distinctValues: distinct.size,
      examples: [...distinct].slice(0, 4).map((v) => (isSensitiveKey(name) ? REDACTED : redactString(v))),
      // "required" is only a hypothesis: seen in every sample, which does not prove the server rejects its absence.
      ...claim(always && n >= 2 ? 'hypothesis' : 'observed', n, e.ids, true),
      ...(type === 'string' ? queryEnum(name, e.values, e.ids) : {}),
    };
  });

  // request body
  let requestBody: BodyInfo | undefined;
  const bodies = samples.filter((s) => s.body !== undefined && !s.gql);
  if (bodies.length) {
    const schema = inferFromSamples(bodies.map((s) => s.body))!;
    requestBody = {
      contentType: reqCt(bodies[0]!.r) || 'application/json', schema, samples: bodies.length,
      example: shrinkExample(redactJson(bodies[0]!.body), maxEx),
      ...claim('inferred', bodies.length, bodies.map((s) => s.r.id)),
    };
  }

  // responses
  const byStatus = new Map<number, Sample[]>();
  for (const s of samples) if (s.r.status !== undefined) (byStatus.get(s.r.status) ?? byStatus.set(s.r.status, []).get(s.r.status)!).push(s);
  const responses: ResponseInfo[] = [...byStatus].sort((a, b) => a[0] - b[0]).map(([status, ss]) => {
    const jsons = ss.map((s) => s.resJson).filter((j) => j !== undefined);
    return {
      status, count: ss.length, contentType: ctOf(ss[0]!.r) || undefined,
      schema: jsons.length ? inferFromSamples(jsons) : undefined,
      example: jsons.length ? shrinkExample(redactJson(jsons[0]), maxEx) : undefined,
      ...claim(jsons.length ? 'inferred' : 'observed', ss.length, ss.map((s) => s.r.id)),
    };
  });
  const errors = responses.filter((r) => r.status >= 400).map((r) => ({ status: r.status, count: r.count, shape: r.schema }));

  // auth
  const auth = detectAuth(samples);
  const unauth401 = samples.filter((s) => s.r.status === 401 || s.r.status === 403);
  const notes: string[] = [];
  if (unauth401.length) notes.push(`Observed ${unauth401.length} ${unauth401.map((s) => s.r.status).join('/')} response(s): authentication/authorization is enforced for at least some requests.`);
  if (n === 1) notes.push('Only one sample: required/optional parameters and schemas cannot be distinguished.');
  if (samples.some((s) => s.r.responseBody === undefined)) notes.push('Some responses had no captured body (response-body capture off or not available), so response schemas may be incomplete.');

  const pagination = detectPagination(samples, new Set(qNames.keys()));

  // version from path
  const vseg = key.template.split('/').find((s) => RE_VERSION.test(s));
  const version = vseg ?? undefined;

  const first = samples[0]!;
  const gql = first.gql ? {
    operationName: key.op,
    operationType: /^\s*(query|mutation|subscription)\b/.exec(first.gql.query ?? '')?.[1],
    variables: [...new Set(samples.flatMap((s) => Object.keys(s.gql?.variables ?? {})))],
    query: first.gql.query ? first.gql.query.slice(0, 2000) : undefined,
  } : undefined;

  const requestHeaders = [...new Set(samples.flatMap((s) => s.r.requestHeaders.map((h) => h.name.toLowerCase())))]
    .filter((h) => !/^(cookie|authorization|host|user-agent|accept-encoding|accept-language|connection|origin|referer|sec-.*|priority|te|dnt|upgrade-insecure-requests|content-length|pragma|cache-control|if-.*)$/.test(h)).slice(0, 15);

  return {
    id: `${key.method} ${key.template}${key.op ? `#${key.op}` : ''}`,
    method: key.method, scheme: key.scheme, host: key.host, pathTemplate: key.template,
    pathParams, query, requestBody, responses, auth, pagination, graphql: gql, version,
    sampleCount: n, requestHeaders, errors, notes,
    // The endpoint's existence is observed; its generalised shape is inferred.
    ...claim('observed', n, ev),
  };
}

export function analyzeRequests(requests: CapturedRequest[], opts: AnalyzeOptions = {}): AnalysisReport {
  const warnings: string[] = [];
  const samples: Sample[] = [];
  let skippedStatic = 0;
  for (const r of requests) {
    let url: URL;
    try { url = new URL(r.url); } catch { continue; }
    if (!/^https?:$/.test(url.protocol)) continue;
    if (opts.hosts?.length && !opts.hosts.some((h) => hostMatches(url.hostname, h))) continue;
    const s: Sample = { r, url, segs: url.pathname.split('/').filter(Boolean) };
    s.body = parseBody(r);
    if (r.responseBody && !r.responseBodyBase64) s.resJson = parseJson(r.responseBody);
    if (s.body && typeof s.body === 'object' && !Array.isArray(s.body) && typeof (s.body as Record<string, unknown>).query === 'string' && /^\s*(query|mutation|subscription|\{)/.test((s.body as { query: string }).query)) {
      const b = s.body as { operationName?: string; query: string; variables?: Record<string, unknown> };
      s.gql = { operationName: b.operationName ?? /^\s*(?:query|mutation|subscription)\s+(\w+)/.exec(b.query)?.[1], query: b.query, variables: b.variables };
    }
    if (!opts.includeStatic && !looksApi(r, s)) { skippedStatic++; continue; }
    samples.push(s);
  }

  // group by method + host + templated path (+ GraphQL operation)
  const groups = new Map<string, { key: Parameters<typeof analyzeGroup>[0]; samples: Sample[] }>();
  const paramSamples = new Map<string, { name: string; value: string }[]>();
  for (const s of samples) {
    const { template, params } = templatePath(s.segs);
    paramSamples.set(s.r.id, params);
    const op = s.gql ? (s.gql.operationName ?? 'anonymous') : undefined;
    const key = { method: s.r.method.toUpperCase(), scheme: s.url.protocol.replace(':', ''), host: s.url.host, template, op };
    const k = `${key.method} ${key.host}${key.template}#${op ?? ''}`;
    (groups.get(k) ?? groups.set(k, { key, samples: [] }).get(k)!).samples.push(s);
  }

  const endpoints = [...groups.values()].map((g) => analyzeGroup(g.key, g.samples, opts, paramSamples));
  const min = opts.minSamples ?? 1;
  for (const e of endpoints) if (e.sampleCount < min) { e.confidence = 'low'; e.notes.push(`Fewer than ${min} samples.`); }
  endpoints.sort((a, b) => a.host.localeCompare(b.host) || a.pathTemplate.localeCompare(b.pathTemplate) || a.method.localeCompare(b.method));

  // Deduplicate security schemes across endpoints (no values, only kinds/names).
  const schemes = new Map<string, AuthInfo>();
  for (const e of endpoints) for (const a of e.auth) {
    const k = `${a.kind}:${a.name ?? ''}`;
    const ex = schemes.get(k);
    if (!ex) schemes.set(k, { ...a, evidence: [...a.evidence] });
    else { ex.evidence = [...new Set([...ex.evidence, ...a.evidence])].slice(0, 10); if (a.requiredBy === 'some-samples') ex.requiredBy = 'some-samples'; }
  }

  const hostMap = new Map<string, { host: string; scheme: string; endpoints: number }>();
  for (const e of endpoints) (hostMap.get(e.host) ?? hostMap.set(e.host, { host: e.host, scheme: e.scheme, endpoints: 0 }).get(e.host)!).endpoints++;

  if (samples.length === 0) warnings.push('No API-like requests found. Capture traffic first (browse the site with capture enabled) or set includeStatic.');
  if (samples.length > 0 && samples.every((s) => s.r.responseBody === undefined)) warnings.push('No response bodies were captured; response schemas are unavailable. Enable network_configure_capture {captureBodies:true} or import a HAR with bodies.');
  const redactedHits = samples.filter((s) => s.r.requestHeaders.some((h) => h.value === REDACTED)).length;
  if (redactedHits) warnings.push('Some header values in the capture are already redacted; authentication kinds are inferred from header names/schemes only.');

  return {
    captureId: opts.captureId ?? 'live',
    generatedAt: new Date().toISOString(),
    stats: { requestsConsidered: requests.length, requestsAnalyzed: samples.length, skippedStatic, endpoints: endpoints.length },
    hosts: [...hostMap.values()],
    securitySchemes: [...schemes.values()],
    endpoints, warnings,
    disclaimer: 'Derived only from the captured traffic. "observed" = seen directly; "inferred" = generalised from samples; "hypothesis" = plausible but unverified. Behaviour not exercised in the capture is unknown.',
  };
}
