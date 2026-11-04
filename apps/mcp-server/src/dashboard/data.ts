import { describePermissions } from '@browserforge/plugin-sdk';
import type { ServerContext } from '../context.js';
import { deciderStatus } from '../decider.js';
import { systemStatus } from '../tools/system.js';

/**
 * Everything the read-only dashboard shows. It is built from what the daemon already knows and never includes tokens, secrets, typed values,
 * page content or profile data. Plugin and skill texts are written by other people: the page shows them as plain text only.
 */

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Core tools are grouped by the word before the first underscore (browser, network, api, ...); a plugin tool says "[plugin <id>]". */
function toolRows(ctx: ServerContext) {
  // ctx.tools is filled when the server starts (the plugin loader builds the tool list once), so it is complete before any agent connects.
  return [...ctx.tools.entries()]
    .map(([name, t]) => {
      const description = t.meta?.description ?? '';
      const plugin = /^\[plugin ([a-z0-9][a-z0-9._-]*)\]/i.exec(description)?.[1];
      return {
        name,
        title: t.meta?.title ?? name,
        description: clip(description.replace(/^\[plugin [^\]]*\]\s*/i, ''), 300),
        readOnly: t.meta?.readOnly ?? false,
        group: plugin ? `plugin:${plugin}` : (name.split('_')[0] ?? name),
      };
    })
    .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}

const modelCache = new WeakMap<ServerContext, { at: number; value: Awaited<ReturnType<typeof deciderStatus>> }>();
/** Asking the local model servers is slow when they are down, and the page refreshes every few seconds: look at most every 15 s. */
async function modelStatus(ctx: ServerContext) {
  const hit = modelCache.get(ctx);
  if (hit && Date.now() - hit.at < 15_000) return hit.value;
  const value = await deciderStatus(ctx.config.decider);
  modelCache.set(ctx, { at: Date.now(), value });
  return value;
}

export async function dashboardData(ctx: ServerContext) {
  const status = systemStatus(ctx);
  const loadedIds = new Set(ctx.plugins.plugins.map((p) => p.manifest.id));
  const flows = ctx.flows.list();
  const traces = ctx.knowledge.traces;

  const plugins = [
    ...ctx.plugins.plugins.map((p) => ({
      id: p.manifest.id,
      version: p.version,
      state: 'loaded' as const,
      description: clip(p.manifest.description, 300),
      toolPrefix: p.manifest.toolPrefix ?? '',
      tools: p.tools.map((t) => t.name),
      permissions: describePermissions({ ...p.manifest, permissions: p.granted }),
    })),
    ...ctx.plugins.skipped.map((s) => ({ id: s.id, version: '', state: 'skipped' as const, description: '', toolPrefix: '', tools: [] as string[], permissions: [] as string[], reason: clip(s.reason, 300) })),
    // Installed but switched off, and not already listed as loaded or skipped.
    ...ctx.pluginStore
      .list()
      .filter((r) => r.kind === 'plugin' && !r.enabled && !loadedIds.has(r.id))
      .map((r) => ({ id: r.id, version: r.version, state: 'disabled' as const, description: '', toolPrefix: '', tools: [] as string[], permissions: [] as string[] })),
  ];

  return {
    generatedAt: new Date().toISOString(),
    server: status.server,
    transports: status.transports,
    browsers: status.browsers,
    connected: status.connected,
    policy: { allowReveal: status.policy.allowReveal },
    tools: toolRows(ctx),
    plugins,
    skills: ctx.plugins.skills.map((s) => ({
      name: s.name,
      description: clip(s.description, 300),
      source: s.source,
      requiresTools: s.requiresTools,
      requiresPlugins: s.requiresPlugins,
      workflows: Object.values(s.workflows).map((w) => ({ name: w.name, description: clip(w.description ?? '', 200), inputs: Object.keys(w.inputs), steps: w.steps.length })),
    })),
    flows: { total: flows.length, recent: flows.slice(0, 20) },
    localModels: {
      mode: ctx.config.decider.mode,
      status: await modelStatus(ctx),
      traces: { recording: traces.enabled, ...traces.stats() },
    },
    sites: ctx.knowledge.sites.list().length,
  };
}
