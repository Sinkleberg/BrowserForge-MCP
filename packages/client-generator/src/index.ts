export * from './naming.js';
export * from './ir.js';
export * from './openapi.js';
export * from './params.js';
export * from './python.js';
export * from './writer.js';
export * from './javascript.js';
export * from './php.js';

import type { Ir } from './ir.js';
import { generateJsFamily } from './javascript.js';
import { generatePhp } from './php.js';
import type { GenOptions, GeneratedClient } from './params.js';
import { generatePython } from './python.js';

export type TargetLanguage = 'python' | 'typescript' | 'javascript' | 'php';
export const TARGET_LANGUAGES: TargetLanguage[] = ['python', 'typescript', 'javascript', 'php'];

export function generateClient(ir: Ir, language: TargetLanguage, opts: GenOptions): GeneratedClient {
  switch (language) {
    case 'python': return generatePython(ir, opts);
    case 'typescript': return generateJsFamily(ir, opts, true);
    case 'javascript': return generateJsFamily(ir, opts, false);
    case 'php': return generatePhp(ir, opts);
  }
}
