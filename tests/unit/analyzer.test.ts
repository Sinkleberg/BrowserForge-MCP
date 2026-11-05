import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeRequests, inferFromSamples, mergeSchemas, inferSchema, type AnalysisReport } from '@browserforge/api-analyzer';
import { NetworkStore, type CapturedRequest } from '@browserforge/network-inspector';
import { generateOpenApi } from '@browserforge/client-generator';
import { containsSecretLike } from '@browserforge/shared';
import { recordDemoTraffic } from '../helpers/traffic.js';
// @ts-expect-error plain JS fixture
import { startDemoSite, DEMO_API_KEY, DEMO_TOKEN } from '../fixtures/demo-site/server.mjs';

describe('query enum hypotheses', () => {
  const samples = (name: string, values: (string | undefined)[]): CapturedRequest[] => values.map((value, i) => ({
    id: `enum-${i}`, captureId: 'synthetic', method: 'GET',
    url: `https://shop.test/products${value === undefined ? '' : `?${encodeURIComponent(name)}=${encodeURIComponent(value)}`}`,
    requestHeaders: [], responseHeaders: [], status: 200, mimeType: 'application/json', startedAt: i,
  }));
  const query = (name: string, values: string[]) => analyzeRequests(samples(name, values)).endpoints[0]!.query[0]!;

  it('keeps an enum guess separate from observed parameter evidence and exports that distinction', () => {
    const report = analyzeRequests(samples('category', ['books', 'tools', 'books', 'tools', 'books', undefined]));
    const parameter = report.endpoints[0]!.query[0]!;
    expect(parameter).toMatchObject({ basis: 'observed', required: false, occurrences: 5, enum: ['books', 'tools'], enumClaim: { basis: 'hypothesis', confidence: 'low', evidence: ['enum-0', 'enum-1', 'enum-2', 'enum-3', 'enum-4'] } });
    const document: any = generateOpenApi(report);
    expect(document.paths['/products'].get.parameters[0]).toMatchObject({ required: false, 'x-basis': 'observed', schema: { type: 'string', enum: ['books', 'tools'], 'x-basis': 'hypothesis', 'x-confidence': 'low', 'x-evidence': parameter.enumClaim!.evidence } });
  });

  it('requires five distinct requests, two or three values and repeated support for every value', () => {
    expect(query('status', ['open', 'closed', 'open', 'closed']).enum).toBeUndefined();
    expect(query('status', ['open', 'open', 'open', 'open', 'closed']).enum).toBeUndefined();
    expect(query('status', ['open', 'open', 'open', 'open', 'open']).enum).toBeUndefined();
    expect(query('status', ['open', 'closed', 'pending', 'open', 'closed', 'pending']).enum).toEqual(['open', 'closed', 'pending']);
    expect(query('status', ['open', 'closed', 'pending', 'new', 'open', 'closed', 'pending', 'new']).enum).toBeUndefined();
  });

  it('does not mistake repeated values in one request for independent samples', () => {
    const requests = samples('category', ['books', 'tools', 'books', 'tools']);
    requests[0]!.url += '&category=tools&category=books&category=tools';
    expect(analyzeRequests(requests).endpoints[0]!.query[0]!.enum).toBeUndefined();
    const five = samples('category', ['books', 'books', 'books', 'books', 'books']);
    five[0]!.url += '&category=tools&category=tools';
    expect(analyzeRequests(five).endpoints[0]!.query[0]!.enum).toBeUndefined();
  });

  it.each(['id', 'productId', 'user_id', 'account', 'filter[user]', 'api_key', 'accessToken', 'email', 'q', 'search', 'description', 'comment'])('excludes identifier, sensitive and free-text parameter names: %s', (name) => {
    const parameter = query(name, ['books', 'tools', 'books', 'tools', 'books']);
    expect(parameter.enum).toBeUndefined();
    expect(parameter.enumClaim).toBeUndefined();
  });

  it.each([
    ['1', '2'], ['true', 'false'], ['123e4567-e89b-12d3-a456-426614174000', '123e4567-e89b-12d3-a456-426614174001'],
    ['usr_abcd', 'usr_efgh'], ['abcdefabcdef', 'fedcbafedcba'], ['a long sentence', 'another sentence'],
    ['ada@example.test', 'bob@example.test'], ['https://a.test', 'https://b.test'], ['sk-abcdefghijklmnop', 'sk-ponmlkjihgfedcba'], ['', 'books'],
  ])('excludes values that are not categorical labels: %j', (first, second) => {
    expect(query('category', [first, second, first, second, first]).enum).toBeUndefined();
  });
});

describe('schema inference', () => {
  it('merges optional/nullable fields and formats', () => {
    const s = inferFromSamples([{ id: 1, name: 'a', at: '2025-01-01T10:00:00Z', tags: ['x'] }, { id: 2, name: null, tags: [] }])!;
    expect(s.properties!.id).toEqual({ type: 'integer' });
    expect(s.properties!.name).toMatchObject({ type: 'string', nullable: true });
    expect(s.required).toEqual(expect.arrayContaining(['id', 'name']));
    expect(s.required).not.toContain('at');
    expect(inferSchema('2025-01-01T10:00:00Z')).toMatchObject({ format: 'date-time' });
    expect(mergeSchemas({ type: 'integer' }, { type: 'number' }).type).toBe('number');
  });
});

