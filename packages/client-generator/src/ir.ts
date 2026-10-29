import type { AnalysisReport, AuthInfo, Endpoint, JsonSchema } from '@browserforge/api-analyzer';
import { BrowserForgeError } from '@browserforge/shared';
import { singular, snake, words } from './naming.js';

export interface IrParam { wire: string; type: string; required: boolean }
export interface IrPagination { style: 'page' | 'offset' | 'cursor'; param: string; sizeParam?: string; itemsField?: string; nextField?: string }
export interface IrOp {
  name: string; // snake_case base name
  kind: 'rest' | 'graphql';
  method: string;
  path: string;
  pathParams: IrParam[];
  query: IrParam[];
  body?: { schema: JsonSchema; contentType: string; required: boolean };
  response?: { schema: JsonSchema; status: number };
  pagination?: IrPagination;
  gql?: { operationName: string; query?: string };
  summary: string;
  confidence: string;
  sampleCount: number;
  endpoint: Endpoint;
}
export interface Ir {
  baseUrl: string;
  host: string;
  ops: IrOp[];
  auth: AuthInfo[];
  skipped: string[];
  title: string;
}

function opName(e: Endpoint): string {
  if (e.graphql) return 'graphql_' + (snake(e.graphql.operationName ?? 'anonymous') || 'anonymous');
  const segs = e.pathTemplate.split('/').filter(Boolean);
  const staticWords = segs.filter((s) => !s.startsWith('{') && !/^v\d+(\.\d+)?$/i.test(s) && s.toLowerCase() !== 'api').flatMap((s) => words(s));
  const trailingParam = segs.at(-1)?.startsWith('{') ?? false;
  const parts = [...staticWords];
  if ((trailingParam || e.method === 'POST') && parts.length) parts[parts.length - 1] = singular(parts[parts.length - 1]!);
  const base = parts.join('_') || 'root';
  const last = staticWords.at(-1) ?? '';
  switch (e.method) {
    case 'GET': return (trailingParam ? 'get_' : e.pagination || last.endsWith('s') ? 'list_' : 'get_') + base;
    case 'POST': return 'create_' + base;
    case 'PUT': return 'replace_' + base;
    case 'PATCH': return 'update_' + base;
    case 'DELETE': return 'delete_' + base;
    default: return e.method.toLowerCase() + '_' + base;
  }
}

function pickResponse(e: Endpoint): IrOp['response'] {
  const ok = e.responses.filter((r) => r.status >= 200 && r.status < 300 && r.schema).sort((a, b) => a.status - b.status)[0];
  return ok?.schema ? { schema: ok.schema, status: ok.status } : undefined;
}

function pagination(e: Endpoint, response: IrOp['response']): IrPagination | undefined {
  const p = e.pagination;
  if (!p || p.style === 'link-header' || p.style === 'unknown') return undefined;
  const props = response?.schema.properties ?? {};
  const itemsField = Object.entries(props).find(([, s]) => s.type === 'array')?.[0];
  if (!itemsField && response?.schema.type !== 'array') return undefined;
  const nextField = p.responseFields.find((f) => /next/i.test(f) && (p.style !== 'cursor' || /cursor|token|next/i.test(f)));
  if (p.style === 'cursor' && !nextField) return undefined; // cannot follow a cursor we never saw in a response
  return { style: p.style, param: p.requestParams[0]!, sizeParam: p.pageSizeParam, itemsField, nextField };
}

export function buildIr(report: AnalysisReport, opts: { host?: string; title?: string } = {}): Ir {
  if (report.endpoints.length === 0) throw new BrowserForgeError('GENERATION_FAILED', 'The analysis contains no endpoints');
  const hostCount = new Map<string, number>();
  for (const e of report.endpoints) hostCount.set(e.host, (hostCount.get(e.host) ?? 0) + 1);
  const host = opts.host ?? [...hostCount].sort((a, b) => b[1] - a[1])[0]![0];
  if (!hostCount.has(host)) throw new BrowserForgeError('INVALID_ARGUMENTS', `Host '${host}' is not in the analysis`);
  const eps = report.endpoints.filter((e) => e.host === host);
  const skipped = report.endpoints.filter((e) => e.host !== host).map((e) => `${e.id} (${e.host})`);
  const used = new Map<string, number>();
  const ops: IrOp[] = eps.map((e) => {
    let name = opName(e);
    const n = (used.get(name) ?? 0) + 1;
    used.set(name, n);
    if (n > 1) name = `${name}_${n}`;
    const response = pickResponse(e);
    const op: IrOp = {
      name, kind: e.graphql ? 'graphql' : 'rest', method: e.method, path: e.pathTemplate,
      pathParams: e.pathParams.map((p) => ({ wire: p.name, type: p.type === 'integer' ? 'integer' : 'string', required: true })),
      query: e.query.map((q) => ({ wire: q.name, type: q.type, required: false })), // "required" is only a hypothesis; never enforced
      response, pagination: pagination(e, response),
      summary: `${e.method} ${e.pathTemplate}`, confidence: e.confidence, sampleCount: e.sampleCount, endpoint: e,
    };
    if (e.requestBody && !e.graphql) op.body = { schema: e.requestBody.schema, contentType: e.requestBody.contentType, required: ['POST', 'PUT', 'PATCH'].includes(e.method) };
    if (e.graphql) op.gql = { operationName: e.graphql.operationName ?? 'anonymous', query: e.graphql.query };
    return op;
  });
  const auth = report.securitySchemes.filter((a) => report.endpoints.some((e) => e.host === host && e.auth.some((x) => x.kind === a.kind && x.name === a.name)));
  return { baseUrl: `${eps[0]!.scheme}://${host}`, host, ops, auth, skipped, title: opts.title ?? 'Inferred API' };
}
