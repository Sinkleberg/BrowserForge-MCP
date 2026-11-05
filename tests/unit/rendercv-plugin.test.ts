import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createTestApi } from '@browserforge/plugin-sdk/testing';
import type { PluginApi } from '@browserforge/plugin-sdk';
// @ts-expect-error plain JS plugin
import plugin from '../../plugins/rendercv/index.js';
// @ts-expect-error plain JS plugin
import { applyTailoring, describe as describeCv, index, newFacts, slug } from '../../plugins/rendercv/lib/cvdoc.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins/rendercv/package.json'), 'utf8')).browserforge;

const MASTER = `cv:
  name: Ada Lovelace
  headline: Software Engineer | Cloud and Automation
  email: ada@example.com
  photo: me.jpg
  sections:
    Summary:
      - Engineer with experience building automation and cloud systems. Delivered an AI agent used in production.
    Experience:
      - company: Analytical Ltd
        position: Full Stack Engineer
        location: London
        start_date: 2024-01
        end_date: 2026-03
        highlights:
          - Built an AI agent that automates ERP workflows, cutting manual work by 40%.
          - Developed REST APIs with ASP.NET and Microsoft Graph API integrations.
          - Ran production infrastructure on Azure with CI/CD in GitHub Actions.
      - company: Engine Co
        position: CTO
        start_date: 2022-01
        end_date: 2023-12
        highlights:
          - Led a team of 8 building an e-commerce platform serving 10k monthly users.
    Projects:
      - name: Edge Detector
        summary: Object detection on a Jetson Orin using CUDA and OpenCV.
        highlights:
          - Optimised inference for real-time edge deployment.
    Skills:
      - label: Programming
        details: Python, C++, Node.js, Bash
      - label: Cloud
        details: Azure, Docker, Terraform
design:
  theme: classic
`;

const FAKE_RENDERCV = `#!/bin/sh
in="$2"; pdf=""; png=""; typ=""
while [ $# -gt 0 ]; do
  case "$1" in --pdf-path) pdf="$2"; shift;; --png-path) png="$2"; shift;; --typst-path) typ="$2"; shift;; esac
  shift
done
if grep -q FAILME "$in"; then echo "1 validation error: cv.email is not valid" >&2; exit 1; fi
mkdir -p "$(dirname "$pdf")"
printf '%%PDF-fake' > "$pdf"; echo typst > "$typ"
lines=$(wc -l < "$in"); pages=$(( (lines + 39) / 40 ))
base="\${png%.png}"; i=1
while [ $i -le $pages ]; do echo png > "\${base}_$i.png"; i=$((i+1)); done
`;

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function setup(settings: Record<string, string | number> = {}) {
  const cvDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bf-cv-')));
  fs.mkdirSync(path.join(cvDir, 'AI'));
  fs.writeFileSync(path.join(cvDir, 'AI/master.yaml'), MASTER);
  fs.writeFileSync(path.join(cvDir, 'AI/notes.yaml'), 'just: notes\n'); // not a CV
  const bin = path.join(cvDir, 'fake-rendercv');
  fs.writeFileSync(bin, FAKE_RENDERCV, { mode: 0o755 });
  const t = createTestApi(manifest, { settings: { cvDir, rendercv: bin, ...settings } });
  cleanups.push(t.cleanup, () => fs.rmSync(cvDir, { recursive: true, force: true }));
  const run = (name: string, args: object = {}) => {
    const def = plugin.tools.find((x: { name: string }) => x.name === name);
    return def.run(def.input.parse(args), t.api as PluginApi);
  };
  return { cvDir, api: t.api, dirs: t.dirs, run, bin };
}
const tailor = (extra: object = {}) => ({ master: 'AI/master.yaml', company: 'Globex', role: 'AI Engineer', ...extra });

