/** Pure helpers for mapping source files to tests and to app layers. */

export type Layer = 'UI' | 'State' | 'Data' | 'Utils' | 'Other';

export const LAYERS: Layer[] = ['UI', 'State', 'Data', 'Utils', 'Other'];

const LAYER_RULES: Array<[Layer, RegExp, Set<string>]> = [
  [
    'State',
    /_(bloc|cubit|event|events|state|states|provider|providers|notifier|controller|view_?model|store)\.dart$/,
    new Set(['bloc', 'blocs', 'cubit', 'cubits', 'provider', 'providers', 'riverpod', 'state', 'states', 'controller', 'controllers', 'viewmodel', 'viewmodels', 'view_models', 'notifiers', 'store', 'stores', 'getx']),
  ],
  [
    'UI',
    /_(page|screen|widget|widgets|view|dialog|sheet|tile|card|button|form|layout)\.dart$/,
    new Set(['widgets', 'widget', 'screens', 'screen', 'pages', 'page', 'views', 'view', 'ui', 'presentation', 'components', 'dialogs']),
  ],
  [
    'Data',
    /_(repository|repo|model|models|service|api|client|dto|entity|datasource|data_source|response|request)\.dart$/,
    new Set(['data', 'repositories', 'repository', 'models', 'model', 'services', 'service', 'api', 'datasources', 'data_sources', 'network', 'dto', 'dtos', 'entities', 'domain', 'db', 'database']),
  ],
  [
    'Utils',
    /_(utils|util|helper|helpers|extension|extensions|constants|config|theme|validators?)\.dart$/,
    new Set(['utils', 'util', 'helpers', 'helper', 'extensions', 'core', 'common', 'constants', 'config', 'theme', 'shared']),
  ],
];

export function layerOf(relativePath: string): Layer {
  const lower = relativePath.toLowerCase().replace(/\\/g, '/');
  const base = lower.split('/').pop() ?? lower;
  for (const [layer, re] of LAYER_RULES) {
    if (re.test(base)) {
      return layer;
    }
  }
  const segments = lower.split('/').slice(0, -1).reverse();
  for (const segment of segments) {
    for (const [layer, , dirs] of LAYER_RULES) {
      if (dirs.has(segment)) {
        return layer;
      }
    }
  }
  return 'Other';
}

/** `lib/src/auth/login.dart` -> best matching `test/.../login_test.dart` paths (package-relative). */
export function testsForSource(sourceRel: string, testFiles: string[]): string[] {
  const src = sourceRel.replace(/\\/g, '/');
  const base = src.split('/').pop()!.replace(/\.dart$/, '');
  const wanted = `${base}_test.dart`;
  const srcDirs = src.split('/').slice(1, -1); // drop "lib"
  let bestScore = -1;
  let best: string[] = [];
  for (const t of testFiles) {
    const parts = t.replace(/\\/g, '/').split('/');
    if (parts[parts.length - 1] !== wanted) {
      continue;
    }
    const testDirs = parts.slice(1, -1); // drop "test"
    let score = 0;
    for (let i = 1; i <= Math.min(srcDirs.length, testDirs.length); i++) {
      if (srcDirs[srcDirs.length - i] === testDirs[testDirs.length - i]) {
        score++;
      } else {
        break;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = [t];
    } else if (score === bestScore) {
      best.push(t);
    }
  }
  return best;
}

/** `test/auth/login_test.dart` -> candidates in `lib/` with the same base name, best match first. */
export function sourcesForTest(testRel: string, sourceFiles: string[]): string[] {
  const t = testRel.replace(/\\/g, '/');
  const base = t.split('/').pop()!.replace(/_test\.dart$/, '.dart');
  return sourceFiles.filter((s) => s.replace(/\\/g, '/').endsWith('/' + base) && testsForSource(s, [t]).length > 0);
}

/** Where a new test for `lib/<rest>` should go: `test/<rest without src/>_test.dart`. */
export function testPathForSource(sourceRel: string): string {
  const parts = sourceRel.replace(/\\/g, '/').split('/');
  const rest = parts.slice(1);
  if (rest[0] === 'src') {
    rest.shift();
  }
  const file = rest.pop()!.replace(/\.dart$/, '_test.dart');
  return ['test', ...rest, file].join('/');
}
