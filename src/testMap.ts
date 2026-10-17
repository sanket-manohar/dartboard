import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CoverageStore, PackageInfo } from './coverageStore';
import { parseLcov } from './lcov';
import { runFlutter } from './runner';

interface StoredMap {
  createdAt: number;
  /** absolute source path -> line -> package-relative test paths */
  files: Record<string, Record<string, string[]>>;
  /** test path -> package root, so a test can be opened or re-run */
  tests: Record<string, string>;
}

/**
 * Answers "which tests cover this line?" by running each test file on its own with
 * coverage once, then remembering which lines each test touched.
 */
export class TestMap {
  private data: StoredMap | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: CoverageStore,
    private readonly output: vscode.OutputChannel,
  ) {
    this.data = this.read();
  }

  get available(): boolean {
    return !!this.data;
  }

  get createdAt(): Date | undefined {
    return this.data ? new Date(this.data.createdAt) : undefined;
  }

  testsFor(uri: vscode.Uri, line: number): Array<{ test: string; root: string }> {
    const tests = this.data?.files[path.resolve(uri.fsPath)]?.[String(line)] ?? [];
    return tests.map((t) => ({ test: t.split('::')[1] ?? t, root: this.data!.tests[t] }));
  }

  private get file(): string | undefined {
    return this.context.storageUri ? path.join(this.context.storageUri.fsPath, 'test-map.json') : undefined;
  }

  private read(): StoredMap | undefined {
    try {
      return this.file && fs.existsSync(this.file) ? (JSON.parse(fs.readFileSync(this.file, 'utf8')) as StoredMap) : undefined;
    } catch {
      return undefined;
    }
  }

  async build(): Promise<void> {
    const packages = this.store.packages.filter((p) => p.testFiles.length > 0);
    if (packages.length === 0) {
      void vscode.window.showInformationMessage('No *_test.dart files found in this workspace.');
      return;
    }
    const total = packages.reduce((n, p) => n + p.testFiles.length, 0);
    const go = 'Map tests';
    const pick = await vscode.window.showInformationMessage(
      `Find out which tests cover which lines? This runs each of your ${total} test files on its own once, so it takes a while. Afterwards, hover over any green line to see its tests.`,
      { modal: true },
      go,
    );
    if (pick !== go) {
      return;
    }
    const result: StoredMap = { createdAt: Date.now(), files: {}, tests: {} };
    let done = 0;
    let cancelled = false;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Mapping tests to lines', cancellable: true },
      async (progress, token) => {
        for (const pkg of packages) {
          for (const test of pkg.testFiles) {
            if (token.isCancellationRequested) {
              cancelled = true;
              return;
            }
            progress.report({ message: `${++done}/${total}: ${test}`, increment: 100 / total });
            await this.mapOne(pkg, test, result, token);
          }
        }
      },
    );
    if (cancelled) {
      void vscode.window.showInformationMessage('Test mapping cancelled; the previous map (if any) is kept.');
      return;
    }
    this.data = result;
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(result));
    }
    void vscode.window.showInformationMessage('Done. Hover over a green line to see which tests cover it.');
  }

  private async mapOne(pkg: PackageInfo, test: string, result: StoredMap, token: vscode.CancellationToken): Promise<void> {
    const outRel = 'coverage/.pertest_lcov.info';
    const outAbs = path.join(pkg.root, outRel);
    await runFlutter(['test', '--coverage', `--coverage-path=${outRel}`, test], pkg.root, this.output, { token, quiet: true });
    try {
      if (!fs.existsSync(outAbs)) {
        return;
      }
      const key = `${pkg.root}::${test}`;
      result.tests[key] = pkg.root;
      for (const [sf, cov] of parseLcov(fs.readFileSync(outAbs, 'utf8'))) {
        const abs = path.isAbsolute(sf) ? sf : path.resolve(pkg.root, sf);
        const fileMap = (result.files[abs] ??= {});
        for (const [line, hits] of cov.lines) {
          if (hits > 0) {
            (fileMap[String(line)] ??= []).push(key);
          }
        }
      }
    } finally {
      try {
        fs.unlinkSync(outAbs);
      } catch {
        // Nothing to clean up.
      }
    }
  }

  async clear(): Promise<void> {
    this.data = undefined;
    if (this.file && fs.existsSync(this.file)) {
      fs.unlinkSync(this.file);
    }
  }
}
