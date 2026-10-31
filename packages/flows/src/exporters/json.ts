import type { Exporter, Flow } from '../schema.js';

/** The neutral format itself, for any tool or language. Sensitive parameters never carry a value; others only with includeDefaults. */
export const neutralJson: Exporter = {
  format: 'json',
  description: 'BrowserForge neutral flow JSON (documented in docs/FLOWS.md)',
  extension: 'json',
  generate(flow: Flow, opts) {
    const params = flow.params.map((p) => (opts?.includeDefaults && !p.sensitive ? p : { name: p.name, sensitive: p.sensitive, label: p.label }));
    return JSON.stringify({ ...flow, params }, null, 2) + '\n';
  },
};