describe('endpoint analysis (mock API traffic)', () => {
  let demo: any;
  let report: AnalysisReport;
  const ep = (id: string) => report.endpoints.find((e) => e.id === id)!;
  beforeAll(async () => {
    demo = await startDemoSite({ port: 0 });
    const store = new NetworkStore();
    for (const r of await recordDemoTraffic(demo.url)) store.add('live', r);
    report = analyzeRequests(store.getCapture('live').requests);
  });
  afterAll(() => demo.close());

  it('groups requests into endpoint families and ignores static pages', () => {
    expect(report.endpoints.map((e) => e.id)).toEqual(expect.arrayContaining([
      'GET /api/v1/products', 'GET /api/v1/products/{productId}', 'GET /api/v1/articles', 'POST /api/v1/orders', 'GET /api/v1/orders/{orderId}', 'POST /graphql#GetProduct',
    ]));
    expect(report.stats.skippedStatic).toBe(1);
    expect(ep('GET /api/v1/products/{productId}').sampleCount).toBe(4);
    expect(ep('GET /api/v1/products/{productId}').pathParams[0]).toMatchObject({ name: 'productId', type: 'integer', basis: 'inferred' });
    expect(ep('GET /api/v1/orders/{orderId}').pathParams[0]!.type).toBe('string');
  });

  it('extracts query parameters and compares values across requests', () => {
    const q = Object.fromEntries(ep('GET /api/v1/products').query.map((p) => [p.name, p]));
    expect(q.page).toMatchObject({ type: 'integer', distinctValues: 3 });
    expect(q.category!.occurrences).toBe(3);
    expect(q.category!.required).toBe(false); // absent from one sample
    expect(q.per_page!.required).toBe(true);
    expect(q.per_page!.basis).toBe('hypothesis'); // "required" is never claimed as fact
  });

  it('infers request/response schemas with optional fields', () => {
    const body = ep('POST /api/v1/orders').requestBody!;
    expect(body.schema.properties).toHaveProperty('note');
    expect(body.schema.required).toEqual(expect.arrayContaining(['product_id']));
    expect(body.schema.required).not.toContain('note');
    expect(body.schema.required).not.toContain('quantity'); // one sample omitted it
    const ok = ep('POST /api/v1/orders').responses.find((r) => r.status === 201)!;
    expect(ok.schema!.properties).toHaveProperty('total');
  });

  it('detects page and cursor pagination', () => {
    expect(ep('GET /api/v1/products').pagination).toMatchObject({ style: 'page', pageSizeParam: 'per_page' });
    expect(ep('GET /api/v1/products').pagination!.responseFields).toContain('next_page');
    expect(ep('GET /api/v1/articles').pagination).toMatchObject({ style: 'cursor', requestParams: ['cursor'] });
  });

  it('detects auth schemes without exposing secrets', () => {
    expect(ep('POST /api/v1/orders').auth.map((a) => a.kind)).toEqual(['bearer']);
    expect(ep('POST /api/v1/orders').auth[0]!.requiredBy).toBe('some-samples');
    expect(ep('GET /api/v1/articles').auth[0]).toMatchObject({ kind: 'apiKeyHeader', name: 'X-Api-Key' });
    expect(ep('GET /api/v1/orders/{orderId}').auth[0]!.requiredBy).toBe('all-samples');
    expect(report.securitySchemes.map((s) => s.kind).sort()).toEqual(['apiKeyHeader', 'bearer']);
    const json = JSON.stringify(report);
    expect(json).not.toContain(DEMO_TOKEN);
    expect(json).not.toContain(DEMO_API_KEY);
    expect(containsSecretLike(json)).toBe(false);
  });

  it('records error/status patterns, versions and GraphQL', () => {
    expect(ep('GET /api/v1/products/{productId}').errors.map((e) => e.status)).toEqual([404]);
    expect(ep('POST /api/v1/orders').errors.map((e) => e.status).sort()).toEqual([401, 422]);
    expect(ep('POST /api/v1/orders').notes.join(' ')).toMatch(/401/);
    expect(ep('GET /api/v1/products').version).toBe('v1');
    expect(ep('POST /graphql#GetProduct').graphql).toMatchObject({ operationName: 'GetProduct', operationType: 'query', variables: ['id'] });
  });

  it('assigns evidence and confidence, and warns when data is thin', () => {
    const e = ep('GET /api/v1/products');
    expect(e.evidence.length).toBeGreaterThan(0);
    expect(e.confidence).toBe('medium');
    expect(ep('POST /graphql#GetProduct').confidence).toBe('low');
    expect(analyzeRequests([]).warnings[0]).toMatch(/No API-like requests/);
  });
});
