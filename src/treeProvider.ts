import * as path from 'path';
import * as vscode from 'vscode';
import { CoverageStore, ResolvedFileCoverage, includeUntestedSetting } from './coverageStore';
import { enclosingSymbol } from './dart';
import { formatPercent, percent, uncoveredRanges } from './lcov';
import { LAYERS, layerOf } from './paths';
import { levelFor as coverageLevel, themeColorFor } from './thresholds';

export type ViewMode = 'tree' | 'flat' | 'layers';
export type SortBy = 'name' | 'coverageAsc' | 'coverageDesc';

interface BaseNode {
  parent?: CoverageNode;
}

export interface SummaryNode extends BaseNode {
  kind: 'summary';
}
export interface SectionNode extends BaseNode {
  kind: 'section';
  section: 'risk' | 'untested';
}
export interface FolderNode extends BaseNode {
  kind: 'folder';
  name: string;
  id: string;
  children: CoverageNode[];
  linesFound: number;
  linesHit: number;
  /** Absolute folder path when it maps to a real folder (not a layer group). */
  fsPath?: string;
  isLayer?: boolean;
}
export interface FileNode extends BaseNode {
  kind: 'file';
  file: ResolvedFileCoverage;
  /** Nodes inside the risk/untested sections get a different id and extra detail. */
  context?: 'risk' | 'untested';
}
export interface RangeNode extends BaseNode {
  kind: 'range';
  file: ResolvedFileCoverage;
  start: number;
  end: number;
  symbol?: string;
}
export interface WeakNode extends BaseNode {
  kind: 'weak';
  file: ResolvedFileCoverage;
  line: number;
  original: string;
  replacement: string;
  code: string;
}
export interface InfoNode extends BaseNode {
  kind: 'info';
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: vscode.ThemeIcon;
  command?: vscode.Command;
}

export type CoverageNode = SummaryNode | SectionNode | FolderNode | FileNode | RangeNode | WeakNode | InfoNode;

const config = () => vscode.workspace.getConfiguration('dartboard');

export class CoverageTreeProvider implements vscode.TreeDataProvider<CoverageNode> {
  private readonly emitter = new vscode.EventEmitter<CoverageNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private roots: CoverageNode[] = [];
  private fileNodes = new Map<string, FileNode>();

  constructor(private readonly store: CoverageStore) {
    store.onDidChange(() => this.rebuild());
  }

  get viewMode(): ViewMode {
    return config().get<ViewMode>('viewMode', 'tree');
  }

  get sortBy(): SortBy {
    return config().get<SortBy>('sortBy', 'coverageAsc');
  }

  get changedOnly(): boolean {
    return config().get<boolean>('changedFilesOnly', false) && this.store.gitAvailable && !!this.store.changedFiles;
  }

  /** Files currently shown in the main list (after the changed-files filter). */
  visibleFiles(): ResolvedFileCoverage[] {
    const files = this.store.all();
    return this.changedOnly ? files.filter((f) => this.store.isChanged(f)) : files;
  }

