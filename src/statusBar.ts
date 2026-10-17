import * as vscode from 'vscode';
import { CoverageStore } from './coverageStore';
import { formatPercent, percent } from './lcov';
import { levelFor } from './thresholds';
import { trendText } from './treeProvider';

/** Shows the active file's line coverage; clicking it reveals the file in the panel. */
export class CoverageStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly store: CoverageStore) {
    this.item = vscode.window.createStatusBarItem('dartboard.status', vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'Dartboard';
    this.disposables.push(
      this.item,
      store.onDidChange(() => this.update()),
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
    );
    this.update();
  }

  update(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'dart') {
      this.item.hide();
      return;
    }
    const coverage = this.store.get(editor.document.uri);
    if (!coverage) {
      if (!this.store.hasData) {
        this.item.text = '$(graph) Coverage';
        this.item.tooltip = 'No coverage report loaded. Click to run tests with coverage.';
        this.item.command = 'dartboard.run';
      } else {
        this.item.text = '$(graph) No coverage';
        this.item.tooltip = 'This file is not in the coverage report (no test imports it, or it is excluded).';
        this.item.command = 'dartboard.files.focus';
      }
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }
    if (coverage.untested) {
      this.item.text = '$(graph) 0% · no tests';
      this.item.tooltip = 'No test imports this file. Click to create a test file for it.';
      this.item.command = { command: 'dartboard.createTest', title: 'Create test', arguments: [editor.document.uri] };
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      this.item.show();
      return;
    }
    const pct = percent(coverage.linesHit, coverage.linesFound);
    const level = levelFor(pct);
    const trend = this.store.trend(coverage);
    this.item.text = `$(graph) ${formatPercent(pct)}${trend !== undefined ? ` ${trendText(trend)}` : ''}`;
    this.item.tooltip = `Line coverage for ${coverage.relativePath}: ${formatPercent(pct)} (${coverage.linesHit}/${coverage.linesFound}). Click to show in the Coverage panel.`;
    this.item.command = { command: 'dartboard.revealActive', title: 'Reveal in Coverage panel' };
    this.item.backgroundColor =
      level === 'low'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : level === 'medium'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
    this.item.show();
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
