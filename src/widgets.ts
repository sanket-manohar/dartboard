/**
 * Widget-level analysis of Dart source: the widget tree each build() returns, which of
 * those widgets tests actually rendered, how testable interactive widgets are, and which
 * screens the app routes to. Pure (no `vscode` import) so it can be unit tested.
 */
import { analyzeDart, DartSymbol, sanitizeDart } from './dart';

export type RenderStatus = 'rendered' | 'missed' | 'unknown';

export interface WidgetNode {
  name: string;
  /** 1-based. */
  line: number;
  column: number;
  status: RenderStatus;
  /** True for buttons, fields, switches and other things a user interacts with. */
  interactive: boolean;
  hasKey: boolean;
  children: WidgetNode[];
}

export interface WidgetClassTree {
  /** The widget class (for State classes, the widget it belongs to). */
  widget: string;
  /** Class holding the build method (`_HomeState` for stateful widgets). */
  holder: string;
  buildLine: number;
  roots: WidgetNode[];
  rendered: number;
  missed: number;
  unknown: number;
  /** Interactive widgets without a Key, which tests can't find reliably. */
  unkeyedInteractive: WidgetNode[];
  interactiveCount: number;
}

/** Constructor-looking calls that are values, not widgets. */
const NOT_WIDGETS = new Set([
  'EdgeInsets', 'EdgeInsetsDirectional', 'BorderRadius', 'BorderRadiusDirectional', 'Radius', 'Border', 'BorderSide',
  'BoxDecoration', 'ShapeDecoration', 'RoundedRectangleBorder', 'CircleBorder', 'StadiumBorder', 'BeveledRectangleBorder',
  'ContinuousRectangleBorder', 'OutlineInputBorder', 'UnderlineInputBorder', 'TextStyle', 'StrutStyle', 'Color', 'Offset',
  'Size', 'Rect', 'Duration', 'Alignment', 'AlignmentDirectional', 'FractionalOffset', 'BoxConstraints', 'BoxShadow',
  'Shadow', 'LinearGradient', 'RadialGradient', 'SweepGradient', 'Matrix4', 'Key', 'ValueKey', 'ObjectKey', 'UniqueKey',
  'GlobalKey', 'PageStorageKey', 'Locale', 'ThemeData', 'ColorScheme', 'TextTheme', 'InputDecoration', 'ButtonStyle',
  'MaterialStateProperty', 'WidgetStateProperty', 'MaterialStatePropertyAll', 'WidgetStatePropertyAll', 'DateTime', 'Uri',
  'List', 'Map', 'Set', 'String', 'Future', 'Stream', 'MaterialPageRoute', 'CupertinoPageRoute', 'PageRouteBuilder',
  'TextEditingController', 'ScrollController', 'PageController', 'TabController', 'AnimationController', 'FocusNode',
  'TextSpan', 'WidgetSpan', 'IconData', 'AssetImage', 'NetworkImage', 'FileImage', 'MemoryImage', 'DecorationImage',
  'ImageIcon', 'Curves', 'Tween', 'ColorTween', 'CurvedAnimation', 'Interval', 'SliverGridDelegateWithFixedCrossAxisCount',
  'SliverGridDelegateWithMaxCrossAxisExtent', 'SliverChildBuilderDelegate', 'SliverChildListDelegate', 'TextInputType',
  'FilteringTextInputFormatter', 'LengthLimitingTextInputFormatter', 'Exception', 'StateError', 'ArgumentError',
  'Error', 'Object', 'Stopwatch', 'Timer', 'Completer', 'RegExp', 'Paint', 'Path', 'BorderDirectional', 'IconThemeData',
  'AppBarTheme', 'CardTheme', 'SystemUiOverlayStyle', 'FontWeight', 'TextAlign', 'Brightness', 'GoRouter', 'GoRoute',
  'ShellRoute', 'StatefulShellRoute', 'MaterialPage', 'CupertinoPage', 'CustomTransitionPage', 'NoTransitionPage',
  'Navigator', 'MediaQuery', 'Theme', 'ScaffoldMessenger', 'Scrollable', 'Focus', 'FocusScope', 'DefaultTabController',
]);

/** Static helpers like Theme.of() that look like named constructors. */
const STATIC_CALLS = /^(of|maybeOf|push\w*|pop\w*|go|goNamed|showSnackBar|fromSeed|fromARGB|fromRGBO|fromLTRB|fromLTWH|all|symmetric|only|circular|lerp|copyWith|parse|tryParse|now|from|value|zero|merge|withOpacity|withAlpha|withValues)$/;

