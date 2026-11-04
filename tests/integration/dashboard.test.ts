import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../../apps/mcp-server/src/app.js';
import { dashboardUrl, openerFor } from '../../apps/mcp-server/src/dashboard/open.js';
import { commit, stage } from '../../apps/mcp-server/src/plugins/installer.js';
import { PluginStore } from '../../apps/mcp-server/src/plugins/store.js';
import { startStack, type Stack } from '../helpers/stack.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const HELLO = path.join(ROOT, 'examples/plugins/hello');

const stacks: Stack[] = [];
const apps: App[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (stacks.length) await stacks.pop()!.close();
  while (apps.length) await apps.pop()!.close();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const get = (port: number, p: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${p}`, { headers });
const dash = (a: App) => ({ authorization: `Bearer ${a.ctx.config.dashboardToken}` });

describe('the dashboard page', () => {
  it('serves the page and its two files without a token, and they hold no data', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-dash-'));
    dirs.push(dir);
    const app = createApp({ port: 0, configDir: dir, logLevel: 'error' });
    apps.push(app);
    await app.listen();
    const c = app.ctx.config;

    const html = await get(app.port, '/dashboard');
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toMatch(/text\/html/);
    const page = await html.text();
    expect(page).toContain('/dashboard/app.js');
    expect((await get(app.port, '/dashboard/app.js')).headers.get('content-type')).toMatch(/javascript/);
    expect((await get(app.port, '/dashboard/app.css')).headers.get('content-type')).toMatch(/text\/css/);

    const everything = page + (await (await get(app.port, '/dashboard/app.js')).text()) + (await (await get(app.port, '/dashboard/app.css')).text());
    for (const secret of [c.mcpToken, c.extensionToken, c.dashboardToken]) expect(everything).not.toContain(secret);
  });

  it('answers /dashboard/data only to the dashboard token, from the page itself or a program', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-dash-'));
    dirs.push(dir);
    const app = createApp({ port: 0, configDir: dir, logLevel: 'error' });
    apps.push(app);
    await app.listen();
    const c = app.ctx.config;

    expect((await get(app.port, '/dashboard/data')).status).toBe(401);
    expect((await get(app.port, '/dashboard/data', { authorization: 'Bearer nope' })).status).toBe(401);
    // The three tokens are three different keys.
    expect(new Set([c.mcpToken, c.extensionToken, c.dashboardToken]).size).toBe(3);
    expect((await get(app.port, '/dashboard/data', { authorization: `Bearer ${c.mcpToken}` })).status).toBe(401);
    expect((await get(app.port, '/dashboard/data', { authorization: `Bearer ${c.extensionToken}` })).status).toBe(401);
    // ...and the dashboard key opens nothing else.
    expect((await get(app.port, '/status', dash(app))).status).toBe(401);
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
    const mcp = await fetch(`http://127.0.0.1:${app.port}/mcp`, { method: 'POST', headers: { ...dash(app), 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(init) });
    expect(mcp.status).toBe(401);

    const ok = await get(app.port, '/dashboard/data', dash(app));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    // The page's own address as Origin is fine; any other origin is not.
    expect((await get(app.port, '/dashboard/data', { ...dash(app), origin: `http://127.0.0.1:${app.port}` })).status).toBe(200);
    for (const origin of ['http://evil.example', 'https://127.0.0.1', `http://localhost:${app.port}`, 'null']) {
      expect((await get(app.port, '/dashboard/data', { ...dash(app), origin })).status, origin).toBe(403);
    }
    // Only reading is allowed.
    expect((await fetch(`http://127.0.0.1:${app.port}/dashboard/data`, { method: 'POST', headers: dash(app) })).status).toBe(405);
  });

  it('lists the tools even before any agent has connected, and never contains a token', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-dash-'));
    dirs.push(dir);
    const app = createApp({ port: 0, configDir: dir, logLevel: 'error' });
    apps.push(app);
    await app.listen();
    const text = await (await get(app.port, '/dashboard/data', dash(app))).text();
    const d = JSON.parse(text);
    const status = d.tools.find((t: { name: string }) => t.name === 'system_status');
    expect(status).toMatchObject({ readOnly: true, group: 'system' });
    expect(d.tools.length).toBeGreaterThan(40);
    expect(d.tools.find((t: { name: string }) => t.name === 'browser_click')).toMatchObject({ readOnly: false, group: 'browser' });
    expect(d.server.version).toBeTruthy();
    expect(d.transports.mcpSessions).toBe(0);
    expect(d.localModels.status.qwen).toHaveProperty('reachable');
    for (const secret of [app.ctx.config.mcpToken, app.ctx.config.extensionToken, app.ctx.config.dashboardToken]) expect(text).not.toContain(secret);
  });

  it('shows installed plugins with their permissions in plain words, and skills with their workflows', async () => {
    const stack = await startStack({
      beforeStart: async (home) => {
        const store = new PluginStore(home);
        commit(store, await stage(store, HELLO));
        const skill = path.join(home, 'skills', 'demo-skill');
        fs.mkdirSync(skill, { recursive: true });
        fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: demo-skill\ndescription: A skill for the dashboard test.\nrequires-plugins: hello\n---\n# demo-skill\nDo the thing.\n');
      },
    });
    stacks.push(stack);
    const d = await (await get(stack.app.port, '/dashboard/data', dash(stack.app))).json();

    const hello = d.plugins.find((p: { id: string }) => p.id === 'hello');
    expect(hello).toMatchObject({ state: 'loaded', toolPrefix: 'hello' });
    expect(hello.tools.length).toBeGreaterThan(0);
    expect(hello.permissions.join(' ')).toMatch(/data/i);
    // A plugin's tools are grouped under the plugin, not mixed in with the core namespaces.
    expect(d.tools.filter((t: { group: string }) => t.group === 'plugin:hello').map((t: { name: string }) => t.name).sort()).toEqual([...hello.tools].sort());

    expect(d.skills.find((s: { name: string }) => s.name === 'demo-skill')).toMatchObject({ description: 'A skill for the dashboard test.', source: 'user', requiresPlugins: ['hello'] });
    // An open MCP session is counted.
    expect(d.transports.mcpSessions).toBe(1);
  });

  it('lists a plugin that is installed but switched off', async () => {
    const stack = await startStack({
      beforeStart: async (home) => {
        const store = new PluginStore(home);
        commit(store, await stage(store, HELLO), false);
      },
    });
    stacks.push(stack);
    const d = await (await get(stack.app.port, '/dashboard/data', dash(stack.app))).json();
    expect(d.plugins.find((p: { id: string }) => p.id === 'hello')).toMatchObject({ state: 'disabled' });
  });
});

describe('opening the dashboard', () => {
  it('puts the token in the fragment, which the browser never sends, and encodes it', () => {
    const url = dashboardUrl(7345, 'a+b/c=');
    expect(url).toBe('http://127.0.0.1:7345/dashboard#t=a%2Bb%2Fc%3D');
    expect(new URL(url).search).toBe('');
  });
  it('uses the opener of each system', () => {
    expect(openerFor('linux')).toBe('xdg-open');
    expect(openerFor('darwin')).toBe('open');
    expect(openerFor('win32')).toBe('explorer.exe');
  });
});
