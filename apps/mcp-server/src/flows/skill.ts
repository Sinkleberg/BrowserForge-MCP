import fs from 'node:fs';
import path from 'node:path';
import type { Flow } from '@browserforge/flows';
import { BrowserForgeError } from '@browserforge/shared';

export const SKILL_NAME = /^[a-z][a-z0-9-]{1,40}$/;

/** The flow without any recorded value: parameters keep their name, label and sensitivity but lose their default. */
export function valueFree(flow: Flow): Flow {
  return { ...flow, params: flow.params.map((p) => ({ name: p.name, sensitive: p.sensitive, ...(p.label !== undefined ? { label: p.label } : {}) })) };
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
