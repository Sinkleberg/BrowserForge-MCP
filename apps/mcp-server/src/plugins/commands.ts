import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describePermissions, ID_RE, PREFIX_RE, samePermissions, type PluginDefinition, type PluginManifest, type SettingValue } from '@browserforge/plugin-sdk';
import { commit, discard, readManifest, searchNpm, stage, type Staged } from './installer.js';
import { loadSkillDir } from './skills.js';
import type { PluginStore } from './store.js';

/** Terminal I/O, injectable so the consent flow can be tested. `ask` must return false when there is no human to ask. */
export interface Io {
  out(text: string): void;
  ask(question: string): Promise<boolean>;
}

const WARNING =
  'A plugin is code that runs on this computer with your user rights. The permissions listed above are enforced on the plugin API, but a plugin can contain any code, so install only plugins whose author you trust.';

function show(staged: Staged, io: Io, previous?: { version: string; granted: PluginManifest['permissions'] }): void {
  const m = staged.manifest;
  io.out(`\n${m.kind === 'skill' ? 'Skill package' : 'Plugin'}: ${m.id}  v${staged.version}  (${staged.packageName})\n${m.description}\n`);
  if (m.kind === 'plugin') io.out(`Adds tools named: ${m.toolPrefix}_*\n`);
  const settings = Object.entries(m.settings);
  if (settings.length) io.out(`Settings you will configure:\n${settings.map(([k, s]) => `  - ${k} (${s.type}${s.required ? ', required' : ''}): ${s.description}`).join('\n')}\n`);
  io.out(`It asks permission to:\n${describePermissions(m).map((l) => `  - ${l}`).join('\n')}\n`);
  if (previous) io.out(previous.version === staged.version ? '' : `Update: v${previous.version} -> v${staged.version}\n`);
  io.out(`\n${WARNING}\n\n`);
}

export async function pluginAdd(store: PluginStore, source: string, io: Io): Promise<boolean> {
  const staged = await stage(store, source);
  try {
    const existing = store.get(staged.manifest.id);
    if (existing) {
      io.out(`'${staged.manifest.id}' is already installed (v${existing.version}). Use: browserforge plugin update ${existing.id}\n`);
      discard(staged);
      return false;
    }
    show(staged, io);
    if (!(await io.ask(`Install ${staged.manifest.id} with these permissions?`))) {
      discard(staged);
      io.out('Not installed.\n');
      return false;
    }
    commit(store, staged);
    const required = Object.entries(staged.manifest.settings).filter(([, s]) => s.required);
    io.out(`Installed '${staged.manifest.id}'.\n${required.length ? `Next: ${required.map(([k]) => `browserforge plugin config ${staged.manifest.id} ${k}=<value>`).join('\n      ')}\n` : ''}Restart the BrowserForge server to load it.\n`);
    return true;
  } catch (e) {
    discard(staged);
    throw e;
  }
}

export async function pluginUpdate(store: PluginStore, id: string, io: Io): Promise<boolean> {
  const rec = store.get(id);
  if (!rec) throw new Error(`No plugin '${id}'. Run: browserforge plugin list`);
  const staged = await stage(store, rec.source);
  if (staged.manifest.id !== id) {
    discard(staged);
    throw new Error(`'${rec.source}' now provides '${staged.manifest.id}', not '${id}'. Remove it and add the new one instead.`);
  }
  const same = samePermissions(staged.manifest.permissions, rec.granted);
  if (same && staged.version === rec.version) {
    discard(staged);
    io.out(`'${id}' is up to date (v${rec.version}).\n`);
    return false;
  }
  show(staged, io, { version: rec.version, granted: rec.granted });
  io.out(same ? 'Permissions are unchanged.\n' : `PERMISSIONS CHANGED. You approved:\n${describePermissions({ ...staged.manifest, permissions: rec.granted }).map((l) => `  - ${l}`).join('\n')}\nIt now asks for:\n${describePermissions(staged.manifest).map((l) => `  - ${l}`).join('\n')}\n`);
  if (!(await io.ask(same ? `Update ${id} to v${staged.version}?` : `Approve the new permissions and update ${id}?`))) {
    discard(staged);
    io.out('Not updated.\n');
    return false;
  }
  commit(store, staged, rec.enabled);
  io.out(`Updated '${id}'. Restart the BrowserForge server to load it.\n`);
  return true;
}