const INTERACTIVE = new Set([
  'ElevatedButton', 'TextButton', 'OutlinedButton', 'FilledButton', 'IconButton', 'FloatingActionButton', 'CupertinoButton',
  'TextField', 'TextFormField', 'CupertinoTextField', 'Checkbox', 'CheckboxListTile', 'Switch', 'SwitchListTile',
  'CupertinoSwitch', 'Radio', 'RadioListTile', 'Slider', 'RangeSlider', 'CupertinoSlider', 'DropdownButton',
  'DropdownButtonFormField', 'DropdownMenu', 'PopupMenuButton', 'GestureDetector', 'InkWell', 'InkResponse',
  'SegmentedButton', 'ChoiceChip', 'FilterChip', 'ActionChip', 'InputChip', 'BackButton', 'CloseButton', 'Stepper',
  'SearchBar', 'MenuAnchor', 'ToggleButtons',
]);

interface Call {
  name: string;
  start: number;
  /** Index of the `(` that opens the argument list. */
  open: number;
  close: number;
}

/** Finds constructor-like calls (`Text(`, `Image.asset(`, `const Padding(`) in [from, to). */
function findCalls(text: string, from: number, to: number, isWidget: (name: string) => boolean): Call[] {
  const calls: Call[] = [];
  const re = /\b([A-Z][\w$]*)(?:\.([a-zA-Z_$][\w$]*))?\s*(<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>)?\s*\(/g;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && m.index < to) {
    const base = m[1];
    const named = m[2];
    // `x.Foo(` is a method call on an object; `Foo.bar(` is fine unless it's a static helper.
    const before = text[m.index - 1];
    if (before === '.' || (named && STATIC_CALLS.test(named)) || NOT_WIDGETS.has(base) || !isWidget(base)) {
      continue;
    }
    const open = m.index + m[0].length - 1;
    calls.push({ name: named ? `${base}.${named}` : base, start: m.index, open, close: matchParen(text, open) });
  }
  return calls;
}

function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return text.length - 1;
}

/** Text of the call's own arguments with nested brackets blanked, to look for `key:` at depth 1. */
function topLevelArgs(text: string, call: Call): string {
  let out = '';
  let depth = 0;
  for (let i = call.open + 1; i < call.close; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
    }
    out += depth === 0 ? c : ' ';
  }
  return out;
}

/** Whether the call sits in a ternary or collection-if, so it may not run even when its parent did. */
function isConditional(text: string, call: Call, parentOpen: number): boolean {
  // Walk back to the start of this argument (a `,`, `(`, `[` or `{` at the same depth).
  let depth = 0;
  let i = call.start - 1;
  for (; i > parentOpen; i--) {
    const c = text[i];
    if (c === ')' || c === ']' || c === '}') {
      depth++;
    } else if (c === '(' || c === '[' || c === '{') {
      if (depth === 0) {
        break;
      }
      depth--;
    } else if (c === ',' && depth === 0) {
      break;
    }
  }
  const prefix = text.slice(i + 1, call.start);
  return /\?(?![.?])/.test(prefix) || /\bif\s*\(/.test(prefix);
}

export interface Lines {
  get(line: number): number | undefined;
}

/**
 * Builds the widget tree of every build() method in the file and marks each widget as
 * rendered or missed using the line hit counts from coverage.
 */
export function widgetTrees(src: string, lines: Lines | undefined, knownNonWidgets: Set<string> = new Set()): WidgetClassTree[] {
  const text = sanitizeDart(src);
  const analysis = analyzeDart(src);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lineStarts.push(i + 1);
    }
  }
  const pos = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
  };
  const isWidget = (name: string) => !knownNonWidgets.has(name);
  const classes = analysis.symbols.filter((s) => s.kind === 'class');
  const result: WidgetClassTree[] = [];

  for (const build of analysis.symbols.filter((s) => s.name === 'build' && s.kind === 'method' && s.parent)) {
    const holder = classes.find((c) => c.name === build.parent);
    if (!holder) {
      continue;
    }
    const widget = widgetNameFor(holder, src) ?? holder.name;
    const from = lineStarts[build.startLine - 1] ?? 0;
    const to = lineStarts[build.endLine] ?? text.length;
    const calls = findCalls(text, from, to, isWidget);

    const make = (call: Call, parentStatus: RenderStatus, parentOpen: number): WidgetNode => {
      const { line, column } = pos(call.start);
      const hits = lines?.get(line);
      let status: RenderStatus;
      if (!lines) {
        status = 'unknown';
      } else if (hits !== undefined) {
        status = hits > 0 ? 'rendered' : 'missed';
      } else if (parentStatus === 'missed') {
        status = 'missed';
      } else {
        status = isConditional(text, call, parentOpen) ? 'unknown' : parentStatus;
      }
      const base = call.name.split('.')[0];
      return {
        name: call.name,
        line,
        column,
        status,
        interactive: INTERACTIVE.has(base),
        hasKey: /\bkey\s*:/.test(topLevelArgs(text, call)),
        children: [],
      };
    };

    // Nest calls by their argument ranges.
    const roots: WidgetNode[] = [];
    const stack: Array<{ call: Call; node: WidgetNode }> = [];
    for (const call of calls) {
      while (stack.length && call.start > stack[stack.length - 1].call.close) {
        stack.pop();
      }
      const parent = stack[stack.length - 1];
      const node = make(call, parent ? parent.node.status : 'rendered', parent ? parent.call.open : from);
      if (parent) {
        parent.node.children.push(node);
      } else {
        roots.push(node);
      }
      stack.push({ call, node });
    }

    let rendered = 0;
    let missed = 0;
    let unknown = 0;
    let interactiveCount = 0;
    const unkeyedInteractive: WidgetNode[] = [];
    const visit = (n: WidgetNode) => {
      if (n.status === 'rendered') {
        rendered++;
      } else if (n.status === 'missed') {
        missed++;
      } else {
        unknown++;
      }
      if (n.interactive) {
        interactiveCount++;
        if (!n.hasKey) {
          unkeyedInteractive.push(n);
        }
      }
      n.children.forEach(visit);
    };
    roots.forEach(visit);
    if (roots.length === 0) {
      continue;
    }
    result.push({ widget, holder: holder.name, buildLine: build.startLine, roots, rendered, missed, unknown, unkeyedInteractive, interactiveCount });
  }
  return result;
}

