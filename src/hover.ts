import * as path from 'path';
import * as vscode from 'vscode';
import { CoverageStore } from './coverageStore';
import { missedBranchLines } from './lcov';
import { TestMap } from './testMap';

/** Hover on Dart lines: which tests cover the line, and why a weak spot is weak. */
export class CoverageHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly store: CoverageStore,
    private readonly testMap: TestMap,
  ) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const coverage = this.store.get(document.uri);
    if (!coverage || coverage.untested) {
      return undefined;
    }
    const line = position.line + 1;
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ['dartboard.openTest', 'dartboard.runSingleTest'] };

    const weak = this.store.weakSpots(document.uri).find((w) => w.line === line);
    if (weak) {
      md.appendMarkdown(
        `**$(warning) Weak test spot.** Changing \`${weak.original.trim()}\` to \`${weak.replacement.trim()}\` here did not make any test fail. ` +
          `Add an \`expect\` that checks the result of this line.\n\n`,
      );
    }

    if (!weak && missedBranchLines(coverage).includes(line)) {
      md.appendMarkdown(
        `**$(git-compare) Partly tested.** This line ran, but a code path that starts here never did (for example the body of an \`if\`, or one side of \`?:\`, \`&&\` or \`??\`). ` +
          `Add a test where that path is taken.\n\n`,
      );
    }

    const hits = coverage.lines.get(line);
    if (hits !== undefined && hits > 0 && this.testMap.available) {
      const tests = this.testMap.testsFor(document.uri, line);
      if (tests.length) {
        md.appendMarkdown(`**Covered by ${tests.length} test file${tests.length === 1 ? '' : 's'}:**\n\n`);
        for (const t of tests.slice(0, 8)) {
          const args = encodeURIComponent(JSON.stringify([path.join(t.root, t.test)]));
          md.appendMarkdown(
            `- [${t.test}](command:dartboard.openTest?${args}) · [$(play) run](command:dartboard.runSingleTest?${args})\n`,
          );
        }
        if (tests.length > 8) {
          md.appendMarkdown(`- …and ${tests.length - 8} more\n`);
        }
      }
    }
    return md.value ? new vscode.Hover(md) : undefined;
  }
}
