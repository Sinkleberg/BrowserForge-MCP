import type { JsonSchema } from '@browserforge/api-analyzer';
import type { Ir, IrOp } from './ir.js';
import { pascal, snake, upperSnake } from './naming.js';
import { GEN_HEADER, paramNames, strLit, type GenOptions, type GeneratedClient } from './params.js';

function pyType(s: JsonSchema | undefined): string {
  if (!s) return 'Any';
  const types = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
  let t: string;
  if (types.length !== 1) t = 'Any';
  else switch (types[0]) {
    case 'string': t = 'str'; break;
    case 'integer': t = 'int'; break;
    case 'number': t = 'float'; break;
    case 'boolean': t = 'bool'; break;
    case 'null': t = 'None'; break;
    case 'array': t = `List[${pyType(s.items)}]`; break;
    case 'object': t = 'Dict[str, Any]'; break;
    default: t = 'Any';
  }
  return s.nullable && t !== 'Any' && t !== 'None' ? `Optional[${t}]` : t;
}

function typedDict(name: string, schema: JsonSchema): string | undefined {
  if (schema.type !== 'object' || !schema.properties) return undefined;
  const fields = Object.entries(schema.properties).map(([k, v]) => `    ${strLit(k)}: ${pyType(v)},`).join('\n');
  const req = new Set(schema.required ?? []);
  const doc = `# always present in the captured samples: ${[...req].join(', ') || '(none)'}`;
  return `${doc}\n${name} = TypedDict(${strLit(name)}, {\n${fields}\n}, total=False)\n`;
}

const scalarArg = (type: string) => (type === 'integer' ? '1' : '"x"');

