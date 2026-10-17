/**
 * Test case checklist: reads one function and lists the concrete cases a test should
 * cover (each if/else, switch case, thrown error, null and empty input), marking the ones
 * coverage shows were already exercised. Pure (no `vscode` import).
 */
import { DartSymbol, sanitizeDart } from './dart';

export interface TestCase {
  /** Short description, used as the test name. */
  title: string;
  /** What the test should arrange, for the stub's comment. */
  arrange: string;
  status: 'covered' | 'missing' | 'unknown';
  /** 1-based line the case is about. */
  line: number;
}

export function testCases(src: string, fn: DartSymbol, lines?: Map<number, number>, blocks?: Map<number, boolean>): TestCase[] {
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
  const from = lineStarts[fn.startLine - 1] ?? 0;
  const to = lineStarts[fn.endLine] ?? text.length;
  const body = text.slice(from, to);
  const cases: TestCase[] = [];
  /** Whether the block or statement spanning [start, end] (offsets) ever ran. */
  const ran = (start: number, end: number): 'covered' | 'missing' | 'unknown' => {
    if (!lines) {
      return 'unknown';
    }
    const first = lineOf(start);
    const last = lineOf(end);
    const isBlock = text[start] === '{';
    // Lines strictly inside a { } block, or the statement's own lines when it starts on a new line.
    const from = isBlock ? first + 1 : first;
    const to = isBlock ? last - 1 : last;
    const hits: number[] = [];
    for (let l = from; l <= to; l++) {
      const h = lines.get(l);
      if (h !== undefined) {
        hits.push(h);
      }
    }
    if (hits.length) {
      return hits.some((h) => h > 0) ? 'covered' : 'missing';
    }
    const block = blocks?.get(first);
    if (block !== undefined) {
      return block ? 'covered' : 'missing';
    }
    return 'unknown';
  };
  const original = (a: number, b: number) => src.slice(a, b).replace(/\s+/g, ' ').trim();

  // Parameters: nullable values and collections deserve their own cases.
  const header = text.slice(from, text.indexOf('(', from) >= 0 ? matchParen(text, text.indexOf('(', from)) + 1 : from);
  const paramsText = header.slice(header.indexOf('(') + 1, -1);
  for (const p of paramsText.split(',')) {
    const m = /([\w$<>?,\s]+?)\s+([a-zA-Z_$][\w$]*)\s*(?:=.*)?$/.exec(p.replace(/[{}[\]]|\brequired\b/g, '').trim());
    if (!m) {
      continue;
    }
    const type = m[1].trim();
    const name = m[2];
    if (/\?$/.test(type)) {
      cases.push({ title: `when ${name} is null`, arrange: `pass null for ${name}`, status: 'unknown', line: fn.startLine });
    }
    if (/^(List|Set|Map|Iterable|String)\b/.test(type.replace(/\?$/, ''))) {
      cases.push({ title: `with an empty ${name}`, arrange: `pass an empty ${type.replace(/<.*$/, '').replace(/\?$/, '')} as ${name}`, status: 'unknown', line: fn.startLine });
    }
  }

  // if / else if / else.
  for (const m of body.matchAll(/\bif\s*\(/g)) {
    const open = from + m.index! + m[0].length - 1;
    const close = matchParen(text, open);
    const cond = original(open + 1, close);
    if (!cond || /^case\b/.test(cond)) {
      continue;
    }
    const ifLine = lineOf(from + m.index!);
    const thenStart = skipSpace(text, close + 1);
    const thenEnd = text[thenStart] === '{' ? matchParen(text, thenStart) : statementEnd(text, thenStart);
    const isElseIf = /\belse\s*$/.test(text.slice(Math.max(from, from + m.index! - 12), from + m.index!));
    cases.push({
      title: `when ${shorten(cond)}`,
      arrange: `make ${shorten(cond)} true`,
      status: ran(thenStart, thenEnd),
      line: ifLine,
    });
    const after = skipSpace(text, thenEnd + 1);
    const hasElse = text.startsWith('else', after);
    if (!hasElse && !isElseIf) {
      // No else: the "false" path is covered when the if ran more often than its body.
      const ifHits = lines?.get(ifLine);
      const bodyHits = maxHits(lines, lineOf(thenStart) + (text[thenStart] === '{' ? 1 : 0), lineOf(thenEnd));
      cases.push({
        title: `when not ${shorten(cond)}`,
        arrange: `make ${shorten(cond)} false`,
        status: !lines || ifHits === undefined || bodyHits === undefined ? 'unknown' : ifHits > bodyHits ? 'covered' : 'missing',
        line: ifLine,
      });
    } else if (hasElse) {
      const elseBody = skipSpace(text, after + 4);
      if (!text.startsWith('if', elseBody)) {
        const elseEnd = text[elseBody] === '{' ? matchParen(text, elseBody) : statementEnd(text, elseBody);
        cases.push({ title: `when not ${shorten(cond)}`, arrange: `make ${shorten(cond)} false`, status: ran(elseBody, elseEnd), line: lineOf(after) });
      }
    }
  }

  // switch cases (statements and expressions).
  for (const m of body.matchAll(/\bswitch\s*\(/g)) {
    const open = from + m.index! + m[0].length - 1;
    const close = matchParen(text, open);
    const subject = original(open + 1, close);
    const braceOpen = text.indexOf('{', close);
    const braceClose = matchParen(text, braceOpen);
    const inner = text.slice(braceOpen + 1, braceClose);
    const isExpression = /=>/.test(inner) && !/\bcase\b/.test(inner);
    const arms = isExpression
      ? [...inner.matchAll(/(?:^|,)\s*([^,=]+?)\s*=>/g)].map((a) => ({ at: braceOpen + 1 + a.index! + a[0].indexOf(a[1]), label: a[1] }))
      : [...inner.matchAll(/\b(case\s+([^:]+?)|default)\s*:/g)].map((a) => ({ at: braceOpen + 1 + a.index!, label: a[2] ?? 'default' }));
    arms.forEach((arm, i) => {
      const end = i + 1 < arms.length ? arms[i + 1].at - 1 : braceClose;
      const label = original(arm.at, arm.at + arm.label.length).replace(/^case\s+/, '');
      const title = label === 'default' || label === '_' ? `when ${shorten(subject)} matches no other case` : `when ${shorten(subject)} is ${shorten(label)}`;
      cases.push({ title, arrange: title.replace(/^when /, 'make '), status: ran(arm.at, end), line: lineOf(arm.at) });
    });
  }

  // Thrown errors.
  for (const m of body.matchAll(/\bthrow\s+([A-Z][\w$]*)?/g)) {
    const at = from + m.index!;
    const line = lineOf(at);
    const what = m[1] ?? 'an error';
    const status = !lines ? 'unknown' : (lines.get(line) ?? -1) > 0 ? 'covered' : lines.has(line) ? 'missing' : 'unknown';
    cases.push({ title: `throws ${what}`, arrange: `use input that makes it throw ${what}; expect(() => ..., throwsA(isA<${m[1] ?? 'Object'}>()))`, status, line });
  }

  // catch blocks: the failure path.
  for (const m of body.matchAll(/\b(on\s+([A-Z][\w$]*)\s*)?catch\s*\([^)]*\)\s*\{/g)) {
    const braceOpen = from + m.index! + m[0].length - 1;
    const braceClose = matchParen(text, braceOpen);
    cases.push({
      title: `when ${m[2] ? `a ${m[2]} is thrown` : 'a call inside fails'}`,
      arrange: `make the call inside the try fail (use a mock that throws)`,
      status: ran(braceOpen, braceClose),
      line: lineOf(braceOpen),
    });
  }

  // ?? fallbacks.
  for (const m of body.matchAll(/([\w$.()[\]!]+)\s*\?\?(?!=)/g)) {
    const at = from + m.index!;
    cases.push({ title: `when ${shorten(original(at, at + m[1].length))} is null`, arrange: `make ${original(at, at + m[1].length)} null`, status: 'unknown', line: lineOf(at) });
  }

  if (cases.length === 0) {
    cases.push({ title: 'returns the expected result', arrange: 'call it with typical input', status: !lines ? 'unknown' : (lines.get(fn.startLine) ?? 0) > 0 ? 'covered' : lines.has(fn.startLine) ? 'missing' : 'unknown', line: fn.startLine });
  }
  // Drop duplicates (e.g. the same null check twice).
  const seen = new Set<string>();
  return cases.filter((c) => (seen.has(c.title) ? false : (seen.add(c.title), true)));
}

/** Dart test stubs for the chosen cases. */
export function caseStubs(fnName: string, cases: TestCase[], indent = '  '): string {
  const safe = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$');
  return cases
    .map((c) => [
      `${indent}test('${safe(fnName)} ${safe(c.title)}', () {`,
      `${indent}  // Arrange: ${c.arrange.replace(/\n/g, ' ')}.`,
      `${indent}  // Act: call ${fnName}.`,
      `${indent}  // Assert: expect(...);`,
      `${indent}});`,
    ].join('\n'))
    .join('\n\n');
}

function maxHits(lines: Map<number, number> | undefined, from: number, to: number): number | undefined {
  if (!lines) {
    return undefined;
  }
  let max: number | undefined;
  for (let l = from; l <= to; l++) {
    const h = lines.get(l);
    if (h !== undefined) {
      max = Math.max(max ?? 0, h);
    }
  }
  return max;
}

function shorten(s: string): string {
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) {
    i++;
  }
  return i;
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

function statementEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth < 0) {
        return i - 1;
      }
    } else if (c === ';' && depth === 0) {
      return i;
    }
  }
  return text.length - 1;
}
