// "The code I wrote": the lines that differ from the base commit, committed on the branch or not, and untracked
// files whole (D-063). The base is the merge base with the default branch, so on the default branch itself only
// the uncommitted changes count.
import { execFileSync } from "node:child_process";
import path from "node:path";

export interface LineRange { start: number; end: number }

/** A changed file relative to the analyzed root; `ranges` undefined means the whole file is new. */
export interface ChangedFile { file: string; ranges?: LineRange[] }

export interface Changes { base: string; baseDescription: string; files: ChangedFile[] }

export class GitError extends Error {}

const BaseCandidates = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.quotepath=off", ...args], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

function tryGit(cwd: string, args: string[]): string | undefined {
  try {
    return git(cwd, args).trim();
  } catch {
    return undefined;
  }
}

/**
 * New-side line ranges of a unified diff, by the path after the change. A hunk that only removes lines marks the
 * line after which they were, so that the function around the removal still counts as changed.
 */
export function parseUnifiedDiff(text: string): Map<string, LineRange[]> {
  const result = new Map<string, LineRange[]>();
  let current: LineRange[] | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target === "/dev/null") {
        current = undefined;
      } else {
        const file = target.startsWith("b/") ? target.slice(2) : target;
        current = result.get(file) ?? [];
        result.set(file, current);
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      current.push(count === 0 ? { start: Math.max(start, 1), end: Math.max(start, 1) } : { start, end: start + count - 1 });
    }
  }
  return result;
}

/** The commit to compare with: the one given, else the merge base with the default branch, else HEAD. */
export function resolveBase(cwd: string, base?: string): { base: string; description: string } | undefined {
  if (base) {
    const commit = tryGit(cwd, ["rev-parse", "--verify", `${base}^{commit}`]);
    if (!commit) throw new GitError(`git does not know the base "${base}"`);
    return { base: commit, description: base };
  }
  const head = tryGit(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!head) return undefined;
  for (const candidate of BaseCandidates) {
    const mergeBase = tryGit(cwd, ["merge-base", "HEAD", candidate]);
    if (mergeBase && mergeBase !== head) return { base: mergeBase, description: `merge-base with ${candidate}` };
    if (mergeBase) break;
  }
  return { base: head, description: "HEAD (uncommitted changes)" };
}

/** What changed under `root` against the base; paths are relative to `root` with forward slashes. */
export function changes(root: string, base?: string): Changes {
  const top = tryGit(root, ["rev-parse", "--show-toplevel"]);
  if (!top) throw new GitError(`${root} is not inside a git repository, so there is no "changed code"; use the scope "all"`);
  const resolved = resolveBase(top, base);
  const fromTop = (file: string) => path.relative(root, path.join(top, file)).replaceAll("\\", "/");
  const inside = (file: string) => file !== "" && !file.startsWith("../") && !path.isAbsolute(file);
  const files = new Map<string, ChangedFile>();

  if (resolved) {
    const diff = git(top, ["diff", "--unified=0", "--no-color", "--no-ext-diff", "--diff-filter=d", resolved.base, "--"]);
    for (const [file, ranges] of parseUnifiedDiff(diff)) {
      const relative = fromTop(file);
      if (inside(relative)) files.set(relative, { file: relative, ranges });
    }
  }
  for (const file of git(top, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)) {
    const relative = fromTop(file);
    if (inside(relative)) files.set(relative, { file: relative });
  }
  return {
    base: resolved?.base ?? "",
    baseDescription: resolved?.description ?? "no commits yet (every file is new)",
    files: [...files.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)),
  };
}
