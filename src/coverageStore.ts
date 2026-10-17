import * as path from 'path';
import * as vscode from 'vscode';
import { analyzeDart, DartAnalysis } from './dart';
import { changedFiles, churn, headCommit } from './git';
import { History, Snapshot } from './history';
import { FileCoverage, globToRegExp, isExcluded, mergeFileCoverage, parseLcov, percent } from './lcov';
import { Mutant } from './dart';

export interface PackageInfo {
  /** Absolute path of the folder holding pubspec.yaml. */
  root: string;
  name: string;
  isFlutter: boolean;
  folder: vscode.WorkspaceFolder;
  /** Package-relative paths of every `*_test.dart` file. */
  testFiles: string[];
  /** Package-relative paths of every Dart file under lib/. */
  sourceFiles: string[];
  hasReport: boolean;
}

export interface ResolvedFileCoverage extends FileCoverage {
  uri: vscode.Uri;
  /** Path relative to the workspace folder, forward slashes. */
  relativePath: string;
  workspaceFolder: vscode.WorkspaceFolder;
  package?: PackageInfo;
  /** Path relative to the package root, e.g. `lib/src/a.dart`. */
  packagePath?: string;
  /** True for lib/ files that no test imports; linesFound is then an estimate. */
  untested?: boolean;
}

export interface CoverageTotals {
  linesFound: number;
  linesHit: number;
}

export interface RiskEntry {
  file: ResolvedFileCoverage;
  score: number;
  complexity: number;
  changes: number;
}

export interface WeakSpot extends Mutant {
  /** The source line before mutation, trimmed, for display. */
  code: string;
}

const EXCLUDE_DIRS = '{**/node_modules/**,**/.dart_tool/**,**/build/**,**/.symlinks/**,**/ephemeral/**,**/.fvm/**}';

/**
 * Loads every lcov report in the workspace and everything derived from it: untested
 * files, trends vs the previous run, risk scores, git-changed files and weak spots.
 */
export class CoverageStore implements vscode.Disposable {
  private files = new Map<string, ResolvedFileCoverage>();
  private reports: vscode.Uri[] = [];
  private packageList: PackageInfo[] = [];
  private lastLoaded: Date | undefined;
  private analysisCache = new Map<string, { mtime: number; analysis: DartAnalysis }>();
  private trendByKey = new Map<string, number>();
  private totalTrend: number | undefined;
  private risk: RiskEntry[] = [];
  private changed: Set<string> | undefined;
  private gitOk = false;
  private weak = new Map<string, WeakSpot[]>();
  private loading: Promise<void> | undefined;
  private reloadRequested = false;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly snapshotEmitter = new vscode.EventEmitter<{ previous?: Snapshot; next: Snapshot }>();
  /** Fires when a new test run was recorded (not on plain reloads). */
  readonly onDidRecordRun = this.snapshotEmitter.event;

  constructor(
    private readonly output: vscode.OutputChannel,
    readonly history: History,
  ) {}

  get hasData(): boolean {
    return this.reports.length > 0;
  }

  get reportUris(): readonly vscode.Uri[] {
    return this.reports;
  }

  get packages(): readonly PackageInfo[] {
    return this.packageList;
  }

  get loadedAt(): Date | undefined {
    return this.lastLoaded;
  }

  get gitAvailable(): boolean {
    return this.gitOk;
  }

  get changedFiles(): Set<string> | undefined {
    return this.changed;
  }

  get riskiest(): readonly RiskEntry[] {
    return this.risk;
  }

  get totalTrendDelta(): number | undefined {
    return this.totalTrend;
  }

  all(): ResolvedFileCoverage[] {
    return [...this.files.values()];
  }

  tested(): ResolvedFileCoverage[] {
    return this.all().filter((f) => !f.untested);
  }

  untested(): ResolvedFileCoverage[] {
    return this.all().filter((f) => f.untested);
  }

  get(uri: vscode.Uri): ResolvedFileCoverage | undefined {
    return this.files.get(uriKey(uri));
  }

  trend(file: ResolvedFileCoverage): number | undefined {
    return this.trendByKey.get(snapshotKey(file));
  }

