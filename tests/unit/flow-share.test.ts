import { describe, expect, it } from 'vitest';
import { FlowBuilder } from '@browserforge/flows';
import { valueFree } from '../../apps/mcp-server/src/flows/skill.js';

describe('valueFree (the flow.json bundled with a shared skill)', () => {
  it('drops recorded values that were read back off the element: custom dropdowns and contenteditable fields', () => {
    const b = new FlowBuilder({ id: 'shop.test/1', site: 'shop.test', name: 'Order' });
    b.navigate('https://shop.test/order');
    // A custom dropdown after the pick: its accessible name and text are the chosen option, and the label is made from them.
    b.add({ action: 'select', value: 'Italy', custom: true, locator: { tag: 'div', role: 'combobox', name: 'Italy', text: 'Italy', css: '#country' } });
    // A contenteditable after typing: its text is what was typed.
    b.add({ action: 'fill', value: 'Hello team, ready to start', locator: { tag: 'div', role: 'textbox', text: 'Hello team, ready to start', css: 'div.editor' } });
    // A 1-character value must not strip unrelated selectors that happen to contain it.
    b.add({ action: 'fill', value: '7', fieldLabel: 'Years', locator: { tag: 'input', label: 'Years', css: '#years > input:nth-child(7)' } });
    b.add({ action: 'click', url: 'https://shop.test/order?country=Italy', locator: { tag: 'button', role: 'button', name: 'Next', css: 'button.next' } });
    const out = valueFree(b.flow);
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/italy/i);
    expect(json).not.toContain('Hello team');
    expect(out.params.every((p) => p.default === undefined)).toBe(true);
    expect(out.steps[1]!.locator).toEqual({ tag: 'div', role: 'combobox', css: '#country' });
    expect(out.steps[1]!.label).toBe('select "#country"');
    expect(out.steps[2]!.locator).toEqual({ tag: 'div', role: 'textbox', css: 'div.editor' });
    expect(out.steps[3]!.locator!.css).toBe('#years > input:nth-child(7)');
    expect(out.steps[4]!.url).toBeUndefined(); // informational address with the value: dropped
    expect(out.steps[4]!.locator!.name).toBe('Next');
    // The original flow is left alone.
    expect(b.flow.params.find((p) => p.default === 'Italy')).toBeTruthy();
  });

  it('refuses when the value was the only way to find the element, or the address opened carries it', () => {
    const only = new FlowBuilder({ id: 's.test/1', site: 's.test' });
    only.add({ action: 'select', value: 'Italy', custom: true, url: 'https://s.test/a', locator: { tag: 'div', text: 'Italy' } });
    expect(() => valueFree(only.flow)).toThrow(/only be found by text that contains a recorded value/);

    const nav = new FlowBuilder({ id: 's.test/2', site: 's.test' });
    nav.add({ action: 'fill', value: 'lovelace', fieldLabel: 'Search', url: 'https://s.test/a', locator: { tag: 'input', css: '#q' } });
    nav.navigate('https://s.test/search?q=lovelace');
    expect(() => valueFree(nav.flow)).toThrow(/opens an address that contains a recorded value/);
  });

  it('does not refuse ordinary flows because a short value appears inside an address', () => {
    const b = new FlowBuilder({ id: 's.test/3', site: 's.test' });
    b.navigate('https://s.test/en/openings');
    b.add({ action: 'select', value: 'en', fieldLabel: 'Language', locator: { tag: 'select', label: 'Language', css: '#lang' } });
    expect(valueFree(b.flow).steps[0]!.url).toBe('https://s.test/en/openings');
  });
});
