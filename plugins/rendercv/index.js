// BrowserForge plugin: tailor RenderCV resumes per job, render them, and keep an application log.
// Reads and writes only what its manifest declares (see package.json): your CV folder (writes only to its tailored/ subfolder),
// the BrowserForge upload folder (uploads/cv) and its own data folder; runs only the rendercv program you configured.
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { definePlugin, tool, z, PluginError } from '@browserforge/plugin-sdk';
import { absolutizePhoto, applyTailoring, describe, newFacts, slug } from './lib/cvdoc.js';

const CV = 'setting:cvDir';
const TAILORED = 'setting:cvDir/tailored';
const UPLOADS = 'uploads/cv';
const SKIP_DIRS = new Set(['tailored', 'rendered', 'rendercv_output', 'node_modules', '.venv', '.git']);

function load(api, file) {
  if (!/\.ya?ml$/i.test(file)) throw new PluginError('INVALID_ARGUMENTS', 'Pass a .yaml file path relative to your CV folder (see cv_list)');
  let doc;
  try {
    doc = parse(api.files.read(CV, file));
  } catch (e) {
    if (e instanceof PluginError || e?.code) throw e;
    throw new PluginError('INVALID_ARGUMENTS', `${file} is not valid YAML: ${String(e.message).split('\n')[0]}`);
  }
  if (!doc?.cv || typeof doc.cv !== 'object') throw new PluginError('INVALID_ARGUMENTS', `${file} is not a RenderCV file (no "cv:" section)`);
  return doc;
}

/** Master CVs: .yaml files up to two folders deep that have a cv: section. */
function listMasters(api, rel = '', depth = 0, out = []) {
  for (const e of api.files.list(CV, rel)) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.dir) {
      if (depth < 2 && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) listMasters(api, child, depth + 1, out);
    } else if (/\.ya?ml$/i.test(e.name) && e.size < 2_000_000 && out.length < 200) {
      try {
        const doc = parse(api.files.read(CV, child));
        if (doc?.cv && typeof doc.cv === 'object') out.push({ file: child, name: doc.cv.name, headline: doc.cv.headline });
      } catch {
        /* not a CV */
      }
    }
  }
  return out;
}

