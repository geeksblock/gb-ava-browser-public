/**
 * The identity of the build that produced this bundle.
 *
 * A stale unpacked extension is a real, observed failure: Chrome can keep
 * executing the service-worker script it cached when the extension was last
 * loaded, even across a browser restart, and the symptom is an `unknown_method`
 * for a method that exists in the repository. A version string does not help —
 * every build ships `0.1.0` — so every bundle carries the git commit and build
 * time it was made from, and the bridge can compare its own with the
 * extension's.
 *
 * The values are injected by `scripts/build.mjs` (esbuild `define`) and by
 * `vitest.config.ts` for unit tests. The `typeof` guards keep this module safe
 * when it is evaluated unbundled (a plain `node --experimental-strip-types`
 * import, or a REPL): an undeclared identifier in `typeof` does not throw.
 */

declare const __AVA_BUILD_ID__: string | undefined;
declare const __AVA_BUILD_AT__: string | undefined;

/** Git commit this bundle was built from, with `-dirty` when the tree had changes. */
export const BUILD_ID: string =
  typeof __AVA_BUILD_ID__ === "string" && __AVA_BUILD_ID__.length > 0 ? __AVA_BUILD_ID__ : "unbundled";

/** ISO timestamp of the build, or `unknown` when the bundle carries no stamp. */
export const BUILT_AT: string =
  typeof __AVA_BUILD_AT__ === "string" && __AVA_BUILD_AT__.length > 0 ? __AVA_BUILD_AT__ : "unknown";
