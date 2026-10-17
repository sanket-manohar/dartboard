/**
 * Lightweight, dependency-free Dart source analysis: finds classes and functions,
 * estimates complexity and executable lines, generates test skeletons and picks
 * mutation candidates. Pure (no `vscode` import) so it can be unit tested.
 */

export type SymbolKind = 'class' | 'function' | 'method' | 'getter' | 'constructor';

export interface DartSymbol {
  name: string;
  kind: SymbolKind;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  parent?: string;
  isPrivate: boolean;
  /** For classes: true when it extends StatelessWidget/StatefulWidget. */
  isWidget?: boolean;
  /** For classes: true for abstract classes, mixins, extensions and enums. */
  isAbstract?: boolean;
}

export interface DartAnalysis {
  symbols: DartSymbol[];
  /** 1 + number of branch points (if/for/while/case/catch/&&/||/??). */
  complexity: number;
  /** Rough count of executable lines, used for files no test touches. */
  executableLines: number;
}

/** Replaces comments and string contents with spaces, keeping line/column positions. */
export function sanitizeDart(src: string): string {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n' && out[k] !== '\r') {
        out[k] = ' ';
      }
    }
  };
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      const raw = i > 0 && src[i - 1] === 'r';
      const triple = src.substr(i, 3) === c.repeat(3);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < n) {
        if (!raw && src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src.substr(j, quote.length) === quote) {
          break;
        }
        if (!triple && src[j] === '\n') {
          break;
        }
        j++;
      }
      // Keep the quotes so expressions still look like expressions.
      blank(i + quote.length, j);
      i = Math.min(n, j + quote.length);
    } else {
      i++;
    }
  }
  return out.join('');
}

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'assert', 'super', 'this',
  'await', 'throw', 'else', 'do', 'try', 'when', 'yield', 'print', 'setState',
]);

function findMatching(text: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === open) {
      depth++;
    } else if (text[i] === close) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return text.length - 1;
}

/** Index of the `;` that ends an expression starting at `from`, ignoring nested brackets. */
function findStatementEnd(text: string, from: number): number {
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
      return i;
    }
  }
  return text.length - 1;
}

