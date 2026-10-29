import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BrowserForgeError } from '@browserforge/shared';
import { isHumanOnly, mapFields, renderTemplate, resolveOption, type FormField } from '../form-mapping.js';
import type { ServerContext } from '../context.js';
import { registerTool, untrusted } from './helpers.js';

const browserId = z.string().max(100).optional();
const tabId = z.number().int().nonnegative().optional();

interface FormInfo { ref: string; index: number; id?: string; name?: string; action?: string; fields: FormField[]; submitButtons: { ref: string; text?: string; value?: string }[]; requiredMissing: string[] }

async function discover(ctx: ServerContext, args: { browserId?: string; tabId?: number }, signal: AbortSignal): Promise<{ url: string; forms: FormInfo[] }> {
  return (await ctx.hub.call('forms', { tabId: args.tabId }, { browserId: args.browserId, signal })) as { url: string; forms: FormInfo[] };
}

function pickForm(forms: FormInfo[], formRef?: string): FormInfo {
  if (!forms.length) throw new BrowserForgeError('ELEMENT_NOT_FOUND', 'No form found on the page');
  if (formRef) {
    const f = forms.find((x) => x.ref === formRef);
    if (!f) throw new BrowserForgeError('STALE_REF', 'formRef not found; call form_discover again');
    return f;
  }
  if (forms.length === 1) return forms[0]!;
  const withFields = [...forms].sort((a, b) => b.fields.length - a.fields.length);
  return withFields[0]!;
}

