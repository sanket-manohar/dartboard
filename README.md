<p align="center">
  <img src="media/icon-256.png" width="110" alt="Dartboard logo">
</p>

<h1 align="center">Dartboard</h1>

<p align="center"><b>Flutter and Dart testing in one panel.</b><br>
See what your tests really cover, why they fail, and what to test next.</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=sanket-manohar.dartboard"><img src="https://img.shields.io/badge/VS%20Code-Marketplace-0a7bbb" alt="VS Code Marketplace"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=sanket-manohar.dartboard"><img src="https://img.shields.io/badge/version-1.0.0-2ea44f" alt="Version 1.0.0"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

---

## Features

| | |
| --- | --- |
| **Coverage** | Line and branch coverage per file, with untested files shown at 0% so the total is honest. |
| **Widgets** | Every screen and widget tree, with each child marked rendered or never rendered. |
| **States** | Bloc, Cubit, Riverpod and ChangeNotifier events and states your tests reached or missed. |
| **Failures** | Each failure as a title, the line to fix, expected vs. actual, and a hint. |
| **In the editor** | Gutter marks, coverage above each function, untested cases with one-click test stubs. |
| **Widget tests** | Run on 5 screen sizes, check accessibility, and scrub a filmstrip of every frame. |
| **Reports** | A PDF audit report, coverage history, and a README badge for your project. |

Everything runs on your machine. No account, no server, no internet needed.

## Quick start

1. Open a Flutter or Dart project in VS Code.
2. Click the **Dartboard** icon in the activity bar.
3. Press **▶** to run your tests and see the results.

Use **⚡** to run only the tests affected by your changes, and **…** for everything else.

<details>
<summary><b>Settings</b></summary>

| Setting | Default | Description |
| --- | --- | --- |
| `dartboard.testCommand` | `flutter test --coverage` | Command for the full run (▶ in the panel title). |
| `dartboard.flutterCommand` | `flutter` | Executable for background runs (single file, live, strength, mapping). |
| `dartboard.lcovGlob` | `**/coverage/lcov.info` | Where to find reports. Several are merged. |
| `dartboard.exclude` | generated files | Globs left out everywhere. |
| `dartboard.goal` | `80` | Coverage goal (0 hides it). |
| `dartboard.showUntestedFiles` | `true` | List files no test imports at 0%. |
| `dartboard.includeUntestedInTotal` | `true` | Count them in totals (estimated line counts). |
| `dartboard.viewMode` | `tree` | `tree`, `flat` or `layers`. |
| `dartboard.sortBy` | `coverageAsc` | `coverageAsc`, `coverageDesc` or `name`. |
| `dartboard.changedFilesOnly` | `false` | Only files changed on this git branch. |
| `dartboard.liveCoverage` | `false` | Re-run a file's tests on save. |
| `dartboard.maxMutations` | `15` | Changes tried per file by Check Test Strength. |
| `dartboard.lowThreshold` / `highThreshold` | `50` / `80` | Red / amber / green cut-offs. |
| `dartboard.highlightMode` | `both` | `gutter`, `line` or `both`. |
| `dartboard.branchCoverage` | `true` | Collect branch coverage (`--branch-coverage`). |
| `dartboard.codeLens` | `all` | `all`, `uncovered` or `off` for the hints above code. |
| `dartboard.testPitfalls` | `true` | Warn about common widget test mistakes. |
| `dartboard.screenMatrix` | 5 setups | Screen sizes and themes for **Screen sizes**. |
| `dartboard.includeIntegrationCoverage` | `true` | Merge integration test coverage into the totals. |

</details>

<details>
<summary><b>Notes</b></summary>

- Git is optional. Without it, the "changed files" filter is hidden and the risk radar uses coverage and complexity only.
- Test files are matched by name: `lib/src/auth/login.dart` ↔ `test/auth/login_test.dart`.
- Check Test Strength edits the file temporarily and always restores it, even after a crash (on next start).
- Untested files' line counts are estimates from a lightweight Dart parser.
- Widget trees, screens and states are read from your source without running the analyzer. Widgets inside a `const` subtree or a conditional that coverage can't see into are marked *unknown* rather than guessed.
- Screen sizes and Filmstrip write a temporary test file next to yours and delete it afterwards.

</details>

## Development

```bash
npm install
npm test          # compile and run all checks
npm run package   # build the .vsix
```

Press `F5` in VS Code to try it in a development window.

## License

[MIT](LICENSE) © Sanket Santosh Vidya Manohar
