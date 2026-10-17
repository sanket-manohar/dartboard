const test = require('node:test');
const assert = require('node:assert');
const { parseLcov, formatPercent, percent, globToRegExp, isExcluded } = require('../out/lcov');

const sample = `SF:lib/main.dart
DA:1,1
DA:2,0
DA:3,4
DA:4,0
LF:4
LH:2
end_of_record
SF:lib/src/user.g.dart
DA:1,1
LF:1
LH:1
end_of_record
SF:lib/main.dart
DA:2,3
end_of_record
`;

test('parses and merges records for the same file', () => {
  const files = parseLcov(sample);
  assert.strictEqual(files.size, 2);
  const main = files.get('lib/main.dart');
  assert.strictEqual(main.linesFound, 4);
  assert.strictEqual(main.linesHit, 3);
  assert.strictEqual(main.lines.get(2), 3);
});

test('handles CRLF and missing end_of_record', () => {
  const files = parseLcov('SF:a.dart\r\nDA:1,0\r\nDA:2,2\r\n');
  assert.strictEqual(files.get('a.dart').linesFound, 2);
  assert.strictEqual(files.get('a.dart').linesHit, 1);
});

test('falls back to LF/LH when there are no DA lines', () => {
  const f = parseLcov('SF:b.dart\nLF:10\nLH:7\nend_of_record\n').get('b.dart');
  assert.strictEqual(f.linesFound, 10);
  assert.strictEqual(f.linesHit, 7);
});

test('formats percentages without rounding up to 100', () => {
  assert.strictEqual(formatPercent(percent(9999, 10000)), '99.9%');
  assert.strictEqual(formatPercent(100), '100%');
  assert.strictEqual(formatPercent(0), '0%');
  assert.strictEqual(formatPercent(percent(2, 3)), '66.7%');
  assert.strictEqual(formatPercent(60), '60%');
  assert.strictEqual(formatPercent(0.01), '0.1%');
  assert.strictEqual(formatPercent(undefined), 'n/a');
});

test('glob exclusion', () => {
  const pats = ['**/*.g.dart', '**/generated/**', 'lib/{a,b}.dart'].map(globToRegExp);
  assert.ok(isExcluded('lib/src/user.g.dart', pats));
  assert.ok(isExcluded('user.g.dart', pats));
  assert.ok(isExcluded('lib/generated/intl/messages.dart', pats));
  assert.ok(isExcluded('lib/b.dart', pats));
  assert.ok(!isExcluded('lib/main.dart', pats));
  assert.ok(!isExcluded('lib/src/gen.dart', pats));
});
