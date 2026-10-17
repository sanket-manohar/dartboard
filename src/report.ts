import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CoverageStore, toPosix } from './coverageStore';
import { formatPercent, percent } from './lcov';
import { LAYERS, layerOf } from './paths';
import { PAGE_H, PAGE_W, Pdf, RGB } from './pdf';
import { ProjectModel, ProjectSnapshot } from './project';
import { TestResultsStore } from './results';

const M = 40;
const W = PAGE_W - 2 * M;
const INK: RGB = [0.11, 0.13, 0.17];
const MUTED: RGB = [0.42, 0.45, 0.5];
const LINE: RGB = [0.88, 0.89, 0.91];
const SOFT: RGB = [0.965, 0.97, 0.975];
const NAVY: RGB = [0.07, 0.11, 0.2];
const GREEN: RGB = [0.13, 0.62, 0.32];
const AMBER: RGB = [0.85, 0.6, 0.1];
const RED: RGB = [0.85, 0.24, 0.22];
const BLUE: RGB = [0.13, 0.43, 0.85];
const PURPLE: RGB = [0.54, 0.34, 0.9];

/** Lays out content top to bottom and starts a new page when it runs out of room. */
class Doc {
  readonly pdf = new Pdf();
  y = M;

  ensure(h: number): void {
    if (this.y + h > PAGE_H - M - 20) {
      this.pdf.addPage();
      this.y = M;
    }
  }

  heading(text: string, sub?: string): void {
    // Keep a heading with at least the first few lines of what follows it.
    this.ensure(150);
    this.y += 10;
    this.pdf.text(M, this.y, text, { size: 14, bold: true, color: INK });
    if (sub) {
      this.pdf.text(M + W, this.y + 3, sub, { size: 9, color: MUTED, align: 'right' });
    }
    this.y += 20;
    this.pdf.line(M, this.y, M + W, this.y, LINE);
    this.y += 8;
  }

  paragraph(text: string, size = 9.5, color: RGB = MUTED): void {
    for (const line of Pdf.wrap(text, size, W)) {
      this.ensure(size + 4);
      this.pdf.text(M, this.y, line, { size, color });
      this.y += size + 3.5;
    }
    this.y += 4;
  }

  /** A table with optional coverage bar in the last column. */
  table(columns: Array<{ title: string; width: number; align?: 'left' | 'right' }>, rows: Array<Array<string | { bar: number; color: RGB } | { text: string; color: RGB; bold?: boolean }>>): void {
    const rowH = 16;
    const header = () => {
      this.ensure(rowH * 2);
      let x = M;
      this.pdf.rect(M, this.y, W, rowH, SOFT);
      for (const c of columns) {
        this.pdf.text(c.align === 'right' ? x + c.width - 6 : x + 6, this.y + 4, c.title, { size: 8, bold: true, color: MUTED, align: c.align === 'right' ? 'right' : 'left' });
        x += c.width;
      }
      this.y += rowH;
    };
    header();
    for (const row of rows) {
      if (this.y + rowH > PAGE_H - M - 20) {
        this.pdf.addPage();
        this.y = M;
        header();
      }
      let x = M;
      row.forEach((cell, i) => {
        const c = columns[i];
        if (typeof cell === 'string' || 'text' in cell) {
          const text = typeof cell === 'string' ? cell : cell.text;
          const fit = fitText(text, 8.5, c.width - 12);
          this.pdf.text(c.align === 'right' ? x + c.width - 6 : x + 6, this.y + 4, fit, {
            size: 8.5,
            color: typeof cell === 'string' ? INK : cell.color,
            bold: typeof cell !== 'string' && !!cell.bold,
            align: c.align === 'right' ? 'right' : 'left',
          });
        } else {
          const bw = c.width - 12;
          this.pdf.rect(x + 6, this.y + 5, bw, 6, LINE, undefined, 0, 3);
          if (cell.bar > 0) {
            this.pdf.rect(x + 6, this.y + 5, Math.max(6, (bw * Math.min(100, cell.bar)) / 100), 6, cell.color, undefined, 0, 3);
          }
        }
        x += c.width;
      });
      this.y += rowH;
      this.pdf.line(M, this.y, M + W, this.y, LINE, 0.5);
    }
    this.y += 10;
  }
}

