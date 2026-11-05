import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pluginAdd } from '../../apps/mcp-server/src/plugins/commands.js';
import { PluginStore } from '../../apps/mcp-server/src/plugins/store.js';
import { startStack, type Stack } from '../helpers/stack.js';

const source = path.resolve(import.meta.dirname, '../../examples/plugins/github-stats');
const stacks: Stack[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (stacks.length) await stacks.pop()!.close();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('GitHub stats install and discoverability', () => {
  it('displays the origin for consent and lists the tool and permissions in the dashboard', async () => {
    const output: string[] = [];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-ghstats-')); dirs.push(home);
    const store = new PluginStore(home);
    let consent = false;
    const io = { out: (s: string) => output.push(s), ask: async () => consent };
    expect(await pluginAdd(store, source, io)).toBe(false);
    expect(store.list()).toEqual([]);
    expect(output.join('')).toContain('Read public data from: https://api.github.com');
    consent = true;
    expect(await pluginAdd(store, source, io)).toBe(true);
    const stack = await startStack({ beforeStart: async (target) => {
      await pluginAdd(new PluginStore(target), source, { out: () => undefined, ask: async () => true });
    } }); stacks.push(stack);
    const tools = (await stack.client.listTools()).tools;
    expect(tools.find((t) => t.name === 'ghstats_repo')?.annotations?.readOnlyHint).toBe(true);
    const response = await fetch(`http://127.0.0.1:${stack.app.port}/dashboard/data`, { headers: { authorization: `Bearer ${stack.app.ctx.config.dashboardToken}` } });
    const data = await response.json();
    expect(data.plugins.find((p: { id: string }) => p.id === 'github-stats')).toMatchObject({ state: 'loaded', tools: ['ghstats_repo'], permissions: [expect.stringContaining('https://api.github.com')] });
  });

  it('does not load a plugin whose network origin was not approved', async () => {
    const stack = await startStack({ beforeStart: async (home) => {
      const store = new PluginStore(home);
      await pluginAdd(store, source, { out: () => undefined, ask: async () => true });
      const file = path.join(home, 'plugins.json');
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete config.plugins[0].granted.network;
      fs.writeFileSync(file, JSON.stringify(config));
    } }); stacks.push(stack);
    expect((await stack.client.listTools()).tools.map((t) => t.name)).not.toContain('ghstats_repo');
    expect(stack.app.ctx.plugins.skipped).toContainEqual({ id: 'github-stats', reason: expect.stringContaining('different permissions') });
  });
});
