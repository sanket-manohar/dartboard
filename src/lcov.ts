/**
 * Pure lcov parser and helpers. No `vscode` import so it can be unit tested with plain Node.
 */

export interface FileCoverage {
  /** Source path exactly as written in the `SF:` record. */
  sourcePath: string;
  /** Line number (1-based) -> hit count. */
  lines: Map<number, number>;
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
  branchesFound: number;
  branchesHit: number;
  /** `line,block,branch` -> times taken, from BRDA records (only with --branch-coverage). */
  branchData?: Map<string, number>;
}

export function emptyFileCoverage(sourcePath: string): FileCoverage {
  return {
    sourcePath,
    lines: new Map(),
    linesFound: 0,
    linesHit: 0,
    functionsFound: 0,
    functionsHit: 0,
    branchesFound: 0,
    branchesHit: 0,
  };
}

/**
 * Parses the text of an lcov.info file. Records for the same source file are merged
 * (hit counts are summed), which also makes merging several reports straightforward.
 */
export function parseLcov(text: string): Map<string, FileCoverage> {
  const result = new Map<string, FileCoverage>();
  let current: FileCoverage | undefined;
  let sawLF = false;
  let sawLH = false;

  const finish = () => {
    if (!current) {
      return;
    }
    // Always derive line totals from DA records when present; LF/LH are only a fallback.
    if (current.lines.size > 0 || !sawLF) {
      current.linesFound = current.lines.size;
    }
    if (current.lines.size > 0 || !sawLH) {
      let hit = 0;
      for (const count of current.lines.values()) {
        if (count > 0) {
          hit++;
        }
      }
      current.linesHit = hit;
    }
    if (current.branchData?.size) {
      current.branchesFound = current.branchData.size;
      current.branchesHit = [...current.branchData.values()].filter((n) => n > 0).length;
    }
    const existing = result.get(current.sourcePath);
    result.set(current.sourcePath, existing ? mergeFileCoverage(existing, current) : current);
    current = undefined;
    sawLF = false;
    sawLH = false;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line === 'end_of_record') {
      finish();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) {
      continue;
    }
    const tag = line.substring(0, colon);
    const value = line.substring(colon + 1);

    if (tag === 'SF') {
      finish();
      current = emptyFileCoverage(value.trim());
      continue;
    }
    if (!current) {
      continue;
    }
    switch (tag) {
      case 'DA': {
        const [lineNo, hits] = value.split(',');
        const n = parseInt(lineNo, 10);
        const h = parseInt(hits, 10);
        if (Number.isFinite(n) && Number.isFinite(h)) {
          current.lines.set(n, (current.lines.get(n) ?? 0) + h);
        }
        break;
      }
      case 'LF':
        current.linesFound = parseInt(value, 10) || 0;
        sawLF = true;
        break;
      case 'LH':
        current.linesHit = parseInt(value, 10) || 0;
        sawLH = true;
        break;
      case 'FNF':
        current.functionsFound = parseInt(value, 10) || 0;
        break;
      case 'FNH':
        current.functionsHit = parseInt(value, 10) || 0;
        break;
      case 'BRDA': {
        const [lineNo, block, branch, taken] = value.split(',');
        const key = `${parseInt(lineNo, 10)},${block},${branch}`;
        const n = taken === '-' ? 0 : parseInt(taken, 10) || 0;
        current.branchData ??= new Map();
        current.branchData.set(key, (current.branchData.get(key) ?? 0) + n);
        break;
      }
      case 'BRF':
        current.branchesFound = parseInt(value, 10) || 0;
        break;
      case 'BRH':
        current.branchesHit = parseInt(value, 10) || 0;
        break;
      default:
        break;
    }
  }
  // Tolerate a missing trailing end_of_record.
  finish();
  return result;
}

export function mergeFileCoverage(a: FileCoverage, b: FileCoverage): FileCoverage {
  const merged = emptyFileCoverage(a.sourcePath);
  for (const [n, h] of a.lines) {
    merged.lines.set(n, h);
  }
  for (const [n, h] of b.lines) {
    merged.lines.set(n, (merged.lines.get(n) ?? 0) + h);
  }
  if (merged.lines.size > 0) {
    merged.linesFound = merged.lines.size;
    merged.linesHit = [...merged.lines.values()].filter((h) => h > 0).length;
  } else {
    merged.linesFound = Math.max(a.linesFound, b.linesFound);
    merged.linesHit = Math.max(a.linesHit, b.linesHit);
  }
  merged.functionsFound = Math.max(a.functionsFound, b.functionsFound);
  merged.functionsHit = Math.max(a.functionsHit, b.functionsHit);
  merged.branchesFound = Math.max(a.branchesFound, b.branchesFound);
  merged.branchesHit = Math.max(a.branchesHit, b.branchesHit);
  if (a.branchData || b.branchData) {
    merged.branchData = new Map(a.branchData ?? []);
    for (const [k, n] of b.branchData ?? []) {
      merged.branchData.set(k, (merged.branchData.get(k) ?? 0) + n);
    }
    merged.branchesFound = merged.branchData.size;
    merged.branchesHit = [...merged.branchData.values()].filter((n) => n > 0).length;
  }
  return merged;
}

