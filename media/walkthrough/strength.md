# Check that tests really test

A green line only means a test *ran* it, not that a test *checked* it.

**Check Test Strength** (right-click a file) makes tiny changes to covered code, one at a time:

- `>` → `<=`, `==` → `!=`
- `&&` → `||`
- `true` → `false`, `+` → `-`

and runs the file's tests after each one. If no test fails, that line is a **weak spot**, marked in amber with a ⚠ in the panel.

Your file is always restored afterwards, even if VS Code closes mid-check.

## Which test covers this line?

Run **Map Tests to Lines** once from the panel's `⋯` menu, then hover any green line to see the tests that cover it and run them with one click.