function fitText(text: string, size: number, width: number): string {
  if (Pdf.width(text, size) <= width) {
    return text;
  }
  let t = text;
  while (t.length > 1 && Pdf.width(`…${t}`, size) > width) {
    t = t.slice(1);
  }
  // Paths read better cut on the left.
  return `…${t}`;
}

function levelColor(p: number | undefined): RGB {
  const config = vscode.workspace.getConfiguration('dartboard');
  if (p === undefined) {
    return MUTED;
  }
  return p >= config.get<number>('highThreshold', 80) ? GREEN : p >= config.get<number>('lowThreshold', 50) ? AMBER : RED;
}

interface Action {
  text: string;
  weight: number;
}

/** Builds the audit report PDF and returns where it was written. */
export async function writeAuditReport(store: CoverageStore, project: ProjectModel, results: TestResultsStore): Promise<string | undefined> {
  if (!store.hasData) {
    void vscode.window.showInformationMessage('Run tests with coverage first, then create the report.');
    return undefined;
  }
  const snap = await project.get();
  const doc = buildReport(store, snap, results);
  const pkg = store.packages[0];
  const root = pkg?.root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return undefined;
  }
  const file = path.join(root, 'coverage', 'dartboard-report.pdf');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const name = store.packages.length === 1 ? pkg.name : path.basename(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? root);
  fs.writeFileSync(file, doc.pdf.build(`${name}: test audit report`, 'Dartboard'));
  return file;
}

