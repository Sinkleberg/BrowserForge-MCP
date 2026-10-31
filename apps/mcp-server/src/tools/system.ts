import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PROTOCOL_VERSION } from '@browserforge/browser-protocol';
import type { ServerContext } from '../context.js';
import { SERVER_VERSION } from '../context.js';
import { registerTool } from './helpers.js';

export function systemStatus(ctx: ServerContext) {
  const browsers = ctx.hub.listPeers();
  return {
    server: { name: 'browserforge-mcp', version: SERVER_VERSION, protocolVersion: PROTOCOL_VERSION, uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000), bind: `${ctx.config.host}:${ctx.config.port}` },
    transports: { http: ctx.transports.http, stdio: ctx.transports.stdio, mcpSessions: ctx.transports.mcpSessions() },
    browsers,
    connected: browsers.some((b) => b.connected),
    capture: { captures: ctx.store.listCaptures(), limits: ctx.store.getLimits() },
    decider: { mode: ctx.config.decider.mode, qwen: `${ctx.config.decider.model} @ ${ctx.config.decider.url}`, laya: `${ctx.config.decider.laya.model} @ ${ctx.config.decider.laya.url}`, traces: ctx.config.knowledge.traces },
    plugins: { loaded: ctx.plugins.plugins.map((p) => ({ id: p.manifest.id, version: p.version, tools: p.tools.map((t) => t.name) })), skills: ctx.plugins.skills.map((s) => s.name), skipped: ctx.plugins.skipped },
    policy: { allowReveal: ctx.config.allowReveal, uploadRoots: ctx.config.uploadRoots, writeRoots: ctx.config.writeRoots },
    howToConnect: browsers.length ? undefined : `Install the BrowserForge extension, open its popup, paste the token from ${path.join(ctx.config.configDir, 'extension-token')} and press Connect (server ws://${ctx.config.host}:${ctx.config.port}/ext).`,
  };
}

export function registerSystemTools(server: McpServer, ctx: ServerContext): void {
  registerTool(server, ctx, {
    name: 'system_status', title: 'System status', readOnly: true,
    description: 'Server and browser connection status, capture stats and active policy. Call this first to see which browsers are connected.',
    input: z.object({}),
    run: async () => systemStatus(ctx),
  });
  registerTool(server, ctx, {
    name: 'system_diagnostics', title: 'System diagnostics', readOnly: true,
    description: 'Self-checks (loopback binding, token file permissions, browser link) plus recent operational errors and the browser activity log. Never includes page content or secrets.',
    input: z.object({ browserId: z.string().max(100).optional() }),
    run: async ({ browserId }, x) => {
      const checks: { name: string; ok: boolean; detail: string }[] = [];
      checks.push({ name: 'loopback-binding', ok: ctx.config.host === '127.0.0.1', detail: `listening on ${ctx.config.host}` });
      for (const f of ['extension-token', 'mcp-token']) {
        const p = path.join(ctx.config.configDir, f);
        try {
          const mode = fs.statSync(p).mode & 0o777;
          checks.push({ name: `${f}-permissions`, ok: (mode & 0o077) === 0, detail: `mode ${mode.toString(8)}` });
        } catch {
          checks.push({ name: `${f}-permissions`, ok: false, detail: 'missing' });
        }
      }
      const peers = ctx.hub.listPeers();
      checks.push({ name: 'browser-connected', ok: peers.some((p) => p.connected), detail: `${peers.filter((p) => p.connected).length} connected` });
      try {
        const st = (await ctx.hub.call('status', {}, { browserId, timeoutMs: 3000, signal: x.signal })) as { yolo?: boolean };
        checks.push({ name: 'approval-mode', ok: st.yolo !== true, detail: st.yolo ? 'YOLO: every approval auto-passes (set by the human in the extension popup)' : 'manual: consequential actions wait for the human' });
      } catch {
        /* no browser, or several without browserId: skip */
      }
      let activity: unknown = [];
      try {
        activity = ctx.hub.getActivity(browserId);
      } catch {
        /* no browser */
      }
      return {
        checks,
        recentErrors: ctx.hub.recentErrors.slice(-20),
        logs: ctx.logFile ? { file: ctx.logFile.current(), dir: ctx.logFile.dir, retentionDays: ctx.config.logging.retentionDays, readWith: 'browserforge logs --tail 100 --level warn' } : { file: null, hint: 'File logging is off (started with --no-log-file).' },
        activity,
        runtime: { node: process.version, platform: process.platform, rssMB: Math.round(process.memoryUsage().rss / 1048576) },
        workflows: ctx.workflows.list().length,
      };
    },
  });
}
