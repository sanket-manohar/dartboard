// Exercises the store, tree and share logic against a stubbed `vscode` module.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname, 'fixture/app');
const lcovPath = path.join(root, 'coverage/lcov.info');
fs.copyFileSync(path.join(root, 'original.lcov'), lcovPath);
const pkg = require('../package.json');
const settings = Object.fromEntries(
  Object.entries(pkg.contributes.configuration.properties).map(([k, v]) => [k.replace('dartboard.', ''), v.default]),
);
class EventEmitter { constructor() { this.l = []; this.event = (f) => { this.l.push(f); return { dispose() {} }; }; } fire(e) { this.l.forEach((f) => f(e)); } dispose() {} }
class Uri {
  constructor(p) { this.fsPath = p; this.scheme = 'file'; }
  static file(p) { return new Uri(path.resolve(p)); }
  static parse(s) { return new Uri(s.replace('file://', '')); }
  with() { return this; }
  toString() { return 'file://' + this.fsPath; }
}
class Memento { constructor() { this.m = {}; } get(k, d) { return k in this.m ? JSON.parse(JSON.stringify(this.m[k])) : d; } update(k, v) { this.m[k] = v; return Promise.resolve(); } }
const { globToRegExp } = require('../out/lcov');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const folder = { uri: Uri.file(root), name: 'app', index: 0 };
const vscode = {
  EventEmitter, Uri,
  TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  MarkdownString: class { constructor() { this.value = ''; } appendMarkdown(s) { this.value += s; } },
  Range: class { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } },
  Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
  languages: { createDiagnosticCollection: () => ({ set() {}, clear() {}, delete() {}, dispose() {} }) },
  RelativePattern: class { constructor(base, pattern) { this.base = base.uri ? base.uri.fsPath : base.fsPath; this.pattern = pattern; } },
  commands: { executeCommand: async () => {} },
  window: {
    messages: [],
    showInformationMessage: async (msg, ...rest) => { vscode.window.messages.push(msg); const items = rest.filter((r) => typeof r === 'string'); return items[0]; },
    showWarningMessage: async (msg) => { vscode.window.messages.push(msg); },
    setStatusBarMessage: () => {},
    withProgress: (opts, fn) => fn({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    showTextDocument: async () => ({}),
  },
  ProgressLocation: { Notification: 15 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  FileType: { File: 1, Directory: 2 },
  env: { clipboard: { text: '', writeText: async (t) => { vscode.env.clipboard.text = t; } } },
  workspace: {
    workspaceFolders: [folder],
    getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }),
    getWorkspaceFolder: () => folder,
    findFiles: async (pattern) => {
      const base = typeof pattern === 'string' ? root : pattern.base;
      const re = globToRegExp(typeof pattern === 'string' ? pattern : pattern.pattern);
      return walk(base).filter((f) => re.test(path.relative(base, f).split(path.sep).join('/'))).map((f) => Uri.file(f));
    },
    fs: {
      readFile: async (u) => fs.readFileSync(u.fsPath),
      stat: async (u) => ({ mtime: fs.statSync(u.fsPath).mtimeMs, type: fs.statSync(u.fsPath).isDirectory() ? 2 : 1 }),
    },
    asRelativePath: (p) => String(p),
    textDocuments: [],
  },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : origLoad.call(this, req, ...rest); };

const assert = require('assert');
const { CoverageStore } = require('../out/coverageStore');
const { CoverageTreeProvider } = require('../out/treeProvider');
const { History } = require('../out/history');
const { markdownSummary, badgeSvg } = require('../out/share');

