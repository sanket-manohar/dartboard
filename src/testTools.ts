import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { PartialRunner, relatedTests } from './actions';
import { caseStubs, TestCase, testCases } from './checklist';
import { CoverageStore, PackageInfo, toPosix } from './coverageStore';
import { analyzeDart, sanitizeDart } from './dart';
import { ProjectModel } from './project';
import { MatrixRun, TestResultsStore } from './results';
import { extraTestArgs, flutterCommand, runFlutter, runFlutterTask } from './runner';
import { testPathForSource } from './paths';
import { parseTestEvents } from './testEvents';

const GENERATED = /^dartboard_(matrix|filmstrip)__.*_test\.dart$/;
const A11Y_MARKER = '// Accessibility checks (added by Dartboard).';

export interface ScreenSetup {
  name: string;
  width: number;
  height: number;
  pixelRatio?: number;
  textScale?: number;
  dark?: boolean;
}

/** A testWidgets/test declaration found in a test file. */
export interface DeclaredTest {
  name: string;
  /** 0-based line of the call. */
  line: number;
  isWidgetTest: boolean;
  /** Offset just inside the closing brace of the callback body. */
  bodyEnd: number;
}

/** Finds test declarations and their names in a test file. */
export function declaredTests(src: string): DeclaredTest[] {
  const text = sanitizeDart(src);
  const out: DeclaredTest[] = [];
  for (const m of text.matchAll(/(^|[^\w.])(testWidgets|test)\s*\(\s*(['"])/g)) {
    const start = m.index! + m[1].length;
    const quoteAt = m.index! + m[0].length - 1;
    const quote = src[quoteAt];
    let end = quoteAt + 1;
    while (end < src.length && src[end] !== quote) {
      end += src[end] === '\\' ? 2 : 1;
    }
    const name = src.slice(quoteAt + 1, end);
    const parenOpen = text.indexOf('(', start);
    const parenClose = matchParen(text, parenOpen);
    const cb = /\)\s*(?:async\s*)?\{/.exec(text.slice(end, parenClose));
    const bodyOpen = cb ? end + cb.index + cb[0].length - 1 : -1;
    out.push({
      name,
      line: src.slice(0, start).split('\n').length - 1,
      isWidgetTest: m[2] === 'testWidgets',
      bodyEnd: bodyOpen >= 0 ? matchParen(text, bodyOpen) : -1,
    });
  }
  return out;
}

/**
 * The "tools" Dartboard runs on individual tests: screen size and theme matrix,
 * accessibility checks, filmstrips, integration tests on a device, affected tests and the
 * test case checklist.
 */
export class TestTools {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: CoverageStore,
    private readonly project: ProjectModel,
    private readonly results: TestResultsStore,
    private readonly partial: PartialRunner,
    private readonly output: vscode.OutputChannel,
  ) {}

  /** Removes wrapper files left behind if VS Code closed during a run. */
  async cleanupLeftovers(): Promise<void> {
    const files = await vscode.workspace.findFiles('**/test/**/dartboard_{matrix,filmstrip}__*_test.dart', '**/{node_modules,.dart_tool,build}/**');
    for (const f of files) {
      try {
        fs.unlinkSync(f.fsPath);
      } catch {
        // Already gone.
      }
    }
  }

  // ---------------------------------------------------------------- screen matrix

  async screenMatrix(uri: vscode.Uri, testName?: string): Promise<void> {
    const pkg = this.store.packageFor(uri);
    if (!pkg || !uri.fsPath.endsWith('_test.dart')) {
      void vscode.window.showWarningMessage('Open a widget test file (…_test.dart) to run it on several screen sizes.');
      return;
    }
    const setups = vscode.workspace.getConfiguration('dartboard').get<ScreenSetup[]>('screenMatrix', []);
    if (!setups.length) {
      void vscode.window.showWarningMessage('No screen setups configured in "dartboard.screenMatrix".');
      return;
    }
    const wrapper = this.wrapperPath(uri, 'matrix');
    fs.writeFileSync(wrapper, matrixWrapper(path.basename(uri.fsPath), setups));
    const resultsFile = TestResultsStore.fileFor(pkg.root, 'matrix_run.json');
    const label = testName ? `"${testName}"` : path.basename(uri.fsPath);
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Running ${label} on ${setups.length} screen setups`, cancellable: true },
        (_p, token) =>
          runFlutter(
            ['test', rel(pkg, wrapper), `--file-reporter=json:${path.relative(pkg.root, resultsFile)}`, ...(testName ? ['--plain-name', testName] : [])],
            pkg.root,
            this.output,
            { token },
          ),
      );
    } finally {
      safeUnlink(wrapper);
    }
    const run = parseTestEvents(readOr(resultsFile, ''));
    if (run.loadErrors.length) {
      void vscode.window.showErrorMessage(`The test file didn't load: ${run.loadErrors[0].failure.title}`);
      return;
    }
    const names = setups.map((s) => s.name);
    const rows = new Map<string, MatrixRun['rows'][number]>();
    for (const t of run.tests) {
      const m = /^\[([^\]]+)\] (.*)$/.exec(t.name);
      if (!m) {
        continue;
      }
      const row = rows.get(m[2]) ?? { test: m[2], cells: {} };
      row.cells[m[1]] = { status: t.status, failure: t.failure };
      rows.set(m[2], row);
    }
    this.results.setMatrix({ suite: uri.fsPath, configs: names, rows: [...rows.values()], time: Date.now() });
    const failedCells = [...rows.values()].flatMap((r) => Object.entries(r.cells).filter(([, c]) => c.status === 'failed'));
    const failedSetups = new Set(failedCells.map(([n]) => n));
    if (!rows.size) {
      void vscode.window.showWarningMessage('No tests ran. Check the test name, or open the output for details.', 'Show output').then((p) => p && this.output.show());
    } else if (failedSetups.size) {
      void vscode.window
        .showWarningMessage(`Fails on ${[...failedSetups].join(', ')}. See the Tests tab for what broke.`, 'Show')
        .then((p) => p && vscode.commands.executeCommand('dartboard.showTab', 'tests'));
    } else {
      void vscode.window.showInformationMessage(`✓ Passes on all ${names.length} screen setups.`, 'Show').then((p) => p && vscode.commands.executeCommand('dartboard.showTab', 'tests'));
    }
  }

  // ---------------------------------------------------------------- accessibility

  async accessibility(uri: vscode.Uri, line: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const test = declaredTests(doc.getText()).find((t) => t.line === line) ?? declaredTests(doc.getText()).filter((t) => t.line <= line).pop();
    if (!test || !test.isWidgetTest || test.bodyEnd < 0) {
      void vscode.window.showWarningMessage('Put the cursor in a testWidgets() test to check its screen for accessibility.');
      return;
    }
    const pkg = this.store.packageFor(uri);
    if (!pkg) {
      return;
    }
    const src = doc.getText();
    const body = src.slice(0, test.bodyEnd);
    if (!body.slice(body.lastIndexOf('testWidgets')).includes(A11Y_MARKER)) {
      const closeLine = doc.positionAt(test.bodyEnd).line;
      const indent = /^\s*/.exec(doc.lineAt(Math.max(0, closeLine - 1)).text)?.[0] || '    ';
      const edit = new vscode.WorkspaceEdit();
      edit.insert(uri, new vscode.Position(closeLine, 0), `\n${a11ySnippet(indent)}`);
      await vscode.workspace.applyEdit(edit);
      await doc.save();
    }
    const resultsFile = TestResultsStore.fileFor(pkg.root, 'a11y_run.json');
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Checking accessibility: ${test.name}`, cancellable: true },
      (_p, token) =>
        runFlutter(['test', rel(pkg, uri.fsPath), '--plain-name', test.name, `--file-reporter=json:${path.relative(pkg.root, resultsFile)}`], pkg.root, this.output, { token }),
    );
    const run = this.results.ingest(resultsFile);
    const result = run?.tests.find((t) => t.name.endsWith(test.name));
    if (!result) {
      void vscode.window.showWarningMessage('The test did not run. Open the output for details.', 'Show output').then((p) => p && this.output.show());
    } else if (result.status === 'passed') {
      void vscode.window.showInformationMessage(`✓ No accessibility problems found in "${test.name}". The check stays in the test, so it keeps guarding this screen.`);
    } else {
      const items = result.failure?.items?.length ?? 0;
      void vscode.window
        .showWarningMessage(items ? `${items} accessibility problem${items === 1 ? '' : 's'} found in "${test.name}".` : `"${test.name}" failed before the accessibility check.`, 'Show')
        .then((p) => p && vscode.commands.executeCommand('dartboard.showTab', 'tests'));
    }
  }

  // ---------------------------------------------------------------- filmstrip

  async filmstrip(uri: vscode.Uri, testName: string): Promise<void> {
    const pkg = this.store.packageFor(uri);
    if (!pkg) {
      return;
    }
    const slug = testName.replace(/[^\w]+/g, '_').slice(0, 60) || 'test';
    const outDir = path.join(pkg.root, 'build', 'dartboard', 'filmstrip', slug);
    fs.rmSync(outDir, { recursive: true, force: true });
    const wrapper = this.wrapperPath(uri, 'filmstrip');
    fs.writeFileSync(wrapper, filmstripWrapper(path.basename(uri.fsPath)));
    const roboto = robotoPath();
    const resultsFile = TestResultsStore.fileFor(pkg.root, 'filmstrip_run.json');
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Recording "${testName}"`, cancellable: true },
        (_p, token) =>
          runFlutter(
            [
              'test',
              rel(pkg, wrapper),
              '--plain-name',
              testName,
              `--dart-define=DARTBOARD_FILMSTRIP_DIR=${outDir}`,
              ...(roboto ? [`--dart-define=DARTBOARD_ROBOTO=${roboto}`] : []),
              `--file-reporter=json:${path.relative(pkg.root, resultsFile)}`,
            ],
            pkg.root,
            this.output,
            { token },
          ),
      );
    } finally {
      safeUnlink(wrapper);
    }
    const run = parseTestEvents(readOr(resultsFile, ''));
    const frames = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => /^frame_\d+\.png$/.test(f)).sort() : [];
    if (!frames.length) {
      const why = run.loadErrors[0]?.failure.title ?? (run.tests.length ? 'the test drew no frames' : 'the test did not run');
      void vscode.window.showWarningMessage(`No filmstrip recorded: ${why}.`, 'Show output').then((p) => p && this.output.show());
      return;
    }
    let info: { times?: number[] } = {};
    try {
      info = JSON.parse(fs.readFileSync(path.join(outDir, 'info.json'), 'utf8'));
    } catch {
      // Times are optional.
    }
    const test = run.tests.find((t) => t.name.endsWith(testName));
    FilmstripPanel.show(this.context, testName, outDir, frames, info.times ?? [], test?.status, test?.failure?.title, !roboto);
  }

  // ---------------------------------------------------------------- integration tests

  async integrationTests(): Promise<void> {
    const pkgs = this.store.packages.filter((p) => fs.existsSync(path.join(p.root, 'integration_test')));
    if (!pkgs.length) {
      void vscode.window.showInformationMessage('No integration_test/ folder found. Add integration tests with the integration_test package first.');
      return;
    }
    const pkg = pkgs.length === 1 ? pkgs[0] : (await vscode.window.showQuickPick(pkgs.map((p) => ({ label: p.name, p })), { placeHolder: 'Which package?' }))?.p;
    if (!pkg) {
      return;
    }
    const devices = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Looking for devices…' }, () =>
      runFlutter(['devices', '--machine'], pkg.root, this.output, { capture: true, quiet: true, timeoutMs: 60_000 }),
    );
    let list: Array<{ name: string; id: string; isSupported?: boolean; targetPlatform?: string; emulator?: boolean; sdk?: string }> = [];
    try {
      list = JSON.parse(/\[[\s\S]*\]/.exec(devices.stdout ?? '')?.[0] ?? '[]');
    } catch {
      list = [];
    }
    list = list.filter((d) => d.isSupported !== false && !String(d.targetPlatform).startsWith('web'));
    if (!list.length) {
      void vscode.window.showWarningMessage('No device found. Start an emulator or simulator, connect a phone, or enable a desktop platform.');
      return;
    }
    const device = list.length === 1
      ? list[0]
      : (await vscode.window.showQuickPick(
          list.map((d) => ({ label: d.name, description: `${d.targetPlatform ?? ''}${d.emulator ? ' · emulator' : ''}`, detail: d.sdk, d })),
          { placeHolder: 'Run integration tests on which device?' },
        ))?.d;
    if (!device) {
      return;
    }
    const resultsFile = TestResultsStore.fileFor(pkg.root, 'integration_run.json');
    safeUnlink(resultsFile);
    const code = await runFlutterTask(
      `Integration tests on ${device.name}`,
      ['test', 'integration_test', '-d', device.id, '--coverage', '--coverage-path=coverage/integration_lcov.info', `--file-reporter=json:${path.relative(pkg.root, resultsFile)}`],
      pkg.root,
      this.output,
    );
    this.results.ingest(resultsFile);
    await this.store.load();
    const s = this.results.summary;
    if (code === 0) {
      void vscode.window.showInformationMessage(`✓ Integration tests passed on ${device.name}. Their coverage is now included.`);
    } else if (s.failed) {
      void vscode.window.showWarningMessage(`Integration tests failed on ${device.name}.`, 'Show').then((p) => p && vscode.commands.executeCommand('dartboard.showTab', 'tests'));
    }
  }

  // ---------------------------------------------------------------- affected tests

  async runAffected(): Promise<void> {
    const changed = new Set<string>();
    for (const f of this.store.changedFiles ?? []) {
      changed.add(f);
    }
    const active = vscode.window.activeTextEditor?.document;
    let source = 'changed on this branch';
    if (!changed.size && active?.languageId === 'dart') {
      changed.add(path.resolve(active.uri.fsPath));
      source = 'the open file';
    }
    if (!changed.size) {
      void vscode.window.showInformationMessage('No changed Dart files found (git shows none, and no Dart file is open).');
      return;
    }
    const plan: Array<{ pkg: PackageInfo; tests: string[]; changed: string[] }> = [];
    for (const pkg of this.store.packages) {
      const mine = [...changed].filter((f) => f.startsWith(pkg.root + path.sep)).map((f) => toPosix(path.relative(pkg.root, f)));
      if (!mine.length) {
        continue;
      }
      const tests = this.project.graph(pkg).affectedTests(mine, (p) => p.startsWith('test/') && p.endsWith('_test.dart'));
      if (tests.length) {
        plan.push({ pkg, tests, changed: mine });
      }
    }
    const total = plan.reduce((n, p) => n + p.tests.length, 0);
    const files = plan.reduce((n, p) => n + p.changed.length, 0) || changed.size;
    if (!total) {
      void vscode.window.showInformationMessage(`No test depends on the ${changed.size} file(s) ${source}. Nothing to run.`);
      return;
    }
    const all = plan.reduce((n, p) => n + p.pkg.testFiles.length, 0);
    const pick = await vscode.window.showQuickPick(
      [
        { label: `$(play) Run ${total} affected test file${total === 1 ? '' : 's'}`, description: `of ${all}, for ${files} file(s) ${source}`, run: true },
        ...plan.flatMap((p) => p.tests.map((t) => ({ label: `$(beaker) ${t}`, description: p.pkg.name, run: false }))),
      ],
      { placeHolder: 'Tests that import the changed code, directly or indirectly' },
    );
    if (!pick?.run) {
      return;
    }
    for (const p of plan) {
      await this.partial.runTests(p.pkg, p.tests, `Running ${p.tests.length} affected test file(s)`);
    }
  }

  // ---------------------------------------------------------------- checklist

  async checklist(uri: vscode.Uri, line: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const src = doc.getText();
    const fns = analyzeDart(src).symbols.filter((s) => s.kind !== 'class' && line + 1 >= s.startLine && line + 1 <= s.endLine);
    const fn = fns.sort((a, b) => b.startLine - a.startLine)[0];
    if (!fn) {
      void vscode.window.showInformationMessage('Put the cursor inside a function to list its test cases.');
      return;
    }
    const cov = this.store.get(uri);
    const blocks = new Map<number, boolean>();
    for (const [k, n] of cov?.branchData ?? []) {
      const l = parseInt(k, 10);
      blocks.set(l, (blocks.get(l) ?? false) || n > 0);
    }
    const cases = testCases(src, fn, cov && !cov.untested ? cov.lines : undefined, blocks.size ? blocks : undefined);
    const fnName = fn.parent && fn.kind !== 'function' ? `${fn.parent}.${fn.name}` : fn.name;
    const icon = (c: TestCase) => (c.status === 'covered' ? '$(pass-filled)' : c.status === 'missing' ? '$(circle-large-outline)' : '$(question)');
    const items = cases.map((c) => ({
      label: `${icon(c)} ${c.title}`,
      description: c.status === 'covered' ? 'already covered' : c.status === 'missing' ? 'not tested yet' : 'can’t tell from coverage',
      detail: `line ${c.line}: ${c.arrange}`,
      picked: c.status === 'missing',
      c,
    }));
    const picks = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: `Test cases for ${fnName}(): pick the ones to add as test stubs`,
    });
    if (!picks?.length) {
      return;
    }
    await this.insertStubs(uri, fnName, picks.map((p) => p.c));
  }

  private async insertStubs(uri: vscode.Uri, fnName: string, cases: TestCase[]): Promise<void> {
    const pkg = this.store.packageFor(uri);
    if (!pkg) {
      return;
    }
    const rel = toPosix(path.relative(pkg.root, uri.fsPath));
    let testRel = relatedTests(pkg, uri)[0];
    const edit = new vscode.WorkspaceEdit();
    let testUri: vscode.Uri;
    if (!testRel) {
      testRel = testPathForSource(rel);
      testUri = vscode.Uri.file(path.join(pkg.root, testRel));
      const header = `${pkg.isFlutter ? "import 'package:flutter_test/flutter_test.dart';" : "import 'package:test/test.dart';"}\nimport 'package:${pkg.name}/${rel.replace(/^lib\//, '')}';\n\nvoid main() {\n${caseStubs(fnName, cases)}\n}\n`;
      edit.createFile(testUri, { ignoreIfExists: true, contents: Buffer.from(header) });
      pkg.testFiles.push(testRel);
    } else {
      testUri = vscode.Uri.file(path.join(pkg.root, testRel));
      const doc = await vscode.workspace.openTextDocument(testUri);
      const text = doc.getText();
      const last = text.lastIndexOf('}');
      const at = doc.positionAt(last >= 0 ? last : text.length);
      edit.insert(testUri, at, `\n${caseStubs(fnName, cases)}\n`);
    }
    await vscode.workspace.applyEdit(edit);
    const doc = await vscode.workspace.openTextDocument(testUri);
    const editor = await vscode.window.showTextDocument(doc);
    const first = doc.getText().indexOf(`test('${fnName.replace(/'/g, "\\'")} ${cases[0].title.replace(/'/g, "\\'").replace(/\$/g, '\\$')}'`);
    if (first >= 0) {
      const pos = doc.positionAt(first);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
    void vscode.window.setStatusBarMessage(`$(checklist) Added ${cases.length} test stub${cases.length === 1 ? '' : 's'} to ${testRel}`, 5000);
  }

  // ---------------------------------------------------------------- single tests

  /** Re-runs one test by name (or the whole file when name is empty) and refreshes the Tests tab. */
  async rerunTest(suite: string, name: string): Promise<void> {
    const uri = vscode.Uri.file(suite);
    const pkg = this.store.packageFor(uri);
    if (!pkg) {
      return;
    }
    const rel = toPosix(path.relative(pkg.root, suite));
    const resultsFile = TestResultsStore.fileFor(pkg.root, 'rerun.json');
    safeUnlink(resultsFile);
    const args = ['test', rel, ...extraTestArgs(path.relative(pkg.root, resultsFile), false)];
    if (name) {
      args.push('--plain-name', name);
    }
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: name ? `Running "${name}"` : `Running ${path.basename(suite)}`, cancellable: true },
      (_p, token) => runFlutter(args, pkg.root, this.output, { token }),
    );
    if (result.cancelled) {
      return;
    }
    this.results.ingest(resultsFile);
    if (result.code === 0) {
      void vscode.window.setStatusBarMessage(`$(pass) ${name || path.basename(suite)} passed`, 5000);
    } else {
      await vscode.commands.executeCommand('dartboard.showTab', 'tests');
    }
  }

  /** Creates a widget test that pumps the given screen or widget and opens it. */
  async createWidgetTest(uri: vscode.Uri, className: string): Promise<void> {
    const pkg = this.store.packageFor(uri);
    if (!pkg) {
      return;
    }
    const rel = toPosix(path.relative(pkg.root, uri.fsPath));
    const src = fs.readFileSync(uri.fsPath, 'utf8');
    // A constructor with required parameters can't be guessed; leave a TODO in the call.
    const ctor = new RegExp(`(?:const\\s+)?${className}\\s*\\(([^)]*)\\)`).exec(src.slice(src.indexOf(`class ${className}`)));
    const params = ctor?.[1].trim() ?? '';
    const needsArgs = /\brequired\b/.test(params) || (params !== '' && !params.startsWith('{') && !params.startsWith('['));
    let target = testPathForSource(rel).replace(/_test\.dart$/, '_widget_test.dart');
    let n = 2;
    while (fs.existsSync(path.join(pkg.root, target))) {
      target = target.replace(/(_\d+)?_widget_test\.dart$/, `_${n++}_widget_test.dart`);
    }
    const build = needsArgs ? `${className}(/* TODO: arguments */)` : `const ${className}()`;
    const content = `import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:${pkg.name}/${rel.replace(/^lib\//, '')}';

void main() {
  testWidgets('${className} shows its content', (tester) async {
    await tester.pumpWidget(MaterialApp(home: ${build}));
    await tester.pumpAndSettle();

    expect(find.byType(${className}), findsOneWidget);
    // TODO: check the text, buttons and states that matter on this screen.
  });
}
`;
    const targetUri = vscode.Uri.file(path.join(pkg.root, target));
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(targetUri.fsPath)));
    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(content, 'utf8'));
    pkg.testFiles.push(target);
    const doc = await vscode.workspace.openTextDocument(targetUri);
    const editor = await vscode.window.showTextDocument(doc);
    const todo = content.split('\n').findIndex((l) => l.includes('TODO'));
    const pos = new vscode.Position(todo, content.split('\n')[todo].length);
    editor.selection = new vscode.Selection(pos, pos);
    void vscode.window.setStatusBarMessage(`$(new-file) Created ${target}`, 4000);
  }

  private wrapperPath(uri: vscode.Uri, kind: 'matrix' | 'filmstrip'): string {
    return path.join(path.dirname(uri.fsPath), `dartboard_${kind}__${path.basename(uri.fsPath)}`);
  }
}

