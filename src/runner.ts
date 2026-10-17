import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { PackageInfo } from './coverageStore';
import { parseLcov, serializeLcov } from './lcov';
import { sourcesForTest } from './paths';
import { TestResultsStore } from './results';

const EXCLUDE = '{**/node_modules/**,**/.dart_tool/**,**/build/**,**/.symlinks/**,**/ephemeral/**}';

export function flutterCommand(): string {
  return vscode.workspace.getConfiguration('dartboard').get<string>('flutterCommand', 'flutter');
}

export function branchCoverageEnabled(): boolean {
  return vscode.workspace.getConfiguration('dartboard').get<boolean>('branchCoverage', true);
}

/**
 * Extra arguments that make `flutter test` write machine-readable results (for the
 * Tests tab) and, when enabled, branch coverage. Only added to plain flutter/dart test
 * commands, never to custom scripts.
 */
export function extraTestArgs(resultsFile: string, coverage: boolean): string[] {
  const args = [`--file-reporter=json:${resultsFile}`];
  if (coverage && branchCoverageEnabled()) {
    args.push('--branch-coverage');
  }
  return args;
}

/**
 * Runs the configured full test command as a VS Code task in the chosen package so the
 * output shows in the terminal. Resolves with the exit code and the results file, if any.
 */
export async function runCoverage(output: vscode.OutputChannel, preferredRoot?: string): Promise<{ code: number | undefined; root: string; results?: string } | undefined> {
  const packageDir = preferredRoot ?? (await pickPackage());
  if (!packageDir) {
    return undefined;
  }
  let command = vscode.workspace
    .getConfiguration('dartboard')
    .get<string>('testCommand', 'flutter test --coverage');
  let results: string | undefined;
  const flutter = flutterCommand();
  if (/^\s*(flutter|dart|fvm\s+flutter)\s+test\b/.test(command) || command.trim().startsWith(`${flutter} test`)) {
    results = TestResultsStore.fileFor(packageDir, 'last_run.json');
    try {
      fs.unlinkSync(results);
    } catch {
      // No previous results.
    }
    const extra = extraTestArgs(path.relative(packageDir, results), /--coverage\b/.test(command) && /flutter/.test(command))
      .filter((a) => !command.includes(a.split('=')[0]));
    command = `${command} ${extra.map(shellQuote).join(' ')}`;
  }
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(packageDir)) ?? vscode.workspace.workspaceFolders![0];

  const task = new vscode.Task(
    { type: 'dartboard', package: packageDir },
    folder,
    `Coverage: ${path.basename(packageDir)}`,
    'Dartboard',
    new vscode.ShellExecution(command, { cwd: packageDir }),
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
  };

  output.appendLine(`Running "${command}" in ${packageDir}`);
  const execution = await vscode.tasks.executeTask(task);

  return new Promise((resolve) => {
    const sub = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution === execution) {
        sub.dispose();
        output.appendLine(`Finished with exit code ${e.exitCode}`);
        resolve({ code: e.exitCode, root: packageDir, results: results && fs.existsSync(results) ? results : undefined });
      }
    });
  });
}

/** Runs any flutter command as a visible task (used for integration tests on a device). */
export async function runFlutterTask(name: string, args: string[], cwd: string, output: vscode.OutputChannel): Promise<number | undefined> {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd)) ?? vscode.workspace.workspaceFolders![0];
  const task = new vscode.Task(
    { type: 'dartboard', package: cwd, name },
    folder,
    name,
    'Dartboard',
    new vscode.ShellExecution(flutterCommand(), args, { cwd }),
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
  output.appendLine(`Running ${flutterCommand()} ${args.join(' ')} in ${cwd}`);
  const execution = await vscode.tasks.executeTask(task);
  return new Promise((resolve) => {
    const sub = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution === execution) {
        sub.dispose();
        resolve(e.exitCode);
      }
    });
  });
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, '\\$1')}"`;
}

export interface ProcessResult {
  code: number | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  /** Captured stdout, when requested. */
  stdout?: string;
}