describe('cvdoc: ids and the facts check', () => {
  const doc = parse(MASTER);
  it('gives every editable piece a stable id', () => {
    const d = describeCv(doc);
    expect(d.sections.map((s: any) => s.name)).toEqual(['Summary', 'Experience', 'Projects', 'Skills']);
    expect(d.sections[1].items[0]).toMatchObject({ id: 'experience-0', company: 'Analytical Ltd', highlights: [{ id: 'experience-0-h0', text: expect.stringContaining('ERP') }, { id: 'experience-0-h1' }, { id: 'experience-0-h2' }] });
    expect(d.sections[2].items[0].summary.id).toBe('projects-0-summary');
    expect(d.sections[3].items[0].details.id).toBe('skills-0-details');
    expect(slug('Education & Certifications')).toBe('education-certifications');
    expect([...index(doc).keys()]).toContain('summary-0');
  });
  it('flags numbers, links, tool names and acronyms that are not in the master, and nothing else', () => {
    const t = (text: string, allowed: string[] = []) => newFacts(doc, [{ where: 'x', text }], allowed).map((f: any) => `${f.kind}:${f.text}`);
    expect(t('Over 5 years of experience')).toEqual(['number:5']);
    expect(t('Cut manual work by 40%')).toEqual([]); // 40 is in the master
    expect(t('Deployed with Kubernetes and GraphQL')).toEqual(expect.arrayContaining(['term:Kubernetes']));
    expect(t('Built with FastAPI')).toEqual(['term:FastAPI']);
    expect(t('Uses C++ and Terraform')).toEqual([]); // both in the master
    expect(t('See https://evil.example/cv')).toEqual(['link:https://evil.example/cv']);
    expect(t('Mail me at someone@else.com')).toEqual(['link:someone@else.com']);
    expect(t('Delivered a system. Built tools. Designed pipelines. Led teams.')).toEqual([]); // sentence-starting verbs are not claims
    expect(t('AI engineer focused on cloud and automation systems')).toEqual([]); // lower-case words already in the master
    expect(t('Joined Globex as AI Engineer', ['Globex', 'AI Engineer'])).toEqual([]); // the target company and role are allowed
    expect(t('Joined Globex')).toEqual(['term:Globex']);
  });
});

describe('cv_list / cv_get', () => {
  it('finds master CVs only, hides the tailored copies and the tools\' own folders', async () => {
    const s = setup();
    fs.mkdirSync(path.join(s.cvDir, 'rendercv_output'));
    fs.writeFileSync(path.join(s.cvDir, 'rendercv_output/x.yaml'), MASTER);
    const r = await s.run('cv_list');
    expect(r.masters).toEqual([{ file: 'AI/master.yaml', name: 'Ada Lovelace', headline: 'Software Engineer | Cloud and Automation' }]);
    expect(r.tailored).toEqual([]);
    expect((await s.run('cv_get', { file: 'AI/master.yaml' })).sections[1].items[1].id).toBe('experience-1');
    await expect(s.run('cv_get', { file: 'AI/notes.yaml' })).rejects.toThrow(/not a RenderCV file/);
    await expect(s.run('cv_get', { file: 'AI/master.txt' })).rejects.toThrow(/\.yaml file/);
    await expect(s.run('cv_get', { file: '../../etc/passwd.yaml' })).rejects.toThrow(/outside the allowed/);
  });
});

