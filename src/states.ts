/**
 * State coverage: for Bloc, Cubit, Riverpod notifiers and ChangeNotifier classes, which
 * events were handled, which states were emitted and which methods ran during tests.
 * Pure (no `vscode` import) so it can be unit tested.
 */
import { analyzeDart, sanitizeDart } from './dart';
import { declaredClasses, DeclaredClass } from './widgets';

export type Reach = 'reached' | 'missed' | 'unknown';

export interface StateItem {
  kind: 'event' | 'state' | 'method';
  name: string;
  /** File and 1-based line to jump to. */
  file: string;
  line: number;
  status: Reach;
  /** Why it's missed, in plain words. */
  note?: string;
}

export interface StateHolder {
  name: string;
  kind: 'Bloc' | 'Cubit' | 'Notifier' | 'ChangeNotifier';
  file: string;
  line: number;
  items: StateItem[];
  reached: number;
  total: number;
}

export interface SourceFile {
  /** Path used for display and jumping (package-relative or absolute). */
  path: string;
  text: string;
  /** Line hit counts; undefined when the file has no coverage at all. */
  lines?: Map<number, number>;
  /** Lines where Dart branch coverage reports a code block, and whether it ever ran. */
  blocks?: Map<number, boolean>;
}

const NOTIFIERS = /^(Notifier|AsyncNotifier|StreamNotifier|StateNotifier|AutoDisposeNotifier|AutoDisposeAsyncNotifier|FamilyNotifier|FamilyAsyncNotifier|AutoDisposeFamilyNotifier|AutoDisposeFamilyAsyncNotifier|_\$\w+)$/;