export function generatePython(ir: Ir, opts: GenOptions): GeneratedClient {
  const pkg = snake(opts.packageName) || 'api_client';
  const prefix = upperSnake(pkg);
  const kinds = new Set(ir.auth.map((a) => a.kind));
  const apiKey = ir.auth.find((a) => a.kind === 'apiKeyHeader');
  const cookieName = ir.auth.find((a) => a.kind === 'cookie');

  // ---- models
  const models: string[] = [];
  const modelFor = new Map<string, { req?: string; res?: string }>();
  for (const op of ir.ops) {
    const m: { req?: string; res?: string } = {};
    if (op.body) { const n = pascal(op.name) + 'Request'; const d = typedDict(n, op.body.schema); if (d) { models.push(d); m.req = n; } }
    if (op.response) { const n = pascal(op.name) + 'Response'; const d = typedDict(n, op.response.schema); if (d) { models.push(d); m.res = n; } }
    modelFor.set(op.name, m);
  }
  const modelsPy = `"""Response/request shapes observed in captured traffic. All keys are optional at the type level; see comments for keys seen in every sample.\n\n${GEN_HEADER}\n"""\nfrom typing import Any, Dict, List, Optional, TypedDict\n\n${models.join('\n') || '# (no object models were inferred)\n'}\n__all__ = [${models.map((m) => strLit(/^[^\n]*\n(\w+) =/.exec(m)?.[1] ?? '')).filter((x) => x !== '""').join(', ')}]\n`;

  // ---- client
  const authParams = [kinds.has('bearer') ? 'token: Optional[str] = None' : '', apiKey ? 'api_key: Optional[str] = None' : '', kinds.has('basic') ? 'username: Optional[str] = None' : '', kinds.has('basic') ? 'password: Optional[str] = None' : '', cookieName ? 'cookie: Optional[str] = None' : ''].filter(Boolean);
  const authInit = [
    kinds.has('bearer') ? `        self.token = token if token is not None else os.environ.get(ENV_PREFIX + "_TOKEN")` : '',
    apiKey ? `        self.api_key = api_key if api_key is not None else os.environ.get(ENV_PREFIX + "_API_KEY")` : '',
    kinds.has('basic') ? `        self.username = username if username is not None else os.environ.get(ENV_PREFIX + "_USERNAME")\n        self.password = password if password is not None else os.environ.get(ENV_PREFIX + "_PASSWORD")` : '',
    cookieName ? `        self.cookie = cookie if cookie is not None else os.environ.get(ENV_PREFIX + "_COOKIE")` : '',
  ].filter(Boolean).join('\n');
  const authHeaders = [
    kinds.has('bearer') ? `        if getattr(self, "token", None):\n            h["Authorization"] = "Bearer " + self.token` : '',
    kinds.has('basic') ? `        if getattr(self, "username", None) is not None and getattr(self, "password", None) is not None:\n            h["Authorization"] = "Basic " + base64.b64encode(("%s:%s" % (self.username, self.password)).encode()).decode()` : '',
    apiKey ? `        if getattr(self, "api_key", None):\n            h[${strLit(apiKey.name ?? 'X-Api-Key')}] = self.api_key` : '',
    cookieName ? `        if getattr(self, "cookie", None):\n            h["Cookie"] = self.cookie` : '',
  ].filter(Boolean).join('\n');

  const methods: string[] = [];
  for (const op of ir.ops) {
    const names = paramNames(op, 'python');
    const m = modelFor.get(op.name)!;
    const sig: string[] = ['self', ...names.path.map((p) => `${p.local}: ${p.type === 'integer' ? 'int' : 'str'}`)];
    const kw: string[] = [];
    if (op.kind === 'graphql') kw.push('variables: Optional[Dict[str, Any]] = None');
    else {
      for (const q of names.query) kw.push(`${q.local}: Optional[${q.type === 'integer' ? 'int' : q.type === 'number' ? 'float' : q.type === 'boolean' ? 'bool' : 'str'}] = None`);
      if (op.body) kw.push(`body: Optional[${m.req ? `"${m.req}"` : 'Dict[str, Any]'}] = None`);
    }
    const ret = m.res ? `"${m.res}"` : 'Any';
    const lines: string[] = [];
    lines.push(`    def ${op.name}(${[...sig, ...(kw.length ? ['*', ...kw] : [])].join(', ')}) -> ${ret}:`);
    lines.push(`        """${op.summary} (confidence: ${op.confidence}, ${op.sampleCount} sample(s))"""`);
    let pathExpr = strLit(op.path);
    for (const p of names.path) pathExpr += `.replace(${strLit('{' + p.wire + '}')}, _quote(${p.local}))`;
    lines.push(`        path = ${pathExpr}`);
    if (op.kind === 'graphql') {
      lines.push(`        payload = {"operationName": ${strLit(op.gql!.operationName)}, "query": ${strLit(op.gql!.query ?? '')}, "variables": variables or {}}`);
      lines.push(`        return self._request("POST", path, None, payload)`);
    } else {
      lines.push(`        query = {${names.query.map((q) => `${strLit(q.wire)}: ${q.local}`).join(', ')}}`);
      lines.push(`        return self._request(${strLit(op.method)}, path, query, ${op.body ? 'body' : 'None'})`);
    }
    methods.push(lines.join('\n'));

    const pg = op.pagination;
    if (pg && op.kind === 'rest') {
      const pname = names.query.find((q) => q.wire === pg.param)?.local;
      if (pname) {
        const others = names.query.filter((q) => q.local !== pname);
        const args = [...names.path.map((p) => p.local), ...others.map((q) => `${q.local}=${q.local}`)].join(', ');
        const itemsExpr = pg.itemsField ? `resp.get(${strLit(pg.itemsField)}) or [] if isinstance(resp, dict) else resp or []` : 'resp or []';
        const body: string[] = [];
        body.push(`    def iter_${op.name}(${[...sig, '*', ...names.query.filter((q) => q.local !== pname).map((q) => `${q.local}: Optional[${q.type === 'integer' ? 'int' : q.type === 'number' ? 'float' : q.type === 'boolean' ? 'bool' : 'str'}] = None`), `${pname}: Optional[${pg.style === 'cursor' ? 'str' : 'int'}] = None`].join(', ')}) -> Iterator[Any]:`);
        body.push(`        """Yield every item across pages (${pg.style}-style pagination, inferred from captured traffic)."""`);
        if (pg.style === 'cursor') {
          body.push(`        cursor = ${pname}`, `        while True:`, `            resp = self.${op.name}(${[args, `${pname}=cursor`].filter(Boolean).join(', ')})`, `            for item in (${itemsExpr}):`, `                yield item`, `            cursor = resp.get(${strLit(pg.nextField!)}) if isinstance(resp, dict) else None`, `            if not cursor:`, `                return`);
        } else {
          const start = pg.style === 'page' ? '1' : '0';
          body.push(`        pos = ${pname} if ${pname} is not None else ${start}`, `        while True:`, `            resp = self.${op.name}(${[args, `${pname}=pos`].filter(Boolean).join(', ')})`, `            items = ${itemsExpr}`, `            for item in items:`, `                yield item`, `            if not items:`, `                return`);
          if (pg.nextField && pg.style === 'page') body.push(`            if isinstance(resp, dict) and not resp.get(${strLit(pg.nextField)}):`, `                return`);
          body.push(pg.style === 'page' ? `            pos += 1` : `            pos += len(items)`);
        }
        methods.push(body.join('\n'));
      }
    }
  }

  const clientPy = `"""API client. ${GEN_HEADER}\n\nCredentials are read from constructor arguments or environment variables (prefix ${prefix}_), never from this file.\n"""\nimport base64\nimport json\nimport os\nimport time\nimport urllib.error\nimport urllib.parse\nimport urllib.request\nfrom typing import Any, Dict, Iterator, List, Optional\n\nfrom .models import *  # noqa: F401,F403\n\nDEFAULT_BASE_URL = ${strLit(ir.baseUrl)}\nENV_PREFIX = ${strLit(prefix)}\nRETRY_STATUSES = (429, 502, 503, 504)\nIDEMPOTENT_METHODS = ("GET", "HEAD", "PUT", "DELETE", "OPTIONS")\n\n\nclass ApiError(Exception):\n    """Raised for non-2xx responses (status 0 = network error/timeout)."""\n\n    def __init__(self, status: int, message: str, body: Any = None):\n        super().__init__("HTTP %s: %s" % (status, message))\n        self.status = status\n        self.body = body\n\n\ndef _quote(value: Any) -> str:\n    return urllib.parse.quote(str(value), safe="")\n\n\ndef _encode_query(query: Optional[Dict[str, Any]]) -> str:\n    pairs: List = []\n    for key, value in (query or {}).items():\n        if value is None:\n            continue\n        values = value if isinstance(value, (list, tuple)) else [value]\n        for v in values:\n            pairs.append((key, "true" if v is True else "false" if v is False else str(v)))\n    return urllib.parse.urlencode(pairs)\n\n\nclass Client:\n    def __init__(self, base_url: Optional[str] = None, *, ${[...authParams, 'timeout: float = 30.0', 'max_retries: int = 2', 'backoff: float = 0.5', 'headers: Optional[Dict[str, str]] = None'].join(', ')}):\n        self.base_url = (base_url or os.environ.get(ENV_PREFIX + "_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")\n${authInit ? authInit + '\n' : ''}        self.timeout = timeout\n        self.max_retries = max_retries\n        self.backoff = backoff\n        self.headers = dict(headers or {})\n\n    def _auth_headers(self) -> Dict[str, str]:\n        h: Dict[str, str] = {}\n${authHeaders ? authHeaders + '\n' : ''}        return h\n\n    def _request(self, method: str, path: str, query: Optional[Dict[str, Any]] = None, body: Any = None) -> Any:\n        url = self.base_url + path\n        qs = _encode_query(query)\n        if qs:\n            url += "?" + qs\n        data = None\n        headers = {"Accept": "application/json"}\n        headers.update(self.headers)\n        headers.update(self._auth_headers())\n        if body is not None:\n            data = json.dumps(body).encode("utf-8")\n            headers["Content-Type"] = "application/json"\n        retry_statuses = RETRY_STATUSES if method in IDEMPOTENT_METHODS else (429,)\n        attempt = 0\n        while True:\n            req = urllib.request.Request(url, data=data, method=method, headers=headers)\n            try:\n                with urllib.request.urlopen(req, timeout=self.timeout) as resp:\n                    return _parse(resp.read())\n            except urllib.error.HTTPError as e:\n                raw = e.read()\n                if e.code in retry_statuses and attempt < self.max_retries:\n                    delay = _retry_after(e.headers.get("Retry-After")) or self.backoff * (2 ** attempt)\n                    time.sleep(delay)\n                    attempt += 1\n                    continue\n                parsed = _parse(raw)\n                raise ApiError(e.code, e.reason or "error", parsed)\n            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:\n                if method in IDEMPOTENT_METHODS and attempt < self.max_retries:\n                    time.sleep(self.backoff * (2 ** attempt))\n                    attempt += 1\n                    continue\n                raise ApiError(0, str(getattr(e, "reason", e)))\n\n${methods.join('\n\n')}\n\n\ndef _parse(raw: bytes) -> Any:\n    if not raw:\n        return None\n    try:\n        return json.loads(raw.decode("utf-8"))\n    except ValueError:\n        return raw.decode("utf-8", "replace")\n\n\ndef _retry_after(value: Optional[str]) -> float:\n    try:\n        return min(float(value), 30.0) if value else 0.0\n    except ValueError:\n        return 0.0\n`;

  const initPy = `"""${GEN_HEADER}"""\nfrom .client import ApiError, Client\n\n__all__ = ["ApiError", "Client"]\n`;

  // ---- tests
  const get = ir.ops.find((o) => o.kind === 'rest' && o.method === 'GET');
  const post = ir.ops.find((o) => o.kind === 'rest' && o.method === 'POST');
  const call = (op: IrOp) => {
    const names = paramNames(op, 'python');
    const args: string[] = names.path.map((p) => scalarArg(p.type));
    if (op.body) args.push('body={}');
    return `self.client().${op.name}(${args.join(', ')})`;
  };
  const tests: string[] = [];
  if (get) {
    const names = paramNames(get, 'python');
    const exp = get.path.replace(/\{[^}]+\}/g, (m) => (get.pathParams.find((p) => `{${p.wire}}` === m)?.type === 'integer' ? '1' : 'x'));
    tests.push(`    def test_request_path_and_headers(self):\n        self.stub.queue(200, {"ok": True})\n        result = ${call(get)}\n        self.assertEqual(result, {"ok": True})\n        method, path, headers, _ = self.stub.requests[0]\n        self.assertEqual(method, "GET")\n        self.assertEqual(path.split("?")[0], ${strLit(exp)})\n        self.assertEqual(headers.get("Accept"), "application/json")\n`);
    if (names.query[0]) tests.push(`    def test_query_params_are_encoded(self):\n        self.stub.queue(200, {})\n        c = self.client()\n        c.${get.name}(${[...names.path.map((p) => scalarArg(p.type)), `${names.query[0].local}=${names.query[0].type === 'integer' ? '7' : '"v 1"'}`].join(', ')})\n        self.assertIn(${strLit(names.query[0].wire + '=')}, self.stub.requests[0][1])\n`);
    tests.push(`    def test_retries_transient_errors_on_get(self):\n        self.stub.queue(503, {"error": "busy"})\n        self.stub.queue(200, {"ok": True})\n        self.assertEqual(${call(get)}, {"ok": True})\n        self.assertEqual(len(self.stub.requests), 2)\n\n    def test_error_status_raises_api_error(self):\n        self.stub.queue(404, {"error": "not_found"})\n        with self.assertRaises(ApiError) as ctx:\n            ${call(get)}\n        self.assertEqual(ctx.exception.status, 404)\n        self.assertEqual(ctx.exception.body, {"error": "not_found"})\n`);
  }
  if (post) tests.push(`    def test_post_is_not_retried_on_503(self):\n        self.stub.queue(503, {})\n        self.stub.queue(200, {})\n        with self.assertRaises(ApiError):\n            ${call(post)}\n        self.assertEqual(len(self.stub.requests), 1)\n\n    def test_post_sends_json_body(self):\n        self.stub.queue(200, {})\n        c = self.client()\n        c.${post.name}(${[...paramNames(post, 'python').path.map((p) => scalarArg(p.type)), ...(post.body ? ['body={"a": 1}'] : [])].join(', ')})\n        method, _, headers, body = self.stub.requests[0]\n        self.assertEqual(method, "POST")\n${post.body ? '        self.assertEqual(json.loads(body), {"a": 1})\n        self.assertEqual(headers.get("Content-Type"), "application/json")\n' : '        self.assertEqual(body, b"")\n'}`);
  if (kinds.has('bearer')) tests.push(`    def test_bearer_token_is_sent_when_configured(self):\n        self.stub.queue(200, {})\n        c = Client(self.stub.url, token="unit-test-token", max_retries=0)\n        c.${(get ?? ir.ops[0]!).name}(${paramNames(get ?? ir.ops[0]!, 'python').path.map((p) => scalarArg(p.type)).join(', ')})\n        self.assertEqual(self.stub.requests[0][2].get("Authorization"), "Bearer unit-test-token")\n`);
  if (apiKey) tests.push(`    def test_api_key_header_is_sent_when_configured(self):\n        self.stub.queue(200, {})\n        c = Client(self.stub.url, api_key="unit-test-key", max_retries=0)\n        c.${(get ?? ir.ops[0]!).name}(${paramNames(get ?? ir.ops[0]!, 'python').path.map((p) => scalarArg(p.type)).join(', ')})\n        self.assertEqual(self.stub.requests[0][2].get(${strLit(apiKey.name ?? 'X-Api-Key')}), "unit-test-key")\n`);
  const pgOp = ir.ops.find((o) => o.pagination && o.kind === 'rest' && paramNames(o, 'python').query.some((q) => q.wire === o.pagination!.param));
  if (pgOp) {
    const pg = pgOp.pagination!;
    const names = paramNames(pgOp, 'python');
    const items = (n: number[]) => (pg.itemsField ? { [pg.itemsField]: n } : n);
    const page1: unknown = pg.itemsField ? { ...items([1, 2]), ...(pg.nextField ? { [pg.nextField]: pg.style === 'cursor' ? 'c2' : 2 } : {}) } : [1, 2];
    const page2: unknown = pg.itemsField ? { ...items([3]), ...(pg.nextField ? { [pg.nextField]: null } : {}) } : [3];
    tests.push(`    def test_iter_follows_${pg.style}_pagination(self):\n        self.stub.queue(200, ${JSON.stringify(page1).replace(/null/g, 'None')})\n        self.stub.queue(200, ${JSON.stringify(page2).replace(/null/g, 'None')})\n        self.stub.queue(200, ${JSON.stringify(pg.itemsField ? items([]) : [])})\n        c = self.client()\n        got = list(c.iter_${pgOp.name}(${names.path.map((p) => scalarArg(p.type)).join(', ')}))\n        self.assertEqual(got, [1, 2, 3])\n        self.assertIn(${strLit(pg.param + '=')}, self.stub.requests[1][1])\n`);
  }
  const testPy = `import json\nimport threading\nimport unittest\nfrom http.server import BaseHTTPRequestHandler, ThreadingHTTPServer\n\nfrom ${pkg} import ApiError, Client\n\n\nclass Stub:\n    """Local HTTP server returning queued responses and recording requests."""\n\n    def __init__(self):\n        self.requests = []\n        self.responses = []\n        stub = self\n\n        class Handler(BaseHTTPRequestHandler):\n            def _handle(self):\n                length = int(self.headers.get("Content-Length") or 0)\n                body = self.rfile.read(length) if length else b""\n                stub.requests.append((self.command, self.path, dict(self.headers), body))\n                status, payload = stub.responses.pop(0) if stub.responses else (200, {})\n                raw = json.dumps(payload).encode()\n                self.send_response(status)\n                self.send_header("Content-Type", "application/json")\n                self.send_header("Content-Length", str(len(raw)))\n                self.end_headers()\n                self.wfile.write(raw)\n\n            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _handle\n\n            def log_message(self, *args):\n                pass\n\n        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)\n        self.url = "http://127.0.0.1:%d" % self.server.server_address[1]\n        threading.Thread(target=self.server.serve_forever, daemon=True).start()\n\n    def queue(self, status, payload):\n        self.responses.append((status, payload))\n\n    def close(self):\n        self.server.shutdown()\n        self.server.server_close()\n\n\nclass ClientTests(unittest.TestCase):\n    def setUp(self):\n        self.stub = Stub()\n\n    def tearDown(self):\n        self.stub.close()\n\n    def client(self):\n        return Client(self.stub.url, max_retries=2, backoff=0)\n\n${tests.length ? tests.join('\n').replace(/self\.assertEqual\(c\./g, 'self.assertEqual(self.client().') : '    def test_placeholder(self):\n        self.assertTrue(Client(self.stub.url))\n'}\n\nif __name__ == "__main__":\n    unittest.main()\n`;

  const first = get ?? ir.ops[0]!;
  const example = `"""Example usage. Credentials come from the environment (${prefix}_TOKEN etc.), not from this file."""\nfrom ${pkg} import Client, ApiError\n\nclient = Client()\ntry:\n    result = client.${first.name}(${paramNames(first, 'python').path.map((p) => scalarArg(p.type)).join(', ')})\n    print(result)\nexcept ApiError as e:\n    print("request failed:", e.status, e.body)\n`;
  const readme = readmeFor(ir, 'Python', prefix, `from ${pkg} import Client\nclient = Client()  # base URL and credentials from ${prefix}_* environment variables\nclient.${first.name}(${paramNames(first, 'python').path.map((p) => scalarArg(p.type)).join(', ')})`, `python -m unittest discover -s tests`, kinds);
  const pyproject = `[project]\nname = ${strLit(pkg.replace(/_/g, '-'))}\nversion = "0.1.0"\ndescription = "API client generated from captured traffic"\nrequires-python = ">=3.8"\n\n[build-system]\nrequires = ["setuptools"]\nbuild-backend = "setuptools.build_meta"\n\n[tool.setuptools]\npackages = [${strLit(pkg)}]\n`;

  const files: Record<string, string> = { [`${pkg}/__init__.py`]: initPy, [`${pkg}/client.py`]: clientPy, [`${pkg}/models.py`]: modelsPy, 'example_usage.py': example, 'README.md': readme, 'pyproject.toml': pyproject };
  if (opts.tests !== false) { files['tests/__init__.py'] = ''; files['tests/test_client.py'] = testPy; }
  return {
    language: 'python', files, entry: `${pkg}/client.py`,
    checks: [
      { name: 'py_compile', cmd: ['python3', '-m', 'compileall', '-q', pkg, 'tests', 'example_usage.py'] },
      ...(opts.tests !== false ? [{ name: 'unittest', cmd: ['python3', '-m', 'unittest', 'discover', '-s', 'tests', '-t', '.'] }] : []),
    ],
  };
}