export function isGeneratedWrapper(file: string): boolean {
  return GENERATED.test(path.basename(file));
}

function rel(pkg: PackageInfo, file: string): string {
  return toPosix(path.relative(pkg.root, file));
}

function safeUnlink(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone.
  }
}

function readOr(file: string, fallback: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return text.length - 1;
}

/** Locates Roboto in the Flutter SDK so filmstrip frames show real text instead of boxes. */
function robotoPath(): string | undefined {
  const candidates: string[] = [];
  if (process.env.FLUTTER_ROOT) {
    candidates.push(process.env.FLUTTER_ROOT);
  }
  const cmd = flutterCommand();
  const bins = path.isAbsolute(cmd) ? [cmd] : (process.env.PATH ?? '').split(path.delimiter).map((d) => path.join(d, process.platform === 'win32' ? `${cmd}.bat` : cmd));
  for (const b of bins) {
    try {
      if (fs.existsSync(b)) {
        candidates.push(path.dirname(path.dirname(fs.realpathSync(b))));
      }
    } catch {
      // Not this one.
    }
  }
  for (const root of candidates) {
    const font = path.join(root, 'bin', 'cache', 'artifacts', 'material_fonts', 'Roboto-Regular.ttf');
    if (fs.existsSync(font)) {
      return font;
    }
  }
  return undefined;
}