describe('cv_tailor', () => {
  it('writes a tailored copy with the requested changes and never touches the master', async () => {
    const s = setup();
    const before = fs.readFileSync(path.join(s.cvDir, 'AI/master.yaml'));
    const r = await s.run('cv_tailor', tailor({
      headline: 'AI Engineer | Cloud and Automation',
      summary: ['Engineer with experience building automation and cloud systems, including an AI agent used in production.'],
      reword: [{ id: 'experience-0-h0', text: 'Built an AI agent that automates ERP workflows, cutting manual work by 40%, used in production.' }],
      order: [{ ids: ['experience-0-h2', 'experience-0-h0'] }, { ids: ['experience-1', 'experience-0'] }],
      drop: ['projects-0', 'skills-1'],
    }));
    expect(r).toMatchObject({ file: 'tailored/globex-ai-engineer.yaml', overwrote: false, next: expect.stringContaining('cv_render') });
    expect(r.changes.map((c: any) => c.id)).toEqual(expect.arrayContaining(['headline', 'summary', 'experience-0-h0', 'projects-0', 'skills-1']));
    expect(fs.readFileSync(path.join(s.cvDir, 'AI/master.yaml'))).toEqual(before);
    const out = parse(fs.readFileSync(path.join(s.cvDir, 'tailored/globex-ai-engineer.yaml'), 'utf8'));
    expect(out.cv.headline).toBe('AI Engineer | Cloud and Automation');
    expect(out.cv.sections.Experience.map((e: any) => e.company)).toEqual(['Engine Co', 'Analytical Ltd']);
    expect(out.cv.sections.Experience[1].highlights[0]).toMatch(/Ran production infrastructure on Azure/); // moved first
    expect(out.cv.sections.Experience[1].highlights[1]).toMatch(/used in production/); // reworded one, moved second
    expect(out.cv.sections.Experience[1].highlights.length).toBe(3);
    expect(out.cv.sections.Projects).toEqual([]);
    expect(out.cv.sections.Skills.map((x: any) => x.label)).toEqual(['Programming']);
    expect(out.cv.photo).toBe(path.join(fs.realpathSync(s.cvDir), 'AI', 'me.jpg')); // a relative photo path keeps working from tailored/
    expect(out.design).toEqual({ theme: 'classic' });
    expect((await s.run('cv_list')).tailored).toEqual(['tailored/globex-ai-engineer.yaml']);
    expect((await s.run('cv_tailor', tailor())).overwrote).toBe(true);
  });

  it('rejects invented facts and writes nothing', async () => {
    const s = setup();
    const attempts: [object, RegExp][] = [
      [{ summary: ['Engineer with over 7 years of experience.'] }, /number "7"/],
      [{ reword: [{ id: 'experience-0-h1', text: 'Developed REST APIs with ASP.NET and Kubernetes.' }] }, /term "Kubernetes"/],
      [{ headline: 'AI Engineer at Google' }, /term "Google"/],
      [{ summary: ['Portfolio: https://example.org/me'] }, /link "https:\/\/example.org\/me"/],
      [{ reword: [{ id: 'experience-1-h0', text: 'Led a team of 80 building an e-commerce platform.' }] }, /number "80"/],
    ];
    for (const [extra, msg] of attempts) {
      const err = await s.run('cv_tailor', tailor(extra)).catch((e: Error) => e);
      expect(err, JSON.stringify(extra)).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/Nothing was written/);
      expect((err as Error).message).toMatch(msg);
    }
    expect(fs.existsSync(path.join(s.cvDir, 'tailored'))).toBe(false);
  });

  it('only changes things that exist: unknown ids, wrong kinds and cross-list reorders are errors', async () => {
    const s = setup();
    for (const [extra, msg] of [
      [{ reword: [{ id: 'experience-9-h0', text: 'x' }] }, /Unknown id 'experience-9-h0'/],
      [{ reword: [{ id: 'experience-0', text: 'x' }] }, /is a entry/],
      [{ drop: ['nope'] }, /Unknown id/],
      [{ order: [{ ids: ['experience-0-h0', 'experience-1-h0'] }] }, /Cannot reorder across lists/],
    ] as [object, RegExp][]) await expect(s.run('cv_tailor', tailor(extra))).rejects.toThrow(msg);
    await expect(s.run('cv_tailor', tailor({ master: '../../etc/passwd.yaml' }))).rejects.toThrow(/outside the allowed/);
  });
});

describe('cv_render', () => {
  // A plugin runs its program directly, never through a shell, so a shell-script stand-in cannot run on Windows (it needs a real rendercv.exe).
  it.skipIf(process.platform === 'win32')('renders through rendercv, checks the page count and copies the PDF into the upload folder', async () => {
    const s = setup();
    await s.run('cv_tailor', tailor());
    const r = await s.run('cv_render', { file: 'tailored/globex-ai-engineer.yaml' });
    expect(r.pages).toBe(1);
    expect(r.pdf).toBe(path.join(s.dirs.uploads, 'cv', 'Ada_Lovelace_CV_globex-ai-engineer.pdf'));
    expect(fs.readFileSync(r.pdf, 'utf8')).toBe('%PDF-fake');
    expect((await s.run('cv_list')).uploadReadyPdfs).toEqual([{ file: 'Ada_Lovelace_CV_globex-ai-engineer.pdf', bytes: 9 }]);
  });

  it.skipIf(process.platform === 'win32')('refuses CVs over the page limit, shows rendercv\'s own error, and renders only tailored copies', async () => {
    const long = setup({ maxPages: 1 });
    const bigMaster = MASTER.replace('highlights:\n          - Built', `highlights:\n${Array.from({ length: 40 }, (_, i) => `          - Extra line ${i} analytical work`).join('\n')}\n          - Built`);
    fs.writeFileSync(path.join(long.cvDir, 'AI/master.yaml'), bigMaster);
    await long.run('cv_tailor', tailor());
    await expect(long.run('cv_render', { file: 'tailored/globex-ai-engineer.yaml' })).rejects.toThrow(/2 pages; your limit is 1[\s\S]*"drop"/);
    expect(fs.existsSync(path.join(long.dirs.uploads, 'cv'))).toBe(false); // nothing copied for upload

    const bad = setup();
    await bad.run('cv_tailor', tailor({ headline: 'FAILME headline' }).master ? tailor() : tailor());
    fs.appendFileSync(path.join(bad.cvDir, 'tailored/globex-ai-engineer.yaml'), '# FAILME\n');
    await expect(bad.run('cv_render', { file: 'tailored/globex-ai-engineer.yaml' })).rejects.toThrow(/rendercv failed \(exit 1\).*cv\.email is not valid/);
    await expect(bad.run('cv_render', { file: 'AI/master.yaml' })).rejects.toThrow(/Render a tailored copy/);
  });

  it('asks you to configure rendercv when the setting is missing, and will not run any other program', async () => {
    const s = setup({ rendercv: '' });
    await s.run('cv_tailor', tailor());
    await expect(s.run('cv_render', { file: 'tailored/globex-ai-engineer.yaml' })).rejects.toThrow(/plugin config rendercv/);
    await expect(s.api.exec('/bin/ls', [])).rejects.toThrow(/not granted permission to run/);
  });
});

