import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { createTestFile, relatedTests } from './actions';
import { CoverageStore, WeakSpot } from './coverageStore';
import { applyMutant, findMutants } from './dart';
import { runFlutter } from './runner';

const BACKUP = 'mutation-backup.json';

/**
 * "Covered but not tested" check: makes small changes to covered lines one at a time,
 * runs the file's tests, and reports changes that no test noticed. The original file is
 * always restored, and a backup on disk covers crashes mid-check.
 */
export class StrengthChecker {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: CoverageStore,
    private readonly output: vscode.OutputChannel,
  ) {}

  private get backupPath(): string {
    return path.join(this.context.globalStorageUri.fsPath, BACKUP);
  }

  /** Restores a file left mutated by a crash or a closed window during a previous check. */
  async restoreLeftovers(): Promise<void> {
    try {
      if (!fs.existsSync(this.backupPath)) {
        return;
      }
      const { file, content } = JSON.parse(fs.readFileSync(this.backupPath, 'utf8')) as { file: string; content: string };
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== content) {
        fs.writeFileSync(file, content);
        void vscode.window.showInformationMessage(
          `Dartboard restored ${path.basename(file)} after an interrupted test strength check.`,
        );
      }
      fs.unlinkSync(this.backupPath);
    } catch (err) {
      this.output.appendLine(`Could not restore mutation backup: ${String(err)}`);
    }
  }

  async check(uri: vscode.Uri): Promise<void> {
    const coverage = this.store.get(uri);
    const pkg = this.store.packageFor(uri);
    if (!coverage || coverage.untested || !pkg) {
      const create = 'Create test';
      const pick = await vscode.window.showInformationMessage(
        'This file has no coverage yet. Write a test for it first, then check how strong it is.',
        create,
      );
      if (pick === create) {
        await createTestFile(this.store, uri);
      }
      return;
    }
    const tests = relatedTests(pkg, uri);
    if (tests.length === 0) {
      const create = 'Create test';
      const pick = await vscode.window.showInformationMessage(
        `No test file found for ${path.basename(uri.fsPath)} (looked for ${path.basename(uri.fsPath, '.dart')}_test.dart).`,
        create,
      );
      if (pick === create) {
        await createTestFile(this.store, uri);
      }
      return;
    }
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    if (open?.isDirty) {
      const save = 'Save and continue';
      if ((await vscode.window.showWarningMessage('Save the file before checking test strength.', save)) !== save) {
        return;
      }
      await open.save();
    }

    const original = fs.readFileSync(uri.fsPath, 'utf8');
    const covered = [...coverage.lines.entries()].filter(([, hits]) => hits > 0).map(([line]) => line);
    const max = vscode.workspace.getConfiguration('dartboard').get<number>('maxMutations', 15);
    const mutants = findMutants(original, covered, max);
    if (mutants.length === 0) {
      void vscode.window.showInformationMessage(
        'Nothing to check: no covered comparisons, conditions or arithmetic found in this file.',
      );
      return;
    }

    const proceed = 'Start check';
    const pick = await vscode.window.showInformationMessage(
      `Check test strength for ${path.basename(uri.fsPath)}? This makes ${mutants.length} tiny temporary changes and runs ${tests.length} test file(s) after each one. The file is restored afterwards; please don't edit it meanwhile.`,
      { modal: true },
      proceed,
    );
    if (pick !== proceed) {
      return;
    }

    fs.mkdirSync(path.dirname(this.backupPath), { recursive: true });
    fs.writeFileSync(this.backupPath, JSON.stringify({ file: uri.fsPath, content: original }));
    const survivors: WeakSpot[] = [];
    let caught = 0;
    let aborted: string | undefined;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Checking test strength: ${path.basename(uri.fsPath)}`,
        cancellable: true,
      },
      async (progress, token) => {
        try {
          progress.report({ message: 'running tests once as a baseline…' });
          const baseline = await runFlutter(['test', ...tests], pkg.root, this.output, { token });
          if (token.isCancellationRequested) {
            aborted = 'cancelled';
            return;
          }
          if (baseline.code !== 0) {
            aborted = 'The tests already fail without any changes, so their strength can’t be measured. Fix them first.';
            return;
          }
          const timeoutMs = Math.max(30_000, baseline.durationMs * 3);
          const lines = original.split('\n');
          for (let i = 0; i < mutants.length; i++) {
            if (token.isCancellationRequested) {
              aborted = 'cancelled';
              break;
            }
            const m = mutants[i];
            progress.report({
              message: `change ${i + 1} of ${mutants.length} (line ${m.line}: "${m.original.trim()}" → "${m.replacement.trim()}")`,
              increment: 100 / mutants.length,
            });
            fs.writeFileSync(uri.fsPath, applyMutant(original, m));
            const result = await runFlutter(['test', ...tests], pkg.root, this.output, { token, timeoutMs, quiet: true });
            fs.writeFileSync(uri.fsPath, original);
            if (result.cancelled) {
              aborted = 'cancelled';
              break;
            }
            if (result.code === 0) {
              survivors.push({ ...m, code: lines[m.line - 1].trim() });
            } else {
              caught++;
            }
          }
        } finally {
          fs.writeFileSync(uri.fsPath, original);
          try {
            fs.unlinkSync(this.backupPath);
          } catch {
            // Already removed.
          }
        }
      },
    );

    if (aborted && aborted !== 'cancelled') {
      void vscode.window.showWarningMessage(aborted, 'Show output').then((p) => p && this.output.show());
      return;
    }
    const checked = caught + survivors.length;
    if (checked === 0) {
      return;
    }
    this.store.setWeakSpots(uri, survivors);
    const score = Math.round((caught / checked) * 100);
    const message =
      survivors.length === 0
        ? `💪 Test strength ${score}%: your tests caught all ${checked} changes in ${path.basename(uri.fsPath)}.`
        : `Test strength ${score}%: ${caught} of ${checked} changes were caught. ${survivors.length} weak spot${survivors.length === 1 ? ' is' : 's are'} marked in amber; add asserts that would fail there.`;
    void vscode.window.showInformationMessage(message);
  }
}
