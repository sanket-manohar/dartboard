import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CoverageStore, PackageInfo, toPosix } from './coverageStore';
import { generateTestSkeleton } from './dart';
import { testPathForSource, testsForSource } from './paths';
import { TestResultsStore } from './results';
import { runPartialCoverage } from './runner';

/** Test files (package-relative) that exercise a source file, or the file itself for a test. */
export function relatedTests(pkg: PackageInfo, uri: vscode.Uri): string[] {
  const rel = toPosix(path.relative(pkg.root, uri.fsPath));
  if (rel.startsWith('test/') && rel.endsWith('_test.dart')) {
    return [rel];
  }
  if (!rel.startsWith('lib/')) {
    return [];
  }
  return testsForSource(rel, pkg.testFiles);
}

/** Creates `test/.../<name>_test.dart` with stubs for the file's public API and opens it. */
export async function createTestFile(store: CoverageStore, uri: vscode.Uri): Promise<void> {
  const pkg = store.packageFor(uri);
  if (!pkg) {
    void vscode.window.showWarningMessage('This file is not inside a Dart package (no pubspec.yaml found).');
    return;
  }
  const rel = toPosix(path.relative(pkg.root, uri.fsPath));
  if (!rel.startsWith('lib/')) {
    void vscode.window.showWarningMessage('Tests can be created for files under lib/.');
    return;
  }
  const existing = testsForSource(rel, pkg.testFiles);
  if (existing.length) {
    const open = 'Open existing test';
    const pick = await vscode.window.showInformationMessage(
      `${path.basename(rel)} already has a test: ${existing[0]}`,
      open,
      'Create another anyway',
    );
    if (pick === open) {
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(pkg.root, existing[0])));
      return;
    }
    if (!pick) {
      return;
    }
  }
  const analysis = await store.analysis(uri);
  const content = generateTestSkeleton(pkg.name, rel.slice('lib/'.length), pkg.isFlutter, analysis?.symbols ?? []);
  let target = testPathForSource(rel);
  let n = 2;
  while (fs.existsSync(path.join(pkg.root, target))) {
    target = target.replace(/(_\d+)?_test\.dart$/, `_${n++}_test.dart`);
  }
  const targetUri = vscode.Uri.file(path.join(pkg.root, target));
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(targetUri.fsPath)));
  await vscode.workspace.fs.writeFile(targetUri, Buffer.from(content, 'utf8'));
  pkg.testFiles.push(target);
  const doc = await vscode.workspace.openTextDocument(targetUri);
  const editor = await vscode.window.showTextDocument(doc);
  const todo = content.split('\n').findIndex((l) => l.includes('TODO'));
  if (todo >= 0) {
    const pos = new vscode.Position(todo, content.split('\n')[todo].length);
    editor.selection = new vscode.Selection(pos, pos);
  }
  void vscode.window.setStatusBarMessage(`$(new-file) Created ${target}`, 4000);
}

/**
 * Runs the tests for one file or folder with coverage, in the background, and merges the
 * result into the existing report. Queued so saves in quick succession don't overlap.
 */
export class PartialRunner implements vscode.Disposable {
  private running = false;
  private queued: { uri: vscode.Uri; quiet: boolean } | undefined;
  private readonly status: vscode.StatusBarItem;

  constructor(
    private readonly store: CoverageStore,
    private readonly output: vscode.OutputChannel,
    private readonly results?: TestResultsStore,
  ) {
    this.status = vscode.window.createStatusBarItem('dartboard.partial', vscode.StatusBarAlignment.Right, 101);
    this.status.name = 'Dartboard: updating';
  }

  /** Runs specific test files of a package with coverage (used by "run affected tests"). */
  async runTests(pkg: PackageInfo, tests: string[], label: string): Promise<void> {
    if (this.running) {
      void vscode.window.showInformationMessage('Tests are already running. Try again when they finish.');
      return;
    }
    this.running = true;
    this.status.text = `$(sync~spin) ${label}`;
    this.status.show();
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: label, cancellable: true },
        (_p, token) => runPartialCoverage(pkg, tests, this.output, token, this.results),
      );
      await this.store.load();
      if (result.code !== 0 && !result.cancelled) {
        void vscode.window.showWarningMessage('Some tests failed. See the Tests tab in Dartboard.', 'Show').then((p) => p && vscode.commands.executeCommand('dartboard.showTab', 'tests'));
      }
    } finally {
      this.running = false;
      this.status.hide();
    }
  }

  /** Returns false when there were no tests to run. */
  async run(uri: vscode.Uri, quiet = false): Promise<boolean> {
    const pkg = this.store.packageFor(uri);
    if (!pkg) {
      if (!quiet) {
        void vscode.window.showWarningMessage('This file is not inside a Dart package.');
      }
      return false;
    }
    const rel = toPosix(path.relative(pkg.root, uri.fsPath));
    let targets: string[];
    let isDir = false;
    try {
      isDir = (await vscode.workspace.fs.stat(uri)).type === vscode.FileType.Directory;
    } catch {
      isDir = false;
    }
    if (isDir) {
      // lib/features/auth -> tests for every file in it; test/features -> that folder.
      if (rel.startsWith('test')) {
        targets = [rel || 'test'];
      } else {
        const prefix = rel ? rel + '/' : '';
        const set = new Set<string>();
        pkg.sourceFiles.filter((s) => s.startsWith(prefix)).forEach((s) => testsForSource(s, pkg.testFiles).forEach((t) => set.add(t)));
        targets = [...set];
      }
    } else {
      targets = relatedTests(pkg, uri);
    }
    if (targets.length === 0) {
      if (!quiet) {
        const create = 'Create test';
        const pick = await vscode.window.showInformationMessage(`No tests found for ${path.basename(uri.fsPath)}.`, create);
        if (pick === create && !isDir) {
          await createTestFile(this.store, uri);
        }
      }
      return false;
    }
    if (this.running) {
      this.queued = { uri, quiet };
      return true;
    }
    this.running = true;
    this.status.text = `$(sync~spin) Coverage: ${path.basename(uri.fsPath)}`;
    this.status.tooltip = `Running ${targets.length} test file(s) with coverage`;
    this.status.show();
    try {
      const result = await runPartialCoverage(pkg, targets, this.output, undefined, this.results);
      if (result.code !== 0 && !quiet) {
        void vscode.window.showWarningMessage(
          'Some tests failed. Coverage was still updated where possible.',
          'Show failures',
        ).then((pick) => pick && vscode.commands.executeCommand('dartboard.showTab', 'tests'));
      }
      await this.store.load();
    } finally {
      this.running = false;
      this.status.hide();
    }
    const next = this.queued;
    this.queued = undefined;
    if (next) {
      void this.run(next.uri, next.quiet);
    }
    return true;
  }

  dispose(): void {
    this.status.dispose();
  }
}