/** For `class _HomeState extends State<Home>` returns `Home`. */
function widgetNameFor(holder: DartSymbol, src: string): string | undefined {
  const lines = src.split('\n');
  const header = lines.slice(holder.startLine - 1, holder.startLine + 2).join(' ');
  return /extends\s+(?:State|ConsumerState)<\s*([A-Za-z_$][\w$]*)\s*>/.exec(header)?.[1];
}

export interface DeclaredClass {
  name: string;
  superclass?: string;
  /** Type arguments of the superclass, e.g. `['CounterEvent', 'CounterState']` for Bloc. */
  typeArgs: string[];
  interfaces: string[];
  mixins: string[];
  isAbstract: boolean;
  /** 1-based header line and body range. */
  line: number;
  endLine: number;
  /** Annotations right above the class, e.g. `RoutePage`. */
  annotations: string[];
}

/** Every class declaration in a file with its supertypes. */
export function declaredClasses(src: string): DeclaredClass[] {
  const text = sanitizeDart(src);
  const out: DeclaredClass[] = [];
  const re = /(^|[\s;}])((?:(?:abstract|sealed|base|final|interface|mixin)\s+)*)class\s+([A-Za-z_$][\w$]*)\s*(<[^{]*?>)?\s*(?:extends\s+([A-Za-z_$][\w$.]*)\s*(<[^{]*?>)?)?\s*(?:with\s+([^{]*?))?\s*(?:implements\s+([^{]*?))?\s*\{/g;
  // Line lookups are done once per file; slicing per class was quadratic on large generated files.
  const srcLines = src.split('\n');
  const lineStarts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    lineStarts.push(i + 1);
  }
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo + 1;
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + m[1].length;
    const brace = m.index + m[0].length - 1;
    const end = matchParen(text, brace);
    const line = lineOf(start);
    const endLine = lineOf(end);
    const before = srcLines.slice(Math.max(0, line - 4), line - 1).join('\n');
    const annotations = [...before.matchAll(/@(\w+)/g)].map((a) => a[1]);
    out.push({
      name: m[3],
      superclass: m[5],
      typeArgs: m[6] ? splitTypeArgs(m[6].slice(1, -1)) : [],
      mixins: m[7] ? splitTypeArgs(m[7]) : [],
      interfaces: m[8] ? splitTypeArgs(m[8]) : [],
      isAbstract: /abstract|sealed|interface/.test(m[2]),
      line,
      endLine,
      annotations,
    });
  }
  return out;
}

function splitTypeArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '<') {
      depth++;
    } else if (c === '>') {
      depth--;
    }
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim()) {
    out.push(cur.trim());
  }
  return out.map((t) => t.replace(/<.*$/, '').replace(/\?$/, '').trim()).filter(Boolean);
}

export interface RouteEntry {
  /** URL path or route name; undefined for screens reached with Navigator.push. */
  path?: string;
  screen: string;
  /** 1-based line of the route declaration, and the file it's in (filled by the caller). */
  line: number;
  file?: string;
  via: 'go_router' | 'routes map' | 'onGenerateRoute' | 'auto_route' | 'push' | 'name';
}

