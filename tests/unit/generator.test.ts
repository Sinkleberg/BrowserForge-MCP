import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeRequests, type AnalysisReport } from '@browserforge/api-analyzer';
import { buildIr, generateClient, generateOpenApi, generatePython, writeClient, TARGET_LANGUAGES } from '@browserforge/client-generator';
import { NetworkStore } from '@browserforge/network-inspector';
import { recordDemoTraffic } from '../helpers/traffic.js';
// @ts-expect-error plain JS fixture
import { startDemoSite, DEMO_API_KEY, DEMO_TOKEN, DEMO_COOKIE } from '../fixtures/demo-site/server.mjs';

const SECRETS = [DEMO_TOKEN, DEMO_API_KEY, DEMO_COOKIE];
let demo: any;
let report: AnalysisReport;
let tmp: string;
beforeAll(async () => {
  demo = await startDemoSite({ port: 0 });
  const store = new NetworkStore();
  for (const r of await recordDemoTraffic(demo.url)) store.add('live', r);
  report = analyzeRequests(store.getCapture('live').requests);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-gen-'));
});
afterAll(async () => { await demo.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('OpenAPI', () => {
  it('produces an accurate 3.1 document without credentials', () => {
    const doc: any = generateOpenApi(report);
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/api/v1/products', '/api/v1/products/{productId}', '/api/v1/orders']));
    const list = doc.paths['/api/v1/products'].get;
    expect(list.parameters.find((p: any) => p.name === 'per_page')).toMatchObject({ in: 'query', required: false });
    expect(doc.paths['/api/v1/orders'].post.requestBody.content['application/json'].schema.properties).toHaveProperty('product_id');
    expect(doc.components.securitySchemes.bearerAuth).toEqual({ type: 'http', scheme: 'bearer' });
    expect(doc.components.securitySchemes.apiKeyXApiKey).toMatchObject({ type: 'apiKey', in: 'header', name: 'X-Api-Key' });
    expect(doc['x-browserforge-skipped'].join(' ')).toMatch(/GraphQL/);
    for (const s of SECRETS) expect(JSON.stringify(doc)).not.toContain(s);
  });
});

describe('Python client', () => {
  it('generates, validates, passes its own tests, and works against the live mock API', async () => {
    const ir = buildIr(report);
    expect(ir.ops.map((o) => o.name)).toEqual(expect.arrayContaining(['list_products', 'get_product', 'list_articles', 'create_order', 'get_order', 'graphql_get_product']));
    const out = path.join(tmp, 'py');
    const res = await writeClient(generatePython(ir, { packageName: 'shop_api' }), { outDir: out, allowedRoots: [tmp], forbiddenStrings: SECRETS });
    expect(res.checks.map((c) => `${c.name}:${c.status}`), JSON.stringify(res.checks)).toEqual(['py_compile:passed', 'unittest:passed']);
    expect(res.success).toBe(true);

    // Real HTTP against the mock API with credentials supplied only at runtime.
    const script = `
import sys; sys.path.insert(0, ${JSON.stringify(out)})
from shop_api import Client, ApiError
c = Client(${JSON.stringify(demo.url)}, token=${JSON.stringify(DEMO_TOKEN)}, api_key=${JSON.stringify(DEMO_API_KEY)})
p = c.get_product(3); assert p["name"] == "Widget 3", p
items = list(c.iter_list_products(per_page=5, category="tools")); assert len(items) == 8, len(items)
arts = list(c.iter_list_articles(limit=5)); assert len(arts) == 12, len(arts)
o = c.create_order(body={"product_id": 2, "quantity": 2}); assert o["status"] == "created", o
assert c.get_order(o["id"])["quantity"] == 2
g = c.graphql_get_product(variables={"id": 2}); assert g["data"]["product"]["id"] == 2
try:
    c.get_product(9999); raise SystemExit("expected ApiError")
except ApiError as e:
    assert e.status == 404
try:
    Client(${JSON.stringify(demo.url)}).create_order(body={"product_id": 2, "quantity": 1}); raise SystemExit("expected 401")
except ApiError as e:
    assert e.status == 401
print("OK")`;
    const { execFile } = await import('node:child_process');
    const stdout = await new Promise<string>((resolve, reject) => execFile('python3', ['-I', '-c', script], { encoding: 'utf8' }, (e, so, se) => (e ? reject(new Error(se || String(e))) : resolve(so))));
    expect(stdout.trim()).toBe('OK');

    // No credential anywhere in the output tree.
    for (const f of res.files) for (const s of SECRETS) expect(fs.readFileSync(path.join(out, f), 'utf8')).not.toContain(s);
  });

  it.each(['typescript', 'javascript', 'php'] as const)('%s client: generates, passes its own checks, and works against the live mock API', async (lang) => {
    const out = path.join(tmp, lang);
    const res = await writeClient(generateClient(buildIr(report), lang, { packageName: 'shop_api' }), { outDir: out, allowedRoots: [tmp], forbiddenStrings: SECRETS });
    expect(res.checks.filter((c) => c.status === 'skipped'), 'toolchain missing').toEqual([]);
    expect(res.checks.map((c) => `${c.status}`), JSON.stringify(res.checks)).not.toContain('failed');
    expect(res.checks.length).toBeGreaterThanOrEqual(2);
    const { execFile } = await import('node:child_process');
    const sh = (cmd: string, args: string[]) => new Promise<string>((resolve, reject) => execFile(cmd, args, { encoding: 'utf8', cwd: out }, (e, so, se) => (e ? reject(new Error(se || so || String(e))) : resolve(so))));
    const common = { base: demo.url, token: DEMO_TOKEN, key: DEMO_API_KEY };
    let stdout: string;
    if (lang === 'php') {
      stdout = await sh('php', ['-r', `require 'src/Client.php'; use ShopApi\\Client; use ShopApi\\ApiException;
$c = new Client(['baseUrl' => ${JSON.stringify(common.base)}, 'token' => ${JSON.stringify(common.token)}, 'apiKey' => ${JSON.stringify(common.key)}]);
$p = $c->getProduct(3); if ($p['name'] !== 'Widget 3') { exit(1); }
$n = 0; foreach ($c->iterListProducts(['per_page' => 5, 'category' => 'tools']) as $_) { $n++; } if ($n !== 8) { fwrite(STDERR, "items $n"); exit(1); }
$o = $c->createOrder(['product_id' => 2, 'quantity' => 2]); if ($o['status'] !== 'created') { exit(1); }
try { $c->getProduct(9999); exit(1); } catch (ApiException $e) { if ($e->status !== 404) { exit(1); } }
echo "OK";`]);
    } else {
      const ext = lang === 'typescript' ? 'dist/src/index.js' : 'src/index.js';
      stdout = await sh('node', ['--input-type=module', '-e', `import { Client, ApiError } from './${ext}';
const c = new Client({ baseUrl: ${JSON.stringify(common.base)}, token: ${JSON.stringify(common.token)}, apiKey: ${JSON.stringify(common.key)} });
const p = await c.getProduct(3); if (p.name !== 'Widget 3') throw new Error('product');
let n = 0; for await (const _ of c.iterListProducts({ per_page: 5, category: 'tools' })) n++; if (n !== 8) throw new Error('items ' + n);
const o = await c.createOrder({ product_id: 2, quantity: 2 }); if (o.status !== 'created') throw new Error('order');
try { await c.getProduct(9999); throw new Error('no error'); } catch (e) { if (!(e instanceof ApiError) || e.status !== 404) throw e; }
console.log('OK');`]);
    }
    expect(stdout.trim()).toBe('OK');
    for (const f of res.files) for (const s of SECRETS) expect(fs.readFileSync(path.join(out, f), 'utf8')).not.toContain(s);
  });

  it('lists all four target languages', () => { expect(TARGET_LANGUAGES).toEqual(['python', 'typescript', 'javascript', 'php']); });

  it('refuses unsafe output locations and unrelated-file overwrites', async () => {
    const gen = generatePython(buildIr(report), { packageName: 'shop_api' });
    await expect(writeClient(gen, { outDir: '/etc/bf-out', allowedRoots: [tmp] })).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
    await expect(writeClient(gen, { outDir: path.join(tmp, '..', 'escape'), allowedRoots: [tmp] })).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
    const mine = path.join(tmp, 'existing');
    fs.mkdirSync(path.join(mine, 'shop_api'), { recursive: true });
    fs.writeFileSync(path.join(mine, 'README.md'), 'my own readme');
    await expect(writeClient(gen, { outDir: mine, allowedRoots: [tmp], validate: false })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(fs.readFileSync(path.join(mine, 'README.md'), 'utf8')).toBe('my own readme');
    await writeClient(gen, { outDir: mine, allowedRoots: [tmp], validate: false, overwrite: true });
    // Regenerating over our own output is fine without the flag.
    await writeClient(gen, { outDir: mine, allowedRoots: [tmp], validate: false });
  });

  it('blocks output that would contain a captured credential', async () => {
    const dirty = generatePython(buildIr(report), { packageName: 'shop_api' });
    dirty.files['example_usage.py'] += `\nTOKEN = "${DEMO_TOKEN}"\n`;
    await expect(writeClient(dirty, { outDir: path.join(tmp, 'dirty'), allowedRoots: [tmp], forbiddenStrings: SECRETS })).rejects.toMatchObject({ code: 'GENERATION_FAILED' });
    expect(fs.existsSync(path.join(tmp, 'dirty'))).toBe(false);
  });
});
