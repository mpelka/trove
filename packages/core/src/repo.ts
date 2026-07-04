/**
 * Best-effort git repo root for a directory. Used by the CLI's `--here` flag to scope
 * search/list to the project you're standing in. Falls back to `dir` itself when it's not
 * a git worktree (or git is unavailable) — a sensible project filter either way.
 */
export function repoRoot(dir: string = process.cwd()): string {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: dir });
    if (proc.exitCode === 0) {
      const out = proc.stdout.toString().trim();
      if (out) return out;
    }
  } catch {
    /* git missing → fall through */
  }
  return dir;
}
