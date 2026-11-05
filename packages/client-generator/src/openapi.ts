import type { AnalysisReport, JsonSchema } from '@browserforge/api-analyzer';
import { buildIr } from './ir.js';

function toOas(s: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const types = s.type === undefined ? [] : Array.isArray(s.type) ? [...s.type] : [s.type];
  if (s.nullable && types.length && !types.includes('null')) types.push('null');
  if (types.length === 1) out.type = types[0];
  else if (types.length > 1) out.type = types;
  if (s.format) out.format = s.format;
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toOas(v)]));
    if (s.required?.length) out.required = s.required;
  }
  if (s.items) out.items = toOas(s.items);
  return out;
}

/**
 * OpenAPI 3.1 document. Only REST operations are representable; GraphQL operations share one path+method and are listed
 * under x-browserforge-skipped. "required" query parameters are never emitted (they would only be hypotheses).
 */
export function generateOpenApi(report: AnalysisReport, opts: { host?: string; title?: string; version?: string } = {}): Record<string, unknown> {
  const ir = buildIr(report, opts);
  const paths: Record<string, Record<string, unknown>> = {};
  const skipped: string[] = [...ir.skipped];
  for (const op of ir.ops) {
    if (op.kind === 'graphql') { skipped.push(`${op.endpoint.id} (GraphQL operation: not representable as a distinct OpenAPI operation)`); continue; }
    const e = op.endpoint;
    const parameters = [
      ...e.pathParams.map((p) => ({ name: p.name, in: 'path', required: true, schema: { type: p.type === 'integer' ? 'integer' : 'string', ...(p.type === 'uuid' ? { format: 'uuid' } : {}) }, 'x-basis': p.basis })),
      ...e.query.map((q) => ({
        name: q.name, in: 'query', required: false,
        schema: { type: q.type, ...(q.enum?.length ? { enum: q.enum, 'x-basis': 'hypothesis', 'x-confidence': q.enumClaim?.confidence ?? 'low', 'x-evidence': q.enumClaim?.evidence ?? [] } : {}) },
        ...(q.examples.length ? { example: q.examples[0] } : {}),
        'x-observed-in-all-samples': q.required, 'x-basis': q.basis, 'x-confidence': q.confidence,
      })),
    ];
    const responses: Record<string, unknown> = {};
    for (const r of e.responses) {
      responses[String(r.status)] = {
        description: `Observed ${r.count} time(s)`,
        ...(r.schema ? { content: { [r.contentType || 'application/json']: { schema: toOas(r.schema), ...(r.example !== undefined ? { example: r.example } : {}) } } } : {}),
        'x-confidence': r.confidence,
      };
    }
    if (!Object.keys(responses).length) responses.default = { description: 'No response observed' };
    const operation: Record<string, unknown> = {
      operationId: op.name, summary: op.summary, parameters, responses,
      'x-confidence': e.confidence, 'x-sample-count': e.sampleCount, 'x-evidence': e.evidence,
      ...(e.pagination ? { 'x-pagination': { style: e.pagination.style, requestParams: e.pagination.requestParams, responseFields: e.pagination.responseFields, basis: e.pagination.basis } } : {}),
    };
    if (!parameters.length) delete operation.parameters;
    if (e.requestBody) operation.requestBody = { required: false, content: { [e.requestBody.contentType || 'application/json']: { schema: toOas(e.requestBody.schema), ...(e.requestBody.example !== undefined ? { example: e.requestBody.example } : {}) } } };
    const authKinds = e.auth.filter((a) => a.requiredBy === 'all-samples');
    if (authKinds.length) operation.security = authKinds.map((a) => ({ [schemeName(a.kind, a.name)]: [] }));
    (paths[e.pathTemplate] ??= {})[e.method.toLowerCase()] = operation;
  }
  const securitySchemes: Record<string, unknown> = {};
  for (const a of ir.auth) {
    if (a.kind === 'bearer') securitySchemes[schemeName(a.kind)] = { type: 'http', scheme: 'bearer' };
    else if (a.kind === 'basic') securitySchemes[schemeName(a.kind)] = { type: 'http', scheme: 'basic' };
    else if (a.kind === 'apiKeyHeader') securitySchemes[schemeName(a.kind, a.name)] = { type: 'apiKey', in: 'header', name: a.name };
    else if (a.kind === 'cookie') securitySchemes[schemeName(a.kind, a.name)] = { type: 'apiKey', in: 'cookie', name: (a.name ?? 'session').split(',')[0] };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: opts.title ?? `Inferred API for ${ir.host}`, version: opts.version ?? '0.0.0-inferred',
      description: 'Reconstructed from captured traffic by BrowserForge MCP. Only behaviour that was observed is described; x-confidence and x-evidence annotate how well each operation is supported. No credentials are included.',
    },
    servers: [{ url: ir.baseUrl }],
    paths,
    components: { securitySchemes },
    'x-browserforge-skipped': skipped,
  };
}

function schemeName(kind: string, name?: string): string {
  return kind === 'bearer' ? 'bearerAuth' : kind === 'basic' ? 'basicAuth' : kind === 'cookie' ? 'cookieAuth' : 'apiKey' + (name ? name.replace(/[^A-Za-z0-9]/g, '') : '');
}