const HEADER = (what: string) =>
  `// Generated by Dartboard to ${what}.\n// It is deleted after the run. Safe to delete if it is ever left behind.\n// ignore_for_file: type=lint\n`;

export function matrixWrapper(target: string, setups: ScreenSetup[]): string {
  const variants = setups
    .map((s) => {
      const ratio = s.pixelRatio ?? 3;
      return `  variant(${JSON.stringify(s.name)}, const Size(${num(s.width)}, ${num(s.height)}), ${num(ratio)}, ${num(s.textScale ?? 1)}, ui.Brightness.${s.dark ? 'dark' : 'light'});`;
    })
    .join('\n');
  return `${HEADER(`run ${target} on several screen sizes and themes`)}import 'dart:ui' as ui;

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import '${target}' as target;

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  void variant(String name, Size size, double ratio, double textScale, ui.Brightness brightness) {
    group('[\$name]', () {
      setUp(() {
        final view = binding.platformDispatcher.implicitView!;
        view.physicalSize = size * ratio;
        view.devicePixelRatio = ratio;
        binding.platformDispatcher.textScaleFactorTestValue = textScale;
        binding.platformDispatcher.platformBrightnessTestValue = brightness;
      });
      tearDown(() {
        binding.platformDispatcher.implicitView!.reset();
        binding.platformDispatcher.clearAllTestValues();
      });
      target.main();
    });
  }

${variants}
}
`;
}

