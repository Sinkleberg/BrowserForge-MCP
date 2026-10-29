import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserForgeError } from './errors.js';

function realpathOfExistingPrefix(p: string): string {
  // Resolve symlinks for the longest existing prefix so non-existent targets are still checked.
  let current = path.resolve(p);
  const tail: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    tail.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...tail);
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve `input` and ensure it lies inside one of `allowedRoots` (after symlink resolution).
 * Rejects NUL bytes, traversal escapes and symlink escapes.
 */
export function resolveSafePath(input: string, allowedRoots: string[], baseDir?: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
    throw new BrowserForgeError('PATH_NOT_ALLOWED', 'Invalid path');
  }
  const expanded = input.startsWith('~') ? path.join(os.homedir(), input.slice(1)) : input;
  const abs = path.isAbsolute(expanded) ? expanded : path.resolve(baseDir ?? process.cwd(), expanded);
  const real = realpathOfExistingPrefix(abs);
  const roots = allowedRoots.map((r) => realpathOfExistingPrefix(r));
  if (!roots.some((r) => isInside(r, real))) {
    throw new BrowserForgeError('PATH_NOT_ALLOWED', 'Path is outside the allowed directories', {
      details: { allowedRoots: roots },
    });
  }
  return real;
}

/** Sanitise a user-provided identifier so it is safe as a single path segment / package name. */
export function safeSegment(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  if (!cleaned || cleaned === '_') throw new BrowserForgeError('INVALID_ARGUMENTS', 'Invalid name');
  return cleaned.slice(0, 80);
}
