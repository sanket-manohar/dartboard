/**
 * Import graph of a Dart package, used to answer "which tests can break if these files
 * change?". Works on package-relative paths (`lib/a.dart`, `test/a_test.dart`). Pure.
 */
import * as path from 'path';

/** Package-relative paths this file imports, exports or includes as a part. */
export function directDependencies(text: string, fileRel: string, packageName: string): string[] {
  const deps: string[] = [];
  const re = /^\s*(?:import|export|part(?!\s+of))\s+(['"])([^'"]+)\1/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const uri = m[2];
    if (uri.startsWith('dart:')) {
      continue;
    }
    if (uri.startsWith('package:')) {
      const [pkg, ...rest] = uri.slice('package:'.length).split('/');
      if (pkg === packageName) {
        deps.push(`lib/${rest.join('/')}`);
      }
      continue;
    }
    deps.push(path.posix.normalize(path.posix.join(path.posix.dirname(fileRel), uri)));
  }
  // A `part of` file belongs to its library: changing it affects whoever imports the library.
  const partOf = /^\s*part\s+of\s+(['"])([^'"]+)\1/m.exec(text);
  if (partOf) {
    deps.push(path.posix.normalize(path.posix.join(path.posix.dirname(fileRel), partOf[2])));
  }
  return deps;
}

export class ImportGraph {
  /** file -> files that depend on it. */
  private readonly dependents = new Map<string, Set<string>>();

  constructor(files: Array<{ path: string; text: string }>, packageName: string) {
    for (const f of files) {
      for (const dep of directDependencies(f.text, f.path, packageName)) {
        let set = this.dependents.get(dep);
        if (!set) {
          set = new Set();
          this.dependents.set(dep, set);
        }
        set.add(f.path);
      }
    }
  }

  /** Every file that directly or indirectly depends on one of `changed` (including them). */
  affected(changed: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const queue = [...changed];
    while (queue.length) {
      const f = queue.pop()!;
      if (seen.has(f)) {
        continue;
      }
      seen.add(f);
      for (const d of this.dependents.get(f) ?? []) {
        queue.push(d);
      }
    }
    return seen;
  }

  /** Test files that can be affected by the changed files. */
  affectedTests(changed: Iterable<string>, isTest: (p: string) => boolean): string[] {
    return [...this.affected(changed)].filter(isTest).sort();
  }
}
