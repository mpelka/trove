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
 * This is a DEV convenience only, and deliberately best-effort: trove is installed on the
 * work laptop by copying/zipping the source, which drops `.git` — so this is null exactly
 * where you'd most want it. That's why releases are tagged: when git is gone, the tagged
 * VERSION is the only identity, so only ever ship from a tagged commit.
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

/** `0.2.0 (75bec11)` in a checkout; plain `0.2.0` when shipped without git. */
export function versionString(): string {
  const sha = gitSha();
  return sha ? `${VERSION} (${sha})` : VERSION;
}
