import { createRequire } from 'node:module';
import path from 'node:path';
import type { JsonSchema } from '@browserforge/api-analyzer';
import type { Ir, IrOp } from './ir.js';
import { camel, pascal, snake, upperSnake } from './naming.js';
import { GEN_HEADER, paramNames, strLit, type GenOptions, type GeneratedClient } from './params.js';
import { readmeFor } from './python.js';

function tsType(s: JsonSchema | undefined): string {
  if (!s) return 'unknown';
  const types = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
  let t: string;
  if (types.length !== 1) t = types.length ? types.map((x) => tsType({ type: x })).join(' | ') : 'unknown';
  else switch (types[0]) {
    case 'string': t = 'string'; break;
    case 'integer': case 'number': t = 'number'; break;
    case 'boolean': t = 'boolean'; break;
    case 'null': t = 'null'; break;
    case 'array': t = `Array<${tsType(s.items)}>`; break;
    case 'object': t = s.properties ? `{ ${Object.entries(s.properties).map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : strLit(k)}?: ${tsType(v)}`).join('; ')} }` : 'Record<string, unknown>'; break;
    default: t = 'unknown';
  }
  return s.nullable && !t.includes('null') && t !== 'unknown' ? `${t} | null` : t;
}
const paramTs = (type: string) => (type === 'integer' || type === 'number' ? 'number' : type === 'boolean' ? 'boolean' : 'string');
const scalarArg = (type: string) => (type === 'integer' ? '1' : '"x"');

function resolveTsc(): string | undefined {
  try { return createRequire(import.meta.url).resolve('typescript/bin/tsc'); } catch { return undefined; }
}
function resolveTypesDir(): string | undefined {
  try { return path.resolve(path.dirname(createRequire(import.meta.url).resolve('@types/node/package.json')), '..'); } catch { return undefined; }
}

export function generateJsFamily(ir: Ir, opts: GenOptions, ts: boolean): GeneratedClient {
  const pkg = snake(opts.packageName) || 'api_client';
  const pkgName = pkg.replace(/_/g, '-');
  const prefix = upperSnake(pkg);
  const kinds = new Set(ir.auth.map((a) => a.kind));
  const apiKey = ir.auth.find((a) => a.kind === 'apiKeyHeader');
  const ext = ts ? 'ts' : 'js';

  // ---- models
  const modelDecls: string[] = [];
  const names = new Map<string, { req?: string; res?: string; params?: string }>();
  for (const op of ir.ops) {
    const m: { req?: string; res?: string; params?: string } = {};
    const decl = (n: string, schema: JsonSchema): boolean => {
      if (schema.type !== 'object' || !schema.properties) return false;
      const req = new Set(schema.required ?? []);
      const body = Object.entries(schema.properties).map(([k, v]) => `  ${/^[A-Za-z_$][\w$]*$/.test(k) ? k : strLit(k)}?: ${tsType(v)};${req.has(k) ? ' // always present in captured samples' : ''}`).join('\n');
      modelDecls.push(ts ? `export interface ${n} {\n${body}\n}\n` : `/**\n * @typedef {Object} ${n}\n${Object.entries(schema.properties).map(([k, v]) => ` * @property {${tsType(v).replace(/Array<(.*)>/, '$1[]')}} [${k}]`).join('\n')}\n */\n`);
      return true;
    };
    if (op.body && decl(pascal(op.name) + 'Request', op.body.schema)) m.req = pascal(op.name) + 'Request';
    if (op.response && decl(pascal(op.name) + 'Response', op.response.schema)) m.res = pascal(op.name) + 'Response';
    const pn = paramNames(op, 'typescript');
    if (op.kind === 'rest' && pn.query.length) {
      const n = pascal(op.name) + 'Params';
      modelDecls.push(ts ? `export interface ${n} {\n${pn.query.map((q) => `  ${/^[A-Za-z_$][\w$]*$/.test(q.wire) ? q.wire : strLit(q.wire)}?: ${paramTs(q.type)};`).join('\n')}\n}\n` : `/**\n * @typedef {Object} ${n}\n${pn.query.map((q) => ` * @property {${paramTs(q.type)}} [${q.wire}]`).join('\n')}\n */\n`);
      m.params = n;
    }
    names.set(op.name, m);
  }
  const modelsFile = `/** Shapes observed in captured traffic (all optional at the type level). ${GEN_HEADER} */\n${modelDecls.join('\n') || ''}${ts ? '\nexport {};\n' : '\nexport {};\n'}`;

  // ---- client
  const T = (s: string) => (ts ? s : '');
  const methods: string[] = [];
  for (const op of ir.ops) {
    const m = names.get(op.name)!;
    const pn = paramNames(op, 'typescript');
    const mname = camel(op.name);
    const args: string[] = pn.path.map((p) => `${p.local}${T(`: ${p.type === 'integer' ? 'number' : 'string'} | number`)}`);
    const doc = [`  /** ${op.summary} (confidence: ${op.confidence}, ${op.sampleCount} sample(s)) */`];
    let pathExpr = strLit(op.path);
    for (const p of pn.path) pathExpr += `.replace(${strLit('{' + p.wire + '}')}, encodeURIComponent(String(${p.local})))`;
    const ret = m.res ? m.res : 'unknown';
    let sig: string, bodyLines: string[];
    if (op.kind === 'graphql') {
      sig = `${mname}(${[...args, `variables${T(': Record<string, unknown>')} = {}`].join(', ')})${T(`: Promise<${ret}>`)}`;
      bodyLines = [`    const payload = { operationName: ${strLit(op.gql!.operationName)}, query: ${strLit(op.gql!.query ?? '')}, variables };`, `    return this.request("POST", ${pathExpr}, undefined, payload)${T(` as Promise<${ret}>`)};`];
    } else {
      if (op.body) args.push(`body${T(`?: ${m.req ?? 'Record<string, unknown>'}`)}`);
      if (m.params) args.push(`params${T(`: ${m.params}`)} = {}`);
      sig = `${mname}(${args.join(', ')})${T(`: Promise<${ret}>`)}`;
      bodyLines = [`    return this.request(${strLit(op.method)}, ${pathExpr}, ${m.params ? 'params' : 'undefined'}, ${op.body ? 'body' : 'undefined'})${T(` as Promise<${ret}>`)};`];
    }
    methods.push([...doc, `  async ${sig} {`, ...bodyLines, '  }'].join('\n'));

    const pg = op.pagination;
    if (pg && op.kind === 'rest' && m.params && pn.query.some((q) => q.wire === pg.param)) {
      const key = /^[A-Za-z_$][\w$]*$/.test(pg.param) ? pg.param : null;
      if (key) {
        const callArgs = [...pn.path.map((p) => p.local), ...(op.body ? ['undefined'] : []), `{ ...params, ${key}: pos }`].join(', ');
        const itemsExpr = pg.itemsField ? `(resp${T(' as any')})?.[${strLit(pg.itemsField)}] ?? []` : `Array.isArray(resp) ? resp : []`;
        const lines = [`  /** Yields every item across pages (${pg.style}-style pagination inferred from captured traffic). */`, `  async *iter${pascal(op.name)}(${[...pn.path.map((p) => `${p.local}${T(': string | number')}`), `params${T(`: ${m.params}`)} = {}`].join(', ')})${T(': AsyncGenerator<unknown, void, undefined>')} {`];
        if (pg.style === 'cursor') {
          lines.push(`    let pos${T(': string | undefined')} = params.${key}${T('')};`, `    for (;;) {`, `      const resp${T(': unknown')} = await this.${mname}(${callArgs});`, `      for (const item of ${itemsExpr}) yield item;`, `      pos = (resp${T(' as any')})?.[${strLit(pg.nextField!)}] ?? undefined;`, `      if (!pos) return;`, `    }`);
        } else {
          lines.push(`    let pos = params.${key} ?? ${pg.style === 'page' ? 1 : 0};`, `    for (;;) {`, `      const resp${T(': unknown')} = await this.${mname}(${callArgs});`, `      const items${T(': unknown[]')} = ${itemsExpr};`, `      for (const item of items) yield item;`, `      if (!items.length) return;`);
          if (pg.nextField && pg.style === 'page') lines.push(`      if (!(resp${T(' as any')})?.[${strLit(pg.nextField)}]) return;`);
          lines.push(pg.style === 'page' ? `      pos += 1;` : `      pos += items.length;`, `    }`);
        }
        lines.push('  }');
        methods.push(lines.join('\n'));
      }
    }
  }

  const optFields: [string, string][] = [kinds.has('bearer') ? (['token', 'string'] as [string, string]) : null, apiKey ? (['apiKey', 'string'] as [string, string]) : null, kinds.has('basic') ? (['username', 'string'] as [string, string]) : null, kinds.has('basic') ? (['password', 'string'] as [string, string]) : null, kinds.has('cookie') ? (['cookie', 'string'] as [string, string]) : null].filter((x): x is [string, string] => x !== null);
  const envName = (f: string) => ({ token: 'TOKEN', apiKey: 'API_KEY', username: 'USERNAME', password: 'PASSWORD', cookie: 'COOKIE' }[f]!);
  const clientSrc = `/**\n * API client. ${GEN_HEADER}\n * Credentials come from constructor options or ${prefix}_* environment variables, never from this file.\n */\n${ts ? `import type * as Models from "./models.js";\nexport type * from "./models.js";\n\n` : ''}const DEFAULT_BASE_URL = ${strLit(ir.baseUrl)};\nconst ENV_PREFIX = ${strLit(prefix)};\nconst RETRY_STATUSES = new Set([429, 502, 503, 504]);\nconst IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);\n\nexport class ApiError extends Error {\n${T('  status: number;\n  body: unknown;\n')}  constructor(status${T(': number')}, message${T(': string')}, body${T('?: unknown')}) {\n    super(\`HTTP \${status}: \${message}\`);\n    this.name = "ApiError";\n    this.status = status;\n    this.body = body;\n  }\n}\n\n${ts ? `export interface ClientOptions {\n  baseUrl?: string;\n${optFields.map(([f, t]) => `  ${f}?: ${t};`).join('\n')}\n  timeoutMs?: number;\n  maxRetries?: number;\n  backoffMs?: number;\n  headers?: Record<string, string>;\n  /** Override fetch (testing). */\n  fetch?: typeof fetch;\n}\n` : `/**\n * @typedef {Object} ClientOptions\n * @property {string} [baseUrl]\n${optFields.map(([f, t]) => ` * @property {${t}} [${f}]`).join('\n')}\n * @property {number} [timeoutMs]\n * @property {number} [maxRetries]\n * @property {number} [backoffMs]\n * @property {Record<string, string>} [headers]\n * @property {typeof fetch} [fetch]\n */\n`}\nconst env = (name${T(': string')})${T(': string | undefined')} => (globalThis${T(' as any')}).process?.env?.[ENV_PREFIX + "_" + name];\nconst sleep = (ms${T(': number')}) => new Promise((r) => setTimeout(r, ms));\n\nexport class Client {\n${ts ? `  private baseUrl: string;\n  private timeoutMs: number;\n  private maxRetries: number;\n  private backoffMs: number;\n  private headers: Record<string, string>;\n  private fetchImpl: typeof fetch;\n${optFields.map(([f]) => `  private ${f}?: string;`).join('\n')}\n` : ''}\n  constructor(${T('options: ClientOptions')}${ts ? ' = {}' : 'options = {}'}) {\n    this.baseUrl = (options.baseUrl ?? env("BASE_URL") ?? DEFAULT_BASE_URL).replace(/\\/+$/, "");\n${optFields.map(([f]) => `    this.${f} = options.${f} ?? env(${strLit(envName(f))});`).join('\n')}\n    this.timeoutMs = options.timeoutMs ?? 30000;\n    this.maxRetries = options.maxRetries ?? 2;\n    this.backoffMs = options.backoffMs ?? 500;\n    this.headers = { ...(options.headers ?? {}) };\n    this.fetchImpl = options.fetch ?? fetch;\n  }\n\n  ${T('private ')}authHeaders()${T(': Record<string, string>')} {\n    const h${T(': Record<string, string>')} = {};\n${kinds.has('bearer') ? '    if (this.token) h["Authorization"] = `Bearer ${this.token}`;\n' : ''}${kinds.has('basic') ? '    if (this.username !== undefined && this.password !== undefined) h["Authorization"] = "Basic " + btoa(`${this.username}:${this.password}`);\n' : ''}${apiKey ? `    if (this.apiKey) h[${strLit(apiKey.name ?? 'X-Api-Key')}] = this.apiKey;\n` : ''}${kinds.has('cookie') ? '    if (this.cookie) h["Cookie"] = this.cookie;\n' : ''}    return h;\n  }\n\n  ${T('private ')}async request(method${T(': string')}, path${T(': string')}, query${T('?: object')}, body${T('?: unknown')})${T(': Promise<unknown>')} {\n    const qs = new URLSearchParams();\n    for (const [k, v] of Object.entries(query ?? {})) {\n      if (v === undefined || v === null) continue;\n      for (const item of Array.isArray(v) ? v : [v]) qs.append(k, String(item));\n    }\n    const url = this.baseUrl + path + (qs.toString() ? "?" + qs.toString() : "");\n    const headers${T(': Record<string, string>')} = { Accept: "application/json", ...this.headers, ...this.authHeaders() };\n    if (body !== undefined) headers["Content-Type"] = "application/json";\n    const retryable = IDEMPOTENT.has(method) ? RETRY_STATUSES : new Set([429]);\n    for (let attempt = 0; ; attempt++) {\n      const ctrl = new AbortController();\n      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);\n      let res${T(': Response')};\n      try {\n        res = await this.fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });\n      } catch (e) {\n        clearTimeout(timer);\n        if (IDEMPOTENT.has(method) && attempt < this.maxRetries) { await sleep(this.backoffMs * 2 ** attempt); continue; }\n        throw new ApiError(0, e instanceof Error ? e.message : "network error");\n      }\n      clearTimeout(timer);\n      const text = await res.text();\n      let parsed${T(': unknown')} = text;\n      try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }\n      if (res.ok) return parsed;\n      if (retryable.has(res.status) && attempt < this.maxRetries) {\n        const ra = Number(res.headers.get("retry-after"));\n        await sleep(ra > 0 ? Math.min(ra, 30) * 1000 : this.backoffMs * 2 ** attempt);\n        continue;\n      }\n      throw new ApiError(res.status, res.statusText || "error", parsed);\n    }\n  }\n\n${methods.join('\n\n')}\n}\n`;
  const clientFinal = ts ? clientSrc.replace(/\b(Promise<)(\w+Response)>/g, '$1Models.$2>').replace(/ as Promise<(\w+Response)>/g, ' as Promise<Models.$1>').replace(/body\?: (\w+Request)/g, 'body?: Models.$1').replace(/params: (\w+Params)/g, 'params: Models.$1') : clientSrc;
  const indexSrc = `export { ApiError, Client } from "./client.js";\n${ts ? 'export type { ClientOptions } from "./client.js";\nexport type * from "./models.js";\n' : ''}`;

  // ---- tests
  const get = ir.ops.find((o) => o.kind === 'rest' && o.method === 'GET');
  const post = ir.ops.find((o) => o.kind === 'rest' && o.method === 'POST');
  const pathArgs = (op: IrOp) => paramNames(op, 'typescript').path.map((p) => scalarArg(p.type));
  const expPath = (op: IrOp) => op.path.replace(/\{[^}]+\}/g, (m) => (op.pathParams.find((p) => `{${p.wire}}` === m)?.type === 'integer' ? '1' : 'x'));
  const tests: string[] = [];
  const A = ts ? ' as any' : '';
  if (get) {
    const gn = camel(get.name);
    const gq = paramNames(get, 'typescript').query[0];
    tests.push(`test("builds the request path and headers", async () => {\n  stub.queue(200, { ok: true });\n  const res = await client().${gn}(${pathArgs(get).join(', ')});\n  assert.deepEqual(res, { ok: true });\n  const r = stub.requests[0]${A};\n  assert.equal(r.method, "GET");\n  assert.equal(r.url.split("?")[0], ${strLit(expPath(get))});\n  assert.equal(r.headers["accept"], "application/json");\n});`);
    if (gq) tests.push(`test("encodes query parameters", async () => {\n  stub.queue(200, {});\n  await client().${gn}(${[...pathArgs(get), ...(get.body ? ['undefined'] : []), `{ ${strLit(gq.wire)}: ${gq.type === 'integer' ? '7' : '"v 1"'} }`].join(', ')});\n  assert.ok((stub.requests[0]${A}).url.includes(${strLit(gq.wire + '=')}));\n});`);
    tests.push(`test("retries transient errors on GET", async () => {\n  stub.queue(503, { error: "busy" });\n  stub.queue(200, { ok: true });\n  assert.deepEqual(await client().${gn}(${pathArgs(get).join(', ')}), { ok: true });\n  assert.equal(stub.requests.length, 2);\n});`);
    tests.push(`test("non-2xx raises ApiError with status and body", async () => {\n  stub.queue(404, { error: "not_found" });\n  await assert.rejects(client().${gn}(${pathArgs(get).join(', ')}), (e${T(': any')}) => e.name === "ApiError" && e.status === 404 && e.body.error === "not_found");\n});`);
  }
  if (post) {
    const pn = camel(post.name);
    const pargs = [...pathArgs(post), ...(post.body ? ['{}'] : [])].join(', ');
    tests.push(`test("POST is not retried on 503", async () => {\n  stub.queue(503, {});\n  stub.queue(200, {});\n  await assert.rejects(client().${pn}(${pargs}), (e${T(': any')}) => e instanceof ApiError && e.status === 503);\n  assert.equal(stub.requests.length, 1);\n});`);
    if (post.body) tests.push(`test("POST sends a JSON body", async () => {\n  stub.queue(200, {});\n  await client().${pn}(${[...pathArgs(post), '{ a: 1 }' + A].join(', ')});\n  const r = stub.requests[0]${A};\n  assert.equal(r.method, "POST");\n  assert.deepEqual(JSON.parse(r.body), { a: 1 });\n  assert.equal(r.headers["content-type"], "application/json");\n});`);
  }
  const anyOp = get ?? ir.ops[0]!;
  if (kinds.has('bearer')) tests.push(`test("sends the bearer token when configured", async () => {\n  stub.queue(200, {});\n  await new Client({ baseUrl: stub.url, token: "unit-test-token", maxRetries: 0 }).${camel(anyOp.name)}(${pathArgs(anyOp).join(', ')});\n  assert.equal((stub.requests[0]${A}).headers["authorization"], "Bearer unit-test-token");\n});`);
  if (apiKey) tests.push(`test("sends the API key header when configured", async () => {\n  stub.queue(200, {});\n  await new Client({ baseUrl: stub.url, apiKey: "unit-test-key", maxRetries: 0 }).${camel(anyOp.name)}(${pathArgs(anyOp).join(', ')});\n  assert.equal((stub.requests[0]${A}).headers[${strLit((apiKey.name ?? 'X-Api-Key').toLowerCase())}], "unit-test-key");\n});`);
  const pgOp = ir.ops.find((o) => o.pagination && o.kind === 'rest' && paramNames(o, 'typescript').query.some((q) => q.wire === o.pagination!.param) && /^[A-Za-z_$][\w$]*$/.test(o.pagination!.param));
  if (pgOp) {
    const pg = pgOp.pagination!;
    const wrap = (items: number[], next: unknown) => (pg.itemsField ? { [pg.itemsField]: items, ...(pg.nextField ? { [pg.nextField]: next } : {}) } : items);
    tests.push(`test("iter follows ${pg.style} pagination", async () => {\n  stub.queue(200, ${JSON.stringify(wrap([1, 2], pg.style === 'cursor' ? 'c2' : 2))});\n  stub.queue(200, ${JSON.stringify(wrap([3], null))});\n  stub.queue(200, ${JSON.stringify(wrap([], null))});\n  const got${T(': unknown[]')} = [];\n  for await (const item of client().iter${pascal(pgOp.name)}(${pathArgs(pgOp).join(', ')})) got.push(item);\n  assert.deepEqual(got, [1, 2, 3]);\n  assert.ok((stub.requests[1]${A}).url.includes(${strLit(pg.param + '=')}));\n});`);
  }
  const testSrc = `import assert from "node:assert/strict";\nimport http from "node:http";\nimport { after, beforeEach, test } from "node:test";\nimport { ApiError, Client } from "../src/index.js";\n\n${ts ? 'interface Seen { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }\n' : ''}class Stub {\n${ts ? '  requests: Seen[] = [];\n  responses: Array<[number, unknown]> = [];\n  server: http.Server;\n  url = "";\n' : ''}  constructor() {\n    ${ts ? '' : 'this.requests = []; this.responses = [];\n    '}this.server = http.createServer((req, res) => {\n      const chunks${T(': Buffer[]')} = [];\n      req.on("data", (c) => chunks.push(c));\n      req.on("end", () => {\n        this.requests.push({ method: req.method${T('!')}, url: req.url${T('!')}, headers: req.headers, body: Buffer.concat(chunks).toString() });\n        const [status, payload] = this.responses.shift() ?? [200, {}];\n        res.writeHead(status, { "content-type": "application/json" });\n        res.end(JSON.stringify(payload));\n      });\n    });\n  }\n  async start() {\n    await new Promise${T('<void>')}((r) => this.server.listen(0, "127.0.0.1", () => r()));\n    this.url = \`http://127.0.0.1:\${(this.server.address()${T(' as any')}).port}\`;\n  }\n  queue(status${T(': number')}, payload${T(': unknown')}) { this.responses.push([status, payload]); }\n  reset() { this.requests = []; this.responses = []; }\n}\n\nconst stub = new Stub();\nawait stub.start();\nafter(() => stub.server.close());\nbeforeEach(() => stub.reset());\nconst client = () => new Client({ baseUrl: stub.url, maxRetries: 2, backoffMs: 0 });\n\n${tests.join('\n\n') || 'test("client constructs", () => { assert.ok(new Client({ baseUrl: stub.url })); });'}\n`;
  const first = get ?? ir.ops[0]!;
  const exampleSrc = `import { Client, ApiError } from "${ts ? './src/index.js' : './src/index.js'}";\n\n// Credentials come from ${prefix}_* environment variables (or constructor options), not from this file.\nconst client = new Client();\ntry {\n  console.log(await client.${camel(first.name)}(${pathArgs(first).join(', ')}));\n} catch (e) {\n  if (e instanceof ApiError) console.error("request failed:", e.status, e.body);\n  else throw e;\n}\n`;
  const readme = readmeFor(ir, ts ? 'TypeScript' : 'JavaScript', prefix, `import { Client } from "./src/index.js";\nconst client = new Client(); // base URL and credentials from ${prefix}_* environment variables\nawait client.${camel(first.name)}(${pathArgs(first).join(', ')});`, ts ? 'npm install && npm test' : 'npm test', kinds);

  const files: Record<string, string> = {
    [`src/client.${ext}`]: clientFinal, [`src/index.${ext}`]: indexSrc, [`src/models.${ext}`]: modelsFile, [`example.${ext === 'ts' ? 'mts' : 'mjs'}`]: exampleSrc, 'README.md': readme,
    'package.json': JSON.stringify({ name: pkgName, version: '0.1.0', private: true, type: 'module', main: ts ? 'dist/src/index.js' : 'src/index.js', types: ts ? 'dist/src/index.d.ts' : undefined, engines: { node: '>=18' }, scripts: ts ? { build: 'tsc', test: 'tsc && node --test dist/test/client.test.js' } : { test: 'node --test test/client.test.js' }, devDependencies: ts ? { typescript: '^5.4.0', '@types/node': '^20.0.0' } : undefined }, null, 2) + '\n',
  };
  if (ts) files['tsconfig.json'] = JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, declaration: true, outDir: 'dist', rootDir: '.', skipLibCheck: true, types: ['node'] }, include: ['src', 'test'] }, null, 2) + '\n';
  if (opts.tests !== false) files[`test/client.test.${ext}`] = testSrc;

  const checks: GeneratedClient['checks'] = [];
  if (ts) {
    const tsc = resolveTsc(), types = resolveTypesDir();
    checks.push(tsc ? { name: 'tsc', cmd: ['node', tsc, '-p', '.', ...(types ? ['--typeRoots', types] : [])] } : { name: 'tsc', cmd: ['tsc-not-installed'] });
    if (opts.tests !== false) checks.push({ name: 'node --test', cmd: ['node', '--test', 'dist/test/client.test.js'] });
  } else {
    checks.push({ name: 'node --check', cmd: ['node', '--check', 'src/client.js'] }, { name: 'node --check index', cmd: ['node', '--check', 'src/index.js'] });
    if (opts.tests !== false) checks.push({ name: 'node --test', cmd: ['node', '--test', 'test/client.test.js'] });
  }
  return { language: ts ? 'typescript' : 'javascript', files, checks, entry: `src/client.${ext}` };
}
