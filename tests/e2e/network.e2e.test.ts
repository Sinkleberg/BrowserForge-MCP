import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchChromium, launchFirefox, type BrowserHandle } from '../helpers/browsers.js';
import { startStack, waitFor, type Stack } from '../helpers/stack.js';
// @ts-expect-error plain JS fixture
import { DEMO_API_KEY, DEMO_COOKIE, DEMO_TOKEN } from '../fixtures/demo-site/server.mjs';

const kinds = (process.env.BF_BROWSERS ?? 'firefox,chromium').split(',') as ('firefox' | 'chromium')[];

describe.each(kinds)('network capture — %s', (kind) => {
  let stack: Stack;
  let browser: BrowserHandle;
  beforeAll(async () => {
    stack = await startStack();
    browser = kind === 'firefox' ? await launchFirefox(stack.app) : await launchChromium(stack.app);
    await browser.openPage(stack.demo.url + '/');
    const r = await stack.call('network_configure_capture', { captureBodies: true });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    await stack.call('browser_navigate', { url: stack.demo.url + '/shop' });
    await waitFor(async () => (await stack.call('network_list_requests', { urlPattern: '/graphql' })).data.data.total >= 1, { what: 'shop traffic captured' });
  });
  afterAll(async () => {
    await browser?.close();
    await stack?.close();
  });

  const list = async (args: Record<string, unknown> = {}) => (await stack.call('network_list_requests', args)).data.data as { total: number; nextCursor?: string; requests: any[] };

  it('captures page API calls with method, status and tab', async () => {
    const all = await list({ hostname: '127.0.0.1' });
    expect(all.total).toBeGreaterThanOrEqual(5);
    const products = all.requests.find((r) => r.path === '/api/v1/products');
    expect(products).toMatchObject({ method: 'GET', status: 200 });
    expect(products.url).toContain('page=1');
    expect(typeof products.tabId).toBe('number');
  });

  it('filters by method, status, content type, pattern and host', async () => {
    expect((await list({ method: 'POST' })).requests.every((r) => r.method === 'POST')).toBe(true);
    const notFound = await list({ status: '4xx' });
    expect(notFound.requests.map((r) => r.path)).toEqual(expect.arrayContaining(['/api/v1/products/9999']));
    expect((await list({ status: 404 })).total).toBeGreaterThanOrEqual(1);
    expect((await list({ contentType: 'application/json' })).total).toBeGreaterThanOrEqual(3);
    expect((await list({ urlPattern: '*/api/v1/products/*' })).requests.every((r) => /products\//.test(r.path))).toBe(true);
    expect((await list({ hostname: 'example.org' })).total).toBe(0);
    expect((await list({ hostname: '*.example.org' })).total).toBe(0);
  });

  it('paginates', async () => {
    const first = await list({ limit: 2 });
    expect(first.requests).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();
    const second = await list({ limit: 2, cursor: first.nextCursor });
    expect(second.requests[0].id).not.toBe(first.requests[0].id);
  });

  it('redacts credentials in headers, urls and bodies and never leaks them in any tool output', async () => {
    const artic = (await list({ urlPattern: '/api/v1/articles' })).requests[0];
    const d = (await stack.call('network_get_request_details', { requestId: artic.id })).data.data;
    const apiKey = d.requestHeaders.find((h: any) => h.name.toLowerCase() === 'x-api-key');
    expect(apiKey.value).toBe('[REDACTED]');
    expect(d.redacted).toBe(true);
    const everything = JSON.stringify([await list(), (await stack.call('network_search_requests', { query: 'api' })).data, d, (await stack.call('system_diagnostics')).data]);
    for (const secret of [DEMO_TOKEN, DEMO_COOKIE, DEMO_API_KEY]) expect(everything).not.toContain(secret);
  });

  it('refuses to reveal secrets unless the server operator allowed it', async () => {
    const r = (await list({ limit: 1 })).requests[0];
    const res = await stack.call('network_get_request_details', { requestId: r.id, reveal: true });
    expect(res.isError).toBe(true);
    expect(res.data.error.code).toBe('PERMISSION_DENIED');
    const ex = await stack.call('network_export_har', { includeSensitive: true });
    expect(ex.data.error.code).toBe('PERMISSION_DENIED');
  });

  it('captures request bodies and (opt-in) response bodies', async () => {
    const buy = (await stack.call('browser_get_interactive_elements')).data.data.elements.find((e: any) => e.id === 'buy');
    const click = stack.call('browser_click', { ref: buy.ref });
    await browser.decideApproval(true);
    expect((await click).isError).toBe(false);
    const order = await waitFor(async () => (await list({ method: 'POST', urlPattern: '/api/v1/orders' })).requests[0], { what: 'order request' });
    const d = (await stack.call('network_get_request_details', { requestId: order.id })).data.data;
    expect(JSON.parse(d.requestBody)).toEqual({ product_id: 2, quantity: 1 });
    expect(d.requestHeaders.find((h: any) => h.name.toLowerCase() === 'authorization').value).toBe('[REDACTED]');
    expect(d.status).toBe(201);
    const prod = (await list({ urlPattern: '*/api/v1/products?page=1*' })).requests[0];
    const pd = (await stack.call('network_get_request_details', { requestId: prod.id })).data.data;
    expect(JSON.parse(pd.responseBody).data).toHaveLength(5);
  });

  it('exports HAR (redacted) and re-imports it as a new capture', async () => {
    const out = path.join(stack.app.ctx.config.configDir, 'exports', 'shop.har');
    const ex = await stack.call('network_export_har', { hostname: '127.0.0.1', path: out });
    expect(ex.isError, JSON.stringify(ex.data)).toBe(false);
    const text = fs.readFileSync(out, 'utf8');
    for (const secret of [DEMO_TOKEN, DEMO_COOKIE, DEMO_API_KEY]) expect(text).not.toContain(secret);
    const har = JSON.parse(text);
    expect(har.log.entries.length).toBe(ex.data.entries);
    const imp = await stack.call('network_import_har', { path: out, label: 'roundtrip' });
    expect(imp.data.imported).toBe(ex.data.entries);
    const imported = (await stack.call('network_list_requests', { captureId: imp.data.captureId })).data.data;
    expect(imported.total).toBe(ex.data.entries);
    const bad = await stack.call('network_export_har', { path: '/tmp/outside.har' });
    expect(bad.data.error.code).toBe('PATH_NOT_ALLOWED');
  });

  it('clears captures', async () => {
    const r = await stack.call('network_clear_capture', { captureId: 'live' });
    expect(r.data.cleared).toBeGreaterThan(0);
    expect((await list()).total).toBe(0);
  });
});
