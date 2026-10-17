/**
 * Reads the JSON file written by `flutter test --file-reporter json:<path>` and turns
 * Flutter's long failure dumps into short, readable explanations. Pure, no `vscode` import.
 */

export type TestStatus = 'passed' | 'failed' | 'skipped';

export interface SourceLocation {
  /** Absolute file path. */
  file: string;
  /** 1-based. */
  line: number;
  column?: number;
}

export interface Failure {
  /** One line: what went wrong, in plain words. */
  title: string;
  /** What to try, when the failure matches a known pattern. */
  hint?: string;
  expected?: string;
  actual?: string;
  which?: string;
  /** Where in the test it failed. */
  location?: SourceLocation;
  /** Where in the app code, for layout errors ("The relevant error-causing widget was"). */
  widget?: { name: string } & SourceLocation;
  /** Individual problems, e.g. each accessibility issue. */
  items?: string[];
  /** The full original output, for "show everything". */
  raw: string;
}

export interface TestResult {
  /** Full name including group names, as `--plain-name` expects. */
  name: string;
  /** Absolute path of the test file (the suite). */
  suite: string;
  /** Where the test is declared, when known. */
  location?: SourceLocation;
  status: TestStatus;
  durationMs: number;
  prints: string[];
  failure?: Failure;
}

export interface RunResults {
  tests: TestResult[];
  /** Test files that could not even be loaded (compile errors and the like). */
  loadErrors: Array<{ suite: string; failure: Failure }>;
  success: boolean;
  durationMs: number;
}

interface Pending {
  name: string;
  suite: string;
  location?: SourceLocation;
  start: number;
  prints: string[];
  errors: string[];
  hidden: boolean;
  isLoad: boolean;
}

export function fileFromUrl(url: string | null | undefined): string | undefined {
  if (!url || !url.startsWith('file://')) {
    return undefined;
  }
  try {
    let p = decodeURIComponent(url.replace(/^file:\/\//, ''));
    // file:///C:/x on Windows.
    if (/^\/[A-Za-z]:\//.test(p)) {
      p = p.slice(1);
    }
    return p;
  } catch {
    return undefined;
  }
}

export function parseTestEvents(text: string): RunResults {
  const suites = new Map<number, string>();
  const pending = new Map<number, Pending>();
  const tests: TestResult[] = [];
  const loadErrors: RunResults['loadErrors'] = [];
  let success = true;
  let lastTime = 0;

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('{')) {
      continue;
    }
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof e.time === 'number') {
      lastTime = Math.max(lastTime, e.time);
    }
    switch (e.type) {
      case 'suite':
        suites.set(e.suite.id, e.suite.path);
        break;
      case 'testStart': {
        const t = e.test;
        const suite = suites.get(t.suiteID) ?? '';
        const own = fileFromUrl(t.url);
        const root = fileFromUrl(t.root_url);
        let location: SourceLocation | undefined;
        if (own && t.line) {
          location = { file: own, line: t.line, column: t.column ?? undefined };
        } else if (root && t.root_line) {
          location = { file: root, line: t.root_line, column: t.root_column ?? undefined };
        }
        pending.set(t.id, {
          name: t.name,
          suite,
          location,
          start: e.time,
          prints: [],
          errors: [],
          hidden: false,
          isLoad: !t.groupIDs?.length && typeof t.name === 'string' && t.name.startsWith('loading '),
        });
        break;
      }
      case 'print': {
        const p = pending.get(e.testID);
        p?.prints.push(String(e.message ?? ''));
        break;
      }
      case 'error': {
        const p = pending.get(e.testID);
        if (p) {
          p.errors.push(`${e.error ?? ''}${e.stackTrace ? `\n${e.stackTrace}` : ''}`);
        }
        break;
      }
      case 'testDone': {
        const p = pending.get(e.testID);
        if (!p) {
          break;
        }
        pending.delete(e.testID);
        const failed = e.result !== 'success';
        if (p.isLoad) {
          if (failed) {
            loadErrors.push({ suite: p.suite, failure: explainFailure([...p.prints, ...p.errors].join('\n'), p.suite) });
          }
          break;
        }
        if (e.hidden) {
          break;
        }
        const status: TestStatus = e.skipped ? 'skipped' : failed ? 'failed' : 'passed';
        const result: TestResult = {
          name: p.name,
          suite: p.suite,
          location: p.location,
          status,
          durationMs: Math.max(0, e.time - p.start),
          prints: p.prints.filter((m) => !isFailureDump(m)),
        };
        if (failed) {
          result.failure = explainFailure([...p.prints, ...p.errors].join('\n'), p.suite);
          if (!result.failure.location && p.location) {
            result.failure.location = p.location;
          }
        }
        tests.push(result);
        break;
      }
      case 'done':
        success = !!e.success;
        break;
    }
  }
  if (tests.some((t) => t.status === 'failed') || loadErrors.length) {
    success = false;
  }
  return { tests, loadErrors, success, durationMs: lastTime };
}

