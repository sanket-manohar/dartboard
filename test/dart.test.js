const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const d = require('../out/dart');
const p = require('../out/paths');
const { uncoveredRanges, serializeLcov, parseLcov } = require('../out/lcov');

const src = fs.readFileSync(path.join(__dirname, 'fixture/sample.dart'), 'utf8');

test('finds classes, methods, getters and functions', () => {
  const a = d.analyzeDart(src);
  const names = a.symbols.map((s) => `${s.kind}:${s.parent ? s.parent + '.' : ''}${s.name}`);
  for (const n of ['class:LoginBloc', 'method:LoginBloc.login', 'getter:LoginBloc.isLoggedIn', 'class:LoginPage', 'method:LoginPage.build', 'function:greet']) {
    assert.ok(names.includes(n), `missing ${n} in ${names}`);
  }
  assert.ok(a.symbols.find((s) => s.name === 'LoginPage').isWidget);
  assert.strictEqual(d.enclosingSymbol(a.symbols, 11), 'LoginBloc.login');
  assert.ok(a.complexity >= 3);
  assert.ok(a.executableLines > 5);
});

test('ignores code-like text in comments and strings', () => {
  const a = d.analyzeDart("// void fake() {}\nString s = 'void alsoFake() {}';\nvoid real() {\n  print(1);\n}\n");
  assert.deepStrictEqual(a.symbols.map((s) => s.name), ['real']);
});

test('generates a test skeleton with groups and widget tests', () => {
  const a = d.analyzeDart(src);
  const out = d.generateTestSkeleton('myapp', 'src/login.dart', true, a.symbols);
  assert.match(out, /import 'package:myapp\/src\/login.dart';/);
  assert.match(out, /group\('LoginBloc'/);
  assert.match(out, /test\('login'/);
  assert.match(out, /testWidgets\('renders'/);
  assert.doesNotMatch(out, /_score/);
  assert.doesNotMatch(out, /extension/);
});

test('mutants only touch code, and applying them changes one operator', () => {
  const m = d.findMutants(src, [10, 15, 20], 10);
  assert.strictEqual(m.length, 3);
  const mutated = d.applyMutant(src, m[1]);
  assert.match(mutated.split('\n')[14], /ok != true/);
  assert.strictEqual(d.findMutants("var s = 'a == b';\n", [1], 5).length, 0);
});

test('layers and test paths', () => {
  assert.strictEqual(p.layerOf('lib/features/auth/login_bloc.dart'), 'State');
  assert.strictEqual(p.layerOf('lib/screens/home.dart'), 'UI');
  assert.strictEqual(p.layerOf('lib/data/user_repository.dart'), 'Data');
  assert.strictEqual(p.layerOf('lib/main.dart'), 'Other');
  assert.deepStrictEqual(p.testsForSource('lib/src/auth/login.dart', ['test/auth/login_test.dart', 'test/x/login_test.dart']), ['test/auth/login_test.dart']);
  assert.strictEqual(p.testPathForSource('lib/src/auth/login.dart'), 'test/auth/login_test.dart');
});

test('uncovered ranges and lcov round trip', () => {
  const lines = new Map([[1, 1], [2, 0], [3, 0], [5, 0], [6, 2], [8, 0]]);
  assert.deepStrictEqual(uncoveredRanges(lines), [[2, 5], [8, 8]]);
  const parsed = parseLcov('SF:lib/a.dart\nDA:1,1\nDA:2,0\nend_of_record\n');
  const again = parseLcov(serializeLcov(parsed.values()));
  assert.strictEqual(again.get('lib/a.dart').linesHit, 1);
  assert.strictEqual(again.get('lib/a.dart').linesFound, 2);
});

test('long doc comments stay fast to scan', () => {
  const doc = Array.from({ length: 80 }, (_, i) => `/// Line ${i} of a long doc comment about [things] and \`code\`.`).join('\n');
  const started = Date.now();
  const result = d.analyzeDart(`${doc}\nvoid f() {\n  print(1);\n}\n`);
  assert.ok(Date.now() - started < 250, `took ${Date.now() - started} ms`);
  assert.deepStrictEqual(result.symbols.map((s) => `${s.name}@${s.startLine}`), ['f@81']);
});

test('Windows line endings give the same results', () => {
  const src = fs.readFileSync(path.join(__dirname, 'fixture/features/pit_test.dart'), 'utf8').replace(/\r\n/g, '\n');
  const { findPitfalls } = require('../out/pitfalls');
  assert.deepStrictEqual(findPitfalls(src.replace(/\n/g, '\r\n')), findPitfalls(src));
  assert.deepStrictEqual(d.analyzeDart(src.replace(/\n/g, '\r\n')).symbols, d.analyzeDart(src).symbols);
});
