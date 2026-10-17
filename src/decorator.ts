import * as vscode from 'vscode';
import { CoverageStore } from './coverageStore';
import { missedBranchLines } from './lcov';

type HighlightMode = 'gutter' | 'line' | 'both';

/** Paints covered/uncovered lines in every visible editor that has coverage data. */
export class CoverageDecorator implements vscode.Disposable {
  private covered!: vscode.TextEditorDecorationType;
  private uncovered!: vscode.TextEditorDecorationType;
  private weak!: vscode.TextEditorDecorationType;
  private branch!: vscode.TextEditorDecorationType;
  private enabled: boolean;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: CoverageStore,
  ) {
    this.enabled = vscode.workspace.getConfiguration('dartboard').get<boolean>('highlightOnStartup', true);
    this.createTypes();
    this.disposables.push(
      store.onDidChange(() => this.refreshAll()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('dartboard.highlightMode') || e.affectsConfiguration('dartboard.showCoveredLines')) {
          this.disposeTypes();
          this.createTypes();
          this.refreshAll();
        }
      }),
    );
    void this.updateContext();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  toggle(): void {
    this.enabled = !this.enabled;
    void this.updateContext();
    this.refreshAll();
  }

  show(): void {
    if (!this.enabled) {
      this.toggle();
    }
  }

  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.apply(editor);
    }
  }

  private apply(editor: vscode.TextEditor): void {
    const coverage = this.enabled ? this.store.get(editor.document.uri) : undefined;
    if (!coverage || coverage.untested) {
      editor.setDecorations(this.covered, []);
      editor.setDecorations(this.uncovered, []);
      editor.setDecorations(this.weak, []);
      editor.setDecorations(this.branch, []);
      return;
    }
    const weakLines = new Set(this.store.weakSpots(editor.document.uri).map((w) => w.line));
    const branchLines = new Set(missedBranchLines(coverage));
    const showCovered = vscode.workspace.getConfiguration('dartboard').get<boolean>('showCoveredLines', true);
    const lineCount = editor.document.lineCount;
    const coveredRanges: vscode.Range[] = [];
    const uncoveredRanges: vscode.Range[] = [];
    for (const [lineNo, hits] of coverage.lines) {
      const index = lineNo - 1;
      if (index < 0 || index >= lineCount) {
        continue;
      }
      const range = new vscode.Range(index, 0, index, 0);
      if (hits > 0) {
        if (showCovered && !weakLines.has(lineNo) && !branchLines.has(lineNo)) {
          coveredRanges.push(range);
        }
      } else {
        uncoveredRanges.push(range);
      }
    }
    editor.setDecorations(
      this.branch,
      [...branchLines].filter((l) => l - 1 < lineCount && !weakLines.has(l)).map((l) => new vscode.Range(l - 1, 0, l - 1, 0)),
    );
    editor.setDecorations(this.covered, coveredRanges);
    editor.setDecorations(this.uncovered, uncoveredRanges);
    editor.setDecorations(
      this.weak,
      this.store
        .weakSpots(editor.document.uri)
        .filter((w) => w.line - 1 < lineCount)
        .map((w) => new vscode.Range(w.line - 1, 0, w.line - 1, 0)),
    );
  }

  private createTypes(): void {
    const mode = vscode.workspace.getConfiguration('dartboard').get<HighlightMode>('highlightMode', 'both');
    const gutter = mode === 'gutter' || mode === 'both';
    const line = mode === 'line' || mode === 'both';
    const media = (name: string) => vscode.Uri.joinPath(this.context.extensionUri, 'media', name);

    this.covered = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: line ? new vscode.ThemeColor('dartboard.coveredLineBackground') : undefined,
      gutterIconPath: gutter ? media('gutter-covered.png') : undefined,
      gutterIconSize: 'contain',
      overviewRulerColor: 'rgba(46, 160, 67, 0.6)',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.uncovered = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: line ? new vscode.ThemeColor('dartboard.uncoveredLineBackground') : undefined,
      gutterIconPath: gutter ? media('gutter-uncovered.png') : undefined,
      gutterIconSize: 'contain',
      overviewRulerColor: 'rgba(248, 81, 73, 0.8)',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.createBranchType(gutter, line, media);
    this.weak = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('dartboard.weakLineBackground'),
      gutterIconPath: media('gutter-weak.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: 'rgba(210, 153, 34, 0.9)',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
  }

  private createBranchType(gutter: boolean, line: boolean, media: (name: string) => vscode.Uri): void {
    this.branch = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: line ? new vscode.ThemeColor('dartboard.partialLineBackground') : undefined,
      gutterIconPath: gutter ? media('gutter-branch.svg') : undefined,
      gutterIconSize: 'contain',
      overviewRulerColor: 'rgba(210, 153, 34, 0.7)',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
  }

  private disposeTypes(): void {
    this.branch?.dispose();
    this.covered?.dispose();
    this.uncovered?.dispose();
    this.weak?.dispose();
  }

  private updateContext(): Thenable<unknown> {
    return vscode.commands.executeCommand('setContext', 'dartboard.highlightsOn', this.enabled);
  }

  dispose(): void {
    this.disposeTypes();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
