import { FLOW_VERSION, type Flow, type FlowParam, type FlowStep, type Locator } from './schema.js';

/** The strongest way a step names its element: two recordings of the same step agree on this even when the page's generated ids differ. */
export function locatorKey(l: Locator | undefined): string {
  if (!l) return 'page';
  if (l.testId) return `testId:${l.testId}`;
  if (l.role && l.name) return `role:${l.role}:${l.name}`;
  if (l.label) return `label:${l.label}`;
  if (l.placeholder) return `placeholder:${l.placeholder}`;
  if (l.id) return `id:${l.id}`;
  if (l.nameAttr) return `name:${l.nameAttr}`;
  if (l.name) return `name:${l.name}`;
  if (l.text) return `text:${l.text}`;
  if (l.css) return `css:${l.css}`;
  return 'page';
}

const pathOf = (url: string | undefined): string => {
  try {
    const u = new URL(url ?? '');
    return `${u.origin}${u.pathname.replace(/\/\d{2,}(?=\/|$)/g, '/{id}')}`;
  } catch {
    return url ?? '';
  }
};

/** The ways a step names its element; two steps are the same element when they agree on any one of them. */
function facets(l: Locator | undefined): string[] {
  if (!l) return [];
  const out: string[] = [];
  if (l.testId) out.push(`testId:${l.testId}`);
  if (l.role && l.name) out.push(`role:${l.role}:${l.name}`);
  if (l.label) out.push(`label:${l.label}`);
  if (l.placeholder) out.push(`placeholder:${l.placeholder}`);
  if (l.id) out.push(`id:${l.id}`);
  if (l.nameAttr) out.push(`name:${l.nameAttr}`);
  if (l.text) out.push(`text:${l.text}`);
  if (!out.length && l.css) out.push(`css:${l.css}`); // a CSS path alone is weak, so it only counts when nothing better is known
  return out;
}

/** Same action on the same element (judged by any shared facet), in the same frame. */
export function sameStep(a: FlowStep, b: FlowStep): boolean {
  if (a.action !== b.action) return false;
  if (a.action === 'navigate') return pathOf(a.url) === pathOf(b.url);
  if (a.action === 'press' && (a.key ?? 'Enter') !== (b.key ?? 'Enter')) return false;
  if (Boolean(a.frame) !== Boolean(b.frame)) return false;
  const fb = new Set(facets(b.locator));
  const fa = facets(a.locator);
  if (!fa.length && !fb.size) return true; // two page-level steps (a key press with no element)
  return fa.some((f) => fb.has(f));
}

export function stepKey(s: FlowStep): string {
  if (s.action === 'navigate') return `navigate|${pathOf(s.url)}`;
  return `${s.action}|${locatorKey(s.locator)}${s.action === 'press' ? `|${s.key ?? 'Enter'}` : ''}${s.frame ? `|frame` : ''}`;
}

export interface Consolidated {
  flow: Flow;
  /** How many of the backbone's steps were kept / dropped as one-off detours or repeats. */
  kept: number;
  dropped: number;
}

/**
 * Merge several recordings of the same task on one site into one clean flow:
 * - the longest successful recording is the backbone (the order of its steps stands);
 * - a step stays only when it shows up in at least half of the recordings (rounded up), so wrong turns and one-off popups drop out, but a
 *   consequential step (a submit) always stays;
 * - each kept step gets the locators that other recordings found for the same element, giving the replay more ways to find it;
 * - the same step twice in a row collapses (a fill keeps the last value, a click the first);
 * - parameters are kept for the steps that remain; a parameter is sensitive if it was sensitive anywhere.
 */
export function consolidate(flows: Flow[], init: { id: string; name: string; now?: Date }): Consolidated {
  if (!flows.length) throw new Error('Nothing to consolidate');
  const site = flows[0]!.site;
  if (flows.some((f) => f.site !== site)) throw new Error('All flows must be from the same site');

  const usable = flows.filter((f) => f.outcome !== 'failure');
  const pool = usable.length ? usable : flows;
  const backbone = [...pool].sort((a, b) => Number(b.outcome === 'success') - Number(a.outcome === 'success') || b.steps.length - a.steps.length)[0]!;
  const need = Math.ceil(pool.length / 2);

  const kept: FlowStep[] = [];
  let dropped = 0;
  for (const s of backbone.steps) {
    // The same step in each other recording (the first match), plus the backbone itself.
    const twins = pool.map((f) => (f === backbone ? s : f.steps.find((o) => sameStep(s, o)))).filter((o): o is FlowStep => o !== undefined);
    if (!s.consequential && twins.length < need) {
      dropped++;
      continue;
    }
    const merged: FlowStep = { ...s };
    for (const o of twins) {
      if (o === s) continue;
      if (o.locator) merged.locator = { ...o.locator, ...(merged.locator ?? {}) }; // the backbone's own fields win; others only fill gaps
      if (o.consequential) merged.consequential = true;
    }
    const prev = kept[kept.length - 1];
    if (prev && sameStep(prev, s)) {
      if (s.action === 'fill' || s.action === 'select') kept[kept.length - 1] = { ...merged, locator: { ...prev.locator, ...merged.locator } }; // the latest value stands
      else dropped++;
      continue;
    }
    kept.push(merged);
  }

  const wanted = new Set(kept.map((s) => s.param).filter((p): p is string => !!p));
  const sensitive = new Set(pool.flatMap((f) => f.params.filter((p) => p.sensitive).map((p) => p.name)));
  const params: FlowParam[] = backbone.params
    .filter((p) => wanted.has(p.name))
    .map((p) => (sensitive.has(p.name) ? { name: p.name, sensitive: true, label: p.label } : p));

  const flow: Flow = {
    version: FLOW_VERSION,
    id: init.id,
    site,
    name: init.name.slice(0, 80),
    createdAt: (init.now ?? new Date()).toISOString(),
    saved: true,
    ...(pool.some((f) => f.outcome === 'success') ? { outcome: 'success' as const } : {}),
    derivedFrom: pool.map((f) => f.id),
    params,
    steps: kept,
  };
  return { flow, kept: kept.length, dropped };
}
