// Only packages that actually declare a vitest config take part. Globbing the package
// directories themselves would make an as-yet-empty package a startup error for the whole run.
export default ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts'];
