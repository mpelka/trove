import { fileURLToPath } from "node:url";
import pkg from "../../../package.json" with { type: "json" };

/**
 * The app's version. The ROOT package.json is the single source of truth — trove ships as
 * one thing, and the workspace packages' own versions are inert (nothing is published, so
 * nothing ever resolves @trove/core by version).
 */
export const VERSION: string = pkg.version;

const repoRootDir = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Short git SHA of the working tree, or null when git metadata isn't there.
 *
 * trove is installed everywhere by cloning the (public) repo, so in practice this resolves
 * on every machine — `--version` gives an exact identity, not just a release number, which
 * is what you actually want when comparing two checkouts. The null path is a fallback for
 * the rare gitless copy (a downloaded tarball, a `cp -r`), where the plain VERSION has to
 * stand alone; that's the case tags exist for.
 */
function gitSha(): string | null {
  try {
    const rev = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
      cwd: repoRootDir,
      stderr: "ignore",
    });
    if (rev.exitCode !== 0) return null;
    const sha = rev.stdout.toString().trim();
    if (!sha) return null;
    // Flag uncommitted work, so a hand-patched checkout can't masquerade as the tag.
    const st = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repoRootDir, stderr: "ignore" });
    const dirty = st.exitCode === 0 && st.stdout.toString().trim().length > 0;
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return null; // no git binary / not a repo — the version stands alone
  }
}

/** `0.2.0 (75bec11)` in a checkout; plain `0.2.0` in a gitless copy. */
export function versionString(): string {
  const sha = gitSha();
  return sha ? `${VERSION} (${sha})` : VERSION;
}