export function buildReport(store: CoverageStore, snap: ProjectSnapshot, results: TestResultsStore): Doc {
  const config = vscode.workspace.getConfiguration('dartboard');
  const goal = config.get<number>('goal', 80);
  const d = new Doc();
  const pdf = d.pdf;
  const totals = store.totals();
  const linePct = percent(totals.linesHit, totals.linesFound) ?? 0;
  let bFound = 0;
  let bHit = 0;
  for (const f of store.tested()) {
    bFound += f.branchesFound;
    bHit += f.branchesHit;
  }
  const branchPct = bFound ? (bHit / bFound) * 100 : undefined;
  const untested = store.untested();
  const screensTested = snap.screens.filter((s) => s.tests.length).length;
  const stateTotal = snap.states.reduce((n, h) => n + h.total, 0);
  const stateReached = snap.states.reduce((n, h) => n + h.reached, 0);
  const summary = results.summary;
  const pitfallCount = snap.pitfalls.reduce((n, p) => n + p.items.filter((i) => i.severity === 'warning').length, 0);
  const name = store.packages.length === 1 ? store.packages[0].name : path.basename(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'project');

  // Test health grade: a weighted mix, explained in the footnote on page 1.
  const parts: Array<[number, number]> = [[linePct, 45]];
  if (branchPct !== undefined) {
    parts.push([branchPct, 15]);
  }
  if (snap.screens.length) {
    parts.push([(screensTested / snap.screens.length) * 100, 15]);
  }
  if (stateTotal) {
    parts.push([(stateReached / stateTotal) * 100, 10]);
  }
  if (results.hasResults) {
    const runTotal = summary.passed + summary.failed;
    parts.push([runTotal ? (summary.passed / runTotal) * 100 : 100, 15]);
  }
  const weight = parts.reduce((n, [, w]) => n + w, 0);
  const score = Math.max(0, parts.reduce((n, [v, w]) => n + v * w, 0) / weight - Math.min(10, pitfallCount));
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 55 ? 'D' : 'E';
  const gradeColor = score >= 80 ? GREEN : score >= 60 ? AMBER : RED;

  // ---------------------------------------------------------------- cover band
  pdf.rect(0, 0, PAGE_W, 150, NAVY);
  drawLogo(pdf, M + 18, 46, 18);
  pdf.text(M + 46, 34, 'Dartboard', { size: 11, bold: true, color: [0.75, 0.82, 0.95] });
  pdf.text(M + 46, 50, 'Test audit report', { size: 20, bold: true, color: [1, 1, 1] });
  pdf.text(M, 86, name, { size: 13, bold: true, color: [1, 1, 1] });
  pdf.text(M, 104, `${new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })} · ${store.all().length} Dart files · ${store.packages.length} package${store.packages.length === 1 ? '' : 's'}`, {
    size: 9.5,
    color: [0.75, 0.8, 0.88],
  });
  // Grade badge on the right.
  pdf.circle(PAGE_W - M - 46, 75, 44, [1, 1, 1]);
  pdf.arc(PAGE_W - M - 46, 75, 38, 0, 360, LINE, 7);
  pdf.arc(PAGE_W - M - 46, 75, 38, 0, Math.max(1, (score / 100) * 360), gradeColor, 7);
  pdf.text(PAGE_W - M - 46, 52, grade, { size: 30, bold: true, color: gradeColor, align: 'center' });
  pdf.text(PAGE_W - M - 46, 88, `${Math.round(score)}/100`, { size: 8.5, color: MUTED, align: 'center' });
  pdf.text(PAGE_W - M - 46, 98, 'test health', { size: 7.5, color: MUTED, align: 'center' });
  d.y = 172;

  // ---------------------------------------------------------------- KPI tiles
  const tiles: Array<{ label: string; value: string; note: string; color: RGB; pct?: number }> = [
    { label: 'Line coverage', value: formatPercent(linePct), note: `${totals.linesHit.toLocaleString()} / ${totals.linesFound.toLocaleString()} lines`, color: levelColor(linePct), pct: linePct },
    {
      label: 'Branch coverage',
      value: branchPct === undefined ? 'n/a' : formatPercent(branchPct),
      note: branchPct === undefined ? 'run with --branch-coverage' : `${bHit} / ${bFound} paths`,
      color: levelColor(branchPct),
      pct: branchPct,
    },
    {
      label: 'Screens with tests',
      value: snap.screens.length ? `${screensTested}/${snap.screens.length}` : 'n/a',
      note: snap.screens.length ? `${snap.screens.length - screensTested} without a widget test` : 'no screens found',
      color: snap.screens.length ? levelColor((screensTested / snap.screens.length) * 100) : MUTED,
      pct: snap.screens.length ? (screensTested / snap.screens.length) * 100 : undefined,
    },
    {
      label: 'State coverage',
      value: stateTotal ? formatPercent((stateReached / stateTotal) * 100) : 'n/a',
      note: stateTotal ? `${stateReached} / ${stateTotal} events, states, methods` : 'no Bloc/Cubit/Notifier',
      color: stateTotal ? levelColor((stateReached / stateTotal) * 100) : MUTED,
      pct: stateTotal ? (stateReached / stateTotal) * 100 : undefined,
    },
    {
      label: 'Last test run',
      value: results.hasResults ? (summary.failed ? `${summary.failed} failed` : 'all passed') : 'n/a',
      note: results.hasResults ? `${summary.passed} passed${summary.skipped ? `, ${summary.skipped} skipped` : ''}` : 'run tests from Dartboard',
      color: results.hasResults ? (summary.failed ? RED : GREEN) : MUTED,
    },
    { label: 'Files without tests', value: String(untested.length), note: untested.length ? 'no test imports them' : 'every file is tested', color: untested.length ? RED : GREEN },
    {
      label: 'Test pyramid',
      value: String(snap.pyramid.unit + snap.pyramid.widget + snap.pyramid.golden + snap.pyramid.integration),
      note: `${snap.pyramid.unit} unit · ${snap.pyramid.widget + snap.pyramid.golden} widget · ${snap.pyramid.integration} integr.`,
      color: BLUE,
    },
    { label: 'Test pitfalls', value: String(pitfallCount), note: pitfallCount ? 'missing pump, await, …' : 'none found', color: pitfallCount ? AMBER : GREEN },
  ];
  const tw = (W - 3 * 8) / 4;
  tiles.forEach((t, i) => {
    const x = M + (i % 4) * (tw + 8);
    const y = d.y + Math.floor(i / 4) * 70;
    pdf.rect(x, y, tw, 62, SOFT, LINE, 0.6, 6);
    pdf.rect(x, y + 8, 3, 46, t.color);
    pdf.text(x + 11, y + 9, t.label.toUpperCase(), { size: 6.8, bold: true, color: MUTED });
    pdf.text(x + 11, y + 21, t.value, { size: 16, bold: true, color: INK });
    pdf.text(x + 11, y + 43, fitText(t.note, 7.3, tw - 18), { size: 7.3, color: MUTED });
  });
  d.y += 148;

  // ---------------------------------------------------------------- top actions
  const actions: Action[] = [];
  if (summary.failed) {
    actions.push({ text: `Fix ${summary.failed} failing test${summary.failed === 1 ? '' : 's'}: ${results.failed.slice(0, 2).map((t) => `"${t.name}"`).join(', ')}${summary.failed > 2 ? ' and more' : ''}.`, weight: 100 });
  }
  if (goal > 0 && linePct < goal) {
    const needed = Math.ceil((goal / 100) * totals.linesFound - totals.linesHit);
    actions.push({ text: `Cover about ${needed} more lines to reach the ${goal}% goal (now ${formatPercent(linePct)}).`, weight: 60 });
  }
  if (untested.length) {
    const biggest = untested.slice().sort((a, b) => b.linesFound - a.linesFound).slice(0, 3).map((f) => path.posix.basename(f.relativePath));
    actions.push({ text: `Add tests for ${untested.length} file${untested.length === 1 ? '' : 's'} no test imports; start with ${biggest.join(', ')}.`, weight: 70 + Math.min(20, untested.length) });
  }
  const noTestScreens = snap.screens.filter((s) => !s.tests.length);
  if (noTestScreens.length) {
    actions.push({ text: `Write a widget test for ${noTestScreens.length} screen${noTestScreens.length === 1 ? '' : 's'}: ${noTestScreens.slice(0, 4).map((s) => s.name).join(', ')}${noTestScreens.length > 4 ? ', …' : ''}.`, weight: 75 });
  }
  const missedStates = snap.states.flatMap((h) => h.items.filter((i) => i.status === 'missed').map((i) => `${h.name}: ${i.name}`));
  if (missedStates.length) {
    actions.push({ text: `Test ${missedStates.length} unreached state${missedStates.length === 1 ? '' : 's'} or event${missedStates.length === 1 ? '' : 's'}, e.g. ${missedStates.slice(0, 3).join('; ')}.`, weight: 55 });
  }
  if (store.riskiest.length) {
    const r = store.riskiest[0];
    actions.push({ text: `Riskiest file: ${r.file.relativePath} (${formatPercent(percent(r.file.linesHit, r.file.linesFound))} covered, complexity ${r.complexity}). Add tests here first.`, weight: 50 });
  }
  if (pitfallCount) {
    actions.push({ text: `Fix ${pitfallCount} widget test pitfall${pitfallCount === 1 ? '' : 's'} (missing pump/await, real delays). Each has a one-click fix in the editor.`, weight: 45 });
  }
  if (branchPct !== undefined && branchPct + 10 < linePct) {
    actions.push({ text: `Branch coverage (${formatPercent(branchPct)}) trails line coverage. Look for amber half-bars in the gutter: an if or ?: that only ever went one way.`, weight: 40 });
  }
  const unkeyed = snap.screens.reduce((n, s) => n + (s.tree?.unkeyedInteractive.length ?? 0), 0);
  if (unkeyed) {
    actions.push({ text: `Give Keys to ${unkeyed} button${unkeyed === 1 ? '' : 's'} and field${unkeyed === 1 ? '' : 's'} on screens so tests can find them reliably.`, weight: 30 });
  }
  actions.sort((a, b) => b.weight - a.weight);
  d.heading('What to do next', actions.length ? `${Math.min(6, actions.length)} actions, most important first` : undefined);
  if (!actions.length) {
    d.paragraph('Nothing urgent. Coverage meets the goal, every screen has a test and the last run passed.', 10, INK);
  }
  actions.slice(0, 6).forEach((a, i) => {
    const lines = Pdf.wrap(a.text, 9.5, W - 28);
    d.ensure(lines.length * 13 + 6);
    pdf.circle(M + 8, d.y + 6, 8, i === 0 ? NAVY : SOFT, i === 0 ? undefined : LINE, 0.6);
    pdf.text(M + 8, d.y + 2.2, String(i + 1), { size: 8, bold: true, color: i === 0 ? [1, 1, 1] : INK, align: 'center' });
    lines.forEach((l, k) => pdf.text(M + 24, d.y + 1 + k * 13, l, { size: 9.5, color: INK }));
    d.y += lines.length * 13 + 7;
  });
  d.y += 6;
  d.paragraph(
    `Test health combines line coverage (45%), branch coverage (15%), screens with widget tests (15%), state coverage (10%) and the share of passing tests (15%), leaving out what this project doesn't have, minus one point per test pitfall (up to 10).`,
    7.5,
  );

  // ---------------------------------------------------------------- coverage by area
  d.pdf.addPage();
  d.y = M;
  d.heading('Coverage by area', `goal ${goal}%`);
  const groups = new Map<string, { found: number; hit: number; files: number }>();
  for (const f of store.all()) {
    const parts = (f.packagePath ?? f.relativePath).split('/');
    const key = parts.length > 2 ? parts.slice(0, Math.min(3, parts.length - 1)).join('/') : parts.slice(0, -1).join('/') || '.';
    const g = groups.get(key) ?? { found: 0, hit: 0, files: 0 };
    g.found += f.linesFound;
    g.hit += f.linesHit;
    g.files++;
    groups.set(key, g);
  }
  d.table(
    [
      { title: 'FOLDER', width: 220 },
      { title: 'FILES', width: 45, align: 'right' },
      { title: 'LINES', width: 85, align: 'right' },
      { title: 'COVERAGE', width: 60, align: 'right' },
      { title: '', width: W - 410 },
    ],
    [...groups.entries()]
      .sort((a, b) => (percent(a[1].hit, a[1].found) ?? 0) - (percent(b[1].hit, b[1].found) ?? 0))
      .slice(0, 22)
      .map(([k, g]) => {
        const p = percent(g.hit, g.found) ?? 0;
        return [k, String(g.files), `${g.hit} / ${g.found}`, { text: formatPercent(p), color: levelColor(p), bold: true }, { bar: p, color: levelColor(p) }];
      }),
  );
  const layers = LAYERS.map((l) => {
    const files = store.all().filter((f) => layerOf(f.packagePath ?? f.relativePath) === l);
    const found = files.reduce((n, f) => n + f.linesFound, 0);
    const hit = files.reduce((n, f) => n + f.linesHit, 0);
    return { l, found, hit, files: files.length };
  }).filter((x) => x.files);
  if (layers.length > 1) {
    d.heading('Coverage by app layer', 'guessed from folder and file names');
    d.table(
      [
        { title: 'LAYER', width: 220 },
        { title: 'FILES', width: 45, align: 'right' },
        { title: 'LINES', width: 85, align: 'right' },
        { title: 'COVERAGE', width: 60, align: 'right' },
        { title: '', width: W - 410 },
      ],
      layers.map((x) => {
        const p = percent(x.hit, x.found) ?? 0;
        return [x.l, String(x.files), `${x.hit} / ${x.found}`, { text: formatPercent(p), color: levelColor(p), bold: true }, { bar: p, color: levelColor(p) }];
      }),
    );
  }
  if (store.riskiest.length) {
    d.heading('Riskiest files', 'low coverage × complexity × recent changes');
    d.table(
      [
        { title: 'FILE', width: 280 },
        { title: 'COVERAGE', width: 70, align: 'right' },
        { title: 'COMPLEXITY', width: 80, align: 'right' },
        { title: 'CHANGES', width: W - 430, align: 'right' },
      ],
      store.riskiest.map((r) => {
        const p = percent(r.file.linesHit, r.file.linesFound) ?? 0;
        return [r.file.relativePath, { text: formatPercent(p), color: levelColor(p), bold: true }, String(r.complexity), r.changes ? String(r.changes) : '–'];
      }),
    );
  }
  if (untested.length) {
    d.heading('Files without tests', `${untested.length} file${untested.length === 1 ? '' : 's'}, about ${untested.reduce((n, f) => n + f.linesFound, 0)} lines`);
    d.table(
      [
        { title: 'FILE', width: W - 90 },
        { title: 'EST. LINES', width: 90, align: 'right' },
      ],
      untested
        .slice()
        .sort((a, b) => b.linesFound - a.linesFound)
        .slice(0, 30)
        .map((f) => [f.relativePath, String(f.linesFound)]),
    );
  }

  // ---------------------------------------------------------------- screens & widgets
  if (snap.screens.length) {
    d.heading('Screens', `${screensTested} of ${snap.screens.length} have a widget test`);
    d.table(
      [
        { title: 'SCREEN', width: 150 },
        { title: 'ROUTE', width: 110 },
        { title: 'WIDGET TEST', width: 75 },
        { title: 'WIDGETS RENDERED', width: 95, align: 'right' },
        { title: 'NO KEY', width: W - 430, align: 'right' },
      ],
      snap.screens.map((s) => {
        const t = s.tree;
        const p = t && t.rendered + t.missed ? (t.rendered / (t.rendered + t.missed)) * 100 : undefined;
        return [
          s.name,
          s.route ?? (s.via === 'push' ? '(pushed)' : '–'),
          s.tests.length ? { text: `yes (${s.tests.length})`, color: GREEN, bold: true } : { text: 'missing', color: RED, bold: true },
          p === undefined ? '–' : { text: `${t!.rendered}/${t!.rendered + t!.missed} · ${formatPercent(p)}`, color: levelColor(p) },
          t?.unkeyedInteractive.length ? { text: String(t.unkeyedInteractive.length), color: AMBER, bold: true } : '0',
        ];
      }),
    );
    d.paragraph('"Widgets rendered" counts the widgets in each screen\'s build() that at least one test drew. "No key" counts buttons and fields without a Key, which tests can only find by text or type.', 7.5);
  }

  // ---------------------------------------------------------------- state
  if (snap.states.length) {
    d.heading('State coverage', `${stateReached} of ${stateTotal} reached`);
    d.table(
      [
        { title: 'CLASS', width: 140 },
        { title: 'KIND', width: 70 },
        { title: 'REACHED', width: 60, align: 'right' },
        { title: 'NOT REACHED IN TESTS', width: W - 270 },
      ],
      snap.states.map((h) => {
        const missed = h.items.filter((i) => i.status === 'missed').map((i) => i.name);
        const p = (h.reached / h.total) * 100;
        return [h.name, h.kind, { text: `${h.reached}/${h.total}`, color: levelColor(p), bold: true }, missed.length ? missed.join(', ') : { text: 'everything', color: GREEN }];
      }),
    );
  }

  // ---------------------------------------------------------------- tests
  d.heading('Tests', results.hasResults ? `last run: ${summary.passed} passed, ${summary.failed} failed${summary.skipped ? `, ${summary.skipped} skipped` : ''}` : 'no run recorded yet');
  const p = snap.pyramid;
  const total = p.unit + p.widget + p.golden + p.integration;
  if (total) {
    d.ensure(110);
    const max = Math.max(p.unit, p.widget, p.golden, p.integration, 1);
    const layersP: Array<[string, number, RGB]> = [
      ['Integration', p.integration, PURPLE],
      ['Golden', p.golden, AMBER],
      ['Widget', p.widget, BLUE],
      ['Unit', p.unit, GREEN],
    ];
    const cx = M + 120;
    layersP.forEach(([label, n], i) => {
      const w = 70 + (n / max) * 150;
      const color = layersP[i][2];
      pdf.rect(cx - w / 2, d.y + i * 22, w, 18, n ? color : LINE, undefined, 0, 3);
      pdf.text(cx, d.y + i * 22 + 4.5, `${label} ${n}`, { size: 8.5, bold: true, color: n ? [1, 1, 1] : MUTED, align: 'center' });
    });
    const note =
      p.widget + p.golden + p.integration > p.unit && total > 6
        ? 'More UI tests than unit tests. Unit tests are faster and pin down logic more precisely.'
        : !p.widget && p.unit > 5
          ? 'No widget tests yet. Even one per screen catches layout and wiring bugs.'
          : 'A healthy pyramid: most tests are fast unit tests, with fewer, broader UI tests on top.';
    Pdf.wrap(note, 9, W - 270).forEach((l, i) => pdf.text(M + 270, d.y + 20 + i * 12, l, { size: 9, color: MUTED }));
    d.y += 100;
  }
  if (results.failed.length || results.brokenSuites.length) {
    d.table(
      [
        { title: 'FAILED TEST', width: 200 },
        { title: 'WHAT WENT WRONG', width: W - 200 },
      ],
      [
        ...results.brokenSuites.map((b) => [{ text: path.basename(b.suite), color: RED, bold: true }, `Does not load: ${b.failure.title}`] as Array<string | { text: string; color: RGB; bold?: boolean }>),
        ...results.failed.slice(0, 25).map((t) => [{ text: t.name, color: RED, bold: true }, t.failure?.title ?? 'failed'] as Array<string | { text: string; color: RGB; bold?: boolean }>),
      ],
    );
  }
  const slow = results.slowest(8).filter((t) => t.durationMs >= 100);
  if (slow.length) {
    const max = Math.max(...slow.map((t) => t.durationMs));
    d.table(
      [
        { title: 'SLOWEST TESTS', width: 260 },
        { title: 'FILE', width: 140 },
        { title: 'TIME', width: 50, align: 'right' },
        { title: '', width: W - 450 },
      ],
      slow.map((t) => [t.name, toPosix(vscode.workspace.asRelativePath(t.suite)), `${(t.durationMs / 1000).toFixed(2)} s`, { bar: (t.durationMs / max) * 100, color: BLUE }]),
    );
  }
  if (results.matrix?.rows.length) {
    const m = results.matrix;
    d.table(
      [{ title: `SCREEN SIZES · ${path.basename(m.suite)}`, width: 180 }, ...m.configs.map((c) => ({ title: c.toUpperCase(), width: (W - 180) / m.configs.length }))],
      m.rows.map((r) => [
        r.test,
        ...m.configs.map((c) => {
          const s = r.cells[c]?.status;
          return s === 'passed' ? { text: 'pass', color: GREEN, bold: true } : s === 'failed' ? { text: 'FAIL', color: RED, bold: true } : '–';
        }),
      ]),
    );
  }
  if (snap.pitfalls.length) {
    d.heading('Test pitfalls', `${pitfallCount} warning${pitfallCount === 1 ? '' : 's'}`);
    const label: Record<string, string> = {
      'missing-pump': 'action not followed by pump()',
      'missing-await': 'tester call without await',
      'no-expect': 'test without expect()',
      'real-delay': 'real delay in a widget test',
      'needs-app': 'widget pumped without MaterialApp',
    };
    d.table(
      [
        { title: 'TEST FILE', width: 230 },
        { title: 'ISSUES', width: W - 230 },
      ],
      snap.pitfalls.slice(0, 30).map((f) => {
        const counts = new Map<string, number>();
        f.items.forEach((i) => counts.set(i.code, (counts.get(i.code) ?? 0) + 1));
        return [f.rel, [...counts.entries()].map(([c, n]) => `${n}× ${label[c] ?? c}`).join(', ')];
      }),
    );
  }

  // ---------------------------------------------------------------- footers
  const pages = pdf.pageCount;
  for (let i = 0; i < pages; i++) {
    pdf.onPage(i, () => {
      pdf.line(M, PAGE_H - 30, M + W, PAGE_H - 30, LINE, 0.5);
      pdf.text(M, PAGE_H - 24, `${name} · test audit report`, { size: 7.5, color: MUTED });
      pdf.text(M + W, PAGE_H - 24, `Generated by Dartboard · page ${i + 1} of ${pages}`, { size: 7.5, color: MUTED, align: 'right' });
    });
  }
  return d;
}

/** The Dartboard mark: rings with a dart. */
function drawLogo(pdf: Pdf, cx: number, cy: number, r: number): void {
  pdf.circle(cx, cy, r, [0.86, 0.24, 0.22]);
  pdf.circle(cx, cy, r * 0.72, [0.98, 0.98, 0.98]);
  pdf.circle(cx, cy, r * 0.5, [0.95, 0.67, 0.15]);
  pdf.circle(cx, cy, r * 0.28, [0.16, 0.66, 0.36]);
  pdf.line(cx + r * 0.9, cy - r * 0.9, cx + 1, cy - 1, [0.33, 0.73, 0.98], 2.4);
  pdf.line(cx + r * 0.9, cy - r * 0.9, cx + r * 1.15, cy - r * 0.62, [0.33, 0.73, 0.98], 1.6);
  pdf.line(cx + r * 0.9, cy - r * 0.9, cx + r * 0.62, cy - r * 1.15, [0.33, 0.73, 0.98], 1.6);
}
