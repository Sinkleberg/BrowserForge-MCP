import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportHar, NetworkStore } from '@browserforge/network-inspector';
import { startStack, waitFor, type Stack } from '../helpers/stack.js';
import { recordDemoTraffic } from '../helpers/traffic.js';
// @ts-expect-error plain JS fixture
import { DEMO_API_KEY, DEMO_TOKEN } from '../fixtures/demo-site/server.mjs';

let stack: Stack;
beforeAll(async () => { stack = await startStack(); });
afterAll(async () => { await stack.close(); });

const REQUIRED_TOOLS = [
  'browser_get_tabs', 'browser_get_active_tab', 'browser_navigate', 'browser_click', 'browser_type', 'browser_select_option', 'browser_scroll', 'browser_press_key',
  'browser_fill_field', 'browser_fill_form', 'browser_get_page_text', 'browser_get_dom_snapshot', 'browser_get_interactive_elements', 'browser_take_screenshot',
  'browser_wait_for_element', 'browser_get_forms', 'browser_get_downloads', 'browser_get_console_errors', 'browser_stop',
  'network_list_requests', 'network_get_request', 'network_get_request_details', 'network_search_requests', 'network_export_har', 'network_import_har', 'network_clear_capture',
  'api_analyze_traffic', 'api_list_endpoints', 'api_get_endpoint_details', 'api_generate_openapi', 'api_generate_client',
  'workflow_create', 'workflow_run', 'workflow_pause', 'workflow_resume', 'workflow_get_status', 'system_status', 'system_diagnostics',
];

describe('MCP tool registration', () => {
  it('exposes every documented tool with strict JSON schemas and honest annotations', async () => {
    const { tools } = await stack.client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of REQUIRED_TOOLS) expect(names, `missing ${n}`).toContain(n);
    for (const t of tools) {
      expect(t.inputSchema.type, t.name).toBe('object');
      expect((t.inputSchema as any).additionalProperties, `${t.name} must reject unknown args`).toBe(false);
      expect(t.description!.length, t.name).toBeGreaterThan(20);
      expect(t.annotations, t.name).toBeDefined();
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const ro of ['browser_get_tabs', 'browser_get_page_text', 'network_list_requests', 'api_analyze_traffic', 'system_status']) expect(byName[ro]!.annotations!.readOnlyHint, ro).toBe(true);
    for (const rw of ['browser_click', 'browser_navigate', 'network_clear_capture', 'api_generate_client', 'workflow_run']) expect(byName[rw]!.annotations!.readOnlyHint, rw).toBe(false);
    expect(byName.browser_click!.annotations!.destructiveHint).toBe(true);
  });

  it('rejects unknown and invalid arguments with a structured error', async () => {
    const r = await stack.call('network_list_requests', { bogus: 1 });
    expect(r.isError).toBe(true);
    const r2 = await stack.client.callTool({ name: 'browser_navigate', arguments: { url: 123 } }).catch((e) => e);
    expect(JSON.stringify(r2)).toMatch(/invalid|error/i);
  });
});

describe('without a browser', () => {
  it('system_status explains how to connect', async () => {
    const s = (await stack.call('system_status')).data;
    expect(s.connected).toBe(false);
    expect(s.howToConnect).toMatch(/extension-token/);
    expect(s.server.bind).toMatch(/^127\.0\.0\.1:/);
  });
  it('browser tools fail with NOT_CONNECTED and no stack trace', async () => {
    const r = await stack.call('browser_get_tabs');
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe('NOT_CONNECTED');
    expect(r.data.error.retryable).toBe(true);
    expect(JSON.stringify(r.data)).not.toMatch(/at .*\.(ts|js):\d+/);
  });
  it('diagnostics report healthy local state', async () => {
    const d = (await stack.call('system_diagnostics')).data;
    expect(d.checks.find((c: any) => c.name === 'loopback-binding').ok).toBe(true);
    expect(d.checks.find((c: any) => c.name === 'extension-token-permissions').ok).toBe(true);
    expect(fs.statSync(path.join(stack.home, 'extension-token')).mode & 0o777).toBe(0o600);
  });
});

