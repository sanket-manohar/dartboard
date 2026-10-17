import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Failure, parseTestEvents, RunResults, TestResult } from './testEvents';

export interface MatrixRun {
  /** Absolute path of the test file the matrix ran. */
  suite: string;
  configs: string[];
  rows: Array<{ test: string; cells: Record<string, { status: TestResult['status']; failure?: Failure }> }>;
  time: number;
}

/** Folder (inside the package) where Dartboard asks flutter test to write its JSON results. */
export const RESULTS_DIR = path.join('.dart_tool', 'dartboard');

/**
 * Remembers the latest result of every test (merged across full and partial runs), shows
 * failures as problems in the test files, and keeps durations from the previous run so
 * slow tests that got slower stand out.
 */
export class TestResultsStore implements vscode.Disposable {
  private tests = new Map<string, TestResult>();
  private loadErrors = new Map<string, Failure>();
  private previousDurations: Record<string, number>;
  private matrixRun: MatrixRun | undefined;
  private lastRunAt: number | undefined;
  private lastRunMs = 0;
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('Dartboard tests');
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly state: vscode.Memento) {
    this.previousDurations = state.get<Record<string, number>>('dartboard.durations', {});
  }

  static fileFor(root: string, name: string): string {
    const dir = path.join(root, RESULTS_DIR);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, name);
  }

  get all(): TestResult[] {
    return [...this.tests.values()];
  }

  get failed(): TestResult[] {
    return this.all.filter((t) => t.status === 'failed');
  }

  get brokenSuites(): Array<{ suite: string; failure: Failure }> {
    return [...this.loadErrors.entries()].map(([suite, failure]) => ({ suite, failure }));
  }

  get matrix(): MatrixRun | undefined {
    return this.matrixRun;
  }

  get hasResults(): boolean {
    return this.tests.size > 0 || this.loadErrors.size > 0;
  }

  get summary(): { passed: number; failed: number; skipped: number; durationMs: number; at?: number } {
    let passed = 0;
    let failed = this.loadErrors.size;
    let skipped = 0;
    for (const t of this.tests.values()) {
      if (t.status === 'passed') {
        passed++;
      } else if (t.status === 'failed') {
        failed++;
      } else {
        skipped++;
      }
    }
    return { passed, failed, skipped, durationMs: this.lastRunMs, at: this.lastRunAt };
  }

  /** Change in duration since the previous run, in ms. */
  slowerBy(t: TestResult): number | undefined {
    const before = this.previousDurations[key(t)];
    return before === undefined ? undefined : t.durationMs - before;
  }

  slowest(limit = 10): TestResult[] {
    return this.all
      .filter((t) => t.status !== 'skipped')
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, limit);
  }

  /** Reads a JSON reporter file. Suites in it replace what we had for them. */
  ingest(file: string): RunResults | undefined {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
    const run = parseTestEvents(text);
    const suites = new Set([...run.tests.map((t) => t.suite), ...run.loadErrors.map((e) => e.suite)]);
    // Remember durations of tests we're about to replace.
    const durations: Record<string, number> = { ...this.previousDurations };
    for (const [k, t] of this.tests) {
      if (suites.has(t.suite)) {
        durations[key(t)] = t.durationMs;
        this.tests.delete(k);
      }
    }
    for (const s of suites) {
      this.loadErrors.delete(s);
    }
    for (const t of run.tests) {
      this.tests.set(key(t), t);
    }
    for (const e of run.loadErrors) {
      this.loadErrors.set(e.suite, e.failure);
    }
    this.previousDurations = durations;
    void this.state.update('dartboard.durations', durations);
    this.lastRunAt = Date.now();
    this.lastRunMs = run.durationMs;
    this.updateDiagnostics();
    this.emitter.fire();
    return run;
  }

  /** Loads results left by earlier runs so the panel isn't empty after a reload. */
  restore(roots: string[]): void {
    for (const root of roots) {
      const file = path.join(root, RESULTS_DIR, 'last_run.json');
      if (fs.existsSync(file)) {
        this.ingest(file);
      }
    }
  }

  setMatrix(run: MatrixRun): void {
    this.matrixRun = run;
    this.emitter.fire();
  }

  clear(): void {
    this.tests.clear();
    this.loadErrors.clear();
    this.matrixRun = undefined;
    this.diagnostics.clear();
    this.emitter.fire();
  }

  private updateDiagnostics(): void {
    this.diagnostics.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    const add = (file: string, line: number, message: string) => {
      const list = byFile.get(file) ?? [];
      const d = new vscode.Diagnostic(new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 1000), message, vscode.DiagnosticSeverity.Error);
      d.source = 'Dartboard';
      list.push(d);
      byFile.set(file, list);
    };
    for (const t of this.failed) {
      const loc = t.failure?.location ?? t.location;
      if (loc && t.failure) {
        add(loc.file, loc.line, `Test failed: ${t.failure.title}${t.failure.hint ? `\n${t.failure.hint}` : ''}`);
      }
    }
    for (const [suite, f] of this.loadErrors) {
      add(f.location?.file ?? suite, f.location?.line ?? 1, `Test file failed to load: ${f.title}`);
    }
    for (const [file, list] of byFile) {
      this.diagnostics.set(vscode.Uri.file(file), list);
    }
  }

  dispose(): void {
    this.diagnostics.dispose();
    this.emitter.dispose();
  }
}

function key(t: TestResult): string {
  return `${t.suite}::${t.name}`;
}