describe('cv_applications', () => {
  const add = (s: ReturnType<typeof setup>, extra: object = {}) => s.run('cv_applications', { action: 'add', company: 'Acme', role: 'Engineer', url: 'https://jobs.acme.test/1?utm=a', status: 'submitted', ...extra });
  it('refuses duplicates by link (ignoring tracking parameters) and by company and role', async () => {
    const s = setup();
    expect(await s.run('cv_applications', { action: 'check', company: 'Acme', role: 'Engineer' })).toMatchObject({ allowed: true, duplicate: null, remainingToday: 10 });
    expect(await add(s)).toMatchObject({ submittedToday: 1, remainingToday: 9 });
    expect((await s.run('cv_applications', { action: 'check', url: 'https://JOBS.acme.test/1/?utm=zzz#top' })).duplicate).toMatchObject({ company: 'Acme' });
    expect((await s.run('cv_applications', { action: 'check', company: 'ACME Inc.', role: 'engineer' })).allowed).toBe(true); // a different company string is not guessed to be the same
    expect((await s.run('cv_applications', { action: 'check', company: 'acme', role: 'ENGINEER' })).allowed).toBe(false);
    await expect(add(s, { url: 'https://jobs.acme.test/other', company: 'Acme', role: 'Engineer' })).rejects.toThrow(/Already applied/);
  });
  it('enforces the daily limit on submitted applications only, and lets skipped or failed ones be retried', async () => {
    const s = setup({ dailyLimit: 2 });
    await add(s, { company: 'A', role: 'r', url: 'https://a.test/1' });
    await add(s, { company: 'B', role: 'r', url: 'https://b.test/1' });
    expect(await s.run('cv_applications', { action: 'check', company: 'C', role: 'r' })).toMatchObject({ allowed: false, remainingToday: 0 });
    await expect(add(s, { company: 'C', role: 'r', url: 'https://c.test/1' })).rejects.toThrow(/Daily limit reached/);
    await add(s, { company: 'C', role: 'r', url: 'https://c.test/1', status: 'skipped', notes: 'needs an account' }); // logging a skip is always allowed
    const skipped = (await s.run('cv_applications', { action: 'list' })).data.find((x: any) => x.status === 'skipped');
    expect(skipped).toMatchObject({ company: 'C', notes: 'needs an account' });
    expect((await s.run('cv_applications', { action: 'check', company: 'C', role: 'r' })).duplicate).toBeNull(); // a skipped job may be tried again
    await s.run('cv_applications', { action: 'update', id: skipped.id, status: 'failed' });
    await expect(s.run('cv_applications', { action: 'update', id: 'nope', status: 'failed' })).rejects.toThrow(/No application/);
    await expect(s.run('cv_applications', { action: 'add', company: 'X' })).rejects.toThrow(/company, role and status/);
  });
  it('keeps its log in its own private data folder', async () => {
    const s = setup();
    await add(s);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(s.dirs.data, 'applications.json')).mode & 0o077).toBe(0);
  });
});

describe('applyTailoring on its own', () => {
  it('works on a deep copy and supports any mix of reword, reorder and drop', () => {
    const doc = parse(MASTER);
    const snapshot = JSON.stringify(doc);
    const r = applyTailoring(doc, { reword: [{ id: 'experience-0-h1', text: 'Developed REST APIs.' }], order: [{ ids: ['experience-0-h1'] }], drop: ['experience-0-h0'] });
    expect(JSON.stringify(doc)).toBe(snapshot);
    expect(r.doc.cv.sections.Experience[0].highlights).toEqual(['Developed REST APIs.', 'Ran production infrastructure on Azure with CI/CD in GitHub Actions.']);
  });
});