export function filmstripWrapper(target: string): string {
  return `${HEADER(`record a filmstrip of ${target}`)}import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '${target}' as target;

const _out = String.fromEnvironment('DARTBOARD_FILMSTRIP_DIR');
const _maxFrames = 120;

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  final frames = <(Duration, ui.Image)>[];
  var recording = false;
  binding.addPersistentFrameCallback((timeStamp) {
    if (!recording || frames.length >= _maxFrames) return;
    binding.addPostFrameCallback((_) {
      if (!recording) return;
      final view = binding.renderViews.first;
      final layer = view.debugLayer as OffsetLayer?;
      if (layer == null) return;
      frames.add((timeStamp, layer.toImageSync(view.paintBounds, pixelRatio: 1 / view.flutterView.devicePixelRatio)));
    });
  });

  setUpAll(_loadFonts);
  setUp(() {
    frames.clear();
    recording = true;
  });
  tearDown(() async {
    recording = false;
    // The first and last frames are the test framework's own "starting" and "finished" screens.
    final kept = frames.length > 2 ? frames.sublist(1, frames.length - 1) : frames;
    final dir = Directory(_out)..createSync(recursive: true);
    final times = <int>[];
    List<int>? previous;
    for (final (time, image) in kept) {
      final bytes = (await image.toByteData(format: ui.ImageByteFormat.png))!.buffer.asUint8List();
      if (previous != null && _same(previous, bytes)) continue;
      previous = bytes;
      File('\${dir.path}/frame_\${times.length.toString().padLeft(3, '0')}.png').writeAsBytesSync(bytes);
      times.add(time.inMilliseconds);
    }
    for (final (_, image) in frames) {
      image.dispose();
    }
    frames.clear();
    final start = times.isEmpty ? 0 : times.first;
    File('\${dir.path}/info.json').writeAsStringSync(jsonEncode({'times': [for (final t in times) t - start]}));
  });
  target.main();
}

bool _same(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

Future<void> _loadFonts() async {
  try {
    final manifest = json.decode(await rootBundle.loadString('FontManifest.json')) as List<dynamic>;
    for (final family in manifest.cast<Map<String, dynamic>>()) {
      final loader = FontLoader(family['family'] as String);
      for (final font in (family['fonts'] as List<dynamic>).cast<Map<String, dynamic>>()) {
        loader.addFont(rootBundle.load(font['asset'] as String));
      }
      await loader.load();
    }
  } catch (_) {}
  const roboto = String.fromEnvironment('DARTBOARD_ROBOTO');
  if (roboto.isNotEmpty && File(roboto).existsSync()) {
    final loader = FontLoader('Roboto')..addFont(Future.value(ByteData.sublistView(File(roboto).readAsBytesSync())));
    await loader.load();
  }
}
`;
}

