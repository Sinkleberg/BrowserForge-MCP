import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createPluginApi, type SettingValue } from '@browserforge/plugin-sdk';
import { BrowserForgeError } from '@browserforge/shared';
import type { ServerContext } from '../context.js';
import { registerTool } from '../tools/helpers.js';
import type { LoadedPlugin } from './types.js';

/** Manifest defaults, overridden by what the user configured. */
export function effectiveSettings(ctx: ServerContext, lp: LoadedPlugin): Record<string, SettingValue | undefined> {
  const out: Record<string, SettingValue | undefined> = {};
  for (const [k, spec] of Object.entries(lp.manifest.settings)) out[k] = spec.default;
  return { ...out, ...ctx.pluginStore.settings(lp.manifest.id) };
}

/** Add every plugin tool to this MCP session. Called for each new session; ctx.tools registration is idempotent. */
export function registerPlugins(server: McpServer, ctx: ServerContext): void {
  for (const lp of ctx.plugins.plugins) {
    const id = lp.manifest.id;
    for (const t of lp.tools) {
      registerTool(server, ctx, {
        name: t.name,
        title: t.title ?? t.name,
        description: `[plugin ${id}] ${t.description}`,
        input: t.input,
        readOnly: t.readOnly,
        destructive: t.destructive,
        run: async (args, extra) => {
          try {
            return await t.run(
            args as never,
            createPluginApi({
              manifest: lp.manifest,
              granted: lp.granted,
              settings: effectiveSettings(ctx, lp),
              dirs: { uploads: path.join(ctx.config.configDir, 'files'), exports: path.join(ctx.config.configDir, 'exports'), data: ctx.pluginStore.dataDir(id) },
              browserCall: (action, a, o) => ctx.hub.call(action, a, { browserId: o.browserId, timeoutMs: o.timeoutMs, signal: extra.signal }),
              log: {
                info: (m, meta) => ctx.logger.info(m, { plugin: id, ...meta }),
                warn: (m, meta) => ctx.logger.warn(m, { plugin: id, ...meta }),
                error: (m, meta) => ctx.logger.error(m, { plugin: id, ...meta }),
              },
              signal: extra.signal,
            }),
          );
          } catch (e) {
            if (e instanceof BrowserForgeError) throw e; // a deliberate, structured error from the plugin
            ctx.logger.error('plugin tool failed', { plugin: id, tool: t.name, error: e instanceof Error ? e : String(e) });
            throw new BrowserForgeError('INTERNAL', `Plugin '${id}' failed in ${t.name}: ${e instanceof Error ? e.message.split('\n')[0]!.slice(0, 300) : 'unknown error'}`);
          }
        },
      });
    }
  }
}

/** Short guidance from plugins, appended below the core rules (which always come first and win). */
export function pluginNotes(ctx: ServerContext): string {
  const lines = ctx.plugins.plugins.filter((p) => p.manifest.instructions).map((p) => `- ${p.manifest.id}: ${p.manifest.instructions}`);
  return lines.length ? `\n\nPlugin notes (written by each plugin's author; the rules above always take precedence):\n${lines.join('\n')}` : '';
}