  rebuild(): void {
    this.fileNodes.clear();
    if (!this.store.hasData) {
      this.roots = [];
      this.emitter.fire();
      return;
    }
    const roots: CoverageNode[] = [{ kind: 'summary' }];
    if (this.store.riskiest.length >= 2) {
      roots.push({ kind: 'section', section: 'risk' });
    }
    if (this.store.untested().length > 0) {
      roots.push({ kind: 'section', section: 'untested' });
    }

    const files = this.visibleFiles();
    const mode = this.viewMode;
    const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;

    if (files.length === 0 && this.changedOnly) {
      roots.push({
        kind: 'info',
        id: 'info:nochanges',
        label: 'No changed Dart files on this branch',
        icon: new vscode.ThemeIcon('git-branch'),
        command: { command: 'dartboard.viewOptions', title: 'Options' },
        tooltip: 'Turn off "Only files changed on this branch" in the options to see everything.',
      });
    } else if (mode === 'flat') {
      const nodes = files.map((file) => this.fileNode(file));
      roots.push(...this.sort(nodes));
    } else if (mode === 'layers') {
      for (const layer of LAYERS) {
        const inLayer = files.filter((f) => layerOf(f.packagePath ?? f.relativePath) === layer);
        if (inLayer.length === 0) {
          continue;
        }
        const group: FolderNode = { kind: 'folder', name: layer, id: `layer:${layer}`, children: [], linesFound: 0, linesHit: 0, isLayer: true };
        group.children = this.sort(inLayer.map((f) => this.fileNode(f, group)));
        accumulate(group);
        roots.push(group);
      }
    } else {
      const root: FolderNode = { kind: 'folder', name: '', id: '', children: [], linesFound: 0, linesHit: 0 };
      for (const file of files) {
        const segments = file.relativePath.split('/');
        if (multiRoot) {
          segments.unshift(file.workspaceFolder.name);
        }
        let folder = root;
        let fsPath = multiRoot ? path.dirname(file.workspaceFolder.uri.fsPath) : file.workspaceFolder.uri.fsPath;
        for (const segment of segments.slice(0, -1)) {
          const id = folder.id ? `${folder.id}/${segment}` : segment;
          fsPath = path.join(fsPath, segment);
          let child = folder.children.find((c): c is FolderNode => c.kind === 'folder' && c.id === id);
          if (!child) {
            child = { kind: 'folder', name: segment, id, children: [], linesFound: 0, linesHit: 0, parent: folder, fsPath };
            folder.children.push(child);
          }
          folder = child;
        }
        folder.children.push(this.fileNode(file, folder));
      }
      accumulate(root);
      compact(root);
      this.sortDeep(root);
      for (const child of root.children) {
        child.parent = undefined;
      }
      roots.push(...root.children);
    }
    this.roots = roots;
    void vscode.commands.executeCommand('setContext', 'dartboard.changedOnly', this.changedOnly);
    this.emitter.fire();
  }

  private fileNode(file: ResolvedFileCoverage, parent?: FolderNode): FileNode {
    const node: FileNode = { kind: 'file', file, parent };
    this.fileNodes.set(file.uri.toString(), node);
    return node;
  }

  findFileNode(uri: vscode.Uri): FileNode | undefined {
    return this.fileNodes.get(uri.toString());
  }

  async getChildren(element?: CoverageNode): Promise<CoverageNode[]> {
    if (!element) {
      return this.roots;
    }
    switch (element.kind) {
      case 'folder':
        return element.children;
      case 'section':
        if (element.section === 'risk') {
          return this.store.riskiest.map((r) => ({ kind: 'file', file: r.file, context: 'risk', parent: element }) as FileNode);
        }
        return this.sort(
          this.store.untested().map((file) => ({ kind: 'file', file, context: 'untested', parent: element }) as FileNode),
          'name',
        );
      case 'file':
        return element.context ? [] : this.fileChildren(element);
      default:
        return [];
    }
  }

  private async fileChildren(node: FileNode): Promise<CoverageNode[]> {
    const f = node.file;
    const children: CoverageNode[] = this.store.weakSpots(f.uri).map((w) => ({ kind: 'weak', file: f, parent: node, ...w }) as WeakNode);
    const ranges = uncoveredRanges(f.lines);
    if (ranges.length) {
      const analysis = await this.store.analysis(f.uri);
      for (const [start, end] of ranges) {
        children.push({
          kind: 'range',
          file: f,
          start,
          end,
          symbol: analysis ? enclosingSymbol(analysis.symbols, start) : undefined,
          parent: node,
        });
      }
    }
    return children;
  }


  getParent(element: CoverageNode): CoverageNode | undefined {
    return element.parent;
  }

