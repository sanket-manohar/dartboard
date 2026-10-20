/**
 * Common widget test mistakes that make tests pass for the wrong reason, fail with a
 * confusing error, or hang. Pure (no `vscode` import) so it can be unit tested.
 */
import { sanitizeDart } from './dart';

export interface Pitfall {
  code: 'missing-pump' | 'missing-await' | 'no-expect' | 'real-delay' | 'needs-app';
  /** 1-based line, 0-based columns. */
  line: number;
  column: number;
  endColumn: number;
  severity: 'warning' | 'info';
  message: string;
  /** Text edits that fix it: insertions (or replacements) at 1-based line / 0-based column. */
  fix?: { title: string; edits: Array<{ line: number; column: number; endColumn?: number; endLine?: number; text: string }> };
}

const ACTIONS = /\btester\s*\.\s*(tap|tapAt|longPress|enterText|drag|dragFrom|fling|flingFrom|timedDrag|press|sendKeyEvent|showKeyboard|scrollUntilVisible|ensureVisible)\s*\(/g;
const PUMPS = /\btester\s*\.\s*(pump|pumpAndSettle|pumpWidget|pumpFrames|pumpBenchmark|runAsync)\s*\(/;
const ASYNC_TESTER = /\btester\s*\.\s*(pump|pumpAndSettle|pumpWidget|pumpFrames|tap|tapAt|longPress|enterText|drag|dragFrom|fling|flingFrom|timedDrag|press|sendKeyEvent|showKeyboard|runAsync|ensureVisible|scrollUntilVisible|idle)\s*\(/g;
const NEEDS_APP = new Set([
  'Scaffold', 'AppBar', 'TextField', 'TextFormField', 'ElevatedButton', 'TextButton', 'OutlinedButton', 'FilledButton',
  'IconButton', 'ListTile', 'FloatingActionButton', 'Checkbox', 'Switch', 'Radio', 'Slider', 'DropdownButton', 'Chip',
  'Drawer', 'BottomNavigationBar', 'NavigationBar', 'TabBar', 'AlertDialog', 'Card', 'Text', 'InkWell', 'Tooltip',
  'CheckboxListTile', 'SwitchListTile', 'DropdownButtonFormField', 'SearchBar', 'Form', 'ListView', 'Column', 'Row',
]);

interface Body {
  kind: 'test' | 'testWidgets';
  /** Offsets in sanitized text of the callback body braces. */
  open: number;
  close: number;
  nameLine: number;
  nameColumn: number;
  nameLength: number;
}

export function findPitfalls(src: string): Pitfall[] {
  const text = sanitizeDart(src);
  const lines = src.split(/\r?\n/);
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
    return { line: lo + 1, column: offset - lineStarts[lo] };
  };
  const indentOf = (line: number) => /^\s*/.exec(lines[line - 1] ?? '')![0];
  const out: Pitfall[] = [];

  const bodies: Body[] = [];
  for (const m of text.matchAll(/(^|[^\w.])(testWidgets|test)\s*\(/g)) {
    const start = m.index! + m[1].length;
    const parenOpen = m.index! + m[0].length - 1;
    const parenClose = matchParen(text, parenOpen);
    const cb = /\)\s*(?:async\s*)?\{/.exec(text.slice(parenOpen + 1, parenClose));
    if (!cb) {
      continue;
    }
    const open = parenOpen + 1 + cb.index + cb[0].length - 1;
    const { line, column } = pos(start);
    bodies.push({ kind: m[2] as Body['kind'], open, close: matchParen(text, open), nameLine: line, nameColumn: column, nameLength: m[2].length });
  }

  for (const body of bodies) {
    const inner = text.slice(body.open, body.close);
    const isWidgetTest = body.kind === 'testWidgets';

    if (!/\b(expect|expectLater|verify|verifyNever|verifyInOrder|verifyZeroInteractions|expectAsync\d?|matchesGoldenFile|screenMatchesGolden|multiScreenGolden|check|fail)\s*[(<]/.test(inner)) {
      out.push({
        code: 'no-expect',
        line: body.nameLine,
        column: body.nameColumn,
        endColumn: body.nameColumn + body.nameLength,
        severity: 'info',
        message: 'This test has no expect(), so it only fails if something throws. Add an expect() that checks the result.',
      });
    }

    if (isWidgetTest) {
      // An action (tap, enterText, …) followed by expect() with no pump in between.
      for (const a of inner.matchAll(ACTIONS)) {
        const at = body.open + a.index!;
        const stmtEnd = statementEnd(text, at);
        const rest = text.slice(stmtEnd, body.close);
        const nextExpect = rest.search(/\b(expect|expectLater)\s*\(/);
        if (nextExpect < 0) {
          continue;
        }
        const between = rest.slice(0, nextExpect);
        if (PUMPS.test(between) || /\btester\s*\.\s*\w+\s*\(/.test(between) || /\bawait\s+(?!tester)/.test(between)) {
          continue;
        }
        if (a[1] === 'scrollUntilVisible' || a[1] === 'ensureVisible') {
          continue;
        }
        const { line, column } = pos(at);
        const endLine = pos(stmtEnd).line;
        out.push({
          code: 'missing-pump',
          line,
          column,
          endColumn: column + a[0].length - 1,
          severity: 'warning',
          message: `The screen doesn't update after ${a[1]}() until you pump. The next expect() still sees the old UI.`,
          fix: {
            title: 'Add await tester.pump() after this line',
            edits: [{ line: endLine, column: (lines[endLine - 1] ?? '').length, text: `\n${indentOf(line)}await tester.pump();` }],
          },
        });
      }

      // Real delays don't advance the fake clock in widget tests.
      for (const d of inner.matchAll(/\b(Future\s*\.\s*delayed|sleep)\s*\(/g)) {
        const at = body.open + d.index!;
        const before = text.slice(Math.max(body.open, at - 40), at);
        if (/runAsync\s*\(\s*\(\s*\)\s*(async\s*)?(=>|\{)[^}]*$/.test(before)) {
          continue;
        }
        const { line, column } = pos(at);
        const isSleep = d[1] === 'sleep';
        const open = at + d[0].length - 1;
        const close = matchParen(text, open);
        const arg = src.slice(open + 1, close).trim();
        const fix = !isSleep && pos(close).line === line && arg && !arg.includes(',')
          ? { title: 'Use tester.pump(duration) instead', edits: [{ line, column, endColumn: pos(close).column + 1, text: `tester.pump(${arg})` }] }
          : undefined;
        out.push({
          code: 'real-delay',
          line,
          column,
          endColumn: column + d[1].replace(/\s/g, '').length,
          severity: 'warning',
          message: 'Widget tests use a fake clock, so real delays just slow the test (or hang it) without running timers. Use await tester.pump(const Duration(...)).',
          fix,
        });
      }

      // pumpWidget of a Material widget without an app around it.
      for (const p of inner.matchAll(/\btester\s*\.\s*pumpWidget\s*\(\s*(const\s+)?([A-Z][\w$]*)\s*(?:\.\w+)?\s*\(/g)) {
        const widget = p[2];
        if (!NEEDS_APP.has(widget)) {
          continue;
        }
        const argStart = body.open + p.index! + /^tester\s*\.\s*pumpWidget\s*\(\s*/.exec(p[0])![0].length;
        const argClose = matchParen(text, body.open + p.index! + p[0].length - 1);
        const s = pos(argStart);
        const e = pos(argClose + 1);
        const wrapOpen = widget === 'Scaffold' ? 'MaterialApp(home: ' : 'MaterialApp(home: Scaffold(body: ';
        const wrapClose = widget === 'Scaffold' ? ')' : '))';
        out.push({
          code: 'needs-app',
          line: s.line,
          column: s.column,
          endColumn: s.column + (p[1]?.length ?? 0) + widget.length,
          severity: 'warning',
          message: `${widget} needs an app around it (theme, text direction, navigator). Without one the test fails with "No MaterialLocalizations/Directionality found".`,
          fix: {
            title: `Wrap in ${widget === 'Scaffold' ? 'MaterialApp' : 'MaterialApp and Scaffold'}`,
            edits: [
              // Insert the closing first so the opening insert doesn't shift it on the same line.
              { line: e.line, column: e.column, text: wrapClose },
              { line: s.line, column: s.column, text: wrapOpen },
            ],
          },
        });
      }
    }
  }

  // tester calls that return a Future but aren't awaited.
  for (const c of text.matchAll(ASYNC_TESTER)) {
    const at = c.index!;
    const before = text.slice(Math.max(0, at - 30), at);
    if (/(await|return|=>|=|\(|,|\.then)\s*$/.test(before) || /\bunawaited\s*\(\s*$/.test(before)) {
      continue;
    }
    // Only statement starts: preceded by `;`, `{` or `}` and whitespace.
    if (!/[;{}]\s*$/.test(before) && !/^\s*$/.test(before)) {
      continue;
    }
    const { line, column } = pos(at);
    out.push({
      code: 'missing-await',
      line,
      column,
      endColumn: column + c[0].length - 1,
      severity: 'warning',
      message: `tester.${c[1]}() returns a Future. Without await the test moves on before it finishes, which causes flaky results or "Guarded function conflict".`,
      fix: { title: 'Add await', edits: [{ line, column, text: 'await ' }] },
    });
  }

  return out.sort((a, b) => a.line - b.line || a.column - b.column);
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

/** Offset just after the `;` ending the statement that contains `from`. */
function statementEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth < 0) {
        return i;
      }
    } else if (c === ';' && depth === 0) {
      return i + 1;
    }
  }
  return text.length;
}
