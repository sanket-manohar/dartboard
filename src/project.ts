import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CoverageStore, PackageInfo } from './coverageStore';
import { analyzeDart } from './dart';
import { ImportGraph } from './imports';
import { findPitfalls, Pitfall } from './pitfalls';
import { StateHolder, stateCoverage } from './states';
import { countTests, declaredClasses, findRoutes, RouteEntry, testsUsing, WidgetClassTree, widgetTrees } from './widgets';

export interface SourceText {
  pkg: PackageInfo;
  /** Package-relative, forward slashes. */
  rel: string;
  uri: vscode.Uri;
  text: string;
}

export interface Screen {
  name: string;
  route?: string;
  via?: RouteEntry['via'];
  uri: vscode.Uri;
  line: number;
  tree?: WidgetClassTree;
  /** Package-relative test files that build this screen. */
  tests: string[];
  pkg: PackageInfo;
}

export interface Pyramid {
  unit: number;
  widget: number;
  golden: number;
  integration: number;
}

export interface ProjectSnapshot {
  screens: Screen[];
  /** Widget classes that aren't screens but have a build method, by file. */
  widgets: Array<{ uri: vscode.Uri; trees: WidgetClassTree[] }>;
  states: Array<StateHolder & { uri: vscode.Uri; pkg: PackageInfo }>;
  pyramid: Pyramid;
  pitfalls: Array<{ uri: vscode.Uri; rel: string; items: Pitfall[] }>;
}

/**
 * Reads the Dart sources of every package (cached by modification time) and derives the
 * project-level views: screens and their widget trees, state classes, the test pyramid and
 * test pitfalls. Recomputed lazily when coverage or files change.
 */
