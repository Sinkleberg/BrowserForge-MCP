import fs from 'node:fs';
import path from 'node:path';
import type { PluginStore } from './store.js';
import type { Skill, SkillWorkflow } from './types.js';

/** SKILL.md: optional `---` front matter of flat `key: value` lines, then the instructions. */
export function parseSkillMd(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2]!.trim() };
}

const list = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

export function loadSkillDir(dir: string, source: string): Skill {
  const md = parseSkillMd(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
  const name = md.meta.name ?? path.basename(dir);
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) throw new Error(`Skill name '${name}' must be lowercase letters, digits and dashes`);
  const workflows: Record<string, SkillWorkflow> = {};
  const wdir = path.join(dir, 'workflows');
  if (fs.existsSync(wdir)) {
    for (const f of fs.readdirSync(wdir).filter((x) => x.endsWith('.json')).slice(0, 20)) {
      const wf = JSON.parse(fs.readFileSync(path.join(wdir, f), 'utf8')) as Partial<SkillWorkflow>;
      if (!Array.isArray(wf.steps) || !wf.steps.every((s) => s && typeof s.tool === 'string')) throw new Error(`workflows/${f}: needs a "steps" list of { tool, args }`);
      const key = f.replace(/\.json$/, '');
      workflows[key] = { name: wf.name ?? key, description: wf.description, inputs: wf.inputs ?? {}, steps: wf.steps.map((s) => ({ tool: s.tool, args: s.args ?? {}, label: s.label, approval: s.approval })) };
    }
  }
  return { name, description: md.meta.description ?? '', body: md.body, source, dir, requiresTools: list(md.meta['requires-tools']), requiresPlugins: list(md.meta['requires-plugins']), workflows };
}

/** Skills the user keeps in <config>/skills/<name>/ plus those delivered by installed packages of kind "skill". */
export function discoverSkills(configDir: string, store: PluginStore, onError: (where: string, e: unknown) => void): Skill[] {
  const out: Skill[] = [];
  const add = (dir: string, source: string) => {
    try {
      if (fs.existsSync(path.join(dir, 'SKILL.md'))) out.push(loadSkillDir(dir, source));
    } catch (e) {
      onError(dir, e);
    }
  };
  const userDir = path.join(configDir, 'skills');
  if (fs.existsSync(userDir)) for (const d of fs.readdirSync(userDir)) add(path.join(userDir, d), 'user');
  for (const rec of store.list()) {
    if (rec.kind !== 'skill' || !rec.enabled) continue;
    const root = store.pkgRoot(rec);
    add(root, `skill:${rec.id}`);
    const nested = path.join(root, 'skills');
    if (fs.existsSync(nested)) for (const d of fs.readdirSync(nested)) add(path.join(nested, d), `skill:${rec.id}`);
  }
  const seen = new Set<string>();
  return out.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));
}

/** Replace {{input}} in every string of the steps. A value that is the whole string stays a string; missing required inputs are an error. */
export function fillWorkflow(wf: SkillWorkflow, inputs: Record<string, string>): SkillWorkflow['steps'] {
  const values: Record<string, string> = {};
  for (const [k, spec] of Object.entries(wf.inputs)) {
    const v = inputs[k] ?? spec.default;
    if (v === undefined && spec.required !== false) throw new Error(`Missing input '${k}': ${spec.description}`);
    if (v !== undefined) values[k] = v;
  }
  const sub = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/\{\{\s*(\w[\w-]*)\s*\}\}/g, (_m, k: string) => (k in values ? values[k]! : `{{${k}}}`));
    if (Array.isArray(v)) return v.map(sub);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
    return v;
  };
  return wf.steps.map((s) => ({ ...s, args: sub(s.args) as Record<string, unknown>, ...(s.label ? { label: sub(s.label) as string } : {}), ...(s.approval ? { approval: sub(s.approval) as string } : {}) }));
}
