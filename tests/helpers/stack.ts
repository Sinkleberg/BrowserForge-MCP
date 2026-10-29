import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp, type App } from '../../apps/mcp-server/src/app.js';
// @ts-expect-error plain JS fixture
import { startDemoSite } from '../fixtures/demo-site/server.mjs';

export interface Demo {
  url: string;
  port: number;
  orders: unknown[];
  applications: Record<string, unknown>[];
  hits: { method: string; path: string }[];
  close(): Promise<void>;
}

export interface Stack {
  app: App;
  demo: Demo;
  home: string;
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; data: any; raw: any }>;
  close(): Promise<void>;
}

export const ROOT = path.resolve(import.meta.dirname, '../..');

export async function startStack(opts: { allowReveal?: boolean } = {}): Promise<Stack> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-home-'));
  const demo: Demo = await startDemoSite({ port: 0 });
  const app = createApp({ port: 0, configDir: home, allowReveal: opts.allowReveal ?? false, logLevel: 'error', extraAllowDirs: [home] });
  await app.listen();
  const client = new Client({ name: 'bf-test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${app.ctx.config.mcpToken}` } } }),
  );
  const call: Stack['call'] = async (name, args = {}) => {
    const raw: any = await client.callTool({ name, arguments: args });
    const text = (raw.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text;
    let data: any = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    return { isError: Boolean(raw.isError), data, raw };
  };
  return {
    app, demo, home, client, call,
    close: async () => {
      await client.close().catch(() => undefined);
      await app.close();
      await demo.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

export async function waitFor<T>(fn: () => T | Promise<T>, opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {}): Promise<NonNullable<T>> {
  const end = Date.now() + (opts.timeoutMs ?? 20_000);
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 150));
  }
  throw new Error(`Timed out waiting for ${opts.what ?? 'condition'}${last ? `: ${String(last)}` : ''}`);
}
