import type { CapturedRequest } from '@browserforge/network-inspector';
// @ts-expect-error plain JS fixture
import { DEMO_API_KEY, DEMO_TOKEN } from '../fixtures/demo-site/server.mjs';

/** Drive the demo API with fetch and record each exchange like the extension would (full headers and bodies, secrets included). */
export async function recordDemoTraffic(base: string): Promise<Omit<CapturedRequest, 'id' | 'captureId'>[]> {
  const out: Omit<CapturedRequest, 'id' | 'captureId'>[] = [];
  const t0 = Date.now();
  const rec = async (method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown } = {}) => {
    const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) };
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (body) headers['Content-Type'] = 'application/json';
    const started = Date.now();
    const res = await fetch(base + path, { method, headers, body });
    const text = await res.text();
    out.push({
      url: base + path, method,
      requestHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
      requestBody: body, status: res.status, statusText: res.statusText,
      responseHeaders: Array.from(res.headers.entries()).map(([name, value]) => ({ name, value })),
      responseBody: text, mimeType: res.headers.get('content-type')?.split(';')[0], resourceType: 'fetch',
      startedAt: started, durationMs: Date.now() - started,
    });
  };
  const auth = { Authorization: `Bearer ${DEMO_TOKEN}` };
  for (let p = 1; p <= 3; p++) await rec('GET', `/api/v1/products?page=${p}&per_page=5&category=tools`);
  await rec('GET', '/api/v1/products?page=1&per_page=10');
  for (const id of [3, 5, 7]) await rec('GET', `/api/v1/products/${id}`);
  await rec('GET', '/api/v1/products/9999');
  await rec('GET', '/api/v1/articles?limit=5', { headers: { 'X-Api-Key': DEMO_API_KEY } });
  await rec('GET', '/api/v1/articles?limit=5&cursor=art_006', { headers: { 'X-Api-Key': DEMO_API_KEY } });
  await rec('GET', '/api/v1/articles?limit=5', {});
  await rec('POST', '/api/v1/orders', { headers: auth, body: { product_id: 2, quantity: 1 } });
  await rec('POST', '/api/v1/orders', { headers: auth, body: { product_id: 4, quantity: 2, note: 'gift' } });
  await rec('POST', '/api/v1/orders', { headers: auth, body: { product_id: 4 } });
  await rec('POST', '/api/v1/orders', { body: { product_id: 2, quantity: 1 } });
  await rec('GET', '/api/v1/orders/ord_1', { headers: auth });
  await rec('GET', '/api/v1/orders/ord_2', { headers: auth });
  await rec('POST', '/graphql', { body: { operationName: 'GetProduct', query: 'query GetProduct($id: Int!){ product(id:$id){ id name price } }', variables: { id: 2 } } });
  // Static asset that must be ignored by the analyzer.
  const html = await fetch(base + '/shop');
  out.push({ url: base + '/shop', method: 'GET', requestHeaders: [], status: 200, responseHeaders: [{ name: 'content-type', value: 'text/html' }], responseBody: await html.text(), mimeType: 'text/html', resourceType: 'main_frame', startedAt: t0 });
  return out;
}
