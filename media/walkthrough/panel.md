# Read the panel

The ring at the top is your line coverage, with your goal as a tick. Under it: branch coverage, the trend since your last run and the result of the last test run (click it for the Tests tab).

| Tab | What it tells you |
| --- | --- |
| **Files** | Every folder and file with its coverage. Expand a file for uncovered lines like *Lines 42–58 in login()*. |
| **Widgets** | Each screen and widget's build tree, marked rendered, never rendered, or unknown. Buttons without a `Key` are flagged because tests can't find them reliably. |
| **States** | For each Bloc, Cubit, Notifier or ChangeNotifier: which events, methods and states your tests reached. |
| **Tests** | Failures explained in plain words with the line to fix, screen size results, the slowest tests, your test pyramid and test mistakes. |

Top icons: **▶** run all · **⚡** run only tests affected by your changes · **PDF** audit report · **filter** options. Everything else is in **…**.

Colours: 🔴 below 50% · 🟡 50–80% · 🟢 80% and up. Amber gutter bars mark lines where only one branch ran.
