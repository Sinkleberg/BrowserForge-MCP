import { z } from 'zod';

/** Element addressing: a ref from a previous snapshot (preferred) or a CSS selector. */
const Target = {
  ref: z.string().max(64).optional().describe('Element ref returned by browser_get_interactive_elements / dom snapshot'),
  selector: z.string().max(500).optional().describe('CSS selector (used if ref is not given)'),
};
const TabId = z.number().int().nonnegative().optional().describe('Tab id; defaults to the active tab');
const withTarget = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ tabId: TabId, ...Target, ...shape }).refine((a) => Boolean((a as { ref?: string }).ref || (a as { selector?: string }).selector), { message: 'Provide ref or selector' });

export interface ActionDef {
  args: z.ZodType;
  /** true: does not change page/browser state. */
  readOnly: boolean;
  description: string;
}

export const KEY_MODIFIERS = z.array(z.enum(['Control', 'Shift', 'Alt', 'Meta'])).max(4).optional();

export const ACTIONS = {
  tabs_list: { readOnly: true, description: 'List open tabs', args: z.object({}) },
  tabs_active: { readOnly: true, description: 'Get the active tab', args: z.object({}) },
  tabs_select: { readOnly: false, description: 'Make a tab the active tab', args: z.object({ tabId: z.number().int().nonnegative() }) },
  tabs_close: { readOnly: false, description: 'Close a tab (tabs the agent did not open need approval)', args: z.object({ tabId: z.number().int().nonnegative() }) },
  navigate: {
    readOnly: false,
    description: 'Navigate a tab to a URL (http/https only) or go back/forward/reload',
    args: z.object({
      tabId: TabId,
      url: z.string().max(4000).optional(),
      history: z.enum(['back', 'forward', 'reload']).optional(),
      newTab: z.boolean().optional(),
      timeoutMs: z.number().int().positive().max(120_000).optional(),
    }).refine((a) => a.url || a.history, { message: 'Provide url or history' }),
  },
  click: { readOnly: false, description: 'Click an element', args: withTarget({}) },
  type: {
    readOnly: false,
    description: 'Type text into an input, textarea or contenteditable editor; without ref/selector the focused element is used',
    args: z.object({ tabId: TabId, ...Target, text: z.string().max(20_000), clear: z.boolean().optional(), submit: z.boolean().optional() }),
  },
  fill_field: { readOnly: false, description: 'Set the value of a form field', args: withTarget({ value: z.string().max(20_000) }) },
  select_option: {
    readOnly: false,
    description: 'Select an option in a <select>',
    args: withTarget({ value: z.string().max(500).optional(), label: z.string().max(500).optional() }).refine((a) => a.value !== undefined || a.label !== undefined, { message: 'Provide value or label' }),
  },
  scroll: {
    readOnly: false,
    description: 'Scroll the page or an element into view',
    args: z.object({ tabId: TabId, ...Target, direction: z.enum(['up', 'down', 'top', 'bottom']).optional(), amount: z.number().int().min(1).max(20_000).optional() }),
  },
  press_key: {
    readOnly: false,
    description: 'Press a key on the focused element',
    args: z.object({ tabId: TabId, ...Target, key: z.string().min(1).max(32), modifiers: KEY_MODIFIERS }),
  },
  page_text: { readOnly: true, description: 'Visible page text (untrusted content)', args: z.object({ tabId: TabId, maxChars: z.number().int().positive().max(200_000).optional(), includeFrames: z.boolean().optional() }) },
  tables: {
    readOnly: true,
    description: 'Extract data tables (HTML tables and ARIA grids) as headers and rows (untrusted content)',
    args: z.object({
      tabId: TabId,
      selector: z.string().max(500).optional(),
      maxRows: z.number().int().positive().max(5000).optional(),
      includeLinks: z.boolean().optional(),
      includeFrames: z.boolean().optional(),
    }),
  },
  dom_snapshot: {
    readOnly: true,
    description: 'Compact DOM snapshot (untrusted content)',
    args: z.object({ tabId: TabId, maxNodes: z.number().int().positive().max(5_000).optional(), root: z.string().max(500).optional() }),
  },
  captcha_scan: { readOnly: true, description: 'Find CAPTCHA widgets (type and site key) on the page (untrusted content)', args: z.object({ tabId: TabId }) },
  interactive_elements: { readOnly: true, description: 'Interactive elements with refs', args: z.object({ tabId: TabId, limit: z.number().int().positive().max(1000).optional(), visibleOnly: z.boolean().optional(), inViewport: z.boolean().optional(), format: z.enum(['full', 'table']).optional(), includeFrames: z.boolean().optional() }) },
  screenshot: {
    readOnly: true,
    description: 'Screenshot of the visible area',
    args: z.object({ tabId: TabId, format: z.enum(['png', 'jpeg']).optional(), quality: z.number().int().min(1).max(100).optional(), fullPage: z.boolean().optional() }),
  },
  wait_for_element: {
    readOnly: true,
    description: 'Wait for an element/text to appear',
    args: z.object({ tabId: TabId, ...Target, text: z.string().max(500).optional(), state: z.enum(['present', 'visible', 'hidden', 'absent']).optional(), timeoutMs: z.number().int().positive().max(120_000).optional() })
      .refine((a) => a.ref || a.selector || a.text, { message: 'Provide ref, selector or text' }),
  },
  resolve_locator: { readOnly: true, description: 'Find an element from a recorded flow locator and return a ref', args: z.object({ tabId: TabId, locator: z.record(z.string(), z.unknown()), frameUrl: z.string().max(2000).optional() }) },
  forms: { readOnly: true, description: 'Discover forms and fields', args: z.object({ tabId: TabId, includeFrames: z.boolean().optional() }) },
  fill_form: {
    readOnly: false,
    description: 'Fill multiple fields of a form by label/name/id; optional file attachments',
    args: z.object({
      tabId: TabId,
      formRef: z.string().max(64).optional(),
      fields: z.array(z.object({ key: z.string().max(200), value: z.string().max(20_000) })).max(200).default([]),
      files: z.array(z.object({ key: z.string().max(200), fileName: z.string().max(255), mimeType: z.string().max(100), base64: z.string().max(14_000_000) })).max(5).optional(),
      submit: z.boolean().optional(),
    }),
  },
  downloads: { readOnly: true, description: 'Recent downloads', args: z.object({ limit: z.number().int().positive().max(100).optional() }) },
  console_errors: { readOnly: true, description: 'Recent console errors / uncaught exceptions in a tab', args: z.object({ tabId: TabId, limit: z.number().int().positive().max(200).optional(), clear: z.boolean().optional() }) },
  stop: { readOnly: false, description: 'Emergency stop: cancel in-flight actions and halt automation', args: z.object({}) },
  pause: { readOnly: false, description: 'Pause automation (actions are refused until resume)', args: z.object({}) },
  resume: { readOnly: false, description: 'Resume automation after pause/stop', args: z.object({}) },
  request_approval: {
    readOnly: false,
    description: 'Ask the human to approve a step (shown in the extension popup); resolves when they decide',
    args: z.object({ title: z.string().max(120), detail: z.string().max(1000).optional(), timeoutMs: z.number().int().positive().max(600_000).optional() }),
  },
  status: { readOnly: true, description: 'Extension state (paused, capture on, pending approvals)', args: z.object({}) },
  network_configure: {
    readOnly: false,
    description: 'Enable/disable capture, response bodies, and set host filters',
    args: z.object({ enabled: z.boolean().optional(), captureBodies: z.boolean().optional(), tabIds: z.array(z.number().int()).max(100).optional(), maxBodyBytes: z.number().int().positive().max(2_000_000).optional() }),
  },
} satisfies Record<string, ActionDef>;

export type ActionName = keyof typeof ACTIONS;
export const ACTION_NAMES = Object.keys(ACTIONS) as ActionName[];
export type ActionArgs<A extends ActionName> = z.input<(typeof ACTIONS)[A]['args']>;

export function isActionName(name: string): name is ActionName {
  return Object.prototype.hasOwnProperty.call(ACTIONS, name);
}

/** URL schemes agents may navigate to. Everything else (about:, file:, javascript:, data:, moz-extension:, chrome:) is refused. */
export function isNavigableUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
