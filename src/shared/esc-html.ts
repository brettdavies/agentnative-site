/**
 * Escape HTML special characters. Used at every server-to-client boundary
 * that embeds scorecard fields, some of which come from CLI evidence strings
 * a tool author wrote in their own `--help` output.
 */
export function escHtml(s: unknown): string {
  return String(s).replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