  weakSpots(uri: vscode.Uri): WeakSpot[] {
    return this.weak.get(uriKey(uri)) ?? [];
  }

  setWeakSpots(uri: vscode.Uri, spots: WeakSpot[]): void {
    this.weak.set(uriKey(uri), spots);
    this.emitter.fire();
  }

  isChanged(file: ResolvedFileCoverage): boolean {
    return !!this.changed && this.changed.has(path.resolve(file.uri.fsPath));
  }

  packageFor(uri: vscode.Uri): PackageInfo | undefined {
    const p = uri.fsPath;
    return this.packageList
      .filter((pkg) => p === pkg.root || p.startsWith(pkg.root + path.sep))
      .sort((a, b) => b.root.length - a.root.length)[0];
  }

  totals(includeUntested = includeUntestedSetting()): CoverageTotals {
    let linesFound = 0;
    let linesHit = 0;
    for (const f of this.files.values()) {
      if (f.untested && !includeUntested) {
        continue;
      }
      linesFound += f.linesFound;
      linesHit += f.linesHit;
    }
    return { linesFound, linesHit };
  }

  async analysis(uri: vscode.Uri): Promise<DartAnalysis | undefined> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const key = uriKey(uri);
      const cached = this.analysisCache.get(key);
      if (cached && cached.mtime === stat.mtime) {
        return cached.analysis;
      }
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      const analysis = analyzeDart(text);
      this.analysisCache.set(key, { mtime: stat.mtime, analysis });
      return analysis;
    } catch {
      return undefined;
    }
  }

  clear(): void {
    this.files.clear();
    this.reports = [];
    this.lastLoaded = undefined;
    this.weak.clear();
    this.risk = [];
    void vscode.commands.executeCommand('setContext', 'dartboard.hasCoverage', false);
    this.emitter.fire();
  }

  /** Loads (or reloads) everything. Concurrent calls are coalesced into one extra reload. */
  load(): Promise<void> {
    if (this.loading) {
      this.reloadRequested = true;
      return this.loading;
    }
    this.loading = (async () => {
      do {
        this.reloadRequested = false;
        try {
          await this.loadOnce();
        } catch (err) {
          this.output.appendLine(`Load failed: ${String(err)}`);
        }
      } while (this.reloadRequested);
      this.loading = undefined;
    })();
    return this.loading;
  }

  private async loadOnce(): Promise<void> {
    const config = vscode.workspace.getConfiguration('dartboard');
    const lcovGlob = config.get<string>('lcovGlob', '**/coverage/lcov.info');
    const excludePatterns = config.get<string[]>('exclude', []).map(globToRegExp);

    const packages = await this.findPackages();
    const next = new Map<string, ResolvedFileCoverage>();
    const reports: vscode.Uri[] = [];
    let signature = '';

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, lcovGlob), EXCLUDE_DIRS);
      for (const reportUri of found) {
        try {
          const [bytes, stat] = await Promise.all([
            vscode.workspace.fs.readFile(reportUri),
            vscode.workspace.fs.stat(reportUri),
          ]);
          signature += `${reportUri.fsPath}@${stat.mtime};`;
          const parsed = parseLcov(Buffer.from(bytes).toString('utf8'));
          // Coverage from integration tests on a device is kept next to it and added on top.
          const integration = vscode.Uri.file(path.join(path.dirname(reportUri.fsPath), 'integration_lcov.info'));
          if (config.get<boolean>('includeIntegrationCoverage', true)) {
            try {
              const extra = parseLcov(Buffer.from(await vscode.workspace.fs.readFile(integration)).toString('utf8'));
              signature += `${integration.fsPath};`;
              for (const [sf, fc] of extra) {
                const existing = parsed.get(sf);
                parsed.set(sf, existing ? mergeFileCoverage(existing, fc) : fc);
              }
            } catch {
              // No integration coverage.
            }
          }
          // Flutter writes SF paths relative to the package root, which is the parent of coverage/.
          const packageRoot = path.dirname(path.dirname(reportUri.fsPath));
          const pkg = packages.find((p) => p.root === path.resolve(packageRoot));
          if (pkg) {
            pkg.hasReport = true;
          }
          let count = 0;
          for (const fc of parsed.values()) {
            const absolute = path.isAbsolute(fc.sourcePath) ? fc.sourcePath : path.resolve(packageRoot, fc.sourcePath);
            const uri = vscode.Uri.file(absolute);
            const relativePath = toPosix(path.relative(folder.uri.fsPath, absolute));
            if (isExcluded(relativePath, excludePatterns)) {
              continue;
            }
            const k = uriKey(uri);
            const existing = next.get(k);
            const merged = existing ? mergeFileCoverage(existing, fc) : fc;
            next.set(k, {
              ...merged,
              uri,
              relativePath,
              workspaceFolder: folder,
              package: pkg,
              packagePath: pkg ? toPosix(path.relative(pkg.root, absolute)) : undefined,
            });
            count++;
          }
          reports.push(reportUri);
          this.output.appendLine(`Loaded ${count} file(s) from ${reportUri.fsPath}`);
        } catch (err) {
          this.output.appendLine(`Failed to read ${reportUri.fsPath}: ${String(err)}`);
        }
      }
    }

    // lib/ files that no test imported never show up in lcov. Add them at 0% so the total is honest.
    if (vscode.workspace.getConfiguration('dartboard').get<boolean>('showUntestedFiles', true)) {
      for (const pkg of packages.filter((p) => p.hasReport)) {
        for (const rel of pkg.sourceFiles) {
          const absolute = path.join(pkg.root, rel);
          const uri = vscode.Uri.file(absolute);
          const k = uriKey(uri);
          const relativePath = toPosix(path.relative(pkg.folder.uri.fsPath, absolute));
          if (next.has(k) || isExcluded(relativePath, excludePatterns)) {
            continue;
          }
          const analysis = await this.analysis(uri);
          if (!analysis || analysis.executableLines === 0) {
            continue;
          }
          next.set(k, {
            sourcePath: rel,
            lines: new Map(),
            linesFound: analysis.executableLines,
            linesHit: 0,
            functionsFound: 0,
            functionsHit: 0,
            branchesFound: 0,
            branchesHit: 0,
            uri,
            relativePath,
            workspaceFolder: pkg.folder,
            package: pkg,
            packagePath: rel,
            untested: true,
          });
        }
      }
    }

    this.files = next;
    this.reports = reports;
    this.packageList = packages;
    this.lastLoaded = reports.length ? new Date() : undefined;
    // Weak spots are tied to the code at the time of the check; drop them for files that changed.
    for (const key of [...this.weak.keys()]) {
      if (!next.has(key)) {
        this.weak.delete(key);
      }
    }
    void vscode.commands.executeCommand('setContext', 'dartboard.hasCoverage', this.hasData);

    if (reports.length) {
      await this.updateHistory(signature);
    } else {
      this.trendByKey.clear();
      this.totalTrend = undefined;
    }
    this.emitter.fire();

    // Git-based extras are optional and slower; fill them in afterwards.
    void this.updateGitAndRisk();
  }

  private async findPackages(): Promise<PackageInfo[]> {
    const result: PackageInfo[] = [];
    const pubspecs = await vscode.workspace.findFiles('**/pubspec.yaml', EXCLUDE_DIRS);
    for (const pubspec of pubspecs) {
      const folder = vscode.workspace.getWorkspaceFolder(pubspec);
      if (!folder) {
        continue;
      }
      const root = path.resolve(path.dirname(pubspec.fsPath));
      let name = path.basename(root);
      let isFlutter = false;
      try {
        const text = Buffer.from(await vscode.workspace.fs.readFile(pubspec)).toString('utf8');
        name = /^name:\s*([\w]+)/m.exec(text)?.[1] ?? name;
        isFlutter = /sdk:\s*flutter/.test(text);
      } catch {
        // Keep defaults.
      }
      const rootUri = vscode.Uri.file(root);
      const [tests, sources] = await Promise.all([
        vscode.workspace.findFiles(new vscode.RelativePattern(rootUri, 'test/**/*_test.dart'), EXCLUDE_DIRS),
        vscode.workspace.findFiles(new vscode.RelativePattern(rootUri, 'lib/**/*.dart'), EXCLUDE_DIRS),
      ]);
      const rel = (u: vscode.Uri) => toPosix(path.relative(root, u.fsPath));
      result.push({
        root,
        name,
        isFlutter,
        folder,
        // Skip Dartboard's temporary wrapper files (screen sizes, filmstrip).
        testFiles: tests.map(rel).filter((r) => !/(^|\/)dartboard_(matrix|filmstrip)__/.test(r)).sort(),
        sourceFiles: sources.map(rel).filter((r) => !r.split('/').includes('.dart_tool')).sort(),
        hasReport: false,
      });
    }
    return result;
  }

  private async updateHistory(signature: string): Promise<void> {
    const files: Record<string, [number, number]> = {};
    for (const f of this.files.values()) {
      files[snapshotKey(f)] = [f.linesHit, f.linesFound];
    }
    const totals = this.totals();
    const folder = vscode.workspace.workspaceFolders?.[0];
    const commit = folder ? await headCommit(folder.uri.fsPath) : undefined;
    const snapshot: Snapshot = { time: Date.now(), commit, found: totals.linesFound, hit: totals.linesHit, files };
    const before = this.history.latest();
    const recorded = await this.history.record(signature, snapshot);
    if (recorded) {
      this.snapshotEmitter.fire({ previous: before, next: snapshot });
    }

    const previous = this.history.previous();
    this.trendByKey.clear();
    this.totalTrend = undefined;
    if (previous?.files) {
      for (const f of this.files.values()) {
        const prev = previous.files[snapshotKey(f)];
        const now = percent(f.linesHit, f.linesFound);
        const then = prev ? percent(prev[0], prev[1]) : undefined;
        if (now !== undefined && then !== undefined && Math.abs(now - then) >= 0.05) {
          this.trendByKey.set(snapshotKey(f), now - then);
        }
      }
      const now = percent(totals.linesHit, totals.linesFound);
      const then = percent(previous.hit, previous.found);
      if (now !== undefined && then !== undefined) {
        this.totalTrend = now - then;
      }
    }
  }

  private async updateGitAndRisk(): Promise<void> {
    const roots = [...new Set(this.packageList.map((p) => p.root))];
    const fallback = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    let changed: Set<string> | undefined;
    const churnMap = new Map<string, number>();
    let ok = false;
    for (const root of roots.length ? roots : fallback) {
      const c = await changedFiles(root);
      if (c) {
        ok = true;
        changed = changed ?? new Set();
        c.forEach((f) => changed!.add(f));
      }
      const ch = await churn(root);
      ch?.forEach((n, f) => churnMap.set(f, Math.max(churnMap.get(f) ?? 0, n)));
    }
    this.gitOk = ok;
    this.changed = changed;
    void vscode.commands.executeCommand('setContext', 'dartboard.gitAvailable', ok);

    const entries: RiskEntry[] = [];
    for (const file of this.files.values()) {
      const pct = percent(file.linesHit, file.linesFound);
      if (pct === undefined || pct >= 100 || file.linesFound < 5) {
        continue;
      }
      const analysis = await this.analysis(file.uri);
      const complexity = analysis?.complexity ?? 1;
      const changes = churnMap.get(path.resolve(file.uri.fsPath)) ?? 0;
      const score = (1 - pct / 100) * Math.log2(1 + complexity) * (1 + Math.log2(1 + changes));
      entries.push({ file, score, complexity, changes });
    }
    entries.sort((a, b) => b.score - a.score);
    this.risk = entries.slice(0, 5);
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
    this.snapshotEmitter.dispose();
  }
}

export function includeUntestedSetting(): boolean {
  return vscode.workspace.getConfiguration('dartboard').get<boolean>('includeUntestedInTotal', true);
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function snapshotKey(file: ResolvedFileCoverage): string {
  return `${file.workspaceFolder.name}/${file.relativePath}`;
}

export function uriKey(uri: vscode.Uri): string {
  // Windows and default macOS file systems are case-insensitive; normalize so editor URIs and lcov paths match.
  const s = uri.with({ fragment: '', query: '' }).toString();
  return process.platform === 'win32' || process.platform === 'darwin' ? s.toLowerCase() : s;
}