// ---------- applications log ----------
const today = () => new Date().toLocaleDateString('en-CA');
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
function normUrl(u) {
  try {
    const x = new URL(u);
    return `${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, '')}`;
  } catch {
    return String(u ?? '').toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
}
const readLog = (api) => (api.files.exists('data', 'applications.json') ? JSON.parse(api.files.read('data', 'applications.json')).apps ?? [] : []);
const writeLog = (api, apps) => api.files.write('data', 'applications.json', JSON.stringify({ apps }, null, 1));
const findDuplicate = (apps, { company, role, url }) =>
  apps.find((a) => a.status !== 'failed' && a.status !== 'skipped' && ((url && normUrl(a.url) === normUrl(url)) || (company && role && norm(a.company) === norm(company) && norm(a.role) === norm(role))));

export default definePlugin({
  tools: [
    tool({
      name: 'cv_list',
      description: 'List your master RenderCV files, the tailored per-job copies, and the PDFs ready to upload.',
      input: z.object({}),
      readOnly: true,
      run: async (_a, api) => {
        const tailored = api.files.exists(CV, 'tailored') ? api.files.list(CV, 'tailored').filter((e) => /\.ya?ml$/i.test(e.name)).map((e) => `tailored/${e.name}`) : [];
        const pdfs = api.files.exists(UPLOADS, '') ? api.files.list(UPLOADS).filter((e) => /\.pdf$/i.test(e.name)).map((e) => ({ file: e.name, bytes: e.size })) : [];
        return { masters: listMasters(api), tailored, uploadReadyPdfs: pdfs };
      },
    }),

    tool({
      name: 'cv_get',
      description: 'Read a CV as structured sections. Every editable piece has a stable id (e.g. "experience-0-h2" = third highlight of the first experience) to use with cv_tailor.',
      input: z.object({ file: z.string().min(3).max(200).describe('Path relative to your CV folder, from cv_list') }),
      readOnly: true,
      run: async ({ file }, api) => ({ file, ...describe(load(api, file)) }),
    }),

    tool({
      name: 'cv_tailor',
      description:
        'Make a tailored COPY of a master CV for one job: new headline and summary, reworded text, reordered or dropped items. It cannot add anything: ids must exist, and any number, date, link, tool name or acronym in new text that is not already in the master CV is rejected with the offending words listed. ' +
        'Company and role words are allowed (they are the target, not a claim). The master file is never changed; the copy goes to tailored/<company>-<role>.yaml.',
      input: z.object({
        master: z.string().min(3).max(200).describe('Master CV path from cv_list'),
        company: z.string().min(1).max(80),
        role: z.string().min(1).max(100),
        headline: z.string().max(160).optional(),
        summary: z.array(z.string().min(1).max(1200)).max(6).optional().describe('Replacement lines for the Summary/Profile section'),
        reword: z.array(z.object({ id: z.string().max(80), text: z.string().min(1).max(1200) })).max(60).optional(),
        order: z.array(z.object({ ids: z.array(z.string().max(80)).min(1).max(40) })).max(20).optional().describe('Put these items first, in this order (all ids from the same list)'),
        drop: z.array(z.string().max(80)).max(60).optional().describe('Ids of items or highlights to leave out, e.g. to fit the page limit'),
      }),
      readOnly: false,
      run: async (a, api) => {
        const master = load(api, a.master);
        let result;
        try {
          result = applyTailoring(master, a);
        } catch (e) {
          throw new PluginError('INVALID_ARGUMENTS', e.message);
        }
        const facts = newFacts(master, result.texts, [a.company, a.role]);
        if (facts.length) {
          throw new PluginError(
            'INVALID_ARGUMENTS',
            `Nothing was written: ${facts.length} thing(s) in the new text are not in your master CV: ${facts.map((f) => `${f.kind} "${f.text}" (${f.where})`).join('; ')}. Rephrase using only what the master says, or add the fact to the master CV yourself first.`,
            { details: { newFacts: facts } },
          );
        }
        absolutizePhoto(result.doc, path.dirname(api.files.path(CV, a.master)), path.resolve);
        const name = `tailored/${slug(a.company)}-${slug(a.role)}.yaml`;
        const overwrote = api.files.exists(CV, name);
        api.files.write(TAILORED, `${slug(a.company)}-${slug(a.role)}.yaml`, stringify(result.doc, { lineWidth: 0 }));
        return { file: name, master: a.master, overwrote, changes: result.changes, next: 'cv_render to make the PDF' };
      },
    }),

    tool({
      name: 'cv_render',
      description: 'Render a tailored CV to PDF with rendercv and put it in the BrowserForge upload folder, ready for browser_fill_form. Fails if it runs over your page limit (then drop or shorten items with cv_tailor).',
      input: z.object({ file: z.string().min(10).max(200).describe('A tailored file, e.g. "tailored/acme-ai-engineer.yaml"') }),
      readOnly: false,
      run: async ({ file }, api) => {
        if (!file.startsWith('tailored/')) throw new PluginError('INVALID_ARGUMENTS', 'Render a tailored copy: run cv_tailor first (it can change nothing and still makes the copy).');
        const doc = load(api, file);
        const input = api.files.path(CV, file);
        const stem = path.basename(file).replace(/\.ya?ml$/i, '');
        api.files.remove(TAILORED, 'rendered'); // old renders of other jobs; their PDFs were already copied to the upload folder
        const rendercv = api.settings.rendercv;
        if (typeof rendercv !== 'string' || !rendercv) throw new PluginError('INVALID_ARGUMENTS', 'Set the rendercv program first: browserforge plugin config rendercv rendercv=/path/to/rendercv');
        const r = await api.exec(rendercv, ['render', input, '--pdf-path', `rendered/${stem}.pdf`, '--png-path', `rendered/${stem}.png`, '--typst-path', `rendered/${stem}.typ`, '--dont-generate-markdown', '--quiet'], { cwd: { root: TAILORED }, timeoutMs: 180_000 });
        if (r.code !== 0) throw new PluginError('INVALID_ARGUMENTS', `rendercv failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().split('\n').slice(-8).join(' | ').slice(0, 800)}`);
        const rendered = api.files.exists(CV, `tailored/rendered/${stem}.pdf`);
        if (!rendered) throw new PluginError('INTERNAL', 'rendercv finished but produced no PDF');
        const pngs = api.files.list(CV, 'tailored/rendered').filter((e) => new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_\\d+\\.png$`).test(e.name)).length;
        const pages = pngs || null;
        const max = Number(api.settings.maxPages ?? 2);
        if (pages !== null && pages > max) throw new PluginError('LIMIT_EXCEEDED', `The CV is ${pages} pages; your limit is ${max}. Use cv_tailor with "drop" to remove the least relevant items, then render again.`, { details: { pages, max } });
        // The file name is what the recruiter sees: keep the person's name as written ("Ada_Lovelace_CV_...").
        const who = String(doc.cv.name ?? 'CV').normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'CV';
        const outName = `${who}_CV_${stem}.pdf`;
        const pdf = api.files.copy(CV, `tailored/rendered/${stem}.pdf`, UPLOADS, outName);
        return { pdf, uploadWith: 'browser_fill_form files: [{ key, filePath }]', pages, warning: pages === null ? 'Could not count pages (no PNG output)' : undefined };
      },
    }),

    tool({
      name: 'cv_applications',
      description:
        'Your application log. Call with action "check" BEFORE applying (refuses duplicates by link or company+role, and tells you how many applications are left today), and "add" after each one (status submitted / skipped / failed). Also "list" and "update".',
      input: z.object({
        action: z.enum(['check', 'add', 'list', 'update']),
        company: z.string().max(100).optional(),
        role: z.string().max(120).optional(),
        url: z.string().max(500).optional(),
        cv: z.string().max(200).optional().describe('The PDF that was sent'),
        status: z.enum(['draft', 'submitted', 'skipped', 'failed']).optional(),
        notes: z.string().max(500).optional(),
        id: z.string().max(40).optional().describe('For update'),
        limit: z.number().int().min(1).max(200).optional().describe('For list (default 30)'),
      }),
      readOnly: false,
      run: async (a, api) => {
        const apps = readLog(api);
        const limit = Number(api.settings.dailyLimit ?? 10);
        const submittedToday = apps.filter((x) => x.status === 'submitted' && x.date === today()).length;
        if (a.action === 'list') return api.untrusted('applications', apps.slice(-(a.limit ?? 30)).reverse());
        if (a.action === 'check') {
          const dup = findDuplicate(apps, a);
          return { allowed: !dup && submittedToday < limit, duplicate: dup ? { id: dup.id, date: dup.date, company: dup.company, role: dup.role, status: dup.status } : null, submittedToday, remainingToday: Math.max(0, limit - submittedToday) };
        }
        if (a.action === 'update') {
          const rec = apps.find((x) => x.id === a.id);
          if (!rec) throw new PluginError('NOT_FOUND', `No application '${a.id}'`);
          if (a.status) rec.status = a.status;
          if (a.notes !== undefined) rec.notes = a.notes;
          writeLog(api, apps);
          return { updated: rec.id, status: rec.status };
        }
        if (!a.company || !a.role || !a.status) throw new PluginError('INVALID_ARGUMENTS', 'add needs company, role and status');
        if (a.status === 'submitted') {
          const dup = findDuplicate(apps, a);
          if (dup) throw new PluginError('INVALID_ARGUMENTS', `Already applied: ${dup.company} / ${dup.role} on ${dup.date} (${dup.id})`);
          if (submittedToday >= limit) throw new PluginError('LIMIT_EXCEEDED', `Daily limit reached (${limit} submitted today). Stop for today.`);
        }
        const rec = { id: `app_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, date: today(), company: a.company, role: a.role, url: a.url, cv: a.cv, status: a.status, notes: a.notes };
        apps.push(rec);
        writeLog(api, apps);
        return { added: rec.id, submittedToday: submittedToday + (a.status === 'submitted' ? 1 : 0), remainingToday: Math.max(0, limit - submittedToday - (a.status === 'submitted' ? 1 : 0)) };
      },
    }),
  ],
});