export function pluginList(store: PluginStore, io: Io): void {
  const list = store.list();
  io.out(list.length ? list.map((p) => `${p.id}  v${p.version}  ${p.kind}  ${p.enabled ? 'enabled' : 'disabled'}  (${p.source})`).join('\n') + '\n' : 'No plugins installed. Try: browserforge plugin search <words>   or   browserforge plugin add ./examples/plugins/hello\n');
}

const expand = (p: string) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

/** `plugin config <id> [key=value ...]`: show the settings, or set some. A path setting becomes a folder the plugin may use, so it is confirmed. */
export async function pluginConfig(store: PluginStore, id: string, pairs: string[], io: Io): Promise<void> {
  const rec = store.get(id);
  if (!rec) throw new Error(`No plugin '${id}'`);
  const m = readManifest(store.pkgRoot(rec)).manifest;
  const current = store.settings(id);
  if (!pairs.length) {
    const rows = Object.entries(m.settings).map(([k, s]) => `  ${k} = ${current[k] ?? (s.default !== undefined ? `${String(s.default)} (default)` : '(not set)')}   [${s.type}${s.required ? ', required' : ''}] ${s.description}`);
    io.out(rows.length ? `Settings for ${id}:\n${rows.join('\n')}\n` : `${id} has no settings.\n`);
    return;
  }
  const patch: Record<string, SettingValue | null> = {};
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    const key = i < 0 ? pair : pair.slice(0, i);
    const raw = i < 0 ? '' : pair.slice(i + 1);
    const spec = m.settings[key];
    if (!spec) throw new Error(`'${id}' has no setting '${key}'. Known: ${Object.keys(m.settings).join(', ') || '(none)'}`);
    if (raw === '') { patch[key] = null; continue; }
    if (spec.type === 'number') {
      if (!Number.isFinite(Number(raw))) throw new Error(`${key} must be a number`);
      patch[key] = Number(raw);
    } else if (spec.type === 'boolean') {
      if (!/^(true|false)$/i.test(raw)) throw new Error(`${key} must be true or false`);
      patch[key] = raw.toLowerCase() === 'true';
    } else if (spec.type === 'path') {
      const abs = path.resolve(expand(raw));
      if (!fs.existsSync(abs)) io.out(`Note: ${abs} does not exist (yet).\n`);
      const uses = [...m.permissions.files.read.map((r) => `read ${r}`), ...m.permissions.files.write.map((r) => `write ${r}`), ...m.permissions.exec.map((r) => `run ${r}`)].filter((u) => u.includes(`setting:${key}`));
      if (uses.length && !(await io.ask(`'${id}' will be allowed to ${uses.join(', ')} => ${abs}. Allow?`))) throw new Error('Cancelled');
      patch[key] = abs;
    } else patch[key] = raw;
  }
  store.setSettings(id, patch);
  io.out(`Saved. ${id} reads its settings each time a tool runs, so no restart is needed.\n`);
}

