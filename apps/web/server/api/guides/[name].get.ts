/**
 * The three field guides the Help view shows.
 *
 * Served from `server/assets/guides/`, which are the copies EMBEDDED in index.html (its
 * `help-doc-src*` blocks), extracted verbatim — not `docs/*.html`, which have drifted from what the
 * product actually shows. The Help view must read the same as the source's, so it takes the
 * source's copy. Re-extract if index.html's embedded guides change.
 *
 * Plain text rather than a static file so the client can stamp the theme onto <html> before the
 * frame paints, exactly as index.html's helpDocHtml does with srcdoc.
 */
const GUIDES = new Set(['nested-raci', 'chart-flows-tasks', 'how-to']);

export default defineEventHandler(async (event) => {
  const name = getRouterParam(event, 'name') ?? '';
  if (!GUIDES.has(name)) throw createError({ statusCode: 404, statusMessage: 'No such guide' });
  const html = await useStorage('assets:server').getItem<string>(`guides/${name}.html`);
  if (!html) throw createError({ statusCode: 404, statusMessage: 'Guide missing from this build' });
  setHeader(event, 'Content-Type', 'text/html; charset=utf-8');
  return html;
});
