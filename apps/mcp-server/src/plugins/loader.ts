import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { samePermissions, type PluginDefinition } from '@browserforge/plugin-sdk';
import type { ServerContext } from '../context.js';
import { createMcpServer } from '../mcp.js';
import { readManifest } from './installer.js';
import { discoverSkills } from './skills.js';
import { emptyRegistry, type InstalledPlugin, type LoadedPlugin } from './types.js';

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,62}$/;
const MAX_TOOLS_PER_PLUGIN = 30;

/** Import every enabled plugin and collect its tools. A broken plugin is skipped with a reason; the server still starts. */
export async function loadPlugins(ctx: ServerContext): Promise<void> {
  const reg = emptyRegistry();
  ctx.plugins = reg;
  // Building one throwaway server registers every core tool in ctx.tools, so a plugin can be checked against their names.
  createMcpServer(ctx);
  const claimed = new Set(ctx.tools.keys());
  const claimedPrefixes = new Set<string>();

  const loadOne = async (rec: InstalledPlugin): Promise<void> => {
    if (rec.kind !== 'plugin' || !rec.enabled) return;
    const skip = (reason: string) => {
      reg.skipped.push({ id: rec.id, reason });
      ctx.logger.warn('plugin skipped', { plugin: rec.id, reason });
    };
    try {
      const pkgRoot = ctx.pluginStore.pkgRoot(rec);
      const { manifest, version, main } = readManifest(pkgRoot);
      if (manifest.id !== rec.id) return void skip(`the package now calls itself '${manifest.id}'`);
      if (!samePermissions(manifest.permissions, rec.granted)) return void skip(`it now asks for different permissions than you approved. Review them and approve again: browserforge plugin update ${rec.id}`);
      const prefix = manifest.toolPrefix!;
      if (claimedPrefixes.has(prefix)) return void skip(`tool prefix '${prefix}' is already used by another plugin`);

      const entry = path.resolve(pkgRoot, manifest.main ?? main ?? 'index.js');
      const realRoot = fs.realpathSync(pkgRoot);
      if (!fs.existsSync(entry) || !fs.realpathSync(entry).startsWith(realRoot + path.sep)) return void skip('its main file is missing or outside the package');
      const mod = (await import(pathToFileURL(entry).href)) as { default?: PluginDefinition; plugin?: PluginDefinition };
      const def = mod.default ?? mod.plugin;
      if (!def || !Array.isArray(def.tools)) return void skip('it does not export definePlugin({ tools }) as its default');
      if (def.tools.length > MAX_TOOLS_PER_PLUGIN) return void skip(`it adds more than ${MAX_TOOLS_PER_PLUGIN} tools`);

      const names = new Set<string>();
      for (const t of def.tools) {
        if (!TOOL_NAME_RE.test(t.name) || !t.name.startsWith(`${prefix}_`)) return void skip(`tool '${t.name}' must be named ${prefix}_<something> (lowercase letters, digits, underscores)`);
        if (claimed.has(t.name) || names.has(t.name)) return void skip(`tool '${t.name}' collides with an existing tool`);
        if (!t.input || typeof t.run !== 'function' || !t.description) return void skip(`tool '${t.name}' needs a description, an input schema and a run function`);
        names.add(t.name);
      }
      for (const e of def.exporters ?? []) if (!/^[a-z][a-z0-9-]{1,30}$/.test(e.format) || typeof e.generate !== 'function') return void skip(`exporter '${String(e.format)}' is invalid`);

      for (const n of names) claimed.add(n);
      claimedPrefixes.add(prefix);
      for (const t of def.tools) if (t.workflowSafe) reg.workflowSafe.add(t.name);
      ctx.extraExporters.push(...(def.exporters ?? []));
      const loaded: LoadedPlugin = { manifest, granted: rec.granted, version, tools: def.tools, exporters: def.exporters ?? [] };
      reg.plugins.push(loaded);
      ctx.logger.info('plugin loaded', { plugin: rec.id, version, tools: def.tools.length });
    } catch (e) {
      skip(`it failed to load: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    }
  };
  for (const rec of ctx.pluginStore.list()) await loadOne(rec); // a skipped plugin never stops the others from loading

  reg.skills = discoverSkills(ctx.config.configDir, ctx.pluginStore, (where, e) => {
    reg.skipped.push({ id: path.basename(where), reason: `skill failed to load: ${e instanceof Error ? e.message : String(e)}` });
  });
}
