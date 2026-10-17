import * as path from 'path';
import * as vscode from 'vscode';
import { CoverageStore, toPosix } from './coverageStore';
import { formatPercent, percent } from './lcov';
import { ProjectModel, ProjectSnapshot } from './project';
import { TestResultsStore } from './results';
import { StateItem } from './states';
import { Failure, TestResult } from './testEvents';
import { levelFor } from './thresholds';
import { CoverageNode, CoverageTreeProvider, trendText } from './treeProvider';
import { WidgetNode } from './widgets';

export type Tab = 'files' | 'widgets' | 'states' | 'tests';

/** One row of a list in the panel, as sent to the webview. */
export interface Row {
  id: string;
  label: string;
  /** Muted text after the label. */
  extra?: string;
  /** Small coloured pills after the label. */
  chips?: Array<{ text: string; tone: 'bad' | 'warn' | 'good' | 'info' }>;
  pct?: number;
  pctText?: string;
  level?: 'high' | 'medium' | 'low' | 'none';
  tooltip?: string;
  collapsible: boolean;
  expanded: boolean;
  /** File rows load their children (uncovered lines, weak spots) when first expanded. */
  lazy?: boolean;
  children?: Row[];
  command?: { command: string; args: unknown[] };
  /** Hover buttons on the right. */
  actions?: Array<{ icon: string; title: string; command: string; args: unknown[] }>;
  /** Right-click menu section: file | folder | untested | other. */
  section?: string;
  uri?: string;
  icon?: string;
  bold?: boolean;
  dim?: boolean;
}

export interface Card {
  id: string;
  title: string;
  test: string;
  where?: string;
  open?: { command: string; args: unknown[] };
  widget?: { label: string; open: { command: string; args: unknown[] } };
  hint?: string;
  expected?: string;
  actual?: string;
  items?: string[];
  actions: Array<{ label: string; command: string; args: unknown[] }>;
}

const config = () => vscode.workspace.getConfiguration('dartboard');

/**
 * The Dartboard panel: a summary ring with the last test run, then four tabs (Files,
 * Widgets, States, Tests). Drawn as a webview so rows can show right-aligned percentages
 * with coloured bars and failures can show as readable cards.
 */