function isFailureDump(message: string): boolean {
  return /^══╡ EXCEPTION CAUGHT BY/.test(message) || message.startsWith('♿ ');
}

const HINTS: Array<[RegExp, string]> = [
  [/pumpAndSettle timed out/, 'Something keeps animating, often a progress indicator. Use pump(const Duration(...)) instead of pumpAndSettle(), or stop the animation in the test.'],
  [/A Timer is still pending even after the widget tree was disposed/, 'A Timer or Future.delayed was still waiting when the test ended. Advance time with await tester.pump(const Duration(...)) until it fires, or cancel it in dispose().'],
  [/No MediaQuery widget ancestor found|No Material widget found|No Directionality widget found|No MaterialLocalizations found|No Overlay widget found|No ScaffoldMessenger widget found|No Navigator/, 'The widget needs an app around it. In pumpWidget, wrap it: MaterialApp(home: Scaffold(body: YourWidget())).'],
  [/HTTP request failed, statusCode: 400|NetworkImageLoadException|SocketException/, 'Tests block real network calls. Mock the HTTP client, or use an asset image in tests.'],
  [/setState\(\) called after dispose\(\)/, 'Something called setState after the widget was removed. Check mounted before setState, or cancel timers and streams in dispose().'],
  [/Guarded function conflict/, 'An async tester call is missing an await. Add await before tester.tap, pump, enterText and friends.'],
  [/Null check operator used on a null value/, 'A value used with ! was null. Make sure the test provides everything the widget needs (providers, arguments, mocks).'],
  [/Could not find the correct Provider|ProviderNotFoundException/, 'The widget reads a Provider that the test did not add. Wrap it in the provider (or a mock) inside pumpWidget.'],
  [/No ProviderScope found/, 'Riverpod widgets need a ProviderScope. Wrap the widget: ProviderScope(child: MaterialApp(home: ...)).'],
  [/BlocProvider\.of\(\) called with a context that does not contain/, 'The widget reads a Bloc that the test did not provide. Wrap it in BlocProvider (or BlocProvider.value with a mock).'],
  [/LateInitializationError/, 'A late field was read before it was set. Check setUp() and the order of your arrange steps.'],
  [/MissingPluginException/, 'A plugin has no implementation in tests. Mock its platform channel or the class that wraps the plugin.'],
  [/Multiple widgets used the same GlobalKey|Duplicate keys found/, 'Two widgets share a key. Give each one a unique key.'],
  [/The finder "[^"]*" \(used in a call to "tap\(\)"\) could not find any matching widgets|could not find any matching widgets/, 'The widget to tap was not on screen. Check the finder, scroll to it with tester.ensureVisible() or scrollUntilVisible(), or pump after the step that shows it.'],
  [/derived an Offset .* that would not hit test on the specified widget|would not hit test/, 'The tap landed on something else (the widget is off screen or covered). Use tester.ensureVisible() first, or tap a different finder.'],
];