/** Percentage 0..100, or undefined when there is nothing to cover. */
export function percent(hit: number, found: number): number | undefined {
  if (found <= 0) {
    return undefined;
  }
  return (hit / found) * 100;
}

export function formatPercent(value: number | undefined): string {
  if (value === undefined) {
    return 'n/a';
  }
  let rounded = Math.round(value * 10) / 10;
  // Never claim 100% (or 0%) when a line is still missed (or hit).
  if (rounded === 100 && value < 100) {
    rounded = 99.9;
  } else if (rounded === 0 && value > 0) {
    rounded = 0.1;
  }
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

/**
 * Converts a glob (supporting `**`, `*`, `?`, `{a,b}` and `[...]`) into a RegExp
 * that is matched against forward-slash relative paths.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let inGroup = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    switch (c) {
      case '*': {
        if (glob[i + 1] === '*') {
          // `**/` matches zero or more directories; a bare `**` matches anything.
          if (glob[i + 2] === '/') {
            re += '(?:.*/)?';
            i += 2;
          } else {
            re += '.*';
            i += 1;
          }
        } else {
          re += '[^/]*';
        }
        break;
      }
      case '?':
        re += '[^/]';
        break;
      case '{':
        inGroup = true;
        re += '(?:';
        break;
      case '}':
        inGroup = false;
        re += ')';
        break;
      case ',':
        re += inGroup ? '|' : ',';
        break;
      case '[': {
        const close = glob.indexOf(']', i);
        if (close > i) {
          re += glob.substring(i, close + 1);
          i = close;
        } else {
          re += '\\[';
        }
        break;
      }
      default:
        re += c.replace(/[.+^$()|\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function isExcluded(relativePath: string, patterns: RegExp[]): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  return patterns.some((p) => p.test(normalized));
}

/** Writes coverage back out in lcov format: line data plus branch data when present. */
export function serializeLcov(files: Iterable<FileCoverage>): string {
  let out = '';
  for (const f of files) {
    out += `SF:${f.sourcePath}\n`;
    const entries = [...f.lines.entries()].sort((a, b) => a[0] - b[0]);
    for (const [line, hits] of entries) {
      out += `DA:${line},${hits}\n`;
    }
    const found = entries.length || f.linesFound;
    const hit = entries.length ? entries.filter(([, h]) => h > 0).length : f.linesHit;
    out += `LF:${found}\nLH:${hit}\n`;
    if (f.branchData?.size) {
      const branches = [...f.branchData.entries()].sort((x, y) => parseInt(x[0], 10) - parseInt(y[0], 10));
      for (const [key, taken] of branches) {
        out += `BRDA:${key},${taken}\n`;
      }
      out += `BRF:${branches.length}\nBRH:${branches.filter(([, t]) => t > 0).length}\n`;
    }
    out += 'end_of_record\n';
  }
  return out;
}

/**
 * Groups uncovered lines into ranges. Lines without data between two uncovered
 * lines (blank lines, comments, braces) don't break a range; a covered line does.
 */
export function uncoveredRanges(lines: Map<number, number>): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start: number | undefined;
  let end = 0;
  for (const [line, hits] of [...lines.entries()].sort((a, b) => a[0] - b[0])) {
    if (hits === 0) {
      if (start === undefined) {
        start = line;
      }
      end = line;
    } else if (start !== undefined) {
      ranges.push([start, end]);
      start = undefined;
    }
  }
  if (start !== undefined) {
    ranges.push([start, end]);
  }
  return ranges;
}

/**
 * Lines where a code path starts but never ran although the line itself did, e.g. an
 * `if` whose body was never entered. Dart reports a branch at the line its block starts.
 */
export function missedBranchLines(f: FileCoverage): number[] {
  if (!f.branchData) {
    return [];
  }
  const taken = new Map<number, boolean>();
  for (const [key, n] of f.branchData) {
    const line = parseInt(key, 10);
    taken.set(line, (taken.get(line) ?? false) || n > 0);
  }
  return [...taken.entries()]
    .filter(([line, any]) => !any && (f.lines.get(line) ?? 1) > 0)
    .map(([line]) => line)
    .sort((a, b) => a - b);
}