export function registerFormTools(server: McpServer, ctx: ServerContext): void {
  registerTool(server, ctx, {
    name: 'form_profile_save', title: 'Save profile', readOnly: false,
    description:
      'Store reusable personal details locally (0600 file on this machine, never uploaded). Requires consent:true, which you may only set after the user explicitly agreed to store these exact details. ' +
      'Only store values the user gave you; never invent employment history, qualifications, addresses or legal declarations. Keys such as fullName, email, phone, city, country, linkedin, summary, cvPath, coverLetterTemplate are understood by form_fill_from_profile.',
    input: z.object({ name: z.string().min(1).max(40), data: z.record(z.string(), z.string().max(5000)), mode: z.enum(['replace', 'merge']).optional(), consent: z.literal(true).describe('Must be true: the user explicitly consented to local storage') }),
    run: async ({ name, data, mode }) => ctx.profiles.save(name, data, mode ?? 'merge'),
  });
  registerTool(server, ctx, {
    name: 'form_profile_list', title: 'List profiles', readOnly: true,
    description: 'List stored profile names and which keys they contain (values are not returned).',
    input: z.object({}),
    run: async () => ({ profiles: ctx.profiles.list() }),
  });
  registerTool(server, ctx, {
    name: 'form_profile_delete', title: 'Delete profile', readOnly: false, destructive: true,
    description: 'Delete a stored profile.',
    input: z.object({ name: z.string().min(1).max(40) }),
    run: async ({ name }) => ({ deleted: ctx.profiles.delete(name) }),
  });

  registerTool(server, ctx, {
    name: 'form_discover', title: 'Discover application form', readOnly: true,
    description: 'Find forms on the page and map each field label to the profile key it would be filled from. Fields about passwords, legal declarations, consent, protected characteristics, salary or work authorization are flagged humanOnly and are never auto-filled.',
    input: z.object({ browserId, tabId, profile: z.string().max(40).optional().describe('Profile to map against (shows which fields could be filled)') }),
    run: async ({ browserId, tabId, profile }, x) => {
      const { url, forms } = await discover(ctx, { browserId, tabId }, x.signal);
      const data = profile ? ctx.profiles.get(profile) : {};
      return untrusted('forms', {
        url,
        forms: forms.map((f) => {
          const m = mapFields(f.fields, data);
          return {
            ref: f.ref, id: f.id, name: f.name, action: f.action, fieldCount: f.fields.length, requiredMissing: f.requiredMissing,
            fields: f.fields.map((fl) => ({ ref: fl.ref, label: fl.label, name: fl.name, type: fl.type, required: fl.required, options: fl.options?.slice(0, 20).map((o) => o.label), humanOnly: isHumanOnly(fl) || undefined, mappedTo: m.mappings.find((mm) => mm.field.ref === fl.ref)?.key })),
            submitButtons: f.submitButtons,
          };
        }),
      });
    },
  });

  registerTool(server, ctx, {
    name: 'form_fill_from_profile', title: 'Fill form from profile', readOnly: false, destructive: true,
    description:
      'Fill a form using values from a stored profile. Default is dryRun:true, which only returns a preview (what would be filled, what is missing, what needs the human). ' +
      'With dryRun:false it fills mapped text/select fields but never submits, never fills passwords/declarations/consent boxes, and attaches the profile CV only when attachCv:true (the extension asks the human to approve file attachments).',
    input: z.object({
      browserId, tabId, profile: z.string().min(1).max(40), formRef: z.string().max(64).optional(),
      overrides: z.record(z.string(), z.string().max(5000)).optional().describe('Explicit values for this form (label → value); only what the user provided'),
      dryRun: z.boolean().optional(), attachCv: z.boolean().optional(),
    }),
    run: async ({ browserId, tabId, profile, formRef, overrides, dryRun, attachCv }, x) => {
      const data = ctx.profiles.get(profile);
      const { forms } = await discover(ctx, { browserId, tabId }, x.signal);
      const form = pickForm(forms, formRef);
      const { mappings, humanOnly, unmapped } = mapFields(form.fields, data);
      const plan: { ref: string; label?: string; key: string; value: string; note?: string }[] = [];
      const problems: string[] = [];
      for (const m of mappings) {
        let value = data[m.key!]!;
        if (m.field.tag === 'select') {
          const opt = resolveOption(m.field, value);
          if (!opt) { problems.push(`'${m.field.label ?? m.field.name}': no option matches '${value}' exactly (options: ${(m.field.options ?? []).slice(0, 8).map((o) => o.label).join(', ')})`); continue; }
          value = opt;
        }
        plan.push({ ref: m.field.ref, label: m.field.label ?? m.field.name, key: m.key!, value: value.length > 200 ? value.slice(0, 200) + '…' : value, note: m.confidence === 'medium' ? 'matched by name/id only' : undefined });
      }
      const over: { ref: string; label?: string; value: string }[] = [];
      for (const [k, v] of Object.entries(overrides ?? {})) {
        const f = form.fields.find((fl) => (fl.label ?? '').toLowerCase() === k.toLowerCase() || fl.name === k || fl.id === k);
        if (!f) { problems.push(`override '${k}': no such field`); continue; }
        if (isHumanOnly(f)) { problems.push(`override '${k}': this field needs the human (credentials/declaration/consent/protected data)`); continue; }
        over.push({ ref: f.ref, label: f.label ?? f.name, value: v });
      }
      const covered = new Set([...plan.map((p) => p.ref), ...over.map((o) => o.ref)]);
      const fileInput = form.fields.find((f) => f.type === 'file');
      const missingRequired = form.fields.filter((f) => f.required && f.visible !== false && !covered.has(f.ref) && f.type !== 'file' && !f.value && !f.checked).map((f) => ({ ref: f.ref, label: f.label ?? f.name, humanOnly: isHumanOnly(f) || undefined, type: f.type }));
      const cvNeeded = Boolean(fileInput?.required);
      const preview = {
        form: { ref: form.ref, id: form.id, action: form.action },
        willFill: [...plan, ...over.map((o) => ({ ...o, key: '(override)' }))],
        missingRequired, needsHuman: humanOnly.map((f) => ({ ref: f.ref, label: f.label ?? f.name, type: f.type, required: f.required })),
        notMapped: unmapped.filter((f) => !covered.has(f.ref)).map((f) => ({ ref: f.ref, label: f.label ?? f.name, required: f.required })),
        cv: fileInput ? { fieldLabel: fileInput.label ?? fileInput.name, required: fileInput.required, profileHasCv: Boolean(data.cvPath), willAttach: Boolean(attachCv && data.cvPath) } : undefined,
        problems,
        readyToReview: missingRequired.length === 0 && !(cvNeeded && !data.cvPath) && problems.length === 0,
        submission: 'Not performed. Submitting always needs explicit human approval (browser_click on the submit button or browser_fill_form with submit:true opens an approval prompt).',
      };
      if (dryRun !== false) return untrusted('form_fill_preview', { dryRun: true, ...preview });
      const fields = [...plan, ...over].map((p) => ({ key: p.ref, value: 'value' in p ? p.value : '' }));
      // Use the full (untruncated) values for the actual fill.
      const full = [...mappings.filter((m) => plan.some((p) => p.ref === m.field.ref)).map((m) => ({ key: m.field.ref, value: m.field.tag === 'select' ? resolveOption(m.field, data[m.key!]!)! : data[m.key!]! })), ...over.map((o) => ({ key: o.ref, value: o.value }))];
      void fields;
      const args: Record<string, unknown> = { browserId, tabId, formRef: form.ref, fields: full.map((f) => ({ key: refKey(form, f.key), value: f.value })) };
      if (attachCv && data.cvPath && fileInput) args.files = [{ key: refKey(form, fileInput.ref), filePath: data.cvPath }];
      const entry = ctx.tools.get('browser_fill_form')!;
      const res = await entry.run(entry.input.parse(args) as never, { signal: x.signal });
      return untrusted('form_fill_result', { dryRun: false, ...preview, result: unwrap(res) });
    },
  });

  registerTool(server, ctx, {
    name: 'form_validate', title: 'Validate form completion', readOnly: true,
    description: 'Check the current state of a form: required fields still empty, invalid values, and whether it is ready for human review. Passwords are never read.',
    input: z.object({ browserId, tabId, formRef: z.string().max(64).optional() }),
    run: async ({ browserId, tabId, formRef }, x) => {
      const { forms } = await discover(ctx, { browserId, tabId }, x.signal);
      const form = pickForm(forms, formRef);
      const empty = form.fields.filter((f) => f.required && f.visible !== false && f.type !== 'password' && (f.type === 'checkbox' || f.type === 'radio' ? !f.checked : f.type === 'file' ? false : !f.value));
      const files = form.fields.filter((f) => f.type === 'file' && f.required);
      return untrusted('form_validation', {
        form: { ref: form.ref, id: form.id }, complete: empty.length === 0,
        requiredEmpty: empty.map((f) => ({ ref: f.ref, label: f.label ?? f.name, type: f.type, humanOnly: isHumanOnly(f) || undefined })),
        requiredFileInputs: files.map((f) => ({ ref: f.ref, label: f.label ?? f.name, note: 'file inputs cannot be read back; verify visually' })),
      });
    },
  });

  registerTool(server, ctx, {
    name: 'form_preview_submission', title: 'Preview submission', readOnly: true,
    description: 'Produce a human-readable preview of what is currently entered in a form (passwords and file contents omitted) so the user can review it before approving a submission.',
    input: z.object({ browserId, tabId, formRef: z.string().max(64).optional() }),
    run: async ({ browserId, tabId, formRef }, x) => {
      const { url, forms } = await discover(ctx, { browserId, tabId }, x.signal);
      const form = pickForm(forms, formRef);
      const rows = form.fields.filter((f) => f.visible !== false).map((f) => ({ label: f.label ?? f.name ?? f.id, type: f.type, required: f.required || undefined, value: f.type === 'password' ? '(hidden)' : f.type === 'file' ? '(file input)' : f.type === 'checkbox' || f.type === 'radio' ? (f.checked ? 'checked' : 'unchecked') : f.value ?? '' }));
      return untrusted('form_preview', { page: url, action: form.action, submitButtons: form.submitButtons.map((b) => b.text ?? b.value), fields: rows, missingRequired: form.requiredMissing, note: 'Submission is not performed by this tool. Ask the user to review, then click the submit button; the extension will request their approval.' });
    },
  });

  registerTool(server, ctx, {
    name: 'form_prepare_cover_letter', title: 'Prepare cover letter', readOnly: true,
    description: 'Render a cover letter from a template with {{placeholders}} filled from the profile and the supplied company/role. Unresolved placeholders are reported, never invented. Does not fill or send anything.',
    input: z.object({ profile: z.string().min(1).max(40), template: z.string().max(10_000).optional().describe('Overrides the profile coverLetterTemplate'), values: z.record(z.string(), z.string().max(2000)).optional().describe('company, role, hiringManager, etc.') }),
    run: async ({ profile, template, values }) => {
      const data = ctx.profiles.get(profile);
      const tpl = template ?? data.coverLetterTemplate;
      if (!tpl) throw new BrowserForgeError('INVALID_ARGUMENTS', 'No template: pass "template" or store coverLetterTemplate in the profile (the user should write or approve it)');
      const { text, missing } = renderTemplate(tpl, { ...data, ...(values ?? {}) });
      return { text, unresolvedPlaceholders: missing, complete: missing.length === 0, note: missing.length ? 'Ask the user for the missing values; do not make them up.' : 'Review with the user before using it.' };
    },
  });
}

function refKey(form: FormInfo, ref: string): string {
  const f = form.fields.find((x) => x.ref === ref);
  return f?.name || f?.id || f?.label || ref;
}

function unwrap(res: unknown): unknown {
  const r = res as { content?: { type: string; text?: string }[] };
  const t = r?.content?.find((c) => c.type === 'text')?.text;
  try { return t ? JSON.parse(t) : res; } catch { return t; }
}
