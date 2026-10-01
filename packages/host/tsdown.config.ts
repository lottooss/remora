import { defineConfig } from 'tsdown'

/**
 * Build the dsh-plugin bundle: a self-contained `lib/index.js` so the packed
 * tarball can be installed by `dsh plugin add` without any `@remora/*`
 * dependency (those workspace packages are never published — P7-H8).
 *
 * - Bundled into the output: `@remora/crypto`, `@remora/protocol`,
 *   `@remora/relay-link`, `qrcode` (all devDependencies, never published).
 * - Kept external: `@deepseek-ai/cordis` and `@deepseek-ai/schemastery`
 *   (peer dependencies — dsh provides them; duplicating them would break
 *   Loader/schema identity, see docs/upstream/dsh-integration.md Q10) and
 *   `ws` (published runtime dependency of the bundled relay-link).
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
  splitting: false,
  external: ['ws'],
})
