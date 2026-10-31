import type { Exporter } from '@browserforge/flows';
import type { Permissions, PluginManifest, PluginToolDef } from '@browserforge/plugin-sdk';

export interface InstalledPlugin {
  id: string;
  kind: 'plugin' | 'skill';
  /** What the user typed: an npm name, a git URL or a folder. */
  source: string;
  /** The package's own name (the folder under node_modules). */
  packageName: string;
  version: string;
  enabled: boolean;
  /** Exactly what the user approved at install. If the code later asks for more, the plugin is switched off. */
  granted: Permissions;
  installedAt: string;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  /** What the user approved (equal to the manifest's permissions: otherwise the plugin would not have loaded). */
  granted: Permissions;
  version: string;
  tools: PluginToolDef[];
  exporters: Exporter[];
}

export interface SkippedPlugin {
  id: string;
  reason: string;
}

export interface SkillWorkflow {
  name: string;
  description?: string;
  inputs: Record<string, { description: string; required?: boolean; default?: string }>;
  steps: { tool: string; args: Record<string, unknown>; label?: string; approval?: string }[];
}

export interface Skill {
  name: string;
  description: string;
  /** The skill's instructions: the body of SKILL.md. Written by the skill's author, not by the user. */
  body: string;
  source: string;
  dir: string;
  requiresTools: string[];
  requiresPlugins: string[];
  workflows: Record<string, SkillWorkflow>;
}

/** Everything plugins and skills contributed, built once at startup. */
export interface PluginRegistry {
  plugins: LoadedPlugin[];
  skipped: SkippedPlugin[];
  skills: Skill[];
  /** Plugin tools allowed as workflow steps. */
  workflowSafe: Set<string>;
}

export const emptyRegistry = (): PluginRegistry => ({ plugins: [], skipped: [], skills: [], workflowSafe: new Set() });