export class ProjectModel implements vscode.Disposable {
  private cache = new Map<string, { mtime: number; text: string }>();
  private snapshot: ProjectSnapshot | undefined;
  private computing: Promise<ProjectSnapshot> | undefined;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly subs: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly store: CoverageStore) {
    this.subs.push(
      store.onDidChange(() => this.invalidate()),
      vscode.workspace.onDidSaveTextDocument((d) => d.languageId === 'dart' && this.invalidate()),
      vscode.workspace.onDidCreateFiles(() => this.invalidate()),
      vscode.workspace.onDidDeleteFiles(() => this.invalidate()),
    );
  }

  invalidate(): void {
    this.snapshot = undefined;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.emitter.fire(), 150);
  }

  async get(): Promise<ProjectSnapshot> {
    if (this.snapshot) {
      return this.snapshot;
    }
    if (!this.computing) {
      this.computing = this.compute().finally(() => (this.computing = undefined));
    }
    this.snapshot = await this.computing;
    return this.snapshot;
  }

  read(file: string): string | undefined {
    try {
      const mtime = fs.statSync(file).mtimeMs;
      const cached = this.cache.get(file);
      if (cached && cached.mtime === mtime) {
        return cached.text;
      }
      const text = fs.readFileSync(file, 'utf8');
      this.cache.set(file, { mtime, text });
      return text;
    } catch {
      return undefined;
    }
  }

  sources(pkg: PackageInfo, kind: 'lib' | 'test' | 'integration'): SourceText[] {
    let rels: string[];
    if (kind === 'lib') {
      rels = pkg.sourceFiles;
    } else if (kind === 'test') {
      rels = pkg.testFiles;
    } else {
      rels = listDart(path.join(pkg.root, 'integration_test')).map((f) => toPosix(path.relative(pkg.root, f)));
    }
    const out: SourceText[] = [];
    for (const rel of rels) {
      const abs = path.join(pkg.root, rel);
      const text = this.read(abs);
      if (text !== undefined) {
        out.push({ pkg, rel, uri: vscode.Uri.file(abs), text });
      }
    }
    return out;
  }

  /** Import graph of a package including its tests. */
  graph(pkg: PackageInfo): ImportGraph {
    const files = [...this.sources(pkg, 'lib'), ...this.sources(pkg, 'test')].map((s) => ({ path: s.rel, text: s.text }));
    return new ImportGraph(files, pkg.name);
  }

  hasIntegrationTests(): boolean {
    return this.store.packages.some((p) => fs.existsSync(path.join(p.root, 'integration_test')));
  }

  private lineMap(uri: vscode.Uri): Map<number, number> | undefined {
    const cov = this.store.get(uri);
    return cov && !cov.untested ? cov.lines : undefined;
  }

  private async compute(): Promise<ProjectSnapshot> {
    const snapshot: ProjectSnapshot = { screens: [], widgets: [], states: [], pyramid: { unit: 0, widget: 0, golden: 0, integration: 0 }, pitfalls: [] };
    for (const pkg of this.store.packages) {
      const lib = this.sources(pkg, 'lib');
      const tests = this.sources(pkg, 'test');
      const testTexts = tests.map((t) => ({ path: t.rel, text: t.text }));

      // Classes that are clearly not widgets, so `User(...)` in a build method isn't drawn as a widget.
      const nonWidgets = new Set<string>();
      const widgetClasses = new Map<string, { uri: vscode.Uri; line: number }>();
      for (const f of lib) {
        for (const c of declaredClasses(f.text)) {
          if (c.superclass && /^(StatelessWidget|StatefulWidget|ConsumerWidget|ConsumerStatefulWidget|HookWidget|HookConsumerWidget|StatelessWidget)$/.test(c.superclass)) {
            widgetClasses.set(c.name, { uri: f.uri, line: c.line });
          } else if (!c.superclass || !/Widget|State|Painter|Delegate|Route|Page/.test(c.superclass)) {
            nonWidgets.add(c.name);
          }
        }
      }

      // Widget trees per file.
      const treesByWidget = new Map<string, WidgetClassTree>();
      const treesByFile: Array<{ uri: vscode.Uri; trees: WidgetClassTree[] }> = [];
      for (const f of lib) {
        if (!/\bbuild\s*\(/.test(f.text)) {
          continue;
        }
        const trees = widgetTrees(f.text, this.lineMap(f.uri), nonWidgets);
        if (trees.length) {
          trees.forEach((t) => treesByWidget.set(t.widget, t));
          treesByFile.push({ uri: f.uri, trees });
        }
      }

      // Screens: routed widgets, @RoutePage classes, or by naming convention.
      const routes: Array<RouteEntry & { uri: vscode.Uri }> = [];
      for (const f of lib) {
        if (/GoRoute|routes\s*:|onGenerateRoute|AutoRoute|PageRoute/.test(f.text)) {
          findRoutes(f.text).forEach((r) => routes.push({ ...r, uri: f.uri }));
        }
      }
      const screenNames = new Map<string, RouteEntry | undefined>();
      for (const r of routes) {
        if (widgetClasses.has(r.screen) && !screenNames.get(r.screen)?.path) {
          screenNames.set(r.screen, r);
        }
      }
      for (const f of lib) {
        for (const c of declaredClasses(f.text)) {
          if (c.annotations.includes('RoutePage') && !screenNames.has(c.name)) {
            screenNames.set(c.name, undefined);
          }
        }
      }
      if (screenNames.size === 0) {
        for (const name of widgetClasses.keys()) {
          if (/(Screen|Page|View)$/.test(name)) {
            screenNames.set(name, undefined);
          }
        }
      }
      for (const [name, route] of screenNames) {
        const where = widgetClasses.get(name);
        if (!where) {
          continue;
        }
        snapshot.screens.push({
          name,
          route: route?.path,
          via: route?.via,
          uri: where.uri,
          line: where.line,
          tree: treesByWidget.get(name),
          tests: testsUsing(name, testTexts),
          pkg,
        });
      }
      const screenSet = new Set(screenNames.keys());
      for (const f of treesByFile) {
        const others = f.trees.filter((t) => !screenSet.has(t.widget));
        if (others.length) {
          snapshot.widgets.push({ uri: f.uri, trees: others });
        }
      }

      // State classes.
      const stateFiles = lib
        .filter((f) => /\b(Bloc|Cubit|Notifier|ChangeNotifier|StateNotifier)\b|_\$/.test(f.text))
        .map((f) => {
          const cov = this.store.get(f.uri);
          const blocks = new Map<number, boolean>();
          for (const [k, n] of cov?.branchData ?? []) {
            const l = parseInt(k, 10);
            blocks.set(l, (blocks.get(l) ?? false) || n > 0);
          }
          return { path: f.uri.fsPath, text: f.text, lines: cov && !cov.untested ? cov.lines : undefined, blocks: blocks.size ? blocks : undefined };
        });
      // Event and state classes may live in other files (parts, separate files).
      const supporting = lib
        .filter((f) => !stateFiles.some((s) => s.path === f.uri.fsPath) && /\bclass\b/.test(f.text) && /(Event|State)\b/.test(f.text))
        .map((f) => ({ path: f.uri.fsPath, text: f.text }));
      for (const h of stateCoverage([...stateFiles, ...supporting])) {
        snapshot.states.push({ ...h, uri: vscode.Uri.file(h.file), pkg });
      }

      // Test pyramid and pitfalls.
      for (const t of tests) {
        const c = countTests(t.text);
        snapshot.pyramid.unit += c.unit;
        snapshot.pyramid.widget += c.widget;
        snapshot.pyramid.golden += c.golden;
        const items = findPitfalls(t.text);
        if (items.length) {
          snapshot.pitfalls.push({ uri: t.uri, rel: t.rel, items });
        }
      }
      for (const t of this.sources(pkg, 'integration')) {
        const c = countTests(t.text);
        snapshot.pyramid.integration += c.unit + c.widget + c.golden;
      }
    }
    snapshot.screens.sort((a, b) => (a.route ?? '~' + a.name).localeCompare(b.route ?? '~' + b.name));
    return snapshot;
  }

  /** The widget trees of one file (for CodeLens), using current coverage. */
  treesFor(uri: vscode.Uri, text: string): WidgetClassTree[] {
    return widgetTrees(text, this.lineMap(uri));
  }

  /** Public functions and methods of a file, for function-level coverage. */
  functions(text: string) {
    return analyzeDart(text).symbols.filter((s) => s.kind !== 'class');
  }

  dispose(): void {
    this.emitter.dispose();
    this.subs.forEach((s) => s.dispose());
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }
}

function listDart(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? listDart(p) : e.name.endsWith('.dart') ? [p] : [];
    });
  } catch {
    return [];
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
