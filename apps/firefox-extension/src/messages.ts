/** Messages between the background script and content script (internal to the extension). */
export interface ContentCall {
  kind: 'bf-call';
  op: string;
  args: Record<string, unknown>;
  /** Set only by the background after the human approved this exact action. */
  approved?: boolean;
}
export interface ContentReply {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  /** Content script asks the background to obtain human approval, then retry with approved=true. */
  needsApproval?: { title: string; detail: string };
}