(async () => {
  const memento = new Memento();
  const history = new History(memento);
  const store = new CoverageStore({ appendLine: () => {} }, history);
  const tree = new CoverageTreeProvider(store);
  const runs = [];
  store.onDidRecordRun((r) => runs.push(r));
  await store.load();

  // Untested file is added at 0% with an estimated line count; generated file still excluded.
  const untested = store.untested();
  assert.deepStrictEqual(untested.map((f) => f.relativePath), ['lib/src/untested.dart']);
  assert.ok(untested[0].linesFound > 0);
  assert.strictEqual(store.tested().length, 3);
  assert.deepStrictEqual(store.totals(false), { linesFound: 7, linesHit: 5 });
  assert.strictEqual(store.packages[0].name, 'app');
  assert.ok(store.packages[0].isFlutter);

  const print = async (nodes, indent = '', depth = 0) => {
    for (const n of nodes) {
      const it = tree.getTreeItem(n);
      console.log(`${indent}${it.label}   ${it.description ?? ''}`);
      if (depth < 3 && it.collapsibleState) await print(await tree.getChildren(n), indent + '    ', depth + 1);
    }
  };
  console.log('--- first run, folder view');
  await print(await tree.getChildren());

  // Second run with better coverage: trend arrows.
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(lcovPath, fs.readFileSync(lcovPath, 'utf8').replace('DA:4,0', 'DA:4,3'));
  await store.load();
  const main = store.all().find((f) => f.relativePath === 'lib/main.dart');
  assert.ok(Math.abs(store.trend(main) - 33.33) < 0.1, 'main.dart trend +33%');
  assert.ok(store.totalTrendDelta > 0);
  assert.strictEqual(history.list().length, 2);
  assert.strictEqual(runs.length, 2, 'two runs recorded');

  // Reloading without a new report doesn't record another run.
  await store.load();
  assert.strictEqual(history.list().length, 2);

  settings.viewMode = 'layers';
  tree.rebuild();
  console.log('--- second run, layers view');
  await print(await tree.getChildren());

  const roots = await tree.getChildren();
  assert.strictEqual(roots[0].kind, 'summary');
  const untestedSection = roots.find((n) => n.kind === 'section' && n.section === 'untested');
  assert.ok(untestedSection);
  const math = store.all().find((f) => f.relativePath === 'lib/src/math.dart');
  const mathNode = tree.findFileNode(math.uri);
  const ranges = await tree.getChildren(mathNode);
  assert.strictEqual(ranges[0].kind, 'range');
  assert.strictEqual(ranges[0].symbol, 'b');

  const md = markdownSummary(store);
  assert.match(md, /Test coverage: /);
  assert.match(md, /no tests/);
  assert.match(badgeSvg('coverage', '72%', '#2ea043'), /<svg/);
  console.log('--- markdown summary\n' + md);
  // Partial run: only main.dart (owned by test/main_test.dart) is replaced; math.dart keeps its data.
  settings.flutterCommand = path.join(__dirname, 'fake-flutter.js');
  // Zip tools don't always keep the executable bit; the stub is run directly, so restore it.
  fs.chmodSync(settings.flutterCommand, 0o755);
  const { runPartialCoverage } = require('../out/runner');
  const appPkg = store.packages[0];
  const { TestResultsStore } = require('../out/results');
  const results = new TestResultsStore(new Memento());
  const res = await runPartialCoverage(appPkg, ['test/main_test.dart'], { appendLine() {}, append() {} }, undefined, results);
  assert.strictEqual(res.code, 0);
  // The JSON results were read: one pass, one failure explained in plain words.
  assert.deepStrictEqual(results.summary.passed, 1);
  assert.strictEqual(results.failed.length, 1);
  assert.strictEqual(results.failed[0].failure.title, 'No widget found with text "Title"');
  fs.rmSync(path.join(root, '.dart_tool'), { recursive: true, force: true });
  const merged = fs.readFileSync(lcovPath, 'utf8');
  assert.match(merged, /SF:lib\/src\/math.dart\nDA:2,1/, 'math.dart untouched by partial run');
  assert.ok(!fs.existsSync(path.join(root, 'coverage/.partial_lcov.info')), 'partial file cleaned up');
  await store.load();

  // Test strength: the >= mutant is caught, the + mutant survives -> one weak spot, file restored.
  const { StrengthChecker } = require('../out/strength');
  const calcUri = Uri.file(path.join(root, 'lib/src/calc.dart'));
  const before = fs.readFileSync(calcUri.fsPath, 'utf8');
  const ctx = { globalStorageUri: Uri.file(path.join(__dirname, '.tmp-storage')) };
  await new StrengthChecker(ctx, store, { appendLine() {}, append() {}, show() {} }).check(calcUri);
  assert.strictEqual(fs.readFileSync(calcUri.fsPath, 'utf8'), before, 'file restored');
  const weak = store.weakSpots(calcUri);
  assert.deepStrictEqual(weak.map((w) => [w.line, w.original.trim(), w.replacement.trim()]), [[6, '+', '-']]);
  console.log('strength message:', vscode.window.messages.pop());
  fs.rmSync(path.join(__dirname, '.tmp-storage'), { recursive: true, force: true });
  console.log('MOCK CHECKS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
