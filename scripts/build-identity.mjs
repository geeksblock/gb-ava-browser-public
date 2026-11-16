/**
 * Derive the identity a build stamps into its bundles.
 *
 * Kept in its own module so the rule is unit-tested rather than inferred from a
 * build script: a clean tree at commit X is exactly commit X, while a dirty (or
 * git-less) tree is different code every time it is built and must not share an
 * id with an earlier dirty build of the same commit. Collapsing them was the
 * first review finding: two uncommitted builds at one HEAD reported
 * the same id, so a stale extension was declared "not stale".
 *
 * `builtAt` comes from the caller so a build is reproducible in a test and the
 * timestamp is the one written into the bundles.
 */

/**
 * @param {{ commit: string, dirty: boolean, builtAt: string }} input
 *   `commit` is the short git SHA, or `unknown` when git is unavailable.
 * @returns {{ id: string, builtAt: string, clean: boolean }}
 */
export function deriveBuildIdentity({ commit, dirty, builtAt }) {
  const rawCommit = typeof commit === "string" ? commit.trim() : "";
  // `build.mjs` passes the literal "unknown" when git is unavailable: that is not
  // a commit, and treating it as one would give every git-less build the same id.
  const knownCommit = rawCommit.length > 0 && rawCommit !== "unknown";
  const stamp = typeof builtAt === "string" && builtAt.trim().length > 0 ? builtAt : new Date().toISOString();
  const clean = knownCommit && dirty !== true;
  if (clean) return { id: rawCommit, builtAt: stamp, clean: true };
  const base = knownCommit ? rawCommit : "unknown";
  return { id: `${base}${dirty === true ? "-dirty" : ""}-${stamp}`, builtAt: stamp, clean: false };
}
