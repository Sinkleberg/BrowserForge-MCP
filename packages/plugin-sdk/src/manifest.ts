import { z } from 'zod';

export const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
export const PREFIX_RE = /^[a-z][a-z0-9]{1,15}$/;

/** A folder a plugin may touch: one of the three BrowserForge folders, or a path the user sets, optionally narrowed to a sub-folder. */
const rootSpec = z
  .string()
  .regex(/^(uploads|exports|data|setting:[A-Za-z][A-Za-z0-9_]{0,30})(\/[A-Za-z0-9._-]+)*$/, 'Use uploads, exports, data or setting:<key>, optionally followed by /subfolder')
  .refine((s) => !s.split('/').slice(1).some((seg) => /^\.+$/.test(seg)), 'A folder name may not be . or ..');

const settingSchema = z.object({
  type: z.enum(['path', 'string', 'number', 'boolean']),
  description: z.string().min(1).max(200),
  default: z.union([z.string().max(500), z.number(), z.boolean()]).optional(),
  required: z.boolean().optional(),
});

const permissionsSchema = z.object({
  /** Call browser actions through BrowserForge (the approval gate in the extension still applies). */
  browser: z.boolean().optional(),
  files: z.object({ read: z.array(rootSpec).max(10).optional(), write: z.array(rootSpec).max(10).optional() }).optional(),
  /** Programs the plugin may run: a command name (e.g. "python3") or setting:<key> for a path the user sets. Never run through a shell. */
  exec: z.array(z.string().min(1).max(200)).max(10).optional(),
});

export const manifestSchema = z
  .object({
    id: z.string().regex(ID_RE, 'id: lowercase letters, digits and dashes, 2-31 characters, starting with a letter'),
    kind: z.enum(['plugin', 'skill']).optional(),
    /** Every tool the plugin adds must be named `<toolPrefix>_something`, so plugins cannot shadow core tools or each other. */
    toolPrefix: z.string().regex(PREFIX_RE, 'toolPrefix: lowercase letters and digits, 2-16 characters, starting with a letter').optional(),
    description: z.string().min(1).max(200),
    /** Short guidance for the agent, appended to the server instructions below the core rules. */
    instructions: z.string().max(500).optional(),
    main: z.string().max(200).optional(),
    settings: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,30}$/), settingSchema).optional(),
    permissions: permissionsSchema.optional(),
  })
  .strict();

export type PluginManifestInput = z.input<typeof manifestSchema>;

export interface Permissions {
  browser: boolean;
  files: { read: string[]; write: string[] };
  exec: string[];
}

export interface PluginManifest {
  id: string;
  kind: 'plugin' | 'skill';
  toolPrefix?: string;
  description: string;
  instructions?: string;
  main?: string;
  settings: Record<string, z.infer<typeof settingSchema>>;
  permissions: Permissions;
}

export function parseManifest(raw: unknown): PluginManifest {
  const r = manifestSchema.safeParse(raw);
  if (!r.success) throw new Error(`Invalid plugin manifest: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  const m = r.data;
  const kind = m.kind ?? 'plugin';
  if (kind === 'plugin' && !m.toolPrefix) throw new Error('Invalid plugin manifest: a plugin needs a toolPrefix');
  return {
    id: m.id,
    kind,
    ...(m.toolPrefix ? { toolPrefix: m.toolPrefix } : {}),
    description: m.description,
    ...(m.instructions ? { instructions: m.instructions } : {}),
    ...(m.main ? { main: m.main } : {}),
    settings: m.settings ?? {},
    permissions: normalizePermissions(m.permissions),
  };
}

export function normalizePermissions(p: z.infer<typeof permissionsSchema> | Permissions | undefined): Permissions {
  const files = (p?.files ?? {}) as { read?: string[]; write?: string[] };
  const sort = (a: string[] | undefined) => [...new Set(a ?? [])].sort();
  return { browser: p?.browser === true, files: { read: sort(files.read), write: sort(files.write) }, exec: sort(p?.exec) };
}

export const samePermissions = (a: Permissions, b: Permissions): boolean => JSON.stringify(normalizePermissions(a)) === JSON.stringify(normalizePermissions(b));

/** What the user is asked to approve at install time, in plain words. */
export function describePermissions(m: PluginManifest): string[] {
  const p = m.permissions;
  const out: string[] = [];
  if (p.browser) out.push('Drive your browser (every consequential action still waits for your approval in the extension)');
  for (const r of p.files.read) out.push(`Read files in: ${describeRoot(r, m)}`);
  for (const r of p.files.write) out.push(`Create and change files in: ${describeRoot(r, m)}`);
  for (const e of p.exec) out.push(`Run the program: ${e.startsWith('setting:') ? `${e} (the path you configure)` : e}`);
  if (!out.length) out.push('Nothing beyond adding tools that work on their own data');
  return out;
}
const describeRoot = (spec: string, m: PluginManifest): string => {
  const base = spec.split('/')[0]!;
  if (base.startsWith('setting:')) return `${spec} (${m.settings[base.slice(8)]?.description ?? 'a folder you configure'})`;
  return { uploads: `${spec} (your BrowserForge upload folder, where CVs and other files for uploads live)`, exports: `${spec} (your BrowserForge exports folder)`, data: `${spec} (the plugin's own private folder)` }[base] ?? spec;
};
