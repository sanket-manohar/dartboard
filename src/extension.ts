import * as vscode from 'vscode';
import { createTestFile, PartialRunner } from './actions';
import { CoverageStore } from './coverageStore';
import { DartboardCodeLens } from './codelens';
import { CoverageDecorator } from './decorator';
import { History } from './history';
import { CoverageHoverProvider } from './hover';
import { InsightsPanel } from './insights';
import { formatPercent, percent } from './lcov';
import { PitfallDiagnostics } from './pitfallDiagnostics';
import { ProjectModel } from './project';
import { writeAuditReport } from './report';
import { TestResultsStore } from './results';
import { runCoverage } from './runner';
import { share } from './share';
import { CoverageStatusBar } from './statusBar';
import { StrengthChecker } from './strength';
import { TestMap } from './testMap';
import { TestTools } from './testTools';
import { CoveragePanelView } from './panelView';
import { CoverageNode, CoverageTreeProvider, SortBy, ViewMode } from './treeProvider';

const WALKTHROUGH_SHOWN = 'dartboard.walkthroughShown';

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Dartboard');
  try {
    return await start(context, output);
  } catch (err) {
    // Show startup failures instead of leaving commands silently missing.
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    output.appendLine(`Dartboard ${context.extension.packageJSON.version} could not start on ${process.platform} (VS Code ${vscode.version}):`);
    output.appendLine(detail);
    const show = 'Show details';
    if ((await vscode.window.showErrorMessage(`Dartboard could not start: ${err instanceof Error ? err.message : String(err)}`, show)) === show) {
      output.show();
    }
    throw err;
  }
}

