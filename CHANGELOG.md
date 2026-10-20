# Changelog

## 1.0.2

- If Dartboard can't start, it now says why in a message and in the Dartboard output, instead of commands silently missing.

## 1.0.1

**Fixes**
- The panel stayed empty and commands stopped responding on larger projects. Reading the project is now about 20 times faster, and the panel shows right away while widgets and states load.
- One file the scanner can't read no longer blanks the whole panel. It's skipped and the rest still shows.
- Generated files (`*.g.dart`, `*.freezed.dart`, l10n and others in `dartboard.exclude`) are no longer scanned for screens and states.
- Windows: running a single test by name, and paths with spaces, now work.
- Windows: quick fixes on files with Windows line endings insert at the right place.

## 1.0.0

First release.

**Panel**
- Summary ring with your coverage goal, branch coverage, trend since the last run and the last test result.
- **Files:** every file's coverage with an honest total. Files no test imports are listed at 0% ("Not tested yet").
- **Widgets:** each screen (from GoRouter, named routes, AutoRoute or screen classes) and each widget's build tree, marked rendered, never rendered or unknown, with buttons and fields that have no Key.
- **States:** events, methods and states reached for Bloc, Cubit, Riverpod Notifier and ChangeNotifier.
- **Tests:** failures explained in plain words with the line to fix and a hint, slowest tests, test pyramid and common test mistakes.

**In the editor**
- Line, gutter and branch coverage highlights, with "next uncovered line".
- Above each function: its coverage and the test cases still missing, with one-click test stubs.
- Above each widget test: run on several screen sizes and themes, accessibility checks, and a filmstrip of every frame.
- Warnings with quick fixes for common widget test mistakes.
- "Which test covers this line?" on hover.

**Tools**
- Run tests for one file or folder, live coverage on save, and run only the tests affected by your changes.
- Integration tests on a device, merged into coverage.
- Check Test Strength: small temporary code changes reveal lines that run but aren't really tested.
- Insights: coverage map, history and risk radar.
- Create Test File, PR summary, README badge and a PDF audit report.