export function readmeFor(ir: Ir, lang: string, prefix: string, usage: string, testCmd: string, kinds: Set<string>): string {
  const rows = ir.ops.map((o) => `| \`${o.name}\` | \`${o.method} ${o.path}\` | ${o.confidence} (${o.sampleCount}) |${o.pagination ? ' ' + o.pagination.style + ' pagination helper |' : ' |'}`).join('\n');
  const env = [`${prefix}_BASE_URL (default ${ir.baseUrl})`, kinds.has('bearer') ? `${prefix}_TOKEN (Bearer token)` : '', ir.auth.find((a) => a.kind === 'apiKeyHeader') ? `${prefix}_API_KEY (sent as \`${ir.auth.find((a) => a.kind === 'apiKeyHeader')!.name}\`)` : '', kinds.has('basic') ? `${prefix}_USERNAME / ${prefix}_PASSWORD` : '', kinds.has('cookie') ? `${prefix}_COOKIE` : ''].filter(Boolean).map((e) => `- ${e}`).join('\n');
  return `# ${ir.title} — ${lang} client\n\nGenerated by BrowserForge MCP from **captured traffic only**. Operations, parameters and schemas reflect what was observed; anything not exercised in the capture is unknown. Confidence is shown per operation (number of samples in brackets).\n\n**No credentials are included.** Configure them at runtime:\n\n${env}\n\n## Usage\n\n\`\`\`\n${usage}\n\`\`\`\n\n## Behaviour\n\n- Timeouts (default 30 s) and retries with exponential backoff for transient errors (429/502/503/504) on idempotent requests; non-idempotent requests are retried only on 429.\n- Non-2xx responses raise an \`ApiError\` carrying the status and parsed body.\n- Query parameters are all optional: a parameter seen in every sample is *not* proof that the server requires it.\n\n## Operations\n\n| Method | Endpoint | Confidence | Notes |\n|---|---|---|---|\n${rows}\n${ir.skipped.length ? `\n## Not generated\n\nEndpoints on other hosts: ${ir.skipped.join(', ')}\n` : ''}\n## Tests\n\n\`\`\`\n${testCmd}\n\`\`\`\n`;
}
