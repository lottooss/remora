import { defineConfig } from 'tsdown'

/**
 * Build the dsh-plugin bundle: a self-contained `lib/index.js` so the packed
 * tarball can be installed by `dsh plugin add` without any `@remora/*`
 * dependency (those workspace packages are never published — P7-H8).
 *
 * - Bundled into the output: `@remora/crypto`, `@remora/protocol`,
 *   `@remora/relay-link`, `qrcode` (all devDependencies, never published).
 *   The workspace packages are bundled from their built `lib/`; the package
 *   `build` script builds them first (`pnpm --filter "@remora/host^..." run build`).
 * - Kept external: `@deepseek-ai/cordis` and `@deepseek-ai/schemastery`
 *   (peer dependencies — dsh provides them; duplicating them would break
 *   Loader/schema identity, see docs/upstream/dsh-integration.md Q10) and
 *   `ws` (published runtime dependency of the bundled relay-link) and `koffi`
 *   (published native FFI, whose platform binaries must remain package-relative).
 *
 * Fail closed: an import the bundler cannot resolve (for example a sibling
 * whose `lib/` was not built) must never be silently externalized.
 * `failOnWarn` turns Rolldown's `UNRESOLVED_IMPORT` warning into a build error,
 * and `deps.onlyImport` rejects any emitted import outside the allow-list
 * below, which also catches an `@remora/*` package moved back into
 * `dependencies` (tsdown externalizes those automatically).
 * The only warning suppressed is rolldown-plugin-dts skipping zod's CommonJS
 * locale declarations (`zod/v4/locales/*.d.cts`): it affects bundled type
 * declarations only, never `lib/index.js`.
 *
 * `@deepseek-ai/dsh-*` imports in src are type-only and erased at build time;
 * they must stay devDependencies and never appear in the bundle.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  dts: true,
  outDir: 'lib',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  failOnWarn: true,
  suppressWarnings: [/[\\/]node_modules[\\/].*[\\/]zod[\\/]v4[\\/]locales[\\/][\w-]+\.d\.cts uses CommonJS dts syntax/],
  deps: {
    alwaysBundle: ['zod'],
    neverBundle: ['ws', 'koffi'],
    onlyImport: ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', 'ws', 'koffi'],
  },
})
