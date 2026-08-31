/**
 * @raci/core — the domain, with no framework and no DOM in sight.
 *
 * Everything the app knows about RACI charts, task flows and the registries lives here, as pure
 * data and pure functions. The Nuxt app, the API server, the directory sync and the exporters all
 * consume it; none of them re-implements a rule.
 *
 * The rule for this package: no imports from anything that assumes a browser, a server, a
 * database or a framework. If something needs one of those, it belongs in a package that
 * depends on this one.
 */

export * from './constants.js';
export * from './fractional.js';
export * from './ids.js';
export * from './schema.js';
export * from './tree.js';
export * from './raci.js';
export * from './legacy.js';
export * from './export/xml.js';
export * from './export/mermaid.js';
