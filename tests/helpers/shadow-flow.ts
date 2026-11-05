import { FlowBuilder, type Flow } from '@browserforge/flows';

export const UNUSUAL_HOST = '雪\'"\\ >> host';
export const UNUSUAL_FIELD = '雪\'"\\ >> field';

/** Only synthetic localhost fixture data, shared by extension and standalone-export tests. */
export function shadowFlow(url: string, opts: { frame?: boolean; unusual?: boolean; verifyResponse?: boolean } = {}): Flow {
  const hosts = [opts.unusual ? `[data-host=${JSON.stringify(UNUSUAL_HOST)}]` : '#target', 'inner-box:nth-of-type(2)'];
  const b = new FlowBuilder({ id: 'shadow', site: new URL(url).hostname, name: 'Nested shadow fixture', storeValues: true });
  b.navigate(url + (opts.frame ? '/shadow-frame' : '/shadow-nested'));
  const frame = opts.frame ? { frameUrl: url + '/shadow-nested' } : {};
  b.add({ action: 'fill', value: 'synthetic', fieldLabel: 'Shadow value', locator: { tag: 'input', label: 'Repeated field', testId: 'shared', css: opts.unusual ? `[data-field=${JSON.stringify(UNUSUAL_FIELD)}]` : 'form > input[name="second"]', shadow: hosts, nth: 0 }, ...frame });
  b.add({ action: 'click', consequential: true, locator: { tag: 'button', role: 'button', name: 'Store value', css: 'form > button', shadow: hosts, nth: 0 }, ...frame });
  // Positive standalone flows also observe a control that exists only in the successful POST response.
  // Preserve the iframe address: its src attribute stays the same when its document navigates.
  if (opts.verifyResponse) b.add({ action: 'click', locator: { tag: 'button', id: 'shadow-confirmation', css: '#shadow-confirmation' }, ...frame });
  return b.flow;
}