export function stateCoverage(files: SourceFile[]): StateHolder[] {
  const classes: Array<DeclaredClass & { file: SourceFile }> = [];
  for (const f of files) {
    for (const c of declaredClasses(f.text)) {
      classes.push({ ...c, file: f });
    }
  }
  const subclassesOf = (base: string) =>
    classes.filter((c) => c.name !== base && (c.superclass === base || c.interfaces.includes(base) || c.mixins.includes(base)));

  const holders: StateHolder[] = [];
  for (const cls of classes) {
    let kind: StateHolder['kind'] | undefined;
    if (cls.superclass === 'Bloc') {
      kind = 'Bloc';
    } else if (cls.superclass === 'Cubit' || cls.superclass === 'HydratedCubit') {
      kind = 'Cubit';
    } else if (cls.superclass && NOTIFIERS.test(cls.superclass)) {
      kind = 'Notifier';
    } else if (cls.superclass === 'ChangeNotifier' || cls.mixins.includes('ChangeNotifier')) {
      kind = 'ChangeNotifier';
    }
    if (!kind) {
      continue;
    }
    const f = cls.file;
    const text = sanitizeDart(f.text);
    const lineStarts = starts(text);
    const from = lineStarts[cls.line - 1];
    const to = lineStarts[cls.endLine] ?? text.length;
    const body = text.slice(from, to);
    const items: StateItem[] = [];
    const hit = (line: number) => f.lines?.get(line);

    if (kind === 'Bloc') {
      const eventBase = cls.typeArgs[0];
      const handled = new Map<string, { line: number; status: Reach }>();
      for (const m of body.matchAll(/\bon\s*<\s*([A-Za-z_$][\w$]*)\s*>\s*\(/g)) {
        const at = from + m.index!;
        const line = lineAt(lineStarts, at);
        handled.set(m[1], { line, status: handlerStatus(text, at + m[0].length - 1, lineStarts, f) });
      }
      const events = eventBase ? subclassesOf(eventBase).filter((e) => !e.isAbstract) : [];
      for (const e of events) {
        const h = handled.get(e.name) ?? (eventBase ? handled.get(eventBase) : undefined);
        items.push({
          kind: 'event',
          name: e.name,
          file: h ? f.path : e.file.path,
          line: h ? h.line : e.line,
          status: h ? h.status : 'missed',
          note: h ? (h.status === 'missed' ? 'handler never ran in tests' : undefined) : 'no on<…> handler',
        });
      }
      for (const [name, h] of handled) {
        if (!events.some((e) => e.name === name) && name !== eventBase) {
          items.push({ kind: 'event', name, file: f.path, line: h.line, status: h.status, note: h.status === 'missed' ? 'handler never ran in tests' : undefined });
        }
      }
    } else {
      // Public methods are the actions a Cubit, notifier or ChangeNotifier offers.
      const analysis = analyzeDart(f.text);
      for (const s of analysis.symbols) {
        if (s.parent !== cls.name || s.isPrivate || s.kind === 'constructor' || s.kind === 'class' || ['build', 'dispose', 'toString', 'close', 'onChange', 'onError', 'onTransition'].includes(s.name)) {
          continue;
        }
        if (s.kind === 'getter') {
          continue;
        }
        const h = hit(s.startLine);
        const status: Reach = !f.lines ? 'unknown' : h === undefined ? 'unknown' : h > 0 ? 'reached' : 'missed';
        items.push({ kind: 'method', name: `${s.name}()`, file: f.path, line: s.startLine, status, note: status === 'missed' ? 'never called in tests' : undefined });
      }
    }

    // States: subclasses of the state type that are created in emit(...) or `state = ...`.
    const stateBase = kind === 'Bloc' ? cls.typeArgs[1] : kind === 'Cubit' || kind === 'Notifier' ? cls.typeArgs[0] : undefined;
    const stateClasses = stateBase ? subclassesOf(stateBase).filter((s) => !s.isAbstract) : [];
    if (stateClasses.length) {
      for (const s of stateClasses) {
        const sites = [...body.matchAll(new RegExp(`(?:\\bemit\\s*\\(|\\bstate\\s*=|\\bsuper\\s*\\()\\s*(?:const\\s+)?${escape(s.name)}\\s*[.(]`, 'g'))];
        if (!sites.length) {
          items.push({ kind: 'state', name: s.name, file: s.file.path, line: s.line, status: 'missed', note: `${cls.name} never creates it` });
          continue;
        }
        const lines = sites.map((m) => lineAt(lineStarts, from + m.index!));
        // A block on the same line that never ran (a one-line closure) means the emit didn't either.
        const counts = lines.map((l) => (f.blocks?.get(l) === false ? 0 : hit(l)));
        const status: Reach = !f.lines ? 'unknown' : counts.some((c) => (c ?? 0) > 0) ? 'reached' : counts.every((c) => c === undefined) ? 'unknown' : 'missed';
        items.push({ kind: 'state', name: s.name, file: f.path, line: lines[0], status, note: status === 'missed' ? 'never emitted in tests' : undefined });
      }
    }

    if (!items.length) {
      continue;
    }
    const reached = items.filter((i) => i.status === 'reached').length;
    holders.push({ name: cls.name, kind, file: f.path, line: cls.line, items, reached, total: items.length });
  }
  return holders;
}

/** Whether the callback passed to `on<E>(` ever ran. */
function handlerStatus(text: string, open: number, lineStarts: number[], f: SourceFile): Reach {
  if (!f.lines) {
    return 'unknown';
  }
  // Find the callback body: the first `{` or `=>` after the parameter list.
  const close = matchParen(text, open);
  const inner = text.slice(open + 1, close);
  const arrow = inner.search(/\)\s*(async\s*)?(\{|=>)/);
  const firstLine = lineAt(lineStarts, open);
  const lastLine = lineAt(lineStarts, close);
  if (arrow < 0) {
    // A method tear-off like on<Inc>(_onInc): look up the method by name.
    const name = /^\s*([A-Za-z_$][\w$]*)\s*[,)]?/.exec(inner)?.[1];
    if (name) {
      const decl = new RegExp(`(?:^|\\n)[ \\t]*(?:Future<void>|FutureOr<void>|void|Future)\\s+${escape(name)}\\s*\\(`).exec(text);
      if (decl) {
        const line = lineAt(lineStarts, decl.index + (decl[0].startsWith('\n') ? 1 : 0));
        const h = f.lines.get(line);
        return h === undefined ? 'unknown' : h > 0 ? 'reached' : 'missed';
      }
    }
    return 'unknown';
  }
  // Lines strictly inside a multi-line callback tell us whether it ran.
  const bodyLine = lineAt(lineStarts, open + 1 + arrow);
  const inside: number[] = [];
  for (let l = bodyLine + 1; l <= lastLine; l++) {
    const h = f.lines.get(l);
    if (h !== undefined) {
      inside.push(h);
    }
  }
  if (inside.length) {
    return inside.some((h) => h > 0) ? 'reached' : 'missed';
  }
  // One-line handler: branch coverage marks the closure's entry.
  const block = f.blocks?.get(bodyLine) ?? f.blocks?.get(firstLine);
  if (block !== undefined) {
    return block ? 'reached' : 'missed';
  }
  return 'unknown';
}

function starts(text: string): number[] {
  const s = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      s.push(i + 1);
    }
  }
  return s;
}

function lineAt(lineStarts: number[], offset: number): number {
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

function escape(s: string): string {
  return s.replace(/[$]/g, '\\$');
}