/** Runs `flutter <args>` quietly in the background, logging to the output channel. */
export function runFlutter(
  args: string[],
  cwd: string,
  output: vscode.OutputChannel,
  options: { token?: vscode.CancellationToken; timeoutMs?: number; quiet?: boolean; capture?: boolean; env?: Record<string, string> } = {},
): Promise<ProcessResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const cmd = flutterCommand();
    if (!options.quiet) {
      output.appendLine(`$ ${cmd} ${args.join(' ')}   (in ${cwd})`);
    }
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let stdout = '';
    const child = spawn(cmd, args, { cwd, shell: process.platform === 'win32', env: { ...process.env, ...options.env } });
    if (options.capture) {
      child.stdout?.on('data', (d) => (stdout += d.toString()));
    }
    const finish = (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      sub?.dispose();
      resolve({ code, timedOut, cancelled, durationMs: Date.now() - started, stdout: options.capture ? stdout : undefined });
    };
    const kill = () => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, options.timeoutMs)
      : undefined;
    const sub = options.token?.onCancellationRequested(() => {
      cancelled = true;
      kill();
    });
    if (!options.quiet) {
      child.stdout?.on('data', (d) => output.append(d.toString()));
      child.stderr?.on('data', (d) => output.append(d.toString()));
    }
    child.on('error', (err) => {
      output.appendLine(`Could not start "${cmd}": ${err.message}. Set "dartboard.flutterCommand" to the full path of flutter.`);
      finish(-1);
    });
    child.on('close', (code) => finish(code));
  });
}

/**
 * Runs only the given tests with coverage and merges the result into the package's
 * coverage/lcov.info: files belonging to those tests are replaced, everything else is kept.
 */
export async function runPartialCoverage(
  pkg: PackageInfo,
  testPaths: string[],
  output: vscode.OutputChannel,
  token?: vscode.CancellationToken,
  results?: TestResultsStore,
): Promise<ProcessResult> {
  const partialRel = 'coverage/.partial_lcov.info';
  const partialAbs = path.join(pkg.root, partialRel);
  const mainAbs = path.join(pkg.root, 'coverage', 'lcov.info');
  const resultsFile = TestResultsStore.fileFor(pkg.root, 'partial_run.json');
  const result = await runFlutter(
    ['test', '--coverage', `--coverage-path=${partialRel}`, ...extraTestArgs(path.relative(pkg.root, resultsFile), true), ...testPaths],
    pkg.root,
    output,
    { token },
  );
  results?.ingest(resultsFile);
  try {
    if (!fs.existsSync(partialAbs)) {
      return result;
    }
    const partial = parseLcov(fs.readFileSync(partialAbs, 'utf8'));
    const main = fs.existsSync(mainAbs) ? parseLcov(fs.readFileSync(mainAbs, 'utf8')) : new Map();
    // Only trust the partial run for the source files these tests are about; other files it
    // touched incidentally would otherwise drop to whatever this small run happened to hit.
    const owned = new Set<string>();
    for (const t of testPaths) {
      const rel = t.replace(/\\/g, '/');
      const isDir = !rel.endsWith('.dart');
      const tests = isDir ? pkg.testFiles.filter((f) => f.startsWith(rel.replace(/\/$/, '') + '/')) : [rel];
      for (const test of tests) {
        sourcesForTest(test, pkg.sourceFiles).forEach((s) => owned.add(s));
      }
    }
    for (const [sf, cov] of partial) {
      const rel = sf.replace(/\\/g, '/');
      if (owned.has(rel) || !main.has(sf)) {
        main.set(sf, cov);
      }
    }
    fs.mkdirSync(path.dirname(mainAbs), { recursive: true });
    fs.writeFileSync(mainAbs, serializeLcov(main.values()));
  } catch (err) {
    output.appendLine(`Could not merge partial coverage: ${String(err)}`);
  } finally {
    try {
      fs.unlinkSync(partialAbs);
    } catch {
      // Nothing to clean up.
    }
  }
  return result;
}

export async function pickPackage(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    void vscode.window.showWarningMessage('Open a Flutter or Dart project folder to run coverage.');
    return undefined;
  }
  const pubspecs = await vscode.workspace.findFiles('**/pubspec.yaml', EXCLUDE);
  const dirs = [...new Set(pubspecs.map((u) => path.dirname(u.fsPath)))].sort();
  if (dirs.length === 0) {
    // No pubspec found: run in the first workspace folder and let the command report the problem.
    return folders[0].uri.fsPath;
  }
  if (dirs.length === 1) {
    return dirs[0];
  }
  // Prefer the package that contains the active file.
  const active = vscode.window.activeTextEditor?.document.uri.fsPath;
  const owning = active
    ? dirs.filter((d) => active.startsWith(d + path.sep)).sort((a, b) => b.length - a.length)[0]
    : undefined;

  const items = dirs.map((d) => ({
    label: path.basename(d),
    description: vscode.workspace.asRelativePath(d),
    dir: d,
  }));
  if (owning) {
    items.sort((a, b) => (a.dir === owning ? -1 : b.dir === owning ? 1 : 0));
  }
  const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Which package should run tests with coverage?' });
  return choice?.dir;
}
