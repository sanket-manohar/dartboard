import { execFile } from 'child_process';
import * as path from 'path';

/** Thin wrapper over the git CLI. Every call fails soft: no git, no repo, or a timeout all return undefined. */
function git(cwd: string, args: string[], timeout = 8000): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile('git', args, { cwd, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        resolve(err ? undefined : stdout.toString());
      });
    } catch {
      resolve(undefined);
    }
  });
}

export async function gitRoot(cwd: string): Promise<string | undefined> {
  const out = await git(cwd, ['rev-parse', '--show-toplevel']);
  return out ? path.resolve(out.trim()) : undefined;
}

export async function headCommit(cwd: string): Promise<string | undefined> {
  const out = await git(cwd, ['rev-parse', '--short', 'HEAD']);
  return out?.trim() || undefined;
}

/** Files changed on this branch (vs main/master), including uncommitted and untracked files. Absolute paths. */
export async function changedFiles(cwd: string): Promise<Set<string> | undefined> {
  const root = await gitRoot(cwd);
  if (!root) {
    return undefined;
  }
  let base: string | undefined;
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master', 'origin/develop', 'develop']) {
    if (await git(root, ['rev-parse', '--verify', '--quiet', candidate])) {
      const mb = await git(root, ['merge-base', 'HEAD', candidate]);
      const head = await git(root, ['rev-parse', 'HEAD']);
      // On the base branch itself the merge-base is HEAD; fall back to uncommitted changes only.
      if (mb && head && mb.trim() !== head.trim()) {
        base = mb.trim();
      }
      break;
    }
  }
  const diff = await git(root, ['diff', '--name-only', base ?? 'HEAD']);
  const untracked = await git(root, ['ls-files', '--others', '--exclude-standard']);
  if (diff === undefined) {
    return undefined;
  }
  const result = new Set<string>();
  for (const line of `${diff}\n${untracked ?? ''}`.split('\n')) {
    if (line.trim()) {
      result.add(path.resolve(root, line.trim()));
    }
  }
  return result;
}

/** How many commits touched each file in the last six months. Absolute paths. */
export async function churn(cwd: string): Promise<Map<string, number> | undefined> {
  const root = await gitRoot(cwd);
  if (!root) {
    return undefined;
  }
  const out = await git(root, ['log', '--since=6.months', '--name-only', '--pretty=format:', '--', '*.dart'], 15000);
  if (out === undefined) {
    return undefined;
  }
  const counts = new Map<string, number>();
  for (const line of out.split('\n')) {
    const f = line.trim();
    if (f) {
      const abs = path.resolve(root, f);
      counts.set(abs, (counts.get(abs) ?? 0) + 1);
    }
  }
  return counts;
}
