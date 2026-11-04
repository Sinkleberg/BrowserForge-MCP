export * from './schema.js';
export * from './params.js';
export * from './builder.js';
export * from './consolidate.js';
export * from './scrub.js';
export { playwrightTs, playwrightPy, playwrightCandidates } from './exporters/playwright.js';
export { seleniumPy, seleniumJava, seleniumCandidates } from './exporters/selenium.js';
export { puppeteerReplay, replaySelectors } from './exporters/replay.js';
export { neutralJson } from './exporters/json.js';

import type { Exporter } from './schema.js';
import { playwrightPy, playwrightTs } from './exporters/playwright.js';
import { seleniumJava, seleniumPy } from './exporters/selenium.js';
import { puppeteerReplay } from './exporters/replay.js';
import { neutralJson } from './exporters/json.js';

/** Built-in exporters. Plugins can add more; look one up with getExporter(format, extra). */
export const BUILTIN_EXPORTERS: Exporter[] = [playwrightTs, playwrightPy, seleniumPy, seleniumJava, puppeteerReplay, neutralJson];

export function getExporter(format: string, extra: Exporter[] = []): Exporter | undefined {
  return [...BUILTIN_EXPORTERS, ...extra].find((e) => e.format === format);
}