export function a11ySnippet(indent: string): string {
  const i = indent;
  return [
    `${i}${A11Y_MARKER}`,
    `${i}final semantics = tester.ensureSemantics();`,
    `${i}await tester.pump();`,
    `${i}final problems = <String>[];`,
    `${i}for (final guideline in [androidTapTargetGuideline, iOSTapTargetGuideline, labeledTapTargetGuideline, textContrastGuideline]) {`,
    `${i}  final result = await guideline.evaluate(tester);`,
    `${i}  if (!result.passed) problems.add('\${guideline.description}: \${result.reason}');`,
    `${i}}`,
    `${i}semantics.dispose();`,
    `${i}for (final problem in problems) {`,
    `${i}  // ignore: avoid_print`,
    `${i}  print('♿ \${problem.replaceAll('\\n', ' ')}');`,
    `${i}}`,
    `${i}expect(problems, isEmpty, reason: 'Accessibility problems found (see above).');`,
    '',
  ].join('\n');
}

function num(v: number): string {
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

/** Plays back the frames a filmstrip recording captured. */
class FilmstripPanel {
  private static panel: vscode.WebviewPanel | undefined;

  static show(context: vscode.ExtensionContext, title: string, dir: string, frames: string[], times: number[], status?: string, failure?: string, boxesForText = false): void {
    const root = vscode.Uri.file(dir);
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('dartboard.filmstrip', `Filmstrip: ${title}`, vscode.ViewColumn.Beside, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(path.dirname(dir))],
      });
      this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
      this.panel.onDidDispose(() => (this.panel = undefined));
    } else {
      this.panel.title = `Filmstrip: ${title}`;
      this.panel.reveal(vscode.ViewColumn.Beside);
    }
    const webview = this.panel.webview;
    const bust = Date.now();
    const srcs = frames.map((f) => `${webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString()}?v=${bust}`);
    const nonce = Math.random().toString(36).slice(2);
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); margin: 0; padding: 16px 20px; }
  h1 { font-size: 15px; margin: 0 0 4px; font-weight: 600; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 12px; }
  .meta .fail { color: var(--vscode-testing-iconFailed, #f14c4c); }
  .meta .pass { color: var(--vscode-testing-iconPassed, #3fb950); }
  .stage { display: flex; justify-content: center; background: var(--vscode-editorWidget-background, #2222); border: 1px solid var(--vscode-widget-border, #8884); border-radius: 8px; padding: 12px; }
  .stage img { max-width: 100%; max-height: 60vh; box-shadow: 0 2px 12px #0005; border-radius: 4px; image-rendering: auto; }
  .controls { display: flex; align-items: center; gap: 8px; margin: 12px 0; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 4px; padding: 4px 10px; cursor: pointer; font: inherit; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  input[type=range] { flex: 1; }
  .count { font-variant-numeric: tabular-nums; min-width: 110px; text-align: right; color: var(--vscode-descriptionForeground); font-size: 12px; }
  .strip { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 6px; }
  .strip img { height: 72px; border-radius: 3px; border: 2px solid transparent; cursor: pointer; opacity: .75; }
  .strip img.on { border-color: var(--vscode-focusBorder); opacity: 1; }
  .note { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 8px; }
</style></head><body>
<h1>${esc(title)}</h1>
<div class="meta">${frames.length} distinct frame${frames.length === 1 ? '' : 's'} · ${status === 'failed' ? `<span class="fail">failed: ${esc(failure ?? '')}</span>` : status === 'passed' ? '<span class="pass">passed</span>' : ''}</div>
<div class="stage"><img id="frame" alt="frame"></div>
<div class="controls">
  <button id="prev" title="Previous frame (←)">◀</button>
  <button id="play" class="primary" title="Play (space)">▶ Play</button>
  <button id="next" title="Next frame (→)">▶</button>
  <input id="slider" type="range" min="0" max="${frames.length - 1}" value="0">
  <span class="count" id="count"></span>
</div>
<div class="strip" id="strip"></div>
${boxesForText ? '<div class="note">Text shows as boxes because Roboto wasn’t found in your Flutter SDK. Set FLUTTER_ROOT to fix it.</div>' : ''}
<div class="note">Each frame is what the screen looked like after a pump. Identical frames in a row are shown once.</div>
<script nonce="${nonce}">
  const srcs = ${JSON.stringify(srcs)};
  const times = ${JSON.stringify(times)};
  let i = 0, timer = null;
  const img = document.getElementById('frame'), slider = document.getElementById('slider'), count = document.getElementById('count'), strip = document.getElementById('strip'), play = document.getElementById('play');
  strip.innerHTML = srcs.map((s, k) => '<img src="' + s + '" data-k="' + k + '">').join('');
  function show(k) {
    i = Math.max(0, Math.min(srcs.length - 1, k));
    img.src = srcs[i]; slider.value = i;
    count.textContent = 'Frame ' + (i + 1) + ' / ' + srcs.length + (times[i] !== undefined ? '  ·  +' + times[i] + ' ms' : '');
    strip.querySelectorAll('img').forEach((e) => e.classList.toggle('on', Number(e.dataset.k) === i));
    const on = strip.querySelector('img.on'); if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function toggle() {
    if (timer) { clearInterval(timer); timer = null; play.textContent = '▶ Play'; return; }
    if (i >= srcs.length - 1) show(0);
    play.textContent = '❚❚ Pause';
    timer = setInterval(() => { if (i >= srcs.length - 1) { toggle(); } else { show(i + 1); } }, 450);
  }
  document.getElementById('prev').onclick = () => show(i - 1);
  document.getElementById('next').onclick = () => show(i + 1);
  play.onclick = toggle;
  slider.oninput = () => show(Number(slider.value));
  strip.onclick = (e) => { const k = e.target.dataset && e.target.dataset.k; if (k !== undefined) show(Number(k)); };
  document.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') show(i - 1); else if (e.key === 'ArrowRight') show(i + 1); else if (e.key === ' ') { toggle(); e.preventDefault(); } });
  show(0);
</script></body></html>`;
  }
}