async function start(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
  const history = new History(context.workspaceState);
  const store = new CoverageStore(output, history);
  const tree = new CoverageTreeProvider(store);
  const project = new ProjectModel(store);
  const results = new TestResultsStore(context.workspaceState);
  const panel = new CoveragePanelView(context.extensionUri, store, tree, project, results);
  const decorator = new CoverageDecorator(context, store);
  const statusBar = new CoverageStatusBar(store);
  const partial = new PartialRunner(store, output, results);
  const tools = new TestTools(context, store, project, results, partial, output);
  const pitfalls = new PitfallDiagnostics();
  const strength = new StrengthChecker(context, store, output);
  const testMap = new TestMap(context, store, output);
  const insights = new InsightsPanel(store, vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png'));
  const config = () => vscode.workspace.getConfiguration('dartboard');

  // Register the panel first so it always appears, even if a later startup step is slow.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('dartboard.files', panel, { webviewOptions: { retainContextWhenHidden: true } }),
  );

  await strength.restoreLeftovers();
  tools.cleanupLeftovers().catch((err) => output.appendLine(`Cleanup failed: ${String(err)}`));

  // Debounced reload so a burst of watcher events (write + rename) loads once.
  let reloadTimer: NodeJS.Timeout | undefined;
  const scheduleReload = () => {
    if (reloadTimer) {
      clearTimeout(reloadTimer);
    }
    reloadTimer = setTimeout(() => void store.load(), 400);
  };

  let watcher: vscode.FileSystemWatcher | undefined;
  const createWatcher = () => {
    watcher?.dispose();
    watcher = vscode.workspace.createFileSystemWatcher(config().get<string>('lcovGlob', '**/coverage/lcov.info'));
    watcher.onDidCreate(scheduleReload);
    watcher.onDidChange(scheduleReload);
    watcher.onDidDelete(scheduleReload);
  };
  createWatcher();

  const setConfig = (key: string, value: unknown) =>
    config().update(key, value, vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);

  /** Tree context menus pass the node; editor menus pass a Uri; the palette passes nothing. */
  const targetUri = (arg?: CoverageNode | vscode.Uri | { uri?: string }): vscode.Uri | undefined => {
    if (arg instanceof vscode.Uri) {
      return arg;
    }
    // Right-click menus in the panel pass the row's data-vscode-context object.
    if (arg && !('kind' in arg) && 'uri' in arg) {
      return typeof arg.uri === 'string' ? vscode.Uri.parse(arg.uri) : undefined;
    }
    if (arg && 'kind' in arg) {
      if (arg.kind === 'file' || arg.kind === 'range' || arg.kind === 'weak') {
        return arg.file.uri;
      }
      if (arg.kind === 'folder' && arg.fsPath) {
        return vscode.Uri.file(arg.fsPath);
      }
    }
    return vscode.window.activeTextEditor?.document.uri;
  };

  const openWalkthrough = () =>
    vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#gettingStarted`, false);

  context.subscriptions.push(
    output,
    store,
    tree,
    panel,
    decorator,
    statusBar,
    partial,
    insights,
    project,
    results,
    pitfalls,
    vscode.languages.registerCodeLensProvider({ language: 'dart', scheme: 'file' }, new DartboardCodeLens(store, project)),
    vscode.languages.registerCodeActionsProvider({ language: 'dart', scheme: 'file' }, pitfalls, { providedCodeActionKinds: PitfallDiagnostics.kinds }),
    { dispose: () => watcher?.dispose() },
    { dispose: () => reloadTimer && clearTimeout(reloadTimer) },
    vscode.languages.registerHoverProvider({ language: 'dart', scheme: 'file' }, new CoverageHoverProvider(store, testMap)),

    vscode.commands.registerCommand('dartboard.run', async () => {
      const run = await runCoverage(output);
      if (!run) {
        return;
      }
      const exitCode = run.code;
      if (run.results) {
        results.ingest(run.results);
      }
      await store.load();
      decorator.show();
      const totals = store.totals();
      const pct = formatPercent(percent(totals.linesHit, totals.linesFound));
      if (exitCode !== 0) {
        const failed = results.summary.failed + results.brokenSuites.length;
        if (failed) {
          void panel.showTab('tests');
        }
        void vscode.window.showWarningMessage(
          failed
            ? `${failed} test${failed === 1 ? '' : 's'} failed.${store.hasData ? ` Coverage loaded: ${pct}.` : ''}`
            : store.hasData
              ? `Tests finished with failures (exit code ${exitCode}). Coverage loaded: ${pct}.`
              : `Tests failed (exit code ${exitCode}) and no coverage report was produced.`,
        );
      } else if (store.hasData) {
        void vscode.window.setStatusBarMessage(`$(graph) Coverage updated: ${pct}`, 5000);
      } else {
        void vscode.window.showWarningMessage(
          'Tests passed but no lcov.info was found. Check the "dartboard.lcovGlob" setting.',
        );
      }
    }),

    vscode.commands.registerCommand('dartboard.refresh', async () => {
      await store.load();
      if (!store.hasData) {
        void vscode.window.showInformationMessage(
          'No coverage/lcov.info found. Run "Dartboard: Run Tests with Coverage" first.',
        );
      }
    }),

    vscode.commands.registerCommand('dartboard.clear', () => {
      store.clear();
      results.clear();
    }),

    vscode.commands.registerCommand('dartboard.toggleHighlights', () => decorator.toggle()),

    vscode.commands.registerCommand('dartboard.toggleViewMode', async () => {
      const order: ViewMode[] = ['tree', 'flat', 'layers'];
      await setConfig('viewMode', order[(order.indexOf(tree.viewMode) + 1) % order.length]);
    }),

    vscode.commands.registerCommand('dartboard.changeSort', async () => {
      const options: { label: string; value: SortBy }[] = [
        { label: 'Least covered first', value: 'coverageAsc' },
        { label: 'Most covered first', value: 'coverageDesc' },
        { label: 'Name', value: 'name' },
      ];
      const pick = await vscode.window.showQuickPick(
        options.map((o) => ({ ...o, description: o.value === tree.sortBy ? 'current' : undefined })),
        { placeHolder: 'Sort coverage panel by' },
      );
      if (pick) {
        await setConfig('sortBy', pick.value);
      }
    }),

    vscode.commands.registerCommand('dartboard.viewOptions', async () => {
      const on = (b: boolean) => (b ? '$(check)' : '$(blank)');
      type Item = vscode.QuickPickItem & { run?: () => Thenable<unknown> | void };
      const mode = tree.viewMode;
      const sort = tree.sortBy;
      const items: Item[] = [
        { label: 'Group files by', kind: vscode.QuickPickItemKind.Separator },
        { label: `${on(mode === 'tree')} Folders`, run: () => setConfig('viewMode', 'tree') },
        { label: `${on(mode === 'layers')} App layers`, description: 'UI · State · Data · Utils', run: () => setConfig('viewMode', 'layers') },
        { label: `${on(mode === 'flat')} Flat list`, run: () => setConfig('viewMode', 'flat') },
        { label: 'Sort by', kind: vscode.QuickPickItemKind.Separator },
        { label: `${on(sort === 'coverageAsc')} Least covered first`, run: () => setConfig('sortBy', 'coverageAsc') },
        { label: `${on(sort === 'coverageDesc')} Most covered first`, run: () => setConfig('sortBy', 'coverageDesc') },
        { label: `${on(sort === 'name')} Name`, run: () => setConfig('sortBy', 'name') },
        { label: 'Show', kind: vscode.QuickPickItemKind.Separator },
      ];
      if (store.gitAvailable) {
        items.push({
          label: `${on(tree.changedOnly)} Only files changed on this branch`,
          description: 'uses git',
          run: () => setConfig('changedFilesOnly', !config().get<boolean>('changedFilesOnly', false)),
        });
      }
      items.push(
        { label: `${on(decorator.isEnabled)} Line highlights in the editor`, run: () => decorator.toggle() },
        {
          label: `${on(config().get<boolean>('liveCoverage', false))} Live coverage on save`,
          description: 're-runs the related test when you save',
          run: () => vscode.commands.executeCommand('dartboard.toggleLive'),
        },
        { label: 'Goal', kind: vscode.QuickPickItemKind.Separator },
        {
          label: `$(target) Coverage goal: ${config().get<number>('goal', 80)}%`,
          run: async () => {
            const value = await vscode.window.showInputBox({
              prompt: 'Coverage goal in percent (0 hides the goal)',
              value: String(config().get<number>('goal', 80)),
              validateInput: (v) => (/^\d{1,3}$/.test(v) && Number(v) <= 100 ? undefined : 'Enter a number from 0 to 100'),
            });
            if (value !== undefined) {
              await setConfig('goal', Number(value));
            }
          },
        },
      );
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Coverage panel options' });
      await pick?.run?.();
    }),

    vscode.commands.registerCommand('dartboard.openFile', async (uri: vscode.Uri) => {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: true });
        decorator.show();
      } catch {
        void vscode.window.showWarningMessage(`Cannot open ${uri.fsPath}. The coverage report may be stale.`);
      }
    }),

    vscode.commands.registerCommand('dartboard.openAt', async (uri: vscode.Uri, start: number, end: number) => {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      const last = Math.min(end, doc.lineCount) - 1;
      const range = new vscode.Range(start - 1, 0, last, doc.lineAt(Math.max(0, last)).text.length);
      editor.selection = new vscode.Selection(range.start, range.start);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      decorator.show();
    }),

    vscode.commands.registerCommand('dartboard.collapseAll', () => panel.collapseAll()),

    vscode.commands.registerCommand('dartboard.revealActive', async () => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (uri && tree.findFileNode(uri)) {
        await panel.reveal(uri);
      } else {
        await vscode.commands.executeCommand('dartboard.files.focus');
      }
    }),

    vscode.commands.registerCommand('dartboard.nextUncovered', () => {
      const editor = vscode.window.activeTextEditor;
      const coverage = editor ? store.get(editor.document.uri) : undefined;
      if (!editor || !coverage) {
        return;
      }
      const uncovered = [...coverage.lines.entries()]
        .filter(([, hits]) => hits === 0)
        .map(([line]) => line - 1)
        .sort((a, b) => a - b);
      if (uncovered.length === 0) {
        void vscode.window.setStatusBarMessage('$(pass) Every line in this file is covered', 3000);
        return;
      }
      const current = editor.selection.active.line;
      const target = uncovered.find((l) => l > current) ?? uncovered[0];
      const pos = new vscode.Position(target, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      decorator.show();
    }),

    vscode.commands.registerCommand('dartboard.runTestsFor', async (arg?: CoverageNode | vscode.Uri | { uri?: string }) => {
      const uri = targetUri(arg);
      if (!uri) {
        return vscode.commands.executeCommand('dartboard.run');
      }
      await partial.run(uri);
      decorator.show();
    }),

    vscode.commands.registerCommand('dartboard.createTest', async (arg?: CoverageNode | vscode.Uri | { uri?: string }) => {
      const uri = targetUri(arg);
      if (uri) {
        await createTestFile(store, uri);
      }
    }),

    vscode.commands.registerCommand('dartboard.checkStrength', async (arg?: CoverageNode | vscode.Uri | { uri?: string }) => {
      const uri = targetUri(arg);
      if (uri) {
        await strength.check(uri);
        decorator.show();
      }
    }),

    vscode.commands.registerCommand('dartboard.mapTests', () => testMap.build()),

    vscode.commands.registerCommand('dartboard.showTestsForLine', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      if (!testMap.available) {
        const go = 'Map tests now';
        if ((await vscode.window.showInformationMessage('Tests haven’t been mapped to lines yet.', go)) === go) {
          await testMap.build();
        }
        return;
      }
      const tests = testMap.testsFor(editor.document.uri, editor.selection.active.line + 1);
      if (!tests.length) {
        void vscode.window.showInformationMessage('No test covers this line (as of the last mapping).');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        tests.map((t) => ({ label: t.test, description: 'open', t })),
        { placeHolder: `${tests.length} test file(s) cover line ${editor.selection.active.line + 1}` },
      );
      if (pick) {
        await vscode.window.showTextDocument(vscode.Uri.file(`${pick.t.root}/${pick.t.test}`));
      }
    }),

    vscode.commands.registerCommand('dartboard.openTest', async (fsPath: string) => {
      await vscode.window.showTextDocument(vscode.Uri.file(fsPath));
    }),

    vscode.commands.registerCommand('dartboard.runSingleTest', async (fsPath: string) => {
      await partial.run(vscode.Uri.file(fsPath));
    }),

    vscode.commands.registerCommand('dartboard.openInsights', () => insights.show('map')),
    vscode.commands.registerCommand('dartboard.openHistory', () => insights.show('history')),
    vscode.commands.registerCommand('dartboard.openRisk', () => insights.show('risk')),

    vscode.commands.registerCommand('dartboard.share', () => share(store)),

    vscode.commands.registerCommand('dartboard.toggleLive', async () => {
      const next = !config().get<boolean>('liveCoverage', false);
      await setConfig('liveCoverage', next);
      void vscode.window.setStatusBarMessage(
        next ? '$(zap) Live coverage on: saving a file re-runs its tests' : 'Live coverage off',
        4000,
      );
    }),

    vscode.commands.registerCommand('dartboard.resetHistory', async () => {
      const yes = 'Reset';
      if ((await vscode.window.showWarningMessage('Forget coverage history, trends and the test map for this workspace?', { modal: true }, yes)) === yes) {
        await history.clear();
        await testMap.clear();
        await store.load();
      }
    }),

    vscode.commands.registerCommand('dartboard.openWalkthrough', openWalkthrough),

    // ------------------------------------------------------------ test tools
    vscode.commands.registerCommand('dartboard.showTab', (tab: 'files' | 'widgets' | 'states' | 'tests') => panel.showTab(tab)),
    vscode.commands.registerCommand('dartboard.showWidgetTree', (uri: vscode.Uri, widget: string) => panel.revealWidget(uri, widget)),
    vscode.commands.registerCommand('dartboard.runAffected', () => tools.runAffected()),
    vscode.commands.registerCommand('dartboard.runIntegrationTests', () => tools.integrationTests()),
    vscode.commands.registerCommand('dartboard.rerunTest', (suite: string, name: string) => tools.rerunTest(suite, name)),
    vscode.commands.registerCommand('dartboard.createWidgetTest', (uri: vscode.Uri, className: string) => tools.createWidgetTest(uri, className)),
    vscode.commands.registerCommand('dartboard.screenMatrix', (uri?: vscode.Uri, testName?: string) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      return target ? tools.screenMatrix(target, testName) : undefined;
    }),
    vscode.commands.registerCommand('dartboard.checkAccessibility', (uri?: vscode.Uri, line?: number) => {
      const editor = vscode.window.activeTextEditor;
      const target = uri ?? editor?.document.uri;
      return target ? tools.accessibility(target, line ?? editor?.selection.active.line ?? 0) : undefined;
    }),
    vscode.commands.registerCommand('dartboard.filmstrip', (uri: vscode.Uri, testName: string) => tools.filmstrip(uri, testName)),
    vscode.commands.registerCommand('dartboard.testChecklist', (uri?: vscode.Uri, line?: number) => {
      const editor = vscode.window.activeTextEditor;
      const target = uri instanceof vscode.Uri ? uri : editor?.document.uri;
      return target ? tools.checklist(target, typeof line === 'number' ? line : editor?.selection.active.line ?? 0) : undefined;
    }),
    vscode.commands.registerCommand('dartboard.showFailureOutput', async (id: string) => {
      const text = panel.rawOutput(id);
      if (text) {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: text, language: 'log' }), { preview: true });
      }
    }),
    vscode.commands.registerCommand('dartboard.auditReport', async () => {
      const file = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Creating the audit report…' },
        () => writeAuditReport(store, project, results),
      );
      if (!file) {
        return;
      }
      const open = 'Open PDF';
      const pick = await vscode.window.showInformationMessage(`Audit report saved to ${vscode.workspace.asRelativePath(file)}`, open, 'Show in folder');
      if (pick === open) {
        await vscode.env.openExternal(vscode.Uri.file(file));
      } else if (pick) {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file));
      }
    }),

    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId !== 'dart') {
        return;
      }
      // Weak spots describe the code as it was during the check.
      if (store.weakSpots(doc.uri).length) {
        store.setWeakSpots(doc.uri, []);
      }
      if (config().get<boolean>('liveCoverage', false) && store.hasData) {
        void partial.run(doc.uri, true);
      }
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dartboard.lcovGlob')) {
        createWatcher();
      }
      if (
        e.affectsConfiguration('dartboard.lcovGlob') ||
        e.affectsConfiguration('dartboard.exclude') ||
        e.affectsConfiguration('dartboard.showUntestedFiles') ||
        e.affectsConfiguration('dartboard.includeUntestedInTotal')
      ) {
        void store.load();
      } else if (e.affectsConfiguration('dartboard')) {
        tree.rebuild();
        statusBar.update();
      }
    }),

    vscode.workspace.onDidChangeWorkspaceFolders(() => void store.load()),
  );

  await store.load();
  results.restore(store.packages.map((p) => p.root));
  const setIntegrationContext = () =>
    void vscode.commands.executeCommand('setContext', 'dartboard.hasIntegrationTests', project.hasIntegrationTests());
  setIntegrationContext();
  context.subscriptions.push(store.onDidChange(setIntegrationContext));

  if (!context.globalState.get<boolean>(WALKTHROUGH_SHOWN)) {
    await context.globalState.update(WALKTHROUGH_SHOWN, true);
    void openWalkthrough();
  }

  // Exposed for integration tests and other extensions.
  return { store, tree, project, results };
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
