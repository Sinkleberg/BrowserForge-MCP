/**
 * Runs in the page's own JS world (content script `world: MAIN`) with no extension privileges. It only forwards
 * uncaught errors to the isolated content script through a DOM event carrying a short string.
 */
function report(type: string, message: string): void {
  try {
    document.dispatchEvent(new CustomEvent('__bf_page_error', { detail: JSON.stringify({ type, message: String(message).slice(0, 500) }) }));
  } catch {
    /* ignore */
  }
}
window.addEventListener('error', (e) => report('uncaught', e.message || 'error'));
window.addEventListener('unhandledrejection', (e) => report('unhandledrejection', String((e as PromiseRejectionEvent).reason)));