export function analyzeDart(src: string): DartAnalysis {
  const text = sanitizeDart(src);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lineStarts.push(i + 1);
    }
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

  const symbols: DartSymbol[] = [];
  const classRanges: Array<{ name: string; start: number; end: number }> = [];

  const classRe =
    /(^|[\s;}])((?:abstract\s+|sealed\s+|base\s+|final\s+|interface\s+|mixin\s+)*)(class|mixin|extension|enum)\b\s*([A-Za-z_$][\w$]*)?([^{;]*)\{/g;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(text))) {
    const keywordStart = m.index + m[1].length;
    const braceIndex = m.index + m[0].length - 1;
    const end = findMatching(text, braceIndex, '{', '}');
    const kind = m[3];
    const name = m[4] && m[4] !== 'on' ? m[4] : kind === 'extension' ? `extension${m[5] ? m[5].trim() : ''}` : kind;
    const header = m[5] ?? '';
    const isWidget = /extends\s+(StatelessWidget|StatefulWidget|ConsumerWidget|ConsumerStatefulWidget|HookWidget|HookConsumerWidget)\b/.test(header);
    symbols.push({
      name,
      kind: 'class',
      startLine: lineOf(keywordStart),
      endLine: lineOf(end),
      // Unnamed extensions can't be referenced from a test, so treat them as private.
      isPrivate: name.startsWith('_') || (kind === 'extension' && (!m[4] || m[4] === 'on')),
      isWidget,
      isAbstract: /abstract|interface|sealed/.test(m[2]) || kind !== 'class',
    });
    classRanges.push({ name, start: braceIndex, end });
  }

  const parentClass = (offset: number) => {
    let best: { name: string; start: number; end: number } | undefined;
    for (const r of classRanges) {
      if (offset > r.start && offset < r.end && (!best || r.start > best.start)) {
        best = r;
      }
    }
    return best;
  };

  const fnRe = /(?:^|\n)([ \t]*)(?:@[\w.]+(?:\([^)\n]*\))?\s+)*((?:static\s+|external\s+|factory\s+|const\s+|late\s+|final\s+)*)((?:[\w$<>?,.\[\] ]+?\s+)?)(get\s+|set\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*(<[^>(){};=]*>)?\s*(\(|\{|=>)/g;
  let skipUntil = -1;
  let executableLines = 0;
  const countedLines = new Set<number>();
  const countBody = (from: number, to: number) => {
    const first = lineOf(from);
    const last = lineOf(to);
    for (let l = first; l <= last; l++) {
      if (countedLines.has(l)) {
        continue;
      }
      const lineText = text.slice(lineStarts[l - 1], lineStarts[l] ?? text.length);
      if (/[\w$]/.test(lineText)) {
        countedLines.add(l);
        executableLines++;
      }
    }
  };

  while ((m = fnRe.exec(text))) {
    const headerStart = m.index + (m[0].startsWith('\n') ? 1 : 0) + m[1].length;
    if (headerStart < skipUntil) {
      continue;
    }
    const name = m[5];
    const isGetter = m[4]?.trim() === 'get';
    const opener = m[7];
    const lastWord = name.split('.').pop()!;
    if (KEYWORDS.has(lastWord) || KEYWORDS.has(m[3].trim())) {
      continue;
    }
    // Prefix must look like a type, not an expression.
    if (/[=:]/.test(m[3])) {
      continue;
    }
    let bodyStart = -1;
    let bodyEnd = -1;
    const openerIndex = m.index + m[0].length - opener.length;
    if (opener === '(') {
      if (isGetter) {
        continue;
      }
      const closeParen = findMatching(text, openerIndex, '(', ')');
      const rest = text.slice(closeParen + 1, closeParen + 400);
      const body = /^\s*(?:async\*?|sync\*)?\s*(\{|=>)/.exec(rest);
      if (body) {
        bodyStart = closeParen + 1 + body[0].length - body[1].length;
      } else if (/^\s*:/.test(rest)) {
        // Constructor initializer list: body is the next `{` before a `;`.
        const after = closeParen + 1;
        const semi = findStatementEnd(text, after);
        const brace = text.indexOf('{', after);
        if (brace >= 0 && brace < semi) {
          bodyStart = brace;
        } else {
          countBody(after, semi);
          continue;
        }
      } else {
        continue;
      }
    } else if (isGetter) {
      bodyStart = openerIndex;
    } else {
      continue;
    }
    if (text[bodyStart] === '{') {
      bodyEnd = findMatching(text, bodyStart, '{', '}');
    } else {
      bodyEnd = findStatementEnd(text, bodyStart + 2);
    }
    const parent = parentClass(headerStart);
    const isConstructor = !!parent && (lastWord === parent.name || name.startsWith(parent.name + '.'));
    const kind: SymbolKind = isGetter ? 'getter' : isConstructor ? 'constructor' : parent ? 'method' : 'function';
    symbols.push({
      name,
      kind,
      startLine: lineOf(headerStart),
      endLine: lineOf(bodyEnd),
      parent: parent?.name,
      isPrivate: lastWord.startsWith('_'),
    });
    if (text[bodyStart] === '{') {
      countBody(bodyStart + 1, Math.max(bodyStart + 1, bodyEnd - 1));
    } else {
      countBody(bodyStart, bodyEnd);
    }
    skipUntil = bodyEnd;
    fnRe.lastIndex = Math.max(fnRe.lastIndex, bodyEnd);
  }

  const branches = text.match(/\b(if|for|while|case|catch)\b|&&|\|\||\?\?/g)?.length ?? 0;
  symbols.sort((a, b) => a.startLine - b.startLine);
  return { symbols, complexity: 1 + branches, executableLines };
}

/** Innermost function-like symbol containing the line, e.g. `LoginBloc.login`. */
export function enclosingSymbol(symbols: DartSymbol[], line: number): string | undefined {
  let best: DartSymbol | undefined;
  for (const s of symbols) {
    if (s.kind === 'class') {
      continue;
    }
    if (line >= s.startLine && line <= s.endLine && (!best || s.startLine >= best.startLine)) {
      best = s;
    }
  }
  if (!best) {
    return undefined;
  }
  return best.parent && !best.name.startsWith(best.parent) ? `${best.parent}.${best.name}` : best.name;
}

/** Builds a starter `_test.dart` with a group per public class and a test per public member. */
export function generateTestSkeleton(packageName: string, libRelativePath: string, isFlutter: boolean, symbols: DartSymbol[]): string {
  const imports = [
    isFlutter ? "import 'package:flutter_test/flutter_test.dart';" : "import 'package:test/test.dart';",
  ];
  const hasWidgets = symbols.some((s) => s.kind === 'class' && s.isWidget && !s.isPrivate);
  if (hasWidgets) {
    imports.unshift("import 'package:flutter/material.dart';");
  }
  imports.push(`import 'package:${packageName}/${libRelativePath}';`);

  const body: string[] = [];
  const classes = symbols.filter((s) => s.kind === 'class' && !s.isPrivate);
  for (const cls of classes) {
    const members = symbols.filter(
      (s) => s.parent === cls.name && !s.isPrivate && s.kind !== 'constructor' && s.name !== 'build' && s.name !== 'createState',
    );
    body.push(`  group('${cls.name}', () {`);
    if (cls.isWidget) {
      body.push(`    testWidgets('renders', (tester) async {`);
      body.push(`      // TODO: pass the required constructor arguments.`);
      body.push(`      await tester.pumpWidget(const MaterialApp(home: ${cls.name}()));`);
      body.push(`      expect(find.byType(${cls.name}), findsOneWidget);`);
      body.push(`    });`);
    }
    for (const member of members) {
      body.push(`    test('${member.name}', () {`);
      body.push(`      // TODO: arrange, act, assert.`);
      body.push(`    });`);
    }
    if (!cls.isWidget && members.length === 0) {
      body.push(`    test('can be created', () {`);
      body.push(`      // TODO: create a ${cls.name} and check its state.`);
      body.push(`    });`);
    }
    body.push(`  });`, '');
  }
  for (const fn of symbols.filter((s) => s.kind === 'function' && !s.isPrivate && s.name !== 'main')) {
    body.push(`  test('${fn.name}', () {`);
    body.push(`    // TODO: arrange, act, assert.`);
    body.push(`  });`, '');
  }
  if (body.length === 0) {
    body.push(`  test('works', () {`, `    // TODO: write your first test.`, `  });`);
  }
  while (body[body.length - 1] === '') {
    body.pop();
  }
  return `${imports.join('\n')}\n\nvoid main() {\n${body.join('\n')}\n}\n`;
}

export interface Mutant {
  /** 1-based line. */
  line: number;
  column: number;
  original: string;
  replacement: string;
}

const MUTATIONS: Array<[RegExp, string, string]> = [
  [/ == /, ' == ', ' != '],
  [/ != /, ' != ', ' == '],
  [/ >= /, ' >= ', ' < '],
  [/ <= /, ' <= ', ' > '],
  [/ > /, ' > ', ' <= '],
  [/ < /, ' < ', ' >= '],
  [/ && /, ' && ', ' || '],
  [/ \|\| /, ' || ', ' && '],
  [/\btrue\b/, 'true', 'false'],
  [/\bfalse\b/, 'false', 'true'],
  [/ \+ /, ' + ', ' - '],
  [/ - /, ' - ', ' + '],
];

/**
 * Picks up to `max` small code changes ("mutants") on the given lines, one per line,
 * spread across the file. Operators are found in sanitized text so strings and
 * comments are never touched.
 */
export function findMutants(src: string, candidateLines: number[], max: number): Mutant[] {
  const lines = sanitizeDart(src).split('\n');
  const all: Mutant[] = [];
  for (const line of [...new Set(candidateLines)].sort((a, b) => a - b)) {
    const text = lines[line - 1];
    if (!text || /^\s*(import|export|part|library|@)/.test(text)) {
      continue;
    }
    for (const [re, original, replacement] of MUTATIONS) {
      const found = re.exec(text);
      if (found) {
        all.push({ line, column: found.index, original, replacement });
        break;
      }
    }
  }
  if (all.length <= max) {
    return all;
  }
  const picked: Mutant[] = [];
  const step = all.length / max;
  for (let i = 0; i < max; i++) {
    picked.push(all[Math.floor(i * step)]);
  }
  return picked;
}

export function applyMutant(src: string, mutant: Mutant): string {
  const lines = src.split('\n');
  const text = lines[mutant.line - 1];
  lines[mutant.line - 1] =
    text.slice(0, mutant.column) + mutant.replacement + text.slice(mutant.column + mutant.original.length);
  return lines.join('\n');
}
