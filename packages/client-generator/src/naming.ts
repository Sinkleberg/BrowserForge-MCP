export const words = (s: string): string[] =>
  s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w.toLowerCase());
export const snake = (s: string) => words(s).join('_');
export const pascal = (s: string) => words(s).map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
export const camel = (s: string) => { const p = pascal(s); return p ? p[0]!.toLowerCase() + p.slice(1) : p; };
export const upperSnake = (s: string) => snake(s).toUpperCase();
export const singular = (w: string) => (w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.endsWith('ss') ? w : w.endsWith('s') ? w.slice(0, -1) : w);

const PY_RESERVED = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'self', 'body', 'timeout']);
const JS_RESERVED = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'await', 'async', 'arguments', 'eval', 'body', 'options']);
const PHP_RESERVED = new Set(['abstract', 'and', 'array', 'as', 'break', 'callable', 'case', 'catch', 'class', 'clone', 'const', 'continue', 'declare', 'default', 'do', 'echo', 'else', 'elseif', 'empty', 'enddeclare', 'endfor', 'endforeach', 'endif', 'endswitch', 'endwhile', 'eval', 'exit', 'extends', 'final', 'finally', 'fn', 'for', 'foreach', 'function', 'global', 'goto', 'if', 'implements', 'include', 'instanceof', 'insteadof', 'interface', 'isset', 'list', 'match', 'namespace', 'new', 'or', 'print', 'private', 'protected', 'public', 'readonly', 'require', 'return', 'static', 'switch', 'throw', 'trait', 'try', 'unset', 'use', 'var', 'while', 'xor', 'yield', 'this', 'body']);

export type Lang = 'python' | 'typescript' | 'javascript' | 'php';

/** Make a wire name usable as a local identifier in the target language. */
export function ident(name: string, lang: Lang): string {
  let base = lang === 'python' ? snake(name) : camel(name);
  if (!base || /^\d/.test(base)) base = 'p' + base;
  const reserved = lang === 'python' ? PY_RESERVED : lang === 'php' ? PHP_RESERVED : JS_RESERVED;
  return reserved.has(base) ? base + '_' : base;
}
