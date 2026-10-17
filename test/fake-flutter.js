#!/usr/bin/env node
// Stand-in for `flutter` in tests. `test --coverage --coverage-path=X ...` writes a fake report;
// plain `test ...` fails when calc.dart's `>=` was mutated (so that mutant is caught) and passes otherwise.
const fs = require('fs');
const args = process.argv.slice(2);
const cov = args.find((a) => a.startsWith('--coverage-path='));
const report = args.find((a) => a.startsWith('--file-reporter=json:'));
if (report) {
  // One passing and one failing test, in the format of flutter test's JSON reporter.
  const suite = require('path').resolve('test/main_test.dart');
  const ev = [
    { type: 'start', time: 0 },
    { type: 'suite', suite: { id: 0, path: suite }, time: 1 },
    { type: 'testStart', test: { id: 1, name: 'adds', suiteID: 0, line: 4, url: 'file://' + suite }, time: 2 },
    { type: 'testDone', testID: 1, result: 'success', hidden: false, skipped: false, time: 40 },
    { type: 'testStart', test: { id: 2, name: 'shows title', suiteID: 0, line: 9, url: 'file://' + suite }, time: 41 },
    { type: 'error', testID: 2, error: 'Expected: exactly one matching candidate\n  Actual: _TextWidgetFinder:<Found 0 widgets with text "Title": []>', stackTrace: 'test/main_test.dart 12:5  main.<fn>', isFailure: true, time: 90 },
    { type: 'testDone', testID: 2, result: 'failure', hidden: false, skipped: false, time: 95 },
    { type: 'done', success: false, time: 100 },
  ];
  const file = report.slice('--file-reporter=json:'.length);
  require('fs').mkdirSync(require('path').dirname(file), { recursive: true });
  fs.writeFileSync(file, ev.map((e) => JSON.stringify(e)).join('\n'));
}
if (cov) {
  fs.writeFileSync(cov.split('=')[1], 'SF:lib/main.dart\nDA:2,1\nDA:3,1\nDA:4,1\nend_of_record\nSF:lib/src/math.dart\nDA:2,0\nDA:5,0\nend_of_record\n');
  process.exit(0);
}
const calc = fs.readFileSync('lib/src/calc.dart', 'utf8');
process.exit(calc.includes('age < 18') ? 1 : 0);
