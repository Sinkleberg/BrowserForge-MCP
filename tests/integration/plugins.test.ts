import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSpec, commit, discard, searchNpm, stage } from '../../apps/mcp-server/src/plugins/installer.js';
import { PluginStore } from '../../apps/mcp-server/src/plugins/store.js';
import { fillWorkflow, loadSkillDir, parseSkillMd } from '../../apps/mcp-server/src/plugins/skills.js';
import { startStack, type Stack } from '../helpers/stack.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const HELLO = path.join(ROOT, 'examples/plugins/hello');
const SDK = pathToFileURL(path.join(ROOT, 'packages/plugin-sdk/dist/index.js')).href;

const stacks: Stack[] = [];
const tmps: string[] = [];
afterEach(async () => {
  while (stacks.length) await stacks.pop()!.close();
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-plug-')); tmps.push(d); return d; };

/** Write a plugin package to disk. `source` can use definePlugin, tool and z. */
function makePlugin(manifest: Record<string, unknown>, source: string, opts: { zodCopy?: boolean } = {}): string {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `browserforge-plugin-${String(manifest.id).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, version: '1.0.0', type: 'module', main: 'index.js', browserforge: { description: 'test plugin', ...manifest } }));
  const zodImport = opts.zodCopy ? `import * as zodCopy from './node_modules/zod/index.js';\nconst z = zodCopy.z ?? zodCopy;\nimport { definePlugin, tool } from ${JSON.stringify(SDK)};` : `import { definePlugin, tool, z } from ${JSON.stringify(SDK)};`;
  fs.writeFileSync(path.join(dir, 'index.js'), `${zodImport}\n${source}`);
  if (opts.zodCopy) fs.cpSync(path.join(ROOT, 'node_modules/zod'), path.join(dir, 'node_modules/zod'), { recursive: true });
  return dir;
}
const simple = (name: string, body = "async () => ({ ok: true })") => `export default definePlugin({ tools: [tool({ name: ${JSON.stringify(name)}, description: 'a test tool', input: z.object({}), readOnly: true, run: ${body} })] });`;

async function install(home: string, source: string): Promise<void> {
  const store = new PluginStore(home);
  commit(store, await stage(store, source));
}
async function stackWith(...sources: string[]): Promise<Stack> {
  const s = await startStack({ beforeStart: async (home) => { for (const src of sources) await install(home, src); } });
  stacks.push(s);
  return s;
}
const names = async (s: Stack) => (await s.client.listTools()).tools.map((t) => t.name);

describe('installing', () => {
  it('stages a plugin without running its code, shows what it asks for, and installs it only when committed', async () => {
    const store = new PluginStore(tmp());
    const staged = await stage(store, HELLO);
    expect(staged.manifest).toMatchObject({ id: 'hello', toolPrefix: 'hello', permissions: { files: { read: ['data'], write: ['data'] }, exec: [], browser: false } });
    expect(store.list()).toEqual([]); // nothing installed yet
    discard(staged);
    expect(fs.existsSync(staged.stagingDir)).toBe(false);
    const again = await stage(store, HELLO);
    const rec = commit(store, again);
    expect(rec).toMatchObject({ id: 'hello', enabled: true, kind: 'plugin', granted: { files: { write: ['data'] } } });
    expect(store.list().length).toBe(1);
    expect(fs.statSync(path.join(store.root, '..', 'plugins.json')).mode & 0o077).toBe(0);
  });

  it('refuses things that are not plugins, option-looking sources, and cleans up after itself', async () => {
    const store = new PluginStore(tmp());
    const notPlugin = tmp();
    fs.writeFileSync(path.join(notPlugin, 'package.json'), JSON.stringify({ name: 'plain', version: '1.0.0' }));
    await expect(stage(store, notPlugin)).rejects.toThrow(/not a BrowserForge plugin/);
    const bad = makePlugin({ id: 'Bad Id', toolPrefix: 'x' }, simple('x_a'));
    await expect(stage(store, bad)).rejects.toThrow(/Invalid plugin manifest/);
    for (const s of ['--registry=http://evil', '-g foo', 'a b', '']) expect(() => checkSpec(s)).toThrow(/Not a valid plugin source/);
    expect(fs.readdirSync(store.root).filter((f) => f.startsWith('.staging-'))).toEqual([]);
  });

  it('searches npm only when asked, by keyword', async () => {
    let url = '';
    const res = await searchNpm('cv tools', (async (u: string) => { url = u; return new Response(JSON.stringify({ objects: [{ package: { name: 'browserforge-plugin-x', version: '1.2.3', description: 'x' } }] })); }) as never);
    expect(decodeURIComponent(url)).toContain('keywords:browserforge-plugin cv tools');
    expect(res).toEqual([{ name: 'browserforge-plugin-x', version: '1.2.3', description: 'x' }]);
  });
});

describe('a running server with plugins', () => {
  it('registers the plugin\'s tools, keeps its data private, allows workflow-safe tools and adds its notes below the core rules', async () => {
    const s = await stackWith(HELLO);
    expect(await names(s)).toEqual(expect.arrayContaining(['hello_greet', 'hello_note_add', 'hello_note_list', 'browser_click']));
    expect((await s.call('hello_greet', { name: 'Ada' })).data).toEqual({ greeting: 'Hello, Ada!' });
    expect((await s.call('hello_note_add', { text: 'first' })).data).toMatchObject({ saved: true });
    await s.call('hello_note_add', { text: 'second' });
    const list = (await s.call('hello_note_list')).data;
    expect(list).toMatchObject({ untrustedWebContent: true, origin: 'plugin:hello:notes', data: ['first', 'second'] });
    expect(fs.readFileSync(path.join(s.home, 'plugins/hello/data/notes.txt'), 'utf8')).toBe('first\nsecond\n');
    expect((await s.call('hello_greet', {})).isError).toBe(true); // validated by the plugin's own schema
    const tools = (await s.client.listTools()).tools;
    expect((tools.find((t) => t.name === 'hello_greet')!.inputSchema as any).additionalProperties).toBe(false);
    expect(tools.find((t) => t.name === 'hello_greet')!.description).toMatch(/^\[plugin hello\]/);
    const inst = s.client.getInstructions()!;
    expect(inst.indexOf('Do not attempt to bypass CAPTCHAs')).toBeLessThan(inst.indexOf('Plugin notes'));
    expect(inst).toContain('hello: hello_note_add');
    const status = (await s.call('system_status')).data;
    expect(status.plugins.loaded).toEqual([expect.objectContaining({ id: 'hello', tools: ['hello_greet', 'hello_note_add', 'hello_note_list'] })]);
    // hello_greet is workflowSafe, the note tools are not.
    expect((await s.call('workflow_create', { name: 'w', steps: [{ tool: 'hello_greet', args: { name: 'x' } }] })).isError).toBe(false);
    expect((await s.call('workflow_create', { name: 'w', steps: [{ tool: 'hello_note_add', args: { text: 'x' } }] })).isError).toBe(true);
  });

  it('switches a plugin off when its code later asks for permissions you did not approve', async () => {
    const s = await startStack({
      beforeStart: async (home) => {
        await install(home, HELLO);
        const file = path.join(home, 'plugins.json');
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        j.plugins[0].granted.files.write = []; // what was approved: no write access. The package asks for more.
        fs.writeFileSync(file, JSON.stringify(j));
      },
    });
    stacks.push(s);
    expect(await names(s)).not.toContain('hello_greet');
    expect((await s.call('system_status')).data.plugins.skipped[0]).toMatchObject({ id: 'hello', reason: expect.stringMatching(/different permissions[\s\S]*plugin update hello/) });
  });

  it('refuses tools that shadow core tools, break the prefix rule or collide, without taking the server down', async () => {
    const shadow = makePlugin({ id: 'shadow', toolPrefix: 'shadow' }, simple('browser_click'));
    const wrongPrefix = makePlugin({ id: 'wrongp', toolPrefix: 'wrongp' }, simple('other_thing'));
    const first = makePlugin({ id: 'firstp', toolPrefix: 'dup' }, simple('dup_a'));
    const second = makePlugin({ id: 'secondp', toolPrefix: 'dup' }, simple('dup_b'));
    const crash = makePlugin({ id: 'crashy', toolPrefix: 'crashy' }, "throw new Error('boom at import');");
    const noDefault = makePlugin({ id: 'nodef', toolPrefix: 'nodef' }, 'export const x = 1;');
    const good = makePlugin({ id: 'goodp', toolPrefix: 'good' }, simple('good_one'));
    const s = await stackWith(shadow, wrongPrefix, first, second, crash, noDefault, good);
    const tools = await names(s);
    expect(tools).toEqual(expect.arrayContaining(['good_one', 'dup_a']));
    for (const t of ['dup_b', 'other_thing']) expect(tools).not.toContain(t);
    expect(tools.filter((t) => t === 'browser_click').length).toBe(1);
    const skipped = Object.fromEntries((await s.call('system_status')).data.plugins.skipped.map((x: any) => [x.id, x.reason]));
    expect(skipped.shadow).toMatch(/must be named shadow_/);
    expect(skipped.wrongp).toMatch(/must be named wrongp_/);
    expect(skipped.secondp).toMatch(/prefix 'dup' is already used/);
    expect(skipped.crashy).toMatch(/failed to load: boom at import/);
    expect(skipped.nodef).toMatch(/does not export definePlugin/);
    expect((await s.call('good_one')).data).toEqual({ ok: true });
  });

  it('works with a plugin that ships its own copy of zod, as published community plugins will', async () => {
    const own = makePlugin(
      { id: 'ownzod', toolPrefix: 'ownzod' },
      `export default definePlugin({ tools: [tool({ name: 'ownzod_add', description: 'adds', input: z.object({ a: z.number().int(), b: z.number().int().default(1) }), readOnly: true, run: async ({ a, b }) => ({ sum: a + b }) })] });`,
      { zodCopy: true },
    );
    const s = await stackWith(own);
    expect((await s.call('ownzod_add', { a: 2 })).data).toEqual({ sum: 3 });
    expect((await s.call('ownzod_add', { a: 'x' })).isError).toBe(true);
    expect((await s.call('ownzod_add', { a: 1, extra: 1 })).isError).toBe(true);
    expect(((await s.client.listTools()).tools.find((t) => t.name === 'ownzod_add')!.inputSchema as any).properties.a.type).toBe('integer');
  });

  it('keeps disabled plugins off, enforces the manifest\'s file permissions at run time, and sets defaults from settings', async () => {
    const reader = makePlugin(
      { id: 'reader', toolPrefix: 'reader', settings: { dir: { type: 'path', description: 'folder' }, greeting: { type: 'string', description: 'g', default: 'hi' } }, permissions: { files: { read: ['setting:dir'] } } },
      `export default definePlugin({ tools: [
        tool({ name: 'reader_cat', description: 'reads a file', input: z.object({ file: z.string() }), readOnly: true, run: async ({ file }, api) => ({ text: api.files.read('setting:dir', file), greeting: api.settings.greeting }) }),
        tool({ name: 'reader_write', description: 'tries to write', input: z.object({}), readOnly: false, run: async (_a, api) => ({ path: api.files.write('data', 'x', 'y') }) }),
      ] });`,
    );
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'contents');
    const s = await startStack({ beforeStart: async (home) => { await install(home, reader); new PluginStore(home).setSettings('reader', { dir }); } });
    stacks.push(s);
    expect((await s.call('reader_cat', { file: 'a.txt' })).data).toEqual({ text: 'contents', greeting: 'hi' });
    expect((await s.call('reader_cat', { file: '../../etc/passwd' })).data.error.code).toBe('PATH_NOT_ALLOWED');
    const w = await s.call('reader_write');
    expect(w.isError).toBe(true);
    expect(w.data.error.code).toBe('PERMISSION_DENIED');
  });

  it('does not load a disabled plugin and forgets a removed one', async () => {
    const home = tmp();
    const store = new PluginStore(home);
    commit(store, await stage(store, HELLO));
    store.setEnabled('hello', false);
    const s = await startStack({ beforeStart: async (h) => { fs.cpSync(home, h, { recursive: true }); } });
    stacks.push(s);
    expect(await names(s)).not.toContain('hello_greet');
    expect(new PluginStore(home).remove('hello')).toBe(true);
    expect(fs.existsSync(path.join(home, 'plugins/hello'))).toBe(false);
    expect(new PluginStore(home).list()).toEqual([]);
  });

  it('adds flow export formats from plugins', async () => {
    const exp = makePlugin(
      { id: 'expo', toolPrefix: 'expo' },
      `export default definePlugin({ tools: [], exporters: [{ format: 'step-count', description: 'counts steps', extension: 'txt', generate: (f) => 'steps=' + f.steps.length }] });`,
    );
    const s = await stackWith(exp);
    s.app.ctx.flows.handle('b1', 'type', { text: 'hi' }, {}, [{ url: 'https://a.test/x', locator: { tag: 'input', label: 'Name', css: '#n' }, fieldLabel: 'Name' }]);
    const id = (await s.call('flow_list')).data.flows[0].id;
    const r = await s.call('flow_export', { id, format: 'step-count' });
    expect(r.data).toMatchObject({ format: 'step-count', code: 'steps=2' });
    expect((await s.call('flow_export', { id, format: 'nope' })).data.error.message).toMatch(/step-count/);
  });
});

describe('the RenderCV plugin, installed for real', () => {
  it('shows its permissions at install, then tailors, renders and logs through the MCP server', async () => {
    const cvDir = tmp();
    fs.mkdirSync(path.join(cvDir, 'AI'));
    fs.writeFileSync(path.join(cvDir, 'AI/master.yaml'), 'cv:\n  name: Ada Lovelace\n  headline: Engineer\n  sections:\n    Summary:\n      - Builds reliable cloud systems.\n    Experience:\n      - company: Acme\n        position: Engineer\n        highlights:\n          - Ran Azure infrastructure.\n');
    const bin = path.join(cvDir, 'fake-rendercv');
    fs.writeFileSync(bin, '#!/bin/sh\nin="$2"; while [ $# -gt 0 ]; do case "$1" in --pdf-path) pdf="$2"; shift;; --png-path) png="$2"; shift;; --typst-path) typ="$2"; shift;; esac; shift; done\nmkdir -p "$(dirname "$pdf")"; printf "%%PDF-fake" > "$pdf"; echo t > "$typ"; echo p > "${png%.png}_1.png"\n', { mode: 0o755 });
    const CV_PLUGIN = path.join(ROOT, 'plugins/rendercv');
    const staged = await stage(new PluginStore(tmp()), CV_PLUGIN);
    const lines = (await import('@browserforge/plugin-sdk')).describePermissions(staged.manifest);
    expect(lines.join('\n')).toMatch(/Read files in: setting:cvDir \(Folder with your master RenderCV YAML[\s\S]*Create and change files in: setting:cvDir\/tailored[\s\S]*uploads\/cv[\s\S]*Run the program: setting:rendercv/);
    expect(lines.join('\n')).not.toMatch(/Drive your browser/); // it never touches your browser
    discard(staged);

    const s = await startStack({ beforeStart: async (home) => { await install(home, CV_PLUGIN); new PluginStore(home).setSettings('rendercv', { cvDir, rendercv: bin, dailyLimit: 1 }); } });
    stacks.push(s);
    expect(await names(s)).toEqual(expect.arrayContaining(['cv_list', 'cv_get', 'cv_tailor', 'cv_render', 'cv_applications']));
    expect((await s.call('cv_list')).data.masters[0]).toMatchObject({ file: 'AI/master.yaml', name: 'Ada Lovelace' });
    const bad = await s.call('cv_tailor', { master: 'AI/master.yaml', company: 'Globex', role: 'AI Engineer', summary: ['Builds reliable cloud systems with Kubernetes.'] });
    expect(bad.data.error.message).toMatch(/Nothing was written[\s\S]*term "Kubernetes"/);
    expect((await s.call('cv_tailor', { master: 'AI/master.yaml', company: 'Globex', role: 'AI Engineer', headline: 'AI Engineer' })).data.file).toBe('tailored/globex-ai-engineer.yaml');
    const r = (await s.call('cv_render', { file: 'tailored/globex-ai-engineer.yaml' })).data;
    expect(r).toMatchObject({ pages: 1, pdf: path.join(s.home, 'files/cv/Ada_Lovelace_CV_globex-ai-engineer.pdf') });
    expect(fs.readFileSync(r.pdf, 'utf8')).toBe('%PDF-fake');
    expect((await s.call('cv_applications', { action: 'add', company: 'Globex', role: 'AI Engineer', url: 'https://x.test/1', status: 'submitted', cv: r.pdf })).data).toMatchObject({ remainingToday: 0 });
    expect((await s.call('cv_applications', { action: 'check', company: 'Other', role: 'Dev' })).data).toMatchObject({ allowed: false });
    // The uploaded PDF is exactly where browser_fill_form may read it from.
    expect(path.dirname(r.pdf)).toBe(path.join(s.home, 'files', 'cv'));
    expect(s.app.ctx.config.uploadRoots).toContain(path.join(s.home, 'files'));
  });
});

describe('skills', () => {
  const copySkill = (home: string) => fs.cpSync(path.join(ROOT, 'examples/skills/hello'), path.join(home, 'skills/hello-skill'), { recursive: true });

  it('ships a generic job-apply skill whose workflow is valid and whose template holds no personal data', () => {
    const skill = loadSkillDir(path.join(ROOT, 'skills/job-apply'), 'repo');
    expect(skill).toMatchObject({ name: 'job-apply', requiresPlugins: ['rendercv'] });
    expect(skill.requiresTools).toEqual(expect.arrayContaining(['cv_tailor', 'browser_run_goal']));
    const steps = fillWorkflow(skill.workflows['read-job']!, { url: 'https://jobs.example/1' });
    expect(steps.map((s) => s.tool)).toEqual(['browser_navigate', 'browser_get_page_text']);
    expect(steps[0]!.args.url).toBe('https://jobs.example/1');
    const template = fs.readFileSync(path.join(ROOT, 'skills/job-apply/applicant-profile.template.md'), 'utf8');
    expect(template.match(/TODO/g)!.length).toBeGreaterThan(15);
    expect(template).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i); // no real email address
  });

  it('parses SKILL.md and fills workflow inputs safely', () => {
    expect(parseSkillMd('---\nname: x\ndescription: "d: e"\n---\nBody')).toEqual({ meta: { name: 'x', description: 'd: e' }, body: 'Body' });
    expect(parseSkillMd('just text').body).toBe('just text');
    const wf = { name: 'w', inputs: { who: { description: 'who', required: true }, n: { description: 'n', default: '5' } }, steps: [{ tool: 'browser_navigate', args: { url: 'https://x.test/{{who}}', nested: ['{{n}}', { k: '{{who}}' }], keep: '{{unknown}}' }, approval: 'Go to {{who}}?' }] };
    const [step] = fillWorkflow(wf, { who: 'ada' });
    expect(step).toMatchObject({ args: { url: 'https://x.test/ada', nested: ['5', { k: 'ada' }], keep: '{{unknown}}' }, approval: 'Go to ada?' });
    expect(() => fillWorkflow(wf, {})).toThrow(/Missing input 'who'/);
    expect(() => loadSkillDir(makeSkillDir('---\nname: BAD NAME\n---\nx'), 't')).toThrow(/lowercase/);
  });
  function makeSkillDir(md: string): string { const d = tmp(); fs.writeFileSync(path.join(d, 'SKILL.md'), md); return d; }

  it('lists skills with what is missing, serves them as MCP prompts and runs their workflows through the normal engine', async () => {
    const without = await startStack({ beforeStart: copySkill });
    stacks.push(without);
    expect((await without.call('skill_list')).data.skills[0]).toMatchObject({ name: 'hello-skill', source: 'user', missing: ['plugin hello'] });
    expect((await without.call('skill_run_workflow', { skill: 'hello-skill', workflow: 'greet-and-note', inputs: { who: 'Ada' } })).data.error.message).toMatch(/needs: plugin hello/);

    const s = await startStack({ beforeStart: async (home) => { copySkill(home); await install(home, HELLO); } });
    stacks.push(s);
    expect((await s.call('skill_list')).data.skills[0]).toMatchObject({ missing: [], workflows: [{ id: 'greet-and-note', inputs: ['who', 'limit'] }] });
    const got = (await s.call('skill_get', { name: 'hello-skill' })).data;
    expect(got.notice).toMatch(/written by the skill's author, not by the user/);
    expect(got.instructions).toContain('hello_greet');
    expect((await s.client.listPrompts()).prompts.map((p) => p.name)).toContain('hello-skill');
    const prompt = await s.client.getPrompt({ name: 'hello-skill' });
    expect((prompt.messages[0]!.content as { text: string }).text).toMatch(/not by the user[\s\S]*hello_note_add/);

    expect((await s.call('skill_run_workflow', { skill: 'hello-skill', workflow: 'greet-and-note', inputs: {} })).data.error.message).toMatch(/Missing input 'who'/);
    const run = await s.call('skill_run_workflow', { skill: 'hello-skill', workflow: 'greet-and-note', inputs: { who: 'Ada' } });
    expect(run.isError, JSON.stringify(run.data)).toBe(false);
    expect(s.app.ctx.workflows.get(run.data.workflowId).steps[0]).toMatchObject({ tool: 'network_list_requests', label: 'Look at traffic for Ada' }); // the {{who}} was filled in
    expect((await s.call('skill_get', { name: 'nope' })).data.error.code).toBe('NOT_FOUND');
  });
});
