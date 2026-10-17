import * as vscode from 'vscode';
import { CoverageStore } from './coverageStore';
import { percent } from './lcov';

/**
 * A webview in the editor area with three tabs: a treemap of the whole project,
 * coverage history across runs (with the commit that dropped it most), and the risk list.
 * Everything is rendered locally; no network access.
 */
export class InsightsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly sub: vscode.Disposable;

  constructor(
    private readonly store: CoverageStore,
    private readonly iconUri?: vscode.Uri,
  ) {
    this.sub = store.onDidChange(() => this.update());
  }

  show(tab: 'map' | 'history' | 'risk' = 'map'): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      void this.panel.webview.postMessage({ type: 'tab', tab });
      return;
    }
    this.panel = vscode.window.createWebviewPanel('dartboard.insights', 'Coverage Insights', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    if (this.iconUri) {
      this.panel.iconPath = this.iconUri;
    }
    this.panel.onDidDispose(() => (this.panel = undefined));
    this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'open' && typeof msg.uri === 'string') {
        void vscode.commands.executeCommand('dartboard.openFile', vscode.Uri.parse(msg.uri));
      } else if (msg?.type === 'run') {
        void vscode.commands.executeCommand('dartboard.run');
      }
    });
    this.panel.webview.html = this.html(tab);
    this.update();
  }

  private update(): void {
    if (!this.panel) {
      return;
    }
    const files = this.store.all().map((f) => ({
      uri: f.uri.toString(),
      path: f.relativePath,
      found: f.linesFound,
      hit: f.linesHit,
      pct: percent(f.linesHit, f.linesFound) ?? 100,
      untested: !!f.untested,
    }));
    const history = this.store.history.list().map((s) => ({
      time: s.time,
      commit: s.commit,
      pct: percent(s.hit, s.found) ?? 0,
      hit: s.hit,
      found: s.found,
    }));
    const risk = this.store.riskiest.map((r) => ({
      uri: r.file.uri.toString(),
      path: r.file.relativePath,
      pct: percent(r.file.linesHit, r.file.linesFound) ?? 0,
      complexity: r.complexity,
      changes: r.changes,
      score: r.score,
    }));
    const config = vscode.workspace.getConfiguration('dartboard');
    void this.panel.webview.postMessage({
      type: 'data',
      files,
      history,
      risk,
      git: this.store.gitAvailable,
      low: config.get<number>('lowThreshold', 50),
      high: config.get<number>('highThreshold', 80),
    });
  }

  private html(initialTab: string): string {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Coverage Insights</title>
<style>
  :root { --green: var(--vscode-charts-green, #2ea043); --yellow: var(--vscode-charts-yellow, #d29922); --red: var(--vscode-charts-red, #f85149); }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 0 16px 16px; margin: 0; }
  header { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 12px 0 8px; z-index: 2; }
  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--vscode-panel-border, #8884); }
  .tab { background: none; border: none; color: var(--vscode-foreground); opacity: .7; padding: 6px 12px; cursor: pointer; font: inherit; border-bottom: 2px solid transparent; }
  .tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder); }
  .tab:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
  section { display: none; padding-top: 12px; } section.active { display: block; }
  .hint { color: var(--vscode-descriptionForeground); margin: 4px 0 12px; }
  #map { position: relative; width: 100%; height: calc(100vh - 140px); min-height: 320px; }
  .cell { position: absolute; box-sizing: border-box; border: 1px solid var(--vscode-editor-background); overflow: hidden; cursor: pointer; padding: 3px 5px; font-size: 11px; line-height: 1.25; color: #fff; text-shadow: 0 1px 1px #0008; }
  .cell:hover { outline: 2px solid var(--vscode-focusBorder); z-index: 1; }
  .group { position: absolute; box-sizing: border-box; border: 1px solid var(--vscode-panel-border, #8886); pointer-events: none; }
  .group span { position: absolute; top: -1px; left: 0; font-size: 10px; padding: 0 4px; background: var(--vscode-editor-background); color: var(--vscode-descriptionForeground); }
  .legend { display: flex; gap: 14px; align-items: center; margin: 4px 0 8px; color: var(--vscode-descriptionForeground); flex-wrap: wrap; }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
  svg text { fill: var(--vscode-descriptionForeground); font-size: 11px; }
  table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border, #8883); }
  th { font-weight: 600; color: var(--vscode-descriptionForeground); } td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; } a:hover { text-decoration: underline; }
  .drop { color: var(--red); } .rise { color: var(--green); }
  .card { border: 1px solid var(--vscode-panel-border, #8884); border-radius: 6px; padding: 10px 12px; margin-bottom: 12px; }
  .empty { padding: 32px 0; text-align: center; color: var(--vscode-descriptionForeground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 2px; cursor: pointer; font: inherit; }
  #tip { position: fixed; pointer-events: none; background: var(--vscode-editorHoverWidget-background); border: 1px solid var(--vscode-editorHoverWidget-border); padding: 6px 8px; border-radius: 4px; display: none; z-index: 5; max-width: 360px; }
</style>
</head>
<body>
<header>
  <div class="tabs" role="tablist">
    <button class="tab" data-tab="map" role="tab">Coverage map</button>
    <button class="tab" data-tab="history" role="tab">History</button>
    <button class="tab" data-tab="risk" role="tab">Risk radar</button>
  </div>
</header>
<section id="tab-map">
  <div class="legend">
    <span>Box size = lines of code · colour = coverage · click to open</span>
    <span><i class="swatch" style="background:var(--red)"></i>low</span>
    <span><i class="swatch" style="background:var(--yellow)"></i>medium</span>
    <span><i class="swatch" style="background:var(--green)"></i>high</span>
  </div>
  <div id="map"></div>
</section>
<section id="tab-history">
  <p class="hint">Total coverage after each test run in this workspace. The biggest drop is highlighted.</p>
  <div id="history"></div>
</section>
<section id="tab-risk">
  <p class="hint" id="riskHint"></p>
  <div id="risk"></div>
</section>
<div id="tip"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let data = null;
  let current = ${JSON.stringify(initialTab)};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (p) => (Math.round(p * 10) / 10).toFixed(Number.isInteger(Math.round(p * 10) / 10) ? 0 : 1) + '%';
  const colorFor = (p) => p >= data.high ? 'var(--green)' : p >= data.low ? 'var(--yellow)' : 'var(--red)';

  function setTab(tab) {
    current = tab;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('section').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + tab));
    render();
  }
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  // Squarified treemap (Bruls et al.), laid out into rect {x,y,w,h}.
  function squarify(items, rect) {
    const out = [];
    const total = items.reduce((s, i) => s + i.value, 0);
    if (!total) return out;
    const scale = (rect.w * rect.h) / total;
    let rest = items.map((i) => ({ ...i, area: i.value * scale }));
    let r = { ...rect };
    while (rest.length) {
      const short = Math.min(r.w, r.h);
      let row = [rest[0]], best = worst(row, short), i = 1;
      while (i < rest.length) {
        const next = worst([...row, rest[i]], short);
        if (next > best) break;
        row.push(rest[i]); best = next; i++;
      }
      rest = rest.slice(row.length);
      const sum = row.reduce((s, x) => s + x.area, 0);
      if (r.w >= r.h) {
        const w = sum / r.h; let y = r.y;
        row.forEach((x) => { const h = x.area / w; out.push({ ...x, x: r.x, y, w, h }); y += h; });
        r = { x: r.x + w, y: r.y, w: r.w - w, h: r.h };
      } else {
        const h = sum / r.w; let x0 = r.x;
        row.forEach((x) => { const w = x.area / h; out.push({ ...x, x: x0, y: r.y, w, h }); x0 += w; });
        r = { x: r.x, y: r.y + h, w: r.w, h: r.h - h };
      }
    }
    return out;
  }
  function worst(row, short) {
    const sum = row.reduce((s, x) => s + x.area, 0);
    const max = Math.max(...row.map((x) => x.area)), min = Math.min(...row.map((x) => x.area));
    return Math.max((short * short * max) / (sum * sum), (sum * sum) / (short * short * min));
  }

  function renderMap() {
    const el = $('map');
    el.innerHTML = '';
    const files = data.files.filter((f) => f.found > 0);
    if (!files.length) { el.innerHTML = '<div class="empty">No coverage yet.</div>'; return; }
    const W = el.clientWidth, H = el.clientHeight;
    const groups = new Map();
    for (const f of files) {
      const parts = f.path.split('/');
      const key = parts.length > 2 ? parts.slice(0, 2).join('/') : parts.length > 1 ? parts[0] : '.';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    const groupItems = [...groups.entries()].map(([name, list]) => ({ name, list, value: list.reduce((s, f) => s + f.found, 0) }))
      .sort((a, b) => b.value - a.value);
    for (const g of squarify(groupItems, { x: 0, y: 0, w: W, h: H })) {
      const pad = 14;
      const inner = { x: g.x + 2, y: g.y + pad, w: Math.max(0, g.w - 4), h: Math.max(0, g.h - pad - 2) };
      const frame = document.createElement('div');
      frame.className = 'group';
      Object.assign(frame.style, { left: g.x + 'px', top: g.y + 'px', width: g.w + 'px', height: g.h + 'px' });
      frame.innerHTML = '<span>' + esc(g.name) + '</span>';
      el.appendChild(frame);
      const cells = squarify(g.list.map((f) => ({ ...f, value: f.found })).sort((a, b) => b.value - a.value), inner);
      for (const c of cells) {
        const d = document.createElement('div');
        d.className = 'cell';
        Object.assign(d.style, { left: c.x + 'px', top: c.y + 'px', width: c.w + 'px', height: c.h + 'px', background: colorFor(c.pct) });
        if (c.w > 50 && c.h > 26) d.innerHTML = esc(c.path.split('/').pop()) + '<br>' + (c.untested ? 'no tests' : fmt(c.pct));
        d.addEventListener('click', () => vscode.postMessage({ type: 'open', uri: c.uri }));
        d.addEventListener('mousemove', (e) => tip(e, '<b>' + esc(c.path) + '</b><br>' + (c.untested ? '0% · no test imports this file' : fmt(c.pct) + ' · ' + c.hit + '/' + c.found + ' lines')));
        d.addEventListener('mouseleave', () => ($('tip').style.display = 'none'));
        el.appendChild(d);
      }
    }
  }

  function tip(e, html) {
    const t = $('tip');
    t.innerHTML = html; t.style.display = 'block';
    t.style.left = Math.min(e.clientX + 12, window.innerWidth - t.offsetWidth - 8) + 'px';
    t.style.top = Math.min(e.clientY + 12, window.innerHeight - t.offsetHeight - 8) + 'px';
  }

  function renderHistory() {
    const el = $('history');
    const h = data.history;
    if (h.length < 2) {
      el.innerHTML = '<div class="empty">History builds up as you run coverage. Run it again after your next change to see the trend.<br><br><button class="primary" id="runBtn">Run coverage</button></div>';
      $('runBtn').addEventListener('click', () => vscode.postMessage({ type: 'run' }));
      return;
    }
    let worstIdx = -1, worstDrop = 0;
    for (let i = 1; i < h.length; i++) { const d = h[i].pct - h[i - 1].pct; if (d < worstDrop) { worstDrop = d; worstIdx = i; } }
    const W = Math.max(320, el.clientWidth || 600), H = 220, P = { l: 40, r: 12, t: 12, b: 28 };
    const min = Math.max(0, Math.floor(Math.min(...h.map((x) => x.pct)) / 10) * 10 - 10), max = 100;
    const X = (i) => P.l + (i / (h.length - 1)) * (W - P.l - P.r);
    const Y = (p) => P.t + (1 - (p - min) / (max - min)) * (H - P.t - P.b);
    let svg = '<svg width="' + W + '" height="' + H + '" role="img" aria-label="Coverage over time">';
    for (let g = min; g <= max; g += 10) svg += '<line x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + Y(g) + '" y2="' + Y(g) + '" stroke="currentColor" stroke-opacity=".1"/><text x="' + (P.l - 6) + '" y="' + (Y(g) + 4) + '" text-anchor="end">' + g + '%</text>';
    svg += '<polyline fill="none" stroke="var(--vscode-charts-blue, #3794ff)" stroke-width="2" points="' + h.map((x, i) => X(i) + ',' + Y(x.pct)).join(' ') + '"/>';
    h.forEach((x, i) => { svg += '<circle cx="' + X(i) + '" cy="' + Y(x.pct) + '" r="' + (i === worstIdx ? 5 : 3) + '" fill="' + (i === worstIdx ? 'var(--red)' : 'var(--vscode-charts-blue, #3794ff)') + '"><title>' + new Date(x.time).toLocaleString() + ' · ' + fmt(x.pct) + (x.commit ? ' · ' + x.commit : '') + '</title></circle>'; });
    svg += '</svg>';
    let html = svg;
    if (worstIdx > 0) {
      const w = h[worstIdx];
      html += '<div class="card"><b class="drop">Biggest drop: ' + fmt(-worstDrop) + '</b> on ' + new Date(w.time).toLocaleString() + (w.commit ? ' at commit <code>' + esc(w.commit) + '</code>' : '') + '.</div>';
    }
    html += '<table><thead><tr><th>When</th><th>Commit</th><th class="num">Coverage</th><th class="num">Change</th></tr></thead><tbody>';
    for (let i = h.length - 1; i >= 0; i--) {
      const d = i > 0 ? h[i].pct - h[i - 1].pct : 0;
      html += '<tr><td>' + new Date(h[i].time).toLocaleString() + '</td><td>' + esc(h[i].commit || '–') + '</td><td class="num">' + fmt(h[i].pct) + '</td><td class="num ' + (d < -0.05 ? 'drop' : d > 0.05 ? 'rise' : '') + '">' + (i > 0 ? (d > 0 ? '+' : '') + d.toFixed(1) + '%' : '') + '</td></tr>';
    }
    el.innerHTML = html + '</tbody></table>';
  }

  function renderRisk() {
    $('riskHint').textContent = 'Files most likely to hide bugs: low coverage × complex code' + (data.git ? ' × changed often in the last 6 months.' : '. (Git history is added when git is available.)');
    const el = $('risk');
    if (!data.risk.length) { el.innerHTML = '<div class="empty">Nothing risky found. Nice!</div>'; return; }
    let html = '<table><thead><tr><th>File</th><th class="num">Coverage</th><th class="num">Complexity</th>' + (data.git ? '<th class="num">Changes</th>' : '') + '<th class="num">Risk</th></tr></thead><tbody>';
    for (const r of data.risk) {
      html += '<tr><td><a data-uri="' + esc(r.uri) + '">' + esc(r.path) + '</a></td><td class="num" style="color:' + colorFor(r.pct) + '">' + fmt(r.pct) + '</td><td class="num">' + r.complexity + '</td>' + (data.git ? '<td class="num">' + r.changes + '</td>' : '') + '<td class="num">' + r.score.toFixed(1) + '</td></tr>';
    }
    el.innerHTML = html + '</tbody></table>';
    el.querySelectorAll('a[data-uri]').forEach((a) => a.addEventListener('click', () => vscode.postMessage({ type: 'open', uri: a.dataset.uri })));
  }

  function render() {
    if (!data) return;
    if (current === 'map') renderMap();
    else if (current === 'history') renderHistory();
    else renderRisk();
  }

  window.addEventListener('message', (e) => {
    if (e.data.type === 'data') { data = e.data; render(); }
    else if (e.data.type === 'tab') setTab(e.data.tab);
  });
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); });
  setTab(current);
</script>
</body>
</html>`;
  }

  dispose(): void {
    this.sub.dispose();
    this.panel?.dispose();
  }
}