/** Turns raw Flutter test output for one failed test into something a person can read in a glance. */
export function explainFailure(raw: string, suite?: string): Failure {
  const text = raw.replace(/\r/g, '');
  const failure: Failure = { title: '', raw: text.trim() };

  // Accessibility problems printed by the snippet Dartboard inserts.
  const a11y = text.split('\n').filter((l) => l.startsWith('♿ ')).map((l) => l.slice(2).trim());
  if (a11y.length) {
    failure.title = `${a11y.length} accessibility problem${a11y.length === 1 ? '' : 's'}`;
    failure.items = a11y.map(cleanA11y);
    failure.hint = 'Add a Semantics label or tooltip to tappable widgets, make tap targets at least 48×48, and raise text contrast.';
  }

  const expected = /^\s*Expected: ([\s\S]*?)\n\s*Actual: ([\s\S]*?)(?:\n\s*Which: ([\s\S]*?))?\n(?:\n|When the exception|This was caught|To run this test|$)/m.exec(text + '\n\n');
  if (expected) {
    failure.expected = squash(expected[1]);
    failure.actual = squash(expected[2]);
    failure.which = expected[3] ? squash(expected[3]) : undefined;
  }

  const overflow = /A (Render\w+) overflowed by ([\d.]+) pixels on the (right|left|top|bottom)/.exec(text);
  const relevant = /The relevant error-causing widget was:\s*\n\s*(\w+)\b[^\n]*?(?:\n\s*)?\w+:(file:\/\/\/[^\s]+?):(\d+):(\d+)/.exec(text);
  if (relevant) {
    const file = fileFromUrl(relevant[2]);
    if (file) {
      failure.widget = { name: relevant[1], file, line: Number(relevant[3]), column: Number(relevant[4]) };
    }
  }

  const found = /Found (\d+) widgets? with (text|type|key|icon|widget|semantics label|tooltip) ("[^"]*"|[^:\]\n]+)/.exec(text);
  if (!failure.title && overflow) {
    const what = failure.widget?.name ?? overflow[1].replace('Render', '');
    const px = Math.round(Number(overflow[2]));
    failure.title = `${what} overflows by ${px} px on the ${overflow[3]}`;
    failure.hint = overflow[3] === 'right' || overflow[3] === 'left'
      ? 'The content is wider than the screen. Wrap long children in Expanded or Flexible, or let the text wrap or ellipsize.'
      : 'The content is taller than the screen. Make it scrollable (SingleChildScrollView or ListView) or reduce its height.';
  } else if (!failure.title && found && failure.expected) {
    const count = Number(found[1]);
    const what = `${found[2]} ${found[3].trim()}`;
    if (count === 0) {
      failure.title = `No widget found with ${what}`;
      failure.hint = 'Check the spelling, pump() after the action that shows it, or use find.textContaining() for partial text.';
    } else {
      failure.title = `Found ${count} widgets with ${what}, expected ${/exactly one|one/.test(failure.expected) ? 'one' : failure.expected}`;
      if (count > 1) {
        failure.hint = 'Several widgets match. Use .first or .at(i), or give the widget a Key and use find.byKey().';
      }
    }
    // The title already says what was expected and found.
    failure.expected = undefined;
    failure.actual = undefined;
  }

  const thrown = /The following (.+?) was thrown ([^:\n]+):\n([\s\S]*?)\n\n/.exec(text + '\n\n');
  if (!failure.title && thrown && !/TestFailure/.test(thrown[1])) {
    failure.title = squash(firstSentence(thrown[3]));
  }
  const compile = /([^\s:]+\.dart):(\d+):(\d+): Error: ([^\n]+)/.exec(text);
  if (!failure.title && compile) {
    failure.title = `Doesn't compile: ${compile[4]}`;
    const file = compile[1].startsWith('/') || /^[A-Za-z]:/.test(compile[1]) ? compile[1] : suite ? joinPath(dirOfSuiteRoot(suite), compile[1]) : compile[1];
    failure.location = { file, line: Number(compile[2]), column: Number(compile[3]) };
  }
  if (!failure.title && failure.expected) {
    failure.title = `Expected ${shorten(failure.expected, 60)}, got ${shorten(failure.actual ?? '?', 60)}`;
  }
  if (!failure.title) {
    const firstLine = text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('══') && !/^Test failed\. See exception logs above/.test(l) && !/^The test description was/.test(l));
    failure.title = shorten(firstLine ?? 'Test failed', 140);
  }
  if (!failure.hint) {
    failure.hint = HINTS.find(([re]) => re.test(text))?.[1];
  }

  // Where in the test: "caught by the test expectation on the following line", else the first stack frame in a test file.
  const caught = /This was caught by the test expectation on the following line:\s*\n\s*(file:\/\/\/\S+) line (\d+)/.exec(text);
  if (caught && fileFromUrl(caught[1])) {
    failure.location = { file: fileFromUrl(caught[1])!, line: Number(caught[2]) };
  } else if (!failure.location) {
    const frames = [...text.matchAll(/\((file:\/\/\/[^\s)]+?_test\.dart):(\d+):(\d+)\)/g)];
    const frame = frames.find((f) => !suite || fileFromUrl(f[1]) === suite) ?? frames[0];
    if (frame && fileFromUrl(frame[1])) {
      failure.location = { file: fileFromUrl(frame[1])!, line: Number(frame[2]), column: Number(frame[3]) };
    }
  }
  return failure;
}

function cleanA11y(problem: string): string {
  const [guideline, ...rest] = problem.split(': ');
  const detail = rest.join(': ');
  const label = /label: "([^"]*)"/.exec(detail)?.[1];
  const ratio = /contrast ratio of at least ([\d.]+) but found ([\d.]+)/.exec(detail);
  const size = /expected tap target size of at least (Size\([^)]*\)), but found (Size\([^)]*\))/.exec(detail);
  const rect = /Rect\.fromLTRB\(([^)]*)\)/.exec(detail)?.[1];
  const where = label ? `"${label}"` : rect ? `widget at (${rect.split(',').slice(0, 2).map((n) => Math.round(Number(n))).join(', ')})` : 'a widget';
  if (ratio) {
    return `Low text contrast on ${where}: ${ratio[2]}:1, needs ${ratio[1]}:1`;
  }
  if (size) {
    return `Tap target too small on ${where}: ${size[2]}, needs ${size[1]}`;
  }
  if (/semantic label/.test(detail)) {
    return `Tappable ${where} has no label for screen readers`;
  }
  return `${guideline}: ${squash(detail)}`;
}

function squash(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ').trim();
}

function firstSentence(s: string): string {
  const t = squash(s);
  const dot = t.search(/\.(\s|$)/);
  return dot > 20 ? t.slice(0, dot + 1) : shorten(t, 160);
}

function shorten(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function dirOfSuiteRoot(suite: string): string {
  // Compile errors are reported relative to the package root, which holds test/.
  const i = suite.replace(/\\/g, '/').lastIndexOf('/test/');
  return i >= 0 ? suite.slice(0, i) : suite.replace(/[\\/][^\\/]*$/, '');
}

function joinPath(a: string, b: string): string {
  return `${a.replace(/[\\/]$/, '')}/${b}`;
}
