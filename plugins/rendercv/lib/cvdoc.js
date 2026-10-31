// Pure functions over a parsed RenderCV document (no file access): easy to test, easy to read.
// A RenderCV file is { cv: { name, headline, sections: { "Section name": [ entries ] } }, design: ... }.
// Every piece of text an agent may change gets a stable id such as "experience-0-h2" (section, entry, highlight).

export const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'x';

const TITLE_KEYS = ['position', 'company', 'name', 'institution', 'label', 'degree', 'area', 'bullet'];

/**
 * Build id -> accessor for everything editable. Accessors track the actual string or object (`ref`), not its position, so
 * rewording, reordering and dropping can be applied in any combination without ids going stale.
 */
export function index(doc) {
  const out = new Map();
  const sections = doc?.cv?.sections ?? {};
  const listText = (id, kind, section, parent, ref, item) => {
    const e = {
      id, kind, section, parent, item, ref, text: ref,
      set(t) {
        const at = parent.indexOf(e.ref);
        if (at >= 0) parent[at] = t;
        e.ref = t;
        e.text = t;
      },
    };
    out.set(id, e);
  };
  for (const [sectionName, items] of Object.entries(sections)) {
    if (!Array.isArray(items)) continue;
    const s = slug(sectionName);
    [...items].forEach((item, i) => {
      const id = `${s}-${i}`;
      if (typeof item === 'string') return listText(id, 'text', sectionName, items, item);
      if (!item || typeof item !== 'object') return;
      out.set(id, { id, kind: 'entry', section: sectionName, parent: items, item, ref: item, title: TITLE_KEYS.map((k) => item[k]).find((v) => typeof v === 'string') ?? id });
      for (const field of ['summary', 'details', 'bullet']) {
        if (typeof item[field] === 'string') out.set(`${id}-${field}`, { id: `${id}-${field}`, kind: field, section: sectionName, item, text: item[field], set(t) { item[field] = t; this.text = t; } });
      }
      if (Array.isArray(item.highlights)) [...item.highlights].forEach((h, j) => typeof h === 'string' && listText(`${id}-h${j}`, 'highlight', sectionName, item.highlights, h, item));
    });
  }
  return out;
}

/** What an agent should see: sections with ids, titles and editable text. */
export function describe(doc) {
  const idx = index(doc);
  const sections = [];
  for (const [name, items] of Object.entries(doc?.cv?.sections ?? {})) {
    if (!Array.isArray(items)) continue;
    const s = slug(name);
    sections.push({
      name,
      items: items.map((item, i) => {
        const id = `${s}-${i}`;
        if (typeof item === 'string') return { id, text: item };
        const e = idx.get(id);
        const row = { id, title: e?.title };
        for (const k of ['company', 'position', 'institution', 'degree', 'area', 'location', 'start_date', 'end_date', 'date']) if (typeof item?.[k] === 'string') row[k] = item[k];
        for (const f of ['summary', 'details', 'bullet']) if (typeof item?.[f] === 'string') row[f] = { id: `${id}-${f}`, text: item[f] };
        if (Array.isArray(item?.highlights)) row.highlights = item.highlights.map((h, j) => ({ id: `${id}-h${j}`, text: String(h) }));
        return row;
      }),
    });
  }
  return { name: doc?.cv?.name, headline: doc?.cv?.headline, sections };
}