  getTreeItem(element: CoverageNode): vscode.TreeItem {
    switch (element.kind) {
      case 'summary':
        return this.summaryItem();
      case 'section':
        return this.sectionItem(element);
      case 'folder':
        return this.folderItem(element);
      case 'file':
        return this.fileItem(element);
      case 'range':
        return this.rangeItem(element);
      case 'weak':
        return this.weakItem(element);
      case 'info': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.id = element.id;
        item.description = element.description;
        item.tooltip = element.tooltip;
        item.iconPath = element.icon;
        item.command = element.command;
        return item;
      }
    }
  }

  private summaryItem(): vscode.TreeItem {
    const totals = this.store.totals();
    const pct = percent(totals.linesHit, totals.linesFound);
    const goal = config().get<number>('goal', 80);
    const trend = this.store.totalTrendDelta;
    const item = new vscode.TreeItem(`Total ${formatPercent(pct)}`, vscode.TreeItemCollapsibleState.None);
    item.id = 'dartboard.summary';
    const parts: string[] = [];
    if (trend !== undefined && Math.abs(trend) >= 0.05) {
      parts.push(trendText(trend));
    }
    if (goal > 0) {
      parts.push(pct !== undefined && pct >= goal ? `goal ${goal}% reached ✓` : `${bar((pct ?? 0) / goal, 8)} goal ${goal}%`);
    }
    if (this.changedOnly) {
      parts.push('changed files only');
    }
    item.description = parts.join('  ·  ');
    item.iconPath = new vscode.ThemeIcon('graph', themeColorFor(coverageLevel(pct)));
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**Overall line coverage: ${formatPercent(pct)}**\n\n`);
    tooltip.appendMarkdown(`${totals.linesHit} of ${totals.linesFound} lines covered\n\n`);
    const untested = this.store.untested();
    if (untested.length) {
      tooltip.appendMarkdown(
        includeUntestedSetting()
          ? `Includes ${untested.length} file(s) no test imports, counted at 0% (their line counts are estimated).\n\n`
          : `${untested.length} file(s) no test imports are *not* counted.\n\n`,
      );
    }
    if (trend !== undefined) {
      tooltip.appendMarkdown(`Change since the previous run: ${trendText(trend)}\n\n`);
    }
    if (goal > 0 && pct !== undefined && pct < goal) {
      const needed = Math.ceil((goal / 100) * totals.linesFound - totals.linesHit);
      tooltip.appendMarkdown(`Cover about **${needed} more line${needed === 1 ? '' : 's'}** to reach your ${goal}% goal.\n\n`);
    }
    if (this.store.loadedAt) {
      tooltip.appendMarkdown(`Loaded ${this.store.loadedAt.toLocaleString()}`);
    }
    item.tooltip = tooltip;
    item.command = { command: 'dartboard.openInsights', title: 'Open Insights' };
    item.contextValue = 'summary';
    return item;
  }


  private sectionItem(node: SectionNode): vscode.TreeItem {
    if (node.section === 'risk') {
      const item = new vscode.TreeItem('Riskiest files', vscode.TreeItemCollapsibleState.Collapsed);
      item.id = 'section:risk';
      item.description = `top ${this.store.riskiest.length}`;
      item.iconPath = new vscode.ThemeIcon('flame', new vscode.ThemeColor('charts.orange'));
      item.tooltip = this.store.gitAvailable
        ? 'Files most likely to hide bugs: low coverage × complex code × changed often in the last 6 months (git).'
        : 'Files most likely to hide bugs: low coverage × complex code. (Git history is added when git is available.)';
      return item;
    }
    const count = this.store.untested().length;
    const item = new vscode.TreeItem('Not tested yet', vscode.TreeItemCollapsibleState.Collapsed);
    item.id = 'section:untested';
    item.description = `${count} file${count === 1 ? '' : 's'}`;
    item.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.red'));
    item.tooltip = 'Files in lib/ that no test imports. flutter test --coverage leaves them out of lcov.info, which makes coverage look higher than it is. Right-click one to create a test.';
    return item;
  }

  private folderItem(node: FolderNode): vscode.TreeItem {
    const pct = percent(node.linesHit, node.linesFound);
    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `folder:${node.id}`;
    item.description = `${formatPercent(pct)}  ${node.linesHit}/${node.linesFound}`;
    item.iconPath = new vscode.ThemeIcon(node.isLayer ? layerIcon(node.name) : 'folder', themeColorFor(coverageLevel(pct)));
    item.tooltip = node.isLayer
      ? `${node.name} layer: ${formatPercent(pct)} line coverage (${node.linesHit}/${node.linesFound}). Layers are guessed from folder and file names.`
      : `${node.id}\n${formatPercent(pct)} line coverage (${node.linesHit}/${node.linesFound})`;
    item.contextValue = node.fsPath ? 'folder' : 'layer';
    if (node.fsPath) {
      item.resourceUri = vscode.Uri.file(node.fsPath);
    }
    return item;
  }

  private fileItem(node: FileNode): vscode.TreeItem {
    const f = node.file;
    const pct = percent(f.linesHit, f.linesFound);
    const label = this.viewMode === 'flat' && !node.context ? f.relativePath : path.posix.basename(f.relativePath);
    const hasChildren = !node.context && (uncoveredRanges(f.lines).length > 0 || this.store.weakSpots(f.uri).length > 0);
    const item = new vscode.TreeItem(label, hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = `${node.context ?? 'file'}:${f.uri.toString()}`;
    item.resourceUri = f.uri;
    item.command = { command: 'dartboard.openFile', title: 'Open File', arguments: [f.uri] };
    const weak = this.store.weakSpots(f.uri).length;
    const trend = this.store.trend(f);

    if (f.untested) {
      item.description = node.context ? path.posix.dirname(f.relativePath) : '0% · no tests';
      item.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.red'));
      item.contextValue = 'untested';
    } else {
      const parts = [`${formatPercent(pct)}  ${f.linesHit}/${f.linesFound}`];
      if (trend !== undefined) {
        parts.push(trendText(trend));
      }
      if (weak) {
        parts.push(`⚠ ${weak} weak`);
      }
      if (node.context === 'risk') {
        const r = this.store.riskiest.find((x) => x.file === f);
        if (r) {
          parts.push(`complexity ${r.complexity}${r.changes ? ` · ${r.changes} changes` : ''}`);
        }
      }
      item.description = parts.join('  ');
      item.iconPath = new vscode.ThemeIcon(pct !== undefined && pct >= 100 ? 'pass-filled' : 'circle-filled', themeColorFor(coverageLevel(pct)));
      item.contextValue = 'file';
    }

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${f.relativePath}**\n\n`);
    if (f.untested) {
      tooltip.appendMarkdown(`No test imports this file, so it has **0%** coverage (about ${f.linesFound} executable lines).\n\nRight-click → **Create Test File** to get started.`);
    } else {
      tooltip.appendMarkdown(`Lines: ${formatPercent(pct)} (${f.linesHit}/${f.linesFound})\n\n`);
      if (trend !== undefined) {
        tooltip.appendMarkdown(`Since the previous run: ${trendText(trend)}\n\n`);
      }
      const uncovered = f.linesFound - f.linesHit;
      if (uncovered > 0) {
        tooltip.appendMarkdown(`${uncovered} uncovered line${uncovered === 1 ? '' : 's'}. Expand to jump to them.\n\n`);
      }
      if (weak) {
        tooltip.appendMarkdown(`⚠ ${weak} weak spot${weak === 1 ? '' : 's'}: lines that are run by tests but not checked.\n\n`);
      }
      if (this.store.isChanged(f)) {
        tooltip.appendMarkdown(`Changed on this branch.`);
      }
    }
    item.tooltip = tooltip;
    return item;
  }

  private rangeItem(node: RangeNode): vscode.TreeItem {
    const lines = node.start === node.end ? `Line ${node.start}` : `Lines ${node.start}–${node.end}`;
    const item = new vscode.TreeItem(lines, vscode.TreeItemCollapsibleState.None);
    item.id = `range:${node.file.uri.toString()}:${node.start}`;
    item.description = node.symbol ? `in ${node.symbol}()` : 'not covered';
    item.iconPath = new vscode.ThemeIcon('debug-breakpoint-unverified', new vscode.ThemeColor('charts.red'));
    item.tooltip = 'Not run by any test. Click to jump there.';
    item.command = { command: 'dartboard.openAt', title: 'Go to lines', arguments: [node.file.uri, node.start, node.end] };
    return item;
  }

  private weakItem(node: WeakNode): vscode.TreeItem {
    const item = new vscode.TreeItem(`Weak spot: line ${node.line}`, vscode.TreeItemCollapsibleState.None);
    item.id = `weak:${node.file.uri.toString()}:${node.line}`;
    item.description = `"${node.original.trim()}" → "${node.replacement.trim()}" not caught`;
    item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
    item.tooltip = new vscode.MarkdownString(
      `This line is covered, but when \`${node.original.trim()}\` was changed to \`${node.replacement.trim()}\` no test failed:\n\n\`\`\`dart\n${node.code}\n\`\`\`\n\nAdd an \`expect\` that checks this result.`,
    );
    item.command = { command: 'dartboard.openAt', title: 'Go to line', arguments: [node.file.uri, node.line, node.line] };
    return item;
  }

  private sort<T extends CoverageNode>(nodes: T[], forced?: SortBy): T[] {
    const sortBy = forced ?? this.sortBy;
    const name = (n: CoverageNode) => (n.kind === 'folder' ? n.name : n.kind === 'file' ? n.file.relativePath : '');
    const pct = (n: CoverageNode) => {
      if (n.kind === 'folder') {
        return percent(n.linesHit, n.linesFound) ?? 101;
      }
      if (n.kind === 'file') {
        return percent(n.file.linesHit, n.file.linesFound) ?? 101;
      }
      return 0;
    };
    return nodes.sort((a, b) => {
      // Keep folders above files, like the explorer.
      if (a.kind !== b.kind) {
        return a.kind === 'folder' ? -1 : 1;
      }
      if (sortBy === 'name') {
        return name(a).localeCompare(name(b));
      }
      const diff = sortBy === 'coverageAsc' ? pct(a) - pct(b) : pct(b) - pct(a);
      return diff !== 0 ? diff : name(a).localeCompare(name(b));
    });
  }

  private sortDeep(folder: FolderNode): void {
    this.sort(folder.children);
    for (const child of folder.children) {
      if (child.kind === 'folder') {
        this.sortDeep(child);
      }
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

export function trendText(delta: number): string {
  const v = Math.abs(delta) < 0.05 ? 0 : delta;
  return `${v > 0 ? '▲' : v < 0 ? '▼' : '•'} ${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function bar(fraction: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

function layerIcon(layer: string): string {
  switch (layer) {
    case 'UI':
      return 'layout';
    case 'State':
      return 'symbol-event';
    case 'Data':
      return 'database';
    case 'Utils':
      return 'tools';
    default:
      return 'folder';
  }
}

function accumulate(folder: FolderNode): void {
  folder.linesFound = 0;
  folder.linesHit = 0;
  const includeUntested = includeUntestedSetting();
  for (const child of folder.children) {
    if (child.kind === 'folder') {
      accumulate(child);
      folder.linesFound += child.linesFound;
      folder.linesHit += child.linesHit;
    } else if (child.kind === 'file' && (includeUntested || !child.file.untested)) {
      folder.linesFound += child.file.linesFound;
      folder.linesHit += child.file.linesHit;
    }
  }
}

/** Collapses chains of single-folder folders into one node, e.g. `lib/src/features`. */
function compact(folder: FolderNode): void {
  for (let i = 0; i < folder.children.length; i++) {
    let child = folder.children[i];
    if (child.kind !== 'folder') {
      continue;
    }
    while (child.children.length === 1 && child.children[0].kind === 'folder') {
      const only: FolderNode = child.children[0];
      only.name = `${child.name}/${only.name}`;
      only.parent = folder;
      child = only;
    }
    child.parent = folder;
    folder.children[i] = child;
    for (const grandChild of child.children) {
      grandChild.parent = child;
    }
    compact(child);
  }
}
