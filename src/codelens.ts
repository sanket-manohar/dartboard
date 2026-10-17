import * as vscode from 'vscode';
import { testCases } from './checklist';
import { CoverageStore } from './coverageStore';
import { analyzeDart } from './dart';
import { formatPercent } from './lcov';
import { ProjectModel } from './project';
import { declaredTests } from './testTools';

/**
 * Above each function: its own coverage and how many test cases are still missing.
 * Above each build(): how much of the widget tree tests rendered.
 * Above each widget test: screen sizes, accessibility and filmstrip.
 */
export class DartboardCodeLens implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(
    private readonly store: CoverageStore,
    private readonly project: ProjectModel,
  ) {
    store.onDidChange(() => this.emitter.fire());
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('dartboard.codeLens') && this.emitter.fire());
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const mode = vscode.workspace.getConfiguration('dartboard').get<string>('codeLens', 'all');
    if (mode === 'off') {
      return [];
    }
    const text = doc.getText();
    if (doc.uri.fsPath.endsWith('_test.dart')) {
      return this.testLenses(doc, text);
    }
    const cov = this.store.get(doc.uri);
    if (!cov || cov.untested || doc.isDirty) {
      return [];
    }
    const lenses: vscode.CodeLens[] = [];
    const blocks = new Map<number, boolean>();
    for (const [k, n] of cov.branchData ?? []) {
      const l = parseInt(k, 10);
      blocks.set(l, (blocks.get(l) ?? false) || n > 0);
    }
    const trees = new Map(this.project.treesFor(doc.uri, text).map((t) => [t.buildLine, t]));

    for (const s of analyzeDart(text).symbols) {
      if (s.kind === 'class' || s.kind === 'getter' || s.kind === 'constructor') {
        continue;
      }
      const range = new vscode.Range(s.startLine - 1, 0, s.startLine - 1, 0);
      const tree = s.name === 'build' ? trees.get(s.startLine) : undefined;
      if (tree) {
        const known = tree.rendered + tree.missed;
        const title = tree.missed
          ? `$(list-tree) ${tree.rendered}/${known} widgets rendered in tests · ${tree.missed} never shown`
          : `$(list-tree) all ${tree.rendered} widgets rendered in tests`;
        lenses.push(new vscode.CodeLens(range, { title, command: 'dartboard.showWidgetTree', arguments: [doc.uri, tree.widget] }));
        continue;
      }
      // Function-level coverage from the lines inside the function.
      let found = 0;
      let hit = 0;
      let firstMissed: number | undefined;
      for (let l = s.startLine; l <= s.endLine; l++) {
        const h = cov.lines.get(l);
        if (h === undefined) {
          continue;
        }
        found++;
        if (h > 0) {
          hit++;
        } else if (firstMissed === undefined) {
          firstMissed = l;
        }
      }
      if (found === 0) {
        continue;
      }
      if (mode === 'uncovered' && hit === found) {
        continue;
      }
      const pct = (hit / found) * 100;
      lenses.push(
        new vscode.CodeLens(range, {
          title: hit === found ? '$(pass) 100% covered' : `$(circle-large-outline) ${formatPercent(pct)} covered`,
          tooltip: hit === found ? 'Every line of this function ran in tests.' : `${found - hit} of ${found} lines never ran. Click to jump to the first one.`,
          command: firstMissed !== undefined ? 'dartboard.openAt' : '',
          arguments: firstMissed !== undefined ? [doc.uri, firstMissed, firstMissed] : undefined,
        }),
      );
      const missing = testCases(text, s, cov.lines, blocks.size ? blocks : undefined).filter((c) => c.status === 'missing').length;
      if (missing) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(checklist) ${missing} case${missing === 1 ? '' : 's'} to test`,
            tooltip: 'See the cases this function needs and add test stubs for them',
            command: 'dartboard.testChecklist',
            arguments: [doc.uri, s.startLine - 1],
          }),
        );
      }
    }
    return lenses;
  }

  private testLenses(doc: vscode.TextDocument, text: string): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    for (const t of declaredTests(text)) {
      if (!t.isWidgetTest) {
        continue;
      }
      const range = new vscode.Range(t.line, 0, t.line, 0);
      lenses.push(
        new vscode.CodeLens(range, { title: '$(device-mobile) Screen sizes', tooltip: 'Run this test on phones, a tablet, large text and dark mode', command: 'dartboard.screenMatrix', arguments: [doc.uri, t.name] }),
        new vscode.CodeLens(range, { title: '$(eye) Accessibility', tooltip: 'Check tap target sizes, labels and text contrast on this screen', command: 'dartboard.checkAccessibility', arguments: [doc.uri, t.line] }),
        new vscode.CodeLens(range, { title: '$(device-camera-video) Filmstrip', tooltip: 'Record every frame of this test and play it back', command: 'dartboard.filmstrip', arguments: [doc.uri, t.name] }),
      );
    }
    return lenses;
  }
}