describe('HAR → analysis → OpenAPI → client (via MCP tools)', () => {
  let analysisId: string;
  it('imports a HAR file and lists redacted requests', async () => {
    const store = new NetworkStore();
    for (const r of await recordDemoTraffic(stack.demo.url)) store.add('live', r);
    const har = exportHar(store.getCapture('live').requests, { includeSensitive: true }); // raw, as a real devtools HAR would be
    const file = path.join(stack.home, 'exports', 'session.har');
    fs.writeFileSync(file, JSON.stringify(har));
    expect(fs.readFileSync(file, 'utf8')).toContain(DEMO_TOKEN); // fixture really contains secrets
    const imp = await stack.call('network_import_har', { path: file, label: 'demo' });
    expect(imp.isError, JSON.stringify(imp.data)).toBe(false);
    const list = (await stack.call('network_list_requests', { captureId: imp.data.captureId, limit: 200 })).data.data;
    expect(list.total).toBeGreaterThan(15);
    expect(JSON.stringify(list)).not.toContain(DEMO_TOKEN);
    const first = list.requests.find((r: any) => r.path.endsWith('/orders') && r.method === 'POST');
    const det = (await stack.call('network_get_request_details', { requestId: first.id })).data.data;
    expect(det.requestHeaders.find((h: any) => h.name === 'Authorization')?.value ?? '[REDACTED]').toBe('[REDACTED]');
    const search = (await stack.call('network_search_requests', { query: 'Widget 7', captureId: imp.data.captureId })).data.data;
    expect(search.total).toBeGreaterThanOrEqual(1);
    (stack as any).harCapture = imp.data.captureId;
  });

  it('analyses traffic into evidence-backed endpoint documentation', async () => {
    const r = await stack.call('api_analyze_traffic', { captureId: (stack as any).harCapture });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    analysisId = r.data.data.analysisId;
    expect(r.data.data.endpoints.length).toBeGreaterThanOrEqual(6);
    expect(r.data.data.disclaimer).toMatch(/observed/);
    const list = (await stack.call('api_list_endpoints', { analysisId, search: 'orders' })).data.data;
    expect(list.endpoints.map((e: any) => e.method)).toContain('POST');
    const det = (await stack.call('api_get_endpoint_details', { analysisId, endpointId: 'GET /api/v1/products' })).data.data;
    expect(det.evidence.length).toBeGreaterThan(0);
    expect(det.pagination.style).toBe('page');
    expect(JSON.stringify(det)).not.toContain(DEMO_TOKEN);
    expect((await stack.call('api_get_endpoint_details', { analysisId, endpointId: 'GET /nope' })).data.error.code).toBe('NOT_FOUND');
    expect((await stack.call('api_list_endpoints', { analysisId: 'an_missing' })).data.error.code).toBe('NOT_FOUND');
  });

  it('generates an OpenAPI document', async () => {
    const out = path.join(stack.home, 'exports', 'api.json');
    const r = await stack.call('api_generate_openapi', { analysisId, path: out });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(doc.openapi).toBe('3.1.0');
    expect(fs.readFileSync(out, 'utf8')).not.toContain(DEMO_TOKEN);
    const inline = await stack.call('api_generate_openapi', { analysisId });
    expect(inline.data.openapi.paths['/api/v1/orders']).toBeDefined();
  });

  it('generates a working Python client without leaking captured credentials', async () => {
    const outDir = path.join(stack.home, 'exports', 'py-client');
    const r = await stack.call('api_generate_client', { analysisId, language: 'python', outputDir: outDir, packageName: 'demo_shop' });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(r.data.success).toBe(true);
    expect(r.data.checks.map((c: any) => c.status)).toEqual(['passed', 'passed']);
    const { execFile } = await import('node:child_process');
    const out = await new Promise<string>((res, rej) => execFile('python3', ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(outDir)})
from demo_shop import Client
c = Client(${JSON.stringify(stack.demo.url)}, token=${JSON.stringify(DEMO_TOKEN)})
assert c.get_product(5)["name"] == "Widget 5"
print("OK")`], { encoding: 'utf8' }, (e, so, se) => (e ? rej(new Error(se)) : res(so))));
    expect(out.trim()).toBe('OK');
    for (const f of r.data.files) {
      const text = fs.readFileSync(path.join(outDir, f), 'utf8');
      for (const s of [DEMO_TOKEN, DEMO_API_KEY, 'SECRETCOOKIE']) expect(text, f).not.toContain(s);
    }
  });

  it('refuses to write clients outside export roots or over unrelated files', async () => {
    const bad = await stack.call('api_generate_client', { analysisId, language: 'python', outputDir: '/etc/bf-client' });
    expect(bad.data.error.code).toBe('PATH_NOT_ALLOWED');
    const traversal = await stack.call('api_generate_client', { analysisId, language: 'python', outputDir: '../../../tmp/bf-escape' });
    expect(traversal.data.error.code).toBe('PATH_NOT_ALLOWED');
    const dir = path.join(stack.home, 'exports', 'mine');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'README.md'), 'keep me');
    const clash = await stack.call('api_generate_client', { analysisId, language: 'php', outputDir: dir });
    expect(clash.data.error.code).toBe('PERMISSION_DENIED');
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('keep me');
  });

  it('exports and imports redaction-safe HAR through tools', async () => {
    const out = path.join(stack.home, 'exports', 'redacted.har');
    const r = await stack.call('network_export_har', { captureId: (stack as any).harCapture, path: out });
    expect(r.data.redacted).toBe(true);
    expect(fs.readFileSync(out, 'utf8')).not.toContain(DEMO_TOKEN);
    expect((await stack.call('network_export_har', { path: '/tmp/x.har' })).data.error.code).toBe('PATH_NOT_ALLOWED');
    expect((await stack.call('network_import_har', { path: '/etc/passwd' })).data.error.code).toBe('PATH_NOT_ALLOWED');
    expect((await stack.call('network_import_har', {})).data.error.code).toBe('INVALID_ARGUMENTS');
    expect((await stack.call('network_import_har', { har: { nope: true } })).data.error.code).toBe('INVALID_ARGUMENTS');
  });
});

describe('workflows', () => {
  it('rejects unknown tools and bad arguments at creation time', async () => {
    expect((await stack.call('workflow_create', { name: 'x', steps: [{ tool: 'system_status' }] })).data.error.code).toBe('INVALID_ARGUMENTS');
    expect((await stack.call('workflow_create', { name: 'x', steps: [{ tool: 'rm_rf', args: {} }] })).data.error.code).toBe('INVALID_ARGUMENTS');
    expect((await stack.call('workflow_create', { name: 'x', steps: [{ tool: 'network_list_requests', args: { limit: 99999 } }] })).isError).toBe(true);
  });
  it('runs, pauses, resumes and reports status', async () => {
    const wf = (await stack.call('workflow_create', { name: 'demo', steps: [{ tool: 'network_list_requests', args: { limit: 1 } }, { tool: 'network_list_captures', args: {} }] })).data;
    const run = await stack.call('workflow_run', { workflowId: wf.workflowId });
    expect(run.isError, JSON.stringify(run.data)).toBe(false);
    const done = await waitFor(async () => { const s = (await stack.call('workflow_get_status', { workflowId: wf.workflowId })).data; return s.status === 'completed' ? s : null; }, { what: 'workflow completion' });
    expect(done.steps.map((s: any) => s.status)).toEqual(['done', 'done']);
    expect((await stack.call('workflow_run', { workflowId: wf.workflowId })).data.error.code).toBe('INVALID_ARGUMENTS');
  });
  it('a failing step stops the workflow; approval steps cannot be skipped when no human is reachable', async () => {
    const wf = (await stack.call('workflow_create', { name: 'fails', steps: [{ tool: 'browser_get_tabs', args: {} }, { tool: 'network_list_captures', args: {} }] })).data;
    await stack.call('workflow_run', { workflowId: wf.workflowId });
    const s = await waitFor(async () => { const x = (await stack.call('workflow_get_status', { workflowId: wf.workflowId })).data; return x.status === 'failed' ? x : null; }, { what: 'failure' });
    expect(s.steps.map((x: any) => x.status)).toEqual(['failed', 'skipped']);
    expect(s.steps[0].error.code).toBe('NOT_CONNECTED');
    const gated = (await stack.call('workflow_create', { name: 'gated', steps: [{ tool: 'network_list_captures', args: {}, approval: 'Really list captures?' }] })).data;
    await stack.call('workflow_run', { workflowId: gated.workflowId });
    const g = await waitFor(async () => { const x = (await stack.call('workflow_get_status', { workflowId: gated.workflowId })).data; return x.status === 'failed' ? x : null; }, { what: 'gated failure' });
    expect(g.steps[0].status).toBe('failed');
    expect(g.steps[0].error.code).toBe('NOT_CONNECTED'); // never executed without a human decision
  });
});