export function allText(doc) {
  const parts = [];
  const walk = (v) => {
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(doc?.cv);
  return parts.join('\n');
}

// ---------- the "no new facts" check ----------
const NUMBER = /\d[\d.,]*\d|\d/g;
const URLISH = /\bhttps?:\/\/[^\s)]+|\b[\w.+-]+@[\w-]+\.[\w.-]+/g;
// Names of tools, products and acronyms: contain a capital after the first letter, a digit, or one of + # . -, or are all capitals.
const TERM = /\b(?:[A-Z]{2,}[\w+#.-]*|[A-Z][a-z]+[A-Z][\w+#.-]*|[A-Za-z][\w]*[+#]+|[A-Za-z]+\.[A-Za-z]{2,}|[A-Za-z]+-\d+[\w.-]*)\b/g;
const CAPITALISED = /(?<=[a-z0-9,;:)]\s)[A-Z][a-z]{2,}\b/g; // a capitalised word in the middle of a sentence is a name (Kubernetes, Azure, Google)

const words = (text) => new Set((String(text).toLowerCase().match(/[a-z0-9+#]+(?:[.-][a-z0-9+#]+)*/g) ?? []).flatMap((w) => [w, w.replace(/s$/, ''), ...w.split(/[.-]/)]));
const nums = (text) => new Set((String(text).match(NUMBER) ?? []).map((n) => n.replace(/[.,]+$/, '')));

/**
 * Compare new text with the master CV. Anything that reads like a new fact is returned: numbers, links and e-mails, tool/product
 * names, acronyms. Words from `allowed` (the company and role being applied to) are exempt, since a target is not a claim.
 */
export function newFacts(masterDoc, texts, allowed = []) {
  const master = allText(masterDoc);
  const masterWords = words(master);
  const masterNums = nums(master);
  const masterLower = master.toLowerCase();
  const exempt = words(allowed.join(' '));
  const found = [];
  const add = (kind, text, where) => {
    if (!found.some((f) => f.text === text && f.where === where)) found.push({ kind, text, where });
  };
  for (const { where, text: full } of texts) {
    for (const m of full.match(URLISH) ?? []) if (!masterLower.includes(m.toLowerCase())) add('link', m, where);
    const text = full.replace(URLISH, ' '); // a link is judged as a link, not again as numbers and names inside it
    for (const n of nums(text)) if (!masterNums.has(n)) add('number', n, where);
    const terms = new Set([...(text.match(TERM) ?? []), ...(text.match(CAPITALISED) ?? [])]);
    for (const t of terms) {
      const ws = [...words(t)];
      if (ws.every((w) => masterWords.has(w) || exempt.has(w))) continue;
      add('term', t, where);
    }
  }
  return found;
}

// ---------- applying a tailoring ----------
/**
 * Apply changes to a deep copy of the master. Only existing things can change: reword text, reorder, drop. Nothing can be added.
 * Returns { doc, changes, texts } where texts are the new strings that need the facts check.
 */
export function applyTailoring(masterDoc, req) {
  const doc = structuredClone(masterDoc);
  const idx = index(doc);
  const changes = [];
  const texts = [];
  const need = (id, kinds) => {
    const e = idx.get(id);
    if (!e) throw new Error(`Unknown id '${id}'. Use cv_get to see the ids of this CV.`);
    if (kinds && !kinds.includes(e.kind)) throw new Error(`'${id}' is a ${e.kind}; this operation needs ${kinds.join(' or ')}`);
    return e;
  };

  if (req.headline !== undefined) {
    changes.push({ id: 'headline', before: doc.cv.headline ?? '', after: req.headline });
    texts.push({ where: 'headline', text: req.headline });
    doc.cv.headline = req.headline;
  }
  if (req.summary !== undefined) {
    const name = Object.keys(doc.cv.sections ?? {}).find((n) => /summary|profile|about/i.test(n));
    if (!name) throw new Error('This CV has no Summary/Profile section to rewrite');
    changes.push({ id: slug(name), before: (doc.cv.sections[name] ?? []).join(' '), after: req.summary.join(' ') });
    req.summary.forEach((t, i) => texts.push({ where: `summary line ${i + 1}`, text: t }));
    doc.cv.sections[name] = [...req.summary];
  }
  for (const r of req.reword ?? []) {
    const e = need(r.id, ['text', 'highlight', 'summary', 'details', 'bullet']);
    changes.push({ id: r.id, before: e.text, after: r.text });
    texts.push({ where: r.id, text: r.text });
    e.set(r.text);
  }
  // Reorder after rewording (ids of highlights stay valid until something is removed or moved).
  for (const o of req.order ?? []) {
    const first = need(o.ids[0], ['entry', 'text', 'highlight']);
    const parent = first.parent;
    const picked = o.ids.map((id) => {
      const e = need(id, ['entry', 'text', 'highlight']);
      if (e.parent !== parent) throw new Error(`Cannot reorder across lists: '${id}' is not in the same list as '${o.ids[0]}'`);
      return e.ref;
    });
    const rest = parent.filter((x) => !picked.includes(x));
    parent.splice(0, parent.length, ...picked, ...rest);
    changes.push({ id: o.ids.join(','), before: 'original order', after: 'new order' });
  }
  const dropped = (req.drop ?? []).map((id) => need(id, ['entry', 'text', 'highlight']));
  for (const e of dropped) {
    const at = e.parent.indexOf(e.ref);
    if (at >= 0) e.parent.splice(at, 1);
    changes.push({ id: e.id, before: e.kind === 'entry' ? e.title : e.text, after: '(removed)' });
  }
  return { doc, changes, texts };
}

/** `photo` is the only path in a RenderCV file, relative to the file; a copy in another folder needs it absolute. */
export function absolutizePhoto(doc, masterDir, resolve) {
  const photo = doc?.cv?.photo;
  if (typeof photo === 'string' && photo && !/^([a-z]+:|\/|~)/i.test(photo)) doc.cv.photo = resolve(masterDir, photo);
}
