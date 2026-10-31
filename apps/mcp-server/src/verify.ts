/**
 * Decides whether a page shows a finished task, from what the extension already reports about it: the address, the title,
 * the short headings/alerts ("notes") and the control rows. No page text is read or stored.
 */
export interface VerifyRow {
  kind: string;
  label: string;
  state?: string;
  editable?: boolean;
}

export interface VerifyPage {
  url: string;
  title?: string;
  notes: string[];
  rows: VerifyRow[];
}

export type Verdict = 'success' | 'failure' | 'unknown';

export interface Verification {
  verdict: Verdict;
  signals: string[];
}

// English, Italian, French, Spanish, German: the languages job and signup sites are most often in.
const SUCCESS_WORDS =
  /\b(thank you|thanks\b|(?:account|registration|profile) (?:was |has been |is )?(?:successfully )?created|application (?:has been |was )?(?:received|submitted|sent)|(?:successfully|correctly) (?:submitted|sent|received|created|registered)|we(?:'ve| have) received|has been (?:received|submitted|sent)|grazie|ricevut[aoie]|candidatura (?:inviata|ricevuta)|inviata con successo|acquisit[aoie]|registrazione completata|merci|bien (?:été )?(?:reçu|envoy)|candidature (?:envoyée|reçue|enregistrée)|gracias|recibid[ao]|enviad[ao]|solicitud (?:enviada|recibida)|danke|vielen dank|erhalten|eingereicht|bewerbung (?:eingegangen|gesendet))/i;

const FAILURE_WORDS =
  /\b(this field is required|field is required|required field|is required|please (?:fill|enter|select|correct|complete|provide)|invalid|not valid|something went wrong|errors? (?:occurred|found)|obbligatori[oa]|campo obbligatorio|non valid[oa]|compila|errore|champ (?:requis|obligatoire)|invalide|erreur|campo (?:requerido|obligatorio)|inválid[oa]|pflichtfeld|ungültig|fehler)/i;

const SUCCESS_PATH = /(thank|confirm|success|complete|submitted|received|grazie|conferma|completat|merci|gracias|danke)/i;

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

const editableCount = (p: VerifyPage) => p.rows.filter((r) => r.editable || /^input:(text|email|tel|number|url|date|search)|^textarea|^select/.test(r.kind)).length;
const shape = (p: VerifyPage) => p.rows.map((r) => r.label).sort().join('|');

/**
 * `before` is the page just before the final action (a submit click); it makes "the form is gone" and "nothing changed"
 * detectable. Without it only the page's own wording counts.
 */
export function verifyOutcome(after: VerifyPage, before?: VerifyPage): Verification {
  const signals: string[] = [];
  const said = [after.title ?? '', ...after.notes].join(' \n ');
  const success = SUCCESS_WORDS.test(said);
  const failure = FAILURE_WORDS.test(after.notes.join(' \n '));
  if (success) signals.push('confirmation wording');
  if (failure) signals.push('error or required-field wording');

  const urlChanged = before !== undefined && before.url !== after.url;
  if (urlChanged && SUCCESS_PATH.test(pathOf(after.url))) signals.push('address changed to a confirmation page');

  const formGone = before !== undefined && editableCount(before) >= 2 && editableCount(after) === 0;
  if (formGone) signals.push('the form is gone');
  const unchanged = before !== undefined && !urlChanged && shape(before) === shape(after) && !success;
  if (unchanged) signals.push('the page did not change');

  if (failure) return { verdict: 'failure', signals };
  if (success) return { verdict: 'success', signals };
  if (signals.includes('address changed to a confirmation page')) return { verdict: 'success', signals };
  if (formGone && urlChanged) return { verdict: 'success', signals };
  if (unchanged) return { verdict: 'failure', signals };
  return { verdict: 'unknown', signals };
}

/** Build a VerifyPage from the extension's interactive_elements result (table format). */
export function pageFromElements(raw: unknown): VerifyPage {
  const r = (raw ?? {}) as { url?: string; title?: string; rows?: string[]; notes?: string[] };
  const rows: VerifyRow[] = (r.rows ?? []).map((line) => {
    const [, kindPart = '', label = ''] = line.split(' | ');
    const kind = kindPart.replace(/\s*\(.*?\)|\s*\[.*?\]/g, '').trim();
    return { kind, label, state: /\[(\w+)\]/.exec(kindPart)?.[1], editable: kindPart.includes('(editable)') };
  });
  return { url: String(r.url ?? ''), title: r.title, notes: (r.notes ?? []).map(String), rows };
}

/** The goal runner's observation as a VerifyPage (it already holds rows and notes, and no title). */
export function pageFromObservation(o: { url: string; rows: { kind: string; label: string; state: string; editable: boolean }[]; notes: string[] }): VerifyPage {
  return { url: o.url, notes: o.notes, rows: o.rows.map((r) => ({ kind: r.kind, label: r.label, state: r.state, editable: r.editable })) };
}