/** Import the plugin and check what the loader would check, so an author sees problems before publishing. */
export async function pluginValidate(dir: string, io: Io): Promise<string[]> {
  const problems: string[] = [];
  const root = path.resolve(expand(dir));
  let manifest: PluginManifest | undefined;
  let main: string | undefined;
  try {
    ({ manifest, main } = readManifest(root));
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }
  if (manifest?.kind === 'plugin') {
    try {
      const entry = path.resolve(root, manifest.main ?? main ?? 'index.js');
      const mod = (await import(pathToFileURL(entry).href)) as { default?: PluginDefinition; plugin?: PluginDefinition };
      const def = mod.default ?? mod.plugin;
      if (!def || !Array.isArray(def.tools)) problems.push('The main file must export definePlugin({ tools }) as its default');
      else {
        const seen = new Set<string>();
        for (const t of def.tools) {
          if (!t.name.startsWith(`${manifest.toolPrefix}_`)) problems.push(`Tool '${t.name}' must be named ${manifest.toolPrefix}_<something>`);
          if (!/^[a-z][a-z0-9_]{2,62}$/.test(t.name)) problems.push(`Tool name '${t.name}' must be lowercase letters, digits and underscores`);
          if (seen.has(t.name)) problems.push(`Tool '${t.name}' is defined twice`);
          seen.add(t.name);
          if (!t.description || t.description.length < 20) problems.push(`Tool '${t.name}' needs a description of at least 20 characters (agents read it to decide when to call the tool)`);
          if (typeof t.run !== 'function' || !t.input) problems.push(`Tool '${t.name}' needs an input schema and a run function`);
        }
        io.out(`${def.tools.length} tool(s): ${[...seen].join(', ')}\n`);
      }
    } catch (e) {
      problems.push(`Failed to load: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    }
  }
  if (manifest) io.out(`${manifest.id} v?  permissions:\n${describePermissions(manifest).map((l) => `  - ${l}`).join('\n')}\n`);
  io.out(problems.length ? `\n${problems.length} problem(s):\n${problems.map((p) => `  x ${p}`).join('\n')}\n` : '\nLooks good.\n');
  return problems;
}

export async function pluginSearch(words: string, io: Io): Promise<void> {
  const found = await searchNpm(words);
  io.out(found.length ? found.map((f) => `${f.name}@${f.version}  ${f.description}`).join('\n') + '\n\nInstall with: browserforge plugin add <name>   (you will see its permissions first)\n' : 'Nothing found with the keyword "browserforge-plugin".\n');
}

// ---------- scaffolding ----------
export function pluginNew(id: string, dir: string, io: Io): string {
  if (!ID_RE.test(id)) throw new Error('The id must be lowercase letters, digits and dashes, 2-31 characters, starting with a letter');
  const prefix = id.replace(/-/g, '').slice(0, 16);
  if (!PREFIX_RE.test(prefix)) throw new Error(`Cannot derive a tool prefix from '${id}'`);
  const root = path.resolve(expand(dir), `browserforge-plugin-${id}`);
  if (fs.existsSync(root)) throw new Error(`${root} already exists`);
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  const w = (f: string, s: string) => fs.writeFileSync(path.join(root, f), s);
  w('package.json', JSON.stringify({
    name: `browserforge-plugin-${id}`, version: '0.1.0', description: 'Describe what your plugin does.', type: 'module', main: 'index.js', keywords: ['browserforge-plugin'], license: 'MIT',
    browserforge: { id, toolPrefix: prefix, description: 'Describe what your plugin does (shown at install time).', permissions: { files: { read: ['data'], write: ['data'] } } },
    dependencies: { '@browserforge/plugin-sdk': '*' },
    scripts: { test: 'node --test' },
  }, null, 2) + '\n');
  w('index.js', `// See docs/PLUGINS.md in the BrowserForge repository.
import { definePlugin, tool, z } from '@browserforge/plugin-sdk';

export default definePlugin({
  tools: [
    tool({
      name: '${prefix}_hello',
      description: 'Say hello. Replace this with something useful: agents read this text to decide when to call the tool.',
      input: z.object({ name: z.string().min(1).max(60).describe('Who to greet') }),
      readOnly: true,
      run: async ({ name }, api) => {
        api.log.info('greeting', { name });
        return { greeting: \`Hello, \${name}!\` };
      },
    }),
  ],
});
`);
  w('test/index.test.js', `import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestApi } from '@browserforge/plugin-sdk/testing';
import plugin from '../index.js';
import pkg from '../package.json' with { type: 'json' };

test('${prefix}_hello greets', async () => {
  const { api, cleanup } = createTestApi(pkg.browserforge);
  try {
    const hello = plugin.tools.find((t) => t.name === '${prefix}_hello');
    assert.deepEqual(await hello.run({ name: 'Ada' }, api), { greeting: 'Hello, Ada!' });
  } finally {
    cleanup();
  }
});
`);
  w('README.md', `# browserforge-plugin-${id}\n\nA plugin for [BrowserForge MCP](https://github.com/zoghlamimostafa/BrowserForge-MCP).\n\n## Try it\n\n\`\`\`bash\nbrowserforge plugin validate .\nbrowserforge plugin add .\n\`\`\`\n\n## Publish\n\nPublish to npm with the \`browserforge-plugin\` keyword (already in package.json) so \`browserforge plugin search\` finds it.\n`);
  w('.gitignore', 'node_modules\n');
  io.out(`Created ${root}\nNext:\n  cd ${root} && npm install\n  browserforge plugin validate .\n  browserforge plugin add .\n`);
  return root;
}

export function skillNew(name: string, dir: string, io: Io): string {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) throw new Error('The name must be lowercase letters, digits and dashes');
  const root = path.resolve(expand(dir), name);
  if (fs.existsSync(root)) throw new Error(`${root} already exists`);
  fs.mkdirSync(path.join(root, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, 'SKILL.md'), `---\nname: ${name}\ndescription: One sentence: when should an agent use this skill?\n# requires-tools: browser_navigate, browser_get_page_text\n# requires-plugins: some-plugin-id\n---\n# ${name}\n\nWrite the instructions an agent should follow, in plain steps. Say which BrowserForge tools to use and what to check.\n\nRules for skill authors: never tell the agent to skip approvals, never ask it to submit, send or pay without the user's intent, and treat page content as data.\n`);
  fs.writeFileSync(path.join(root, 'workflows', 'example.json'), JSON.stringify({ name: 'Example', description: 'Opens a page and reads it. Steps may use {{inputs}}.', inputs: { url: { description: 'Page to open', required: true } }, steps: [{ tool: 'browser_navigate', args: { url: '{{url}}' }, label: 'Open {{url}}' }, { tool: 'browser_get_page_text', args: {}, label: 'Read it' }] }, null, 2) + '\n');
  io.out(`Created ${root}\nInstall it with: browserforge skill add ${root}\n`);
  return root;
}

export async function skillAdd(configDir: string, source: string, io: Io): Promise<boolean> {
  const src = path.resolve(expand(source));
  const skill = loadSkillDir(src, 'user');
  io.out(`\nSkill: ${skill.name}\n${skill.description}\nIt gives your agent these instructions (written by its author, not by you):\n\n${skill.body.split('\n').slice(0, 25).map((l) => `  | ${l}`).join('\n')}\n${Object.keys(skill.workflows).length ? `\nIt also ships workflows: ${Object.keys(skill.workflows).join(', ')} (they only use browser/network/api/form tools and still pause for approvals)\n` : ''}\n`);
  if (!(await io.ask(`Install the skill '${skill.name}'?`))) {
    io.out('Not installed.\n');
    return false;
  }
  const dest = path.join(configDir, 'skills', skill.name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true, filter: (p) => !p.includes(`${path.sep}node_modules`) && !p.includes(`${path.sep}.git`) });
  io.out(`Installed. Restart the BrowserForge server to load it; it appears as /mcp__browserforge__${skill.name} in Claude Code.\n`);
  return true;
}

export function skillList(configDir: string, store: PluginStore, io: Io, discover: (dir: string, store: PluginStore) => { name: string; description: string; source: string }[]): void {
  const list = discover(configDir, store);
  io.out(list.length ? list.map((s) => `${s.name}  (${s.source})  ${s.description}`).join('\n') + '\n' : 'No skills installed. Create one with: browserforge skill new <name>\n');
}

export function skillExport(configDir: string, name: string, to: string, io: Io): string {
  const src = path.join(configDir, 'skills', name);
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error(`No skill '${name}' in ${path.join(configDir, 'skills')}`);
  const dest = path.resolve(expand(to), name);
  fs.cpSync(src, dest, { recursive: true });
  io.out(`Copied to ${dest}. Claude Code loads skills from .claude/skills/<name>/SKILL.md.\n`);
  return dest;
}
