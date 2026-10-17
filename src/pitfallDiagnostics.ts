import * as vscode from 'vscode';
import { findPitfalls, Pitfall } from './pitfalls';
import { isGeneratedWrapper } from './testTools';

/** Shows widget test pitfalls as warnings in open test files, with one-click fixes. */
export class PitfallDiagnostics implements vscode.CodeActionProvider, vscode.Disposable {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];
  private readonly collection = vscode.languages.createDiagnosticCollection('Dartboard test pitfalls');
  private readonly fixes = new WeakMap<vscode.Diagnostic, Pitfall>();
  private readonly subs: vscode.Disposable[] = [];
  private timers = new Map<string, NodeJS.Timeout>();

  constructor() {
    this.subs.push(
      vscode.workspace.onDidOpenTextDocument((d) => this.schedule(d)),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document)),
      vscode.workspace.onDidCloseTextDocument((d) => this.collection.delete(d.uri)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('dartboard.testPitfalls')) {
          this.collection.clear();
          vscode.workspace.textDocuments.forEach((d) => this.schedule(d));
        }
      }),
    );
    vscode.workspace.textDocuments.forEach((d) => this.schedule(d));
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('dartboard').get<boolean>('testPitfalls', true);
  }

  private schedule(doc: vscode.TextDocument): void {
    if (doc.languageId !== 'dart' || !doc.uri.fsPath.endsWith('_test.dart') || isGeneratedWrapper(doc.uri.fsPath)) {
      return;
    }
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => this.update(doc), 400));
  }

  private update(doc: vscode.TextDocument): void {
    if (!this.enabled()) {
      this.collection.delete(doc.uri);
      return;
    }
    const diagnostics = findPitfalls(doc.getText()).map((p) => {
      const d = new vscode.Diagnostic(
        new vscode.Range(p.line - 1, p.column, p.line - 1, Math.max(p.endColumn, p.column + 1)),
        p.message,
        p.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information,
      );
      d.source = 'Dartboard';
      d.code = p.code;
      this.fixes.set(d, p);
      return d;
    });
    this.collection.set(doc.uri, diagnostics);
  }

  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const d of context.diagnostics) {
      const p = d.source === 'Dartboard' ? this.fixes.get(d) : undefined;
      if (!p?.fix) {
        continue;
      }
      const action = new vscode.CodeAction(p.fix.title, vscode.CodeActionKind.QuickFix);
      const edit = new vscode.WorkspaceEdit();
      for (const e of p.fix.edits) {
        const start = new vscode.Position(e.line - 1, e.column);
        const end = e.endColumn !== undefined ? new vscode.Position((e.endLine ?? e.line) - 1, e.endColumn) : start;
        edit.replace(doc.uri, new vscode.Range(start, end), e.text);
      }
      action.edit = edit;
      action.diagnostics = [d];
      action.isPreferred = true;
      actions.push(action);
    }
    return actions;
  }

  dispose(): void {
    this.collection.dispose();
    this.subs.forEach((s) => s.dispose());
    this.timers.forEach((t) => clearTimeout(t));
  }
}