export class CoveragePanelView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private nodes = new Map<string, CoverageNode>();
  private pendingReveal: string | undefined;
  private pendingTab: Tab | undefined;
  private readonly subs: vscode.Disposable[] = [];
  private postTimer: NodeJS.Timeout | undefined;
  private readonly raw = new Map<string, string>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: CoverageStore,
    private readonly tree: CoverageTreeProvider,
    private readonly project: ProjectModel,
    private readonly results: TestResultsStore,
  ) {
    this.subs.push(
      tree.onDidChangeTreeData(() => this.schedulePost()),
      project.onDidChange(() => this.schedulePost()),
      results.onDidChange(() => this.schedulePost()),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    view.onDidDispose(() => (this.view = undefined));
    view.onDidChangeVisibility(() => view.visible && this.schedulePost());
    this.updateDescription();
  }

  collapseAll(): void {
    void this.view?.webview.postMessage({ type: 'collapseAll' });
  }

  async showTab(tab: Tab): Promise<void> {
    await vscode.commands.executeCommand('dartboard.files.focus');
    if (this.view) {
      void this.view.webview.postMessage({ type: 'tab', tab });
    } else {
      this.pendingTab = tab;
    }
  }

  /** Selects and scrolls to a file row, expanding its folders. */
  async reveal(uri: vscode.Uri): Promise<void> {
    await this.showTab('files');
    const id = `file:${uri.toString()}`;
    if (this.view) {
      void this.view.webview.postMessage({ type: 'reveal', id });
    } else {
      this.pendingReveal = id;
    }
  }

  /** Opens the Widgets tab at a widget's tree. */
  async revealWidget(uri: vscode.Uri, widget: string): Promise<void> {
    await this.showTab('widgets');
    void this.view?.webview.postMessage({ type: 'reveal', id: `w:${uri.toString()}#${widget}` });
  }

  rawOutput(id: string): string | undefined {
    return this.raw.get(id);
  }

  private schedulePost(): void {
    if (this.postTimer) {
      clearTimeout(this.postTimer);
    }
    this.postTimer = setTimeout(() => void this.post(), 60);
  }

  private async post(): Promise<void> {
    this.updateDescription();
    if (!this.view) {
      return;
    }
    this.nodes.clear();
    const files: Row[] = [];
    for (const node of await this.tree.getChildren()) {
      if (node.kind !== 'summary') {
        files.push(await this.toRow(node));
      }
    }
    const snap = this.store.hasData || this.store.packages.length ? await this.project.get() : undefined;
    const widgets = snap ? this.widgetRows(snap) : [];
    const states = snap ? this.stateRows(snap) : [];
    const tests = this.testsTab(snap);
    void this.view.webview.postMessage({
      type: 'state',
      hasData: this.store.hasData,
      hasPackages: this.store.packages.length > 0,
      hero: this.hero(),
      run: this.runLine(),
      files,
      widgets,
      states,
      tests,
      badges: {
        tests: this.results.failed.length + this.results.brokenSuites.length,
        widgets: snap ? snap.screens.filter((s) => !s.tests.length).length : 0,
      },
    });
    if (this.pendingTab) {
      void this.view.webview.postMessage({ type: 'tab', tab: this.pendingTab });
      this.pendingTab = undefined;
    }
    if (this.pendingReveal) {
      void this.view.webview.postMessage({ type: 'reveal', id: this.pendingReveal });
      this.pendingReveal = undefined;
    }
  }

  private updateDescription(): void {
    if (!this.view) {
      return;
    }
    const t = this.store.totals();
    this.view.description = this.store.hasData ? formatPercent(percent(t.linesHit, t.linesFound)) : undefined;
  }

  // ------------------------------------------------------------------ header

  private hero() {
    const t = this.store.totals();
    const pct = percent(t.linesHit, t.linesFound);
    let bFound = 0;
    let bHit = 0;
    for (const f of this.store.tested()) {
      bFound += f.branchesFound;
      bHit += f.branchesHit;
    }
    const goal = config().get<number>('goal', 80);
    const trend = this.store.totalTrendDelta;
    return {
      pct: pct ?? 0,
      pctText: formatPercent(pct),
      level: levelFor(pct),
      lines: `${t.linesHit.toLocaleString()} of ${t.linesFound.toLocaleString()} lines`,
      branches: bFound ? formatPercent(percent(bHit, bFound)) : undefined,
      branchLevel: bFound ? levelFor(percent(bHit, bFound)) : undefined,
      goal: goal > 0 ? goal : undefined,
      goalReached: goal > 0 && pct !== undefined && pct >= goal,
      toGoal: goal > 0 && pct !== undefined && pct < goal ? Math.ceil((goal / 100) * t.linesFound - t.linesHit) : 0,
      trend: trend !== undefined && Math.abs(trend) >= 0.05 ? trendText(trend) : undefined,
      trendUp: (trend ?? 0) > 0,
      changedOnly: this.tree.changedOnly,
    };
  }

  private runLine() {
    if (!this.results.hasResults) {
      return undefined;
    }
    const s = this.results.summary;
    return {
      passed: s.passed,
      failed: s.failed,
      skipped: s.skipped,
      duration: s.durationMs ? formatDuration(s.durationMs) : undefined,
      ago: s.at ? ago(s.at) : undefined,
    };
  }

  // ------------------------------------------------------------------ files tab

  private async toRow(node: CoverageNode): Promise<Row> {
    const item = this.tree.getTreeItem(node);
    const id = item.id ?? Math.random().toString(36);
    this.nodes.set(id, node);
    const label = typeof item.label === 'string' ? item.label : item.label?.label ?? '';
    const collapsible = item.collapsibleState !== vscode.TreeItemCollapsibleState.None && item.collapsibleState !== undefined;
    const row: Row = {
      id,
      label,
      collapsible,
      expanded: item.collapsibleState === vscode.TreeItemCollapsibleState.Expanded,
      tooltip: tooltipText(item.tooltip),
      section: 'other',
    };
    if (item.command) {
      row.command = { command: item.command.command, args: (item.command.arguments ?? []).map(encodeArg) };
    }
    const setPct = (hit: number, found: number) => {
      const p = percent(hit, found);
      row.pct = p;
      row.pctText = p === undefined ? '–' : `${(Math.floor(p * 100) / 100).toFixed(2)}%`;
      row.level = levelFor(p);
    };

    switch (node.kind) {
      case 'section':
        row.extra = item.description as string | undefined;
        row.icon = node.section === 'risk' ? 'flame' : 'slash';
        row.bold = true;
        break;
      case 'folder':
        setPct(node.linesHit, node.linesFound);
        row.section = node.fsPath ? 'folder' : 'other';
        row.uri = node.fsPath ? vscode.Uri.file(node.fsPath).toString() : undefined;
        row.icon = node.isLayer ? 'layer' : undefined;
        if (row.uri) {
          row.actions = [{ icon: 'play', title: 'Run tests for this folder with coverage', command: 'dartboard.runTestsFor', args: [{ $uri: row.uri }] }];
        }
        break;
      case 'file': {
        const f = node.file;
        row.uri = f.uri.toString();
        if (f.untested) {
          row.pct = 0;
          row.pctText = '0.00%';
          row.level = 'low';
          row.extra = node.context === 'untested' ? (item.description as string) : undefined;
          row.chips = node.context === 'untested' ? undefined : [{ text: 'no tests', tone: 'bad' }];
          row.section = 'untested';
          row.dim = true;
          row.actions = [{ icon: 'plus', title: 'Create a test file', command: 'dartboard.createTest', args: [{ $uri: row.uri }] }];
        } else {
          setPct(f.linesHit, f.linesFound);
          const parts: string[] = [];
          const trend = this.store.trend(f);
          if (trend !== undefined) {
            parts.push(trendText(trend));
          }
          if (node.context === 'risk') {
            const r = this.store.riskiest.find((x) => x.file === f);
            if (r) {
              parts.push(`complexity ${r.complexity}`);
            }
          }
          row.extra = parts.join('  ') || undefined;
          const weak = this.store.weakSpots(f.uri).length;
          if (weak) {
            row.chips = [{ text: `${weak} weak`, tone: 'warn' }];
          }
          row.section = 'file';
          row.actions = [{ icon: 'play', title: 'Run this file’s tests with coverage', command: 'dartboard.runTestsFor', args: [{ $uri: row.uri }] }];
        }
        row.lazy = collapsible;
        break;
      }
      case 'range':
        row.extra = item.description as string | undefined;
        row.icon = 'dot';
        break;
      case 'weak':
        row.extra = item.description as string | undefined;
        row.icon = 'warn';
        break;
      case 'info':
        row.extra = item.description as string | undefined;
        row.icon = 'info';
        break;
    }

    if (collapsible && !row.lazy) {
      row.children = [];
      for (const child of await this.tree.getChildren(node)) {
        row.children.push(await this.toRow(child));
      }
    }
    return row;
  }

  // ------------------------------------------------------------------ widgets tab

  private widgetRows(snap: ProjectSnapshot): Row[] {
    const rows: Row[] = [];
    const nodeRows = (uri: vscode.Uri, prefix: string, nodes: WidgetNode[]): Row[] =>
      nodes.map((n, i) => {
        const id = `${prefix}/${i}`;
        const unkeyed = n.interactive && !n.hasKey;
        return {
          id,
          label: n.name,
          icon: n.status === 'rendered' ? 'ok' : n.status === 'missed' ? 'miss' : 'unk',
          chips: unkeyed ? [{ text: 'no key', tone: 'warn' as const }] : undefined,
          tooltip:
            (n.status === 'rendered' ? 'Rendered in at least one test.' : n.status === 'missed' ? 'Never rendered in any test.' : 'Coverage can’t tell (const widget inside a condition).') +
            (unkeyed ? '\nInteractive but has no Key, so tests have to find it by text or type, which breaks easily.' : ''),
          collapsible: n.children.length > 0,
          expanded: n.status !== 'rendered' || i === 0,
          children: n.children.length ? nodeRows(uri, id, n.children) : undefined,
          command: { command: 'dartboard.openAt', args: [{ $uri: uri.toString() }, n.line, n.line] },
          dim: n.status === 'unknown',
        };
      });
    const treePct = (r: number, m: number) => (r + m ? (r / (r + m)) * 100 : undefined);

    if (snap.screens.length) {
      const untested = snap.screens.filter((s) => !s.tests.length).length;
      rows.push({
        id: 'sec:screens',
        label: 'Screens',
        icon: 'screen',
        bold: true,
        extra: `${snap.screens.length}${untested ? ` · ${untested} without a widget test` : ''}`,
        collapsible: true,
        expanded: true,
        children: snap.screens.map((s) => {
          const id = `w:${s.uri.toString()}#${s.name}`;
          const p = s.tree ? treePct(s.tree.rendered, s.tree.missed) : undefined;
          const chips: Row['chips'] = [];
          if (!s.tests.length) {
            chips.push({ text: 'no test', tone: 'bad' });
          } else if (s.tree?.unkeyedInteractive.length) {
            // Keys only matter once there's a test that needs to find things; one chip per row keeps names readable.
            chips.push({ text: `${s.tree.unkeyedInteractive.length} without key`, tone: 'warn' });
          }
          const tip = [
            `${s.name}${s.route ? ` · route ${s.route}` : ''}`,
            s.tree ? `${s.tree.rendered} of ${s.tree.rendered + s.tree.missed} widgets in its build() were rendered by tests.` : 'No build() found for this screen.',
            s.tests.length ? `Built in: ${s.tests.join(', ')}` : 'No test builds this screen yet.',
            s.tree && s.tree.interactiveCount
              ? `Testability: ${s.tree.interactiveCount - s.tree.unkeyedInteractive.length} of ${s.tree.interactiveCount} interactive widgets have a Key.`
              : '',
          ].filter(Boolean).join('\n');
          return {
            id,
            label: s.name,
            extra: s.route ?? (s.via === 'push' ? 'pushed' : undefined),
            chips,
            pct: p,
            pctText: p === undefined ? '–' : formatPercent(p),
            level: p === undefined ? 'none' : levelFor(p),
            tooltip: tip,
            collapsible: !!s.tree,
            expanded: false,
            children: s.tree ? nodeRows(s.uri, id, s.tree.roots) : undefined,
            command: { command: 'dartboard.openAt', args: [{ $uri: s.uri.toString() }, s.line, s.line] },
            actions: s.tests.length
              ? [{ icon: 'play', title: 'Run the tests that build this screen', command: 'dartboard.runTestsFor', args: [{ $uri: vscode.Uri.file(path.join(s.pkg.root, s.tests[0])).toString() }] }]
              : [{ icon: 'plus', title: 'Create a widget test for this screen', command: 'dartboard.createWidgetTest', args: [{ $uri: s.uri.toString() }, s.name] }],
            icon: 'screen',
          } as Row;
        }),
      });
    }

    const others = snap.widgets.flatMap((f) => f.trees.map((t) => ({ uri: f.uri, t })));
    if (others.length) {
      rows.push({
        id: 'sec:widgets',
        label: 'Other widgets',
        icon: 'widget',
        bold: true,
        extra: String(others.length),
        collapsible: true,
        expanded: !snap.screens.length,
        children: others
          .sort((a, b) => (treePct(a.t.rendered, a.t.missed) ?? 101) - (treePct(b.t.rendered, b.t.missed) ?? 101))
          .map(({ uri, t }) => {
            const id = `w:${uri.toString()}#${t.widget}`;
            const p = treePct(t.rendered, t.missed);
            return {
              id,
              label: t.widget,
              extra: toPosix(vscode.workspace.asRelativePath(uri)).split('/').pop(),
              chips: t.unkeyedInteractive.length ? [{ text: `${t.unkeyedInteractive.length} without key`, tone: 'warn' as const }] : undefined,
              pct: p,
              pctText: p === undefined ? '–' : formatPercent(p),
              level: p === undefined ? 'none' : levelFor(p),
              collapsible: true,
              expanded: false,
              children: nodeRows(uri, id, t.roots),
              command: { command: 'dartboard.openAt', args: [{ $uri: uri.toString() }, t.buildLine, t.buildLine] },
              icon: 'widget',
            } as Row;
          }),
      });
    }
    return rows;
  }

  // ------------------------------------------------------------------ states tab

  private stateRows(snap: ProjectSnapshot): Row[] {
    const kindLabel = (i: StateItem) => (i.kind === 'event' ? 'event' : i.kind === 'state' ? 'state' : 'method');
    return snap.states
      .slice()
      .sort((a, b) => a.reached / a.total - b.reached / b.total || a.name.localeCompare(b.name))
      .map((h) => {
        const p = (h.reached / h.total) * 100;
        const id = `s:${h.uri.toString()}#${h.name}`;
        // A file no test imports has nothing reached; anything else unknown has no usable coverage.
        const untested = !!this.store.get(h.uri)?.untested;
        const unknown = !untested && h.items.every((i) => i.status === 'unknown');
        return {
          id,
          label: h.name,
          extra: h.kind,
          chips: untested ? [{ text: 'no tests', tone: 'bad' }] : undefined,
          icon: 'state',
          pct: unknown ? undefined : p,
          pctText: unknown ? '–' : formatPercent(p),
          level: unknown ? 'none' : levelFor(p),
          tooltip: `${h.name} (${h.kind})\n${h.reached} of ${h.total} ${h.kind === 'Bloc' ? 'events and states' : 'methods and states'} were reached by tests.`,
          collapsible: true,
          expanded: false,
          command: { command: 'dartboard.openAt', args: [{ $uri: h.uri.toString() }, h.line, h.line] },
          children: h.items.map((i, k) => ({
            id: `${id}/${k}`,
            label: i.name,
            extra: [kindLabel(i), i.note].filter(Boolean).join(' · '),
            icon: i.status === 'reached' ? 'ok' : i.status === 'missed' ? 'miss' : 'unk',
            collapsible: false,
            expanded: false,
            command: { command: 'dartboard.openAt', args: [{ $uri: vscode.Uri.file(i.file).toString() }, i.line, i.line] },
            dim: i.status === 'unknown',
          })),
        } as Row;
      });
  }

  // ------------------------------------------------------------------ tests tab

  private testsTab(snap: ProjectSnapshot | undefined) {
    this.raw.clear();
    const rel = (file: string) => toPosix(vscode.workspace.asRelativePath(file));
    const open = (file: string, line: number) => ({ command: 'dartboard.openAt', args: [{ $uri: vscode.Uri.file(file).toString() }, line, line] });
    const card = (id: string, f: Failure, test: string, suite: string, t?: TestResult): Card => {
      this.raw.set(id, f.raw);
      const loc = f.location ?? t?.location;
      const isWidgetTest = /testWidgets/.test(f.raw) || !!f.widget || /WidgetTester|flutter_test\/src\/widget_tester/.test(f.raw);
      const actions: Card['actions'] = [{ label: 'Run again', command: 'dartboard.rerunTest', args: [suite, t ? t.name : ''] }];
      if (t && isWidgetTest) {
        actions.push({ label: 'Filmstrip', command: 'dartboard.filmstrip', args: [{ $uri: vscode.Uri.file(suite).toString() }, t.name] });
      }
      actions.push({ label: 'Full output', command: 'dartboard.showFailureOutput', args: [id] });
      return {
        id,
        title: f.title,
        test,
        where: loc ? `${rel(loc.file)}:${loc.line}` : rel(suite),
        open: loc ? open(loc.file, loc.line) : open(suite, 1),
        widget: f.widget ? { label: `${f.widget.name} in ${rel(f.widget.file)}:${f.widget.line}`, open: open(f.widget.file, f.widget.line) } : undefined,
        hint: f.hint,
        expected: f.items ? undefined : f.expected,
        actual: f.items ? undefined : f.actual,
        items: f.items,
        actions,
      };
    };
    const failures: Card[] = [
      ...this.results.brokenSuites.map((b, i) => card(`load${i}`, b.failure, `Couldn’t load ${path.basename(b.suite)}`, b.suite)),
      ...this.results.failed.map((t, i) => card(`fail${i}`, t.failure!, t.name, t.suite, t)),
    ];

    const matrix = this.results.matrix;
    const slowest = this.results.slowest(8).filter((t) => t.durationMs >= 50);
    const maxMs = Math.max(1, ...slowest.map((t) => t.durationMs));
    return {
      hasResults: this.results.hasResults,
      failures,
      matrix: matrix && {
        file: path.basename(matrix.suite),
        configs: matrix.configs,
        rows: matrix.rows.map((r, i) => ({
          test: r.test,
          cells: matrix.configs.map((c, k) => {
            const cell = r.cells[c];
            const id = `m${i}_${k}`;
            if (cell?.failure) {
              this.raw.set(id, cell.failure.raw);
            }
            return {
              status: cell?.status ?? 'skipped',
              title: cell?.failure?.title,
              id,
              open: cell?.failure?.widget ? open(cell.failure.widget.file, cell.failure.widget.line) : undefined,
            };
          }),
        })),
      },
      slowest: slowest.map((t) => {
        const delta = this.results.slowerBy(t);
        return {
          name: t.name,
          file: rel(t.suite),
          ms: formatDuration(t.durationMs),
          width: Math.round((t.durationMs / maxMs) * 100),
          delta: delta !== undefined && Math.abs(delta) >= 100 && t.durationMs > 200 ? `${delta > 0 ? '▲ +' : '▼ '}${formatDuration(Math.abs(delta))}` : undefined,
          slower: (delta ?? 0) > 0,
          open: t.location ? open(t.location.file, t.location.line) : open(t.suite, 1),
        };
      }),
      pyramid: snap?.pyramid,
      pitfalls: (snap?.pitfalls ?? [])
        .map((p) => ({
          file: p.rel,
          warnings: p.items.filter((i) => i.severity === 'warning').length,
          infos: p.items.filter((i) => i.severity === 'info').length,
          open: open(p.uri.fsPath, p.items[0].line),
          top: p.items[0].message,
        }))
        .sort((a, b) => b.warnings - a.warnings || b.infos - a.infos)
        .slice(0, 12),
    };
  }

  // ------------------------------------------------------------------ plumbing

  private async onMessage(msg: { type: string; id?: string; command?: string; args?: unknown[] }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.post();
        break;
      case 'run':
        if (msg.command && msg.command.startsWith('dartboard.')) {
          await vscode.commands.executeCommand(msg.command, ...(msg.args ?? []).map(decodeArg));
        }
        break;
      case 'expand': {
        const node = msg.id ? this.nodes.get(msg.id) : undefined;
        if (!node || !this.view) {
          return;
        }
        const children: Row[] = [];
        for (const child of await this.tree.getChildren(node)) {
          children.push(await this.toRow(child));
        }
        void this.view.webview.postMessage({ type: 'children', id: msg.id, rows: children });
        break;
      }
    }
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
    const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
</head>
<body>
<header id="hero"></header>
<nav id="tabs" role="tablist"></nav>
<main id="list" tabindex="0" role="tree" aria-label="Dartboard"></main>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    if (this.postTimer) {
      clearTimeout(this.postTimer);
    }
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  }
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function ago(time: number): string {
  const s = Math.round((Date.now() - time) / 1000);
  if (s < 60) {
    return 'just now';
  }
  if (s < 3600) {
    return `${Math.round(s / 60)} min ago`;
  }
  if (s < 86400) {
    return `${Math.round(s / 3600)} h ago`;
  }
  return new Date(time).toLocaleDateString();
}

function tooltipText(t: string | vscode.MarkdownString | undefined): string | undefined {
  if (!t) {
    return undefined;
  }
  const s = typeof t === 'string' ? t : t.value;
  return s
    .replace(/```\w*\n?/g, '')
    .replace(/\*\*|`|\\/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function encodeArg(a: unknown): unknown {
  return a instanceof vscode.Uri ? { $uri: a.toString() } : a;
}

export function decodeArg(a: unknown): unknown {
  if (a && typeof a === 'object' && '$uri' in a && typeof (a as { $uri: unknown }).$uri === 'string') {
    return vscode.Uri.parse((a as { $uri: string }).$uri);
  }
  return a;
}
