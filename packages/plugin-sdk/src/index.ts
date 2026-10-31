import type { Exporter } from '@browserforge/flows';
import { z } from 'zod';
import type { PluginApi } from './api.js';

export { z };
export type { Exporter };
export * from './manifest.js';
/** Throw this from a tool to give the agent a clear, structured error: `throw new PluginError('INVALID_ARGUMENTS', 'Why', { details })`. */
export { BrowserForgeError as PluginError } from '@browserforge/shared';
export { createPluginApi, type PluginApi, type PluginRuntime, type SettingValue } from './api.js';

export interface PluginToolDef<S extends z.ZodObject = z.ZodObject> {
  /** Must start with the manifest's `toolPrefix` and an underscore, e.g. "cv_list". */
  name: string;
  title?: string;
  description: string;
  input: S;
  /** true: changes nothing outside the plugin's own reads. */
  readOnly: boolean;
  /** true: can have effects that are hard to undo or leave this machine. */
  destructive?: boolean;
  /** Allow this tool as a step in BrowserForge workflows. */
  workflowSafe?: boolean;
  run(args: z.infer<S>, api: PluginApi): Promise<unknown>;
}

export interface PluginDefinition {
  tools: PluginToolDef[];
  /** Extra flow export formats (flow_export). */
  exporters?: Exporter[];
}

/** The default export of a plugin's main file. */
export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def;
}

/** Keeps the type of `input` for `run` while allowing a heterogeneous list: `tool({ ... })`. */
export function tool<S extends z.ZodObject>(def: PluginToolDef<S>): PluginToolDef {
  return def as unknown as PluginToolDef;
}