/** Finds routes declared with go_router, MaterialApp.routes, onGenerateRoute, auto_route and Navigator.push. */
export function findRoutes(src: string): RouteEntry[] {
  const text = sanitizeDart(src);
  const routes: RouteEntry[] = [];
  const lineOf = (offset: number) => text.slice(0, offset).split('\n').length;
  const stringAt = (from: number, to: number) => {
    const m = /(['"])((?:(?!\1).)*)\1/.exec(src.slice(from, to));
    return m?.[2];
  };
  const firstScreen = (from: number, to: number) => {
    const calls = findCalls(text, from, to, () => true).filter(
      (c) => !/^(MaterialPage|CupertinoPage|CustomTransitionPage|NoTransitionPage|MaterialPageRoute|CupertinoPageRoute|PageRouteBuilder|FadeTransition|SlideTransition|BlocProvider|MultiBlocProvider|ChangeNotifierProvider|MultiProvider|ProviderScope|RepositoryProvider)$/.test(c.name.split('.')[0]),
    );
    return calls[0]?.name.split('.')[0];
  };

  for (const m of text.matchAll(/\bGoRoute\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchParen(text, open);
    const args = topLevelArgs(text, { name: 'GoRoute', start: m.index!, open, close });
    const pathArg = /\bpath\s*:/.exec(args);
    const path = pathArg ? stringAt(open + 1 + pathArg.index, close) : undefined;
    const builder = /\b(builder|pageBuilder)\s*:/.exec(args);
    if (!builder) {
      continue;
    }
    // The builder's extent: up to the next top-level argument.
    const bStart = open + 1 + builder.index;
    const next = args.slice(builder.index + builder[0].length).search(/,\s*\w+\s*:/);
    const bEnd = next >= 0 ? bStart + builder[0].length + next : close;
    const screen = firstScreen(bStart, bEnd);
    if (screen) {
      routes.push({ path, screen, line: lineOf(m.index!), via: 'go_router' });
    }
  }

  for (const m of text.matchAll(/\broutes\s*:\s*(?:<[^>]*>\s*)?\{/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchParen(text, open);
    const body = text.slice(open + 1, close);
    for (const e of body.matchAll(/(['"])[^'"]*\1\s*:\s*\([^)]*\)\s*(?:=>|\{)/g)) {
      const at = open + 1 + e.index!;
      const path = stringAt(at, at + e[0].length);
      const end = body.indexOf(',', e.index! + e[0].length);
      const screen = firstScreen(at + e[0].length, end >= 0 ? open + 1 + end + 200 : close);
      if (screen) {
        routes.push({ path, screen, line: lineOf(at), via: 'routes map' });
      }
    }
  }

  if (/onGenerateRoute/.test(text)) {
    for (const m of text.matchAll(/\bcase\s+(['"])[^'"]*\1\s*:/g)) {
      const path = stringAt(m.index!, m.index! + m[0].length);
      const next = text.indexOf('case ', m.index! + m[0].length);
      const screen = firstScreen(m.index! + m[0].length, next > 0 ? next : m.index! + 600);
      if (screen) {
        routes.push({ path, screen, line: lineOf(m.index!), via: 'onGenerateRoute' });
      }
    }
  }

  for (const m of text.matchAll(/\bAutoRoute\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchParen(text, open);
    const page = /\bpage\s*:\s*([A-Z][\w$]*)\.page/.exec(text.slice(open, close));
    if (page) {
      const pathArg = /\bpath\s*:/.exec(text.slice(open, close));
      routes.push({
        path: pathArg ? stringAt(open + pathArg.index, close) : undefined,
        screen: page[1].replace(/Route$/, ''),
        line: lineOf(m.index!),
        via: 'auto_route',
      });
    }
  }

  for (const m of text.matchAll(/\b(?:MaterialPageRoute|CupertinoPageRoute|PageRouteBuilder)\s*(?:<[^>]*>)?\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchParen(text, open);
    const screen = firstScreen(open + 1, close);
    if (screen && !routes.some((r) => r.screen === screen)) {
      routes.push({ screen, line: lineOf(m.index!), via: 'push' });
    }
  }
  return routes;
}

/** Package-relative test files that construct the class, e.g. `HomeScreen(` in a test. */
export function testsUsing(className: string, tests: Array<{ path: string; text: string }>): string[] {
  const re = new RegExp(`\\b${className.replace(/\$/g, '\\$')}\\s*(?:<[^>]*>)?\\s*\\(`);
  return tests.filter((t) => re.test(sanitizeDart(t.text))).map((t) => t.path);
}

/** Counts tests by kind for the test pyramid. */
export function countTests(text: string): { unit: number; widget: number; golden: number } {
  const clean = sanitizeDart(text);
  const widget = (clean.match(/\btestWidgets\s*\(/g) ?? []).length;
  const unit = (clean.match(/(^|[^\w.])test\s*\(/g) ?? []).length;
  // matchesGoldenFile appears in widget tests; count those tests as golden instead.
  const golden = Math.min(widget, (clean.match(/\bmatchesGoldenFile\s*\(/g) ?? []).length);
  return { unit, widget: widget - golden, golden };
}
