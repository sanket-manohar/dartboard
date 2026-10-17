const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseLcov, missedBranchLines, serializeLcov } = require('../out/lcov');
const { parseTestEvents, explainFailure } = require('../out/testEvents');
const { widgetTrees, findRoutes, countTests } = require('../out/widgets');
const { stateCoverage } = require('../out/states');
const { findPitfalls } = require('../out/pitfalls');
const { testCases, caseStubs } = require('../out/checklist');
const { analyzeDart } = require('../out/dart');
const { ImportGraph } = require('../out/imports');
const { Pdf } = require('../out/pdf');

const F = path.join(__dirname, 'fixture/features');
const read = (f) => fs.readFileSync(path.join(F, f), 'utf8');
const home = () => [...parseLcov(read('lcov.info')).values()][0];
const blocksOf = (f) => {
  const m = new Map();
  for (const [k, n] of f.branchData) {
    const l = parseInt(k, 10);
    m.set(l, (m.get(l) ?? false) || n > 0);
  }
  return m;
};

test('branch coverage is parsed, merged and written back', () => {
  const f = home();
  assert.strictEqual(f.branchesFound, 8);
  assert.strictEqual(f.branchesHit, 5);
  // Line 15 ran but the block under it (the `n > 3` case) never did.
  assert.deepStrictEqual(missedBranchLines(f), [15]);
  const again = [...parseLcov(serializeLcov([f])).values()][0];
  assert.strictEqual(again.branchesHit, 5);
});

test('test results: failures are explained', () => {
  const run = parseTestEvents(read('events.json'));
  assert.strictEqual(run.success, false);
  assert.deepStrictEqual(run.tests.map((t) => [t.name, t.status]).sort(), [['finds save', 'failed'], ['home a11y', 'failed'], ['increments', 'passed'], ['plain', 'passed']]);
  const save = run.tests.find((t) => t.name === 'finds save').failure;
  assert.strictEqual(save.title, 'No widget found with text "Save"');
  assert.strictEqual(save.location.line, 15);
  const a11y = run.tests.find((t) => t.name === 'home a11y').failure;
  assert.strictEqual(a11y.title, '2 accessibility problems');
  assert.match(a11y.items[1], /Low text contrast/);
});

test('overflow failures point at the widget', () => {
  const raw = `══╡ EXCEPTION CAUGHT BY RENDERING LIBRARY ╞══
The following assertion was thrown during layout:
A RenderFlex overflowed by 280 pixels on the right.

The relevant error-causing widget was:
  Row
  Row:file:///home/dev/lab/lib/screens/home.dart:35:17`;
  const f = explainFailure(raw, '/home/dev/lab/test/widget_test.dart');
  assert.strictEqual(f.title, 'Row overflows by 280 px on the right');
  assert.deepStrictEqual(f.widget, { name: 'Row', file: '/home/dev/lab/lib/screens/home.dart', line: 35, column: 17 });
  // Same message on one line.
  const one = explainFailure(raw.replace('Row\n  Row:', 'Row Row:'), '/home/dev/lab/test/widget_test.dart');
  assert.strictEqual(one.widget.line, 35);
});

test('widget tree: rendered, missed and unknown children', () => {
  const [tree] = widgetTrees(read('home.dart'), home().lines);
  assert.strictEqual(tree.widget, 'HomeScreen');
  assert.strictEqual(tree.missed, 1, 'the "Wow" text behind if (count > 5)');
  assert.strictEqual(tree.unkeyedInteractive.length, 1, 'ElevatedButton without a Key');
  const names = [];
  const walk = (n) => { names.push(`${n.name}:${n.status}`); n.children.forEach(walk); };
  tree.roots.forEach(walk);
  assert.ok(names.includes('Scaffold:rendered'));
  assert.ok(names.includes('Center:unknown'));
});

test('routes are found from GoRouter and named routes', () => {
  const routes = findRoutes(`
final router = GoRouter(routes: [
  GoRoute(path: '/', builder: (c, s) => const HomeScreen()),
  GoRoute(path: '/settings', builder: (c, s) => SettingsPage(id: 1)),
]);
final app = MaterialApp(routes: {'/profile': (c) => const ProfileView()});`);
  assert.deepStrictEqual(routes.map((r) => [r.path, r.screen]), [['/', 'HomeScreen'], ['/settings', 'SettingsPage'], ['/profile', 'ProfileView']]);
  assert.deepStrictEqual(countTests(read('pit_test.dart')), { unit: 1, widget: 3, golden: 0 });
});

test('state coverage for Bloc and ChangeNotifier', () => {
  const lines = new Map([[14, 1], [15, 1], [16, 1], [17, 1], [18, 1], [19, 0], [24, 1], [25, 1], [26, 1], [27, 1], [28, 1], [30, 0]]);
  const [bloc, notifier] = stateCoverage([{ path: 'counter_bloc.dart', text: read('counter_bloc.dart'), lines }]);
  assert.deepStrictEqual([bloc.name, bloc.kind, bloc.reached, bloc.total], ['CounterBloc', 'Bloc', 3, 6]);
  assert.deepStrictEqual([notifier.name, notifier.kind, notifier.reached, notifier.total], ['Settings', 'ChangeNotifier', 1, 2]);
});

test('widget test pitfalls with fixes', () => {
  const found = findPitfalls(read('pit_test.dart'));
  assert.deepStrictEqual(found.map((p) => p.code), ['needs-app', 'missing-pump', 'missing-await', 'real-delay', 'no-expect']);
  assert.ok(found.find((p) => p.code === 'missing-pump').fix);
});

test('test case checklist uses branch coverage', () => {
  const src = read('home.dart');
  const fn = analyzeDart(src).symbols.find((s) => s.name === 'label');
  const f = home();
  const cases = testCases(src, fn, f.lines, blocksOf(f));
  assert.deepStrictEqual(cases.map((c) => [c.title, c.status]), [['when n > 3', 'missing'], ['when n == 0', 'covered']]);
  assert.match(caseStubs('label', cases), /test\('label when n > 3'/);
});

test('affected tests follow imports transitively', () => {
  const g = new ImportGraph([
    { path: 'lib/a.dart', text: "import 'b.dart';" },
    { path: 'lib/b.dart', text: '' },
    { path: 'test/a_test.dart', text: "import 'package:app/a.dart';" },
    { path: 'test/c_test.dart', text: '' },
  ], 'app');
  assert.deepStrictEqual(g.affectedTests(['lib/b.dart'], (p) => p.startsWith('test/')), ['test/a_test.dart']);
});

test('pdf writer produces a valid document', () => {
  const pdf = new Pdf();
  pdf.addPage();
  pdf.text(40, 40, 'Café ✓ report', { size: 14, bold: true });
  pdf.arc(100, 100, 30, 0, 270, [0.2, 0.6, 0.3], 6);
  const buf = pdf.build('Report', 'Dartboard');
  const s = buf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.'));
  assert.match(s, /\/Type \/Catalog/);
  assert.match(s, /startxref\s+\d+\s+%%EOF\s*$/);
});
