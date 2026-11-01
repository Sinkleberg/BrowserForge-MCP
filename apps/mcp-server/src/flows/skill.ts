import fs from 'node:fs';
import path from 'node:path';
import { describeLocator, type Flow, type FlowStep, type Locator } from '@browserforge/flows';
import { BrowserForgeError } from '@browserforge/shared';

export const SKILL_NAME = /^[a-z][a-z0-9-]{1,40}$/;

const FINDERS = ['testId', 'name', 'label', 'placeholder', 'id', 'nameAttr', 'text', 'css', 'xpath'] as const satisfies readonly (keyof Locator)[];

/**
 * The flow without any recorded value, safe to share. Parameters lose their default. A value can also have been read back off the element
 * after it was set (the option picked in a custom dropdown becomes the combobox's name or text, typed text becomes a contenteditable's
 * text), so every locator field, label and step address that contains one is dropped and the labels are rebuilt from what is left.
 * Refuses (INVALID_ARGUMENTS) when that would leave a step with no way to find its element, or when a page address it opens carries a value.
 */
export function valueFree(flow: Flow): Flow {
  const values = flow.params.map((p) => p.default?.trim().toLowerCase()).filter((v): v is string => !!v);
  // Equal to a value, or containing one of 4+ characters (short values such as "7" or "en" would match far too much).
  const holds = (s: string | undefined): boolean => {
    if (s === undefined) return false;
    const t = s.trim().toLowerCase();
    return values.some((v) => t === v || (v.length >= 4 && t.includes(v)));
  };
  const holdsUrl = (u: string | undefined): boolean => {
    if (u === undefined) return false;
    let decoded = u;
    try {
      decoded = decodeURIComponent(u.replace(/\+/g, ' '));
      if ([...new URL(u).searchParams.values()].some((q) => holds(q))) return true;
    } catch {
      /* not a URL or bad escapes: check the text as it is */
    }
    return holds(decoded);
  };
  const steps = flow.steps.map((s, i): FlowStep => {
    const out: FlowStep = { ...s };
    if (holdsUrl(s.url)) {
      if (s.action === 'navigate') throw new BrowserForgeError('INVALID_ARGUMENTS', `Step ${i + 1} opens an address that contains a recorded value, so the flow cannot be shared without it`);
      delete out.url; // informational on non-navigate steps
    }
    if (s.locator) {
      const loc: Locator = { ...s.locator };
      let dropped = false;
      for (const k of FINDERS) if (holds(loc[k])) { delete loc[k]; dropped = true; }
      if (dropped && !FINDERS.some((k) => loc[k] !== undefined)) {
        throw new BrowserForgeError('INVALID_ARGUMENTS', `Step ${i + 1} can only be found by text that contains a recorded value, so the flow cannot be shared without it`);
      }
      out.locator = loc;
    }
    if (holds(s.label)) out.label = s.action === 'navigate' ? 'open page' : `${s.action} "${describeLocator(out.locator)}"`;
    return out;
  });
  const params = flow.params.map((p) => ({ name: p.name, sensitive: p.sensitive, ...(p.label !== undefined ? { label: holds(p.label) ? p.name : p.label } : {}) }));
  return { ...flow, params, steps };
}

/**
 * Write a skill folder (SKILL.md, one workflow, and the flow itself as flow.json) that replays a flow. SKILL.md and the workflow hold only
 * identifiers: parameter names are already reduced to a-z, 0-9 and _, so page text never becomes instructions. flow.json is a value-free
 * copy of the flow (addresses and locators, no recorded values), so the skill also works on a computer that never recorded it.
 */
export function writeFlowSkill(configDir: string, flow: Flow, name: string, description: string): { dir: string; inputs: string[] } {
  if (!SKILL_NAME.test(name)) throw new BrowserForgeError('INVALID_ARGUMENTS', 'Skill names use lowercase letters, digits and dashes (2-41 characters)');
  const dir = path.join(configDir, 'skills', name);
  if (fs.existsSync(dir)) throw new BrowserForgeError('INVALID_ARGUMENTS', `A skill named '${name}' already exists`);
  const desc = description.replace(/\s+/g, ' ').trim();
  const inputs = Object.fromEntries(flow.params.map((p) => [p.name, { description: p.sensitive ? 'Sensitive: you must provide it (never stored)' : 'Value for this field', required: true }]));
  const wf = {
    name: `Run ${name}`,
    description: desc,
    inputs,
    steps: [{ tool: 'flow_run', args: { id: flow.id, params: Object.fromEntries(flow.params.map((p) => [p.name, `{{${p.name}}}`])) }, label: `Replay the recorded flow on ${flow.site}` }],
  };
  const body = [
    `# ${name}`,
    '',
    desc,
    '',
    `Replays a flow recorded on ${flow.site} (${flow.steps.length} steps) with no model deciding. Run it with \`skill_run_workflow\` (skill "${name}", workflow "run") and give a value for each input: ${flow.params.map((p) => p.name).join(', ') || 'none'}.`,
    'Steps that need approval (submit, upload, password) still wait for the human. If a step cannot find its element the run stops and says which; then continue by hand or with browser_run_goal.',
  ].join('\n');
  fs.mkdirSync(path.join(dir, 'workflows'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\nrequires-tools: flow_run\n---\n${body}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'workflows', 'run.json'), JSON.stringify(wf, null, 1), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'flow.json'), JSON.stringify(valueFree(flow), null, 1), { mode: 0o600 });
  return { dir, inputs: Object.keys(inputs) };
}
