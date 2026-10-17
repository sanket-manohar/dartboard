// Dartboard panel. Receives the full state from the extension and renders the summary,
// the tab bar and the active tab. Expand state, the active tab and the selection survive reloads.
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const open = new Map(Object.entries(saved.open || {}));
  let tab = saved.tab || 'files';
  let selected = saved.selected || null;
  let state = null;
  const byId = new Map();
  const hero = document.getElementById('hero');
  const tabs = document.getElementById('tabs');
  const list = document.getElementById('list');

  const svg = (body, attrs) => '<svg viewBox="0 0 16 16" ' + (attrs || 'fill="currentColor"') + '>' + body + '</svg>';
  const ICONS = {
    chevron: svg('<path d="M5.7 13.7 4.3 12.3 8.6 8 4.3 3.7l1.4-1.4L11.4 8z"/>'),
    flame: svg('<path d="M8 1s4 3.2 4 7.3A4 4 0 0 1 8 15a4 4 0 0 1-4-4.2c0-1.8 1-3 1-3s.3 1.7 1.6 2.2C6.6 7 8 5 8 1z"/>', 'fill="var(--vscode-charts-orange, #d18616)"'),
    slash: svg('<circle cx="8" cy="8" r="5.5"/><path d="m4.2 11.8 7.6-7.6"/>', 'fill="none" stroke="var(--c-low)" stroke-width="1.6"'),
    layer: svg('<path d="m8 2 6 3-6 3-6-3z"/><path d="m2 8 6 3 6-3M2 11l6 3 6-3"/>', 'fill="none" stroke="currentColor" stroke-width="1.3"'),
    dot: svg('<circle cx="8" cy="8" r="3.5" fill="none" stroke="var(--c-low)" stroke-width="1.5"/>', ''),
    warn: svg('<path d="M8 1.5 15 14H1z"/><path d="M7.3 6h1.4v4H7.3zM7.3 11h1.4v1.4H7.3z" fill="var(--vscode-editor-background, #1e1e1e)"/>', 'fill="var(--c-medium)"'),
    info: svg('<circle cx="8" cy="8" r="6"/><path d="M8 7v4M8 5v.5"/>', 'fill="none" stroke="currentColor" stroke-width="1.3"'),
    play: svg('<path d="M4 2.5v11l9-5.5z"/>'),
    plus: svg('<path d="M7.25 2h1.5v5.25H14v1.5H8.75V14h-1.5V8.75H2v-1.5h5.25z"/>'),
    ok: svg('<circle cx="8" cy="8" r="5.5" fill="var(--c-high)"/><path d="m5.5 8.2 1.7 1.7 3.4-3.6" fill="none" stroke="var(--vscode-editor-background, #1e1e1e)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>', ''),
    miss: svg('<circle cx="8" cy="8" r="5" fill="none" stroke="var(--c-low)" stroke-width="1.8"/>', ''),
    unk: svg('<circle cx="8" cy="8" r="5" fill="none" stroke="var(--c-none)" stroke-width="1.5" stroke-dasharray="2 2"/>', ''),
    screen: svg('<rect x="4" y="1.5" width="8" height="13" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M7 12.5h2" stroke="currentColor" stroke-width="1.3"/>', ''),
    widget: svg('<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1" opacity=".55"/><rect x="2" y="9" width="5" height="5" rx="1" opacity=".55"/><rect x="9" y="9" width="5" height="5" rx="1"/>'),
    state: svg('<circle cx="4" cy="8" r="2.2"/><circle cx="12" cy="4" r="2.2"/><circle cx="12" cy="12" r="2.2"/><path d="M6 7l4-2M6 9l4 2" stroke="currentColor" stroke-width="1.2"/>'),
    collapse: svg('<path d="M9 9H4v1h5V9z"/><path d="M10.1 1.5H5.5l-1 1v1h-1l-1 1V13l1 1h7l1-1v-1h1l1-1V4.9l-3.4-3.4zM10.5 13h-7V4.5h1v6.5l1 1h5v1zm2-2h-7V2.5h4l3 3V11z"/>'),
    check: svg('<circle cx="8" cy="8" r="7" fill="var(--c-high)"/><path d="m4.8 8.3 2.1 2.1 4.3-4.6" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>', ''),
  };
  const TAB_ICONS = {
    files: svg('<path d="M3 1.5h6l4 4v9H3z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M9 1.5v4h4" fill="none" stroke="currentColor" stroke-width="1.2"/>', ''),
    widgets: ICONS.widget,
    states: ICONS.state,
    tests: svg('<path d="M6 1.5h4M7 1.5v4.5L3 13.2a.9.9 0 0 0 .8 1.3h8.4a.9.9 0 0 0 .8-1.3L9 6V1.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>', ''),
  };
  const TAB_NAMES = { files: 'Files', widgets: 'Widgets', states: 'States', tests: 'Tests' };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const persist = () => vscode.setState({ open: Object.fromEntries(open), selected, tab });
  const isOpen = (r) => (open.has(r.id) ? open.get(r.id) : r.expanded);
  const run = (command, args) => vscode.postMessage({ type: 'run', command, args: args || [] });

  // ---------------------------------------------------------------- summary
  function renderHero() {
    if (!state || !state.hasData) { hero.innerHTML = ''; return; }
    const h = state.hero;
    const r = 23, c = 2 * Math.PI * r;
    const color = 'var(--c-' + h.level + ')';
    const goalTick = h.goal ? (() => {
      const a = (h.goal / 100) * 2 * Math.PI - Math.PI / 2;
      const x1 = 28 + Math.cos(a) * 18, y1 = 28 + Math.sin(a) * 18, x2 = 28 + Math.cos(a) * 28, y2 = 28 + Math.sin(a) * 28;
      return '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="var(--vscode-foreground)" stroke-width="1.5" opacity=".55"/>';
    })() : '';
    const pills = [];
    if (h.branches) pills.push('<span class="pill ' + (h.branchLevel === 'high' ? 'good' : h.branchLevel === 'medium' ? 'warn' : 'bad') + '" title="Share of code paths (if/else, ?:, &&, loops) that ran">Branches ' + esc(h.branches) + '</span>');
    if (h.trend) pills.push('<span class="pill ' + (h.trendUp ? 'good' : 'bad') + '" title="Change since the previous run">' + esc(h.trend) + '</span>');
    if (h.goal) pills.push(h.goalReached
      ? '<span class="pill good">Goal ' + h.goal + '% ✓</span>'
      : '<span class="pill" title="Cover about ' + h.toGoal + ' more lines to reach the goal">Goal ' + h.goal + '% · ' + h.toGoal + ' lines to go</span>');
    if (h.changedOnly) pills.push('<span class="pill warn">changed files only</span>');
    let html = '<div class="hero" data-cmd="dartboard.openInsights" title="Open coverage insights">'
      + '<svg class="ring" viewBox="0 0 56 56"><circle class="track" cx="28" cy="28" r="' + r + '" fill="none" stroke-width="6"/>'
      + '<circle class="value" cx="28" cy="28" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="6" stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + (c * (1 - Math.min(100, h.pct) / 100)) + '" transform="rotate(-90 28 28)"/>'
      + goalTick + '</svg>'
      + '<div class="hero-main"><div class="hero-pct">' + esc(h.pctText) + '<small>line coverage</small></div>'
      + '<div class="hero-sub">' + esc(h.lines) + '</div>'
      + (pills.length ? '<div class="pills">' + pills.join('') + '</div>' : '') + '</div></div>';
    const rl = state.run;
    if (rl) {
      html += '<div class="runline" data-tab="tests" title="Last test run: open the Tests tab">'
        + '<span class="ok"><span class="dot"></span>' + rl.passed + ' passed</span>'
        + (rl.failed ? '<span class="ko"><span class="dot"></span>' + rl.failed + ' failed</span>' : '')
        + (rl.skipped ? '<span class="skip"><span class="dot"></span>' + rl.skipped + ' skipped</span>' : '')
        + '<span class="when">' + esc([rl.duration, rl.ago].filter(Boolean).join(' · ')) + '</span></div>';
    }
    hero.innerHTML = html;
  }

  function renderTabs() {
    if (!state || !state.hasPackages) { tabs.innerHTML = ''; return; }
    const b = state.badges || {};
    let html = '';
    for (const t of ['files', 'widgets', 'states', 'tests']) {
      const badge = t === 'tests' && b.tests ? '<span class="badge bad">' + b.tests + '</span>' : '';
      html += '<button class="tab' + (tab === t ? ' on' : '') + '" role="tab" aria-selected="' + (tab === t) + '" data-tab="' + t + '" title="' + TAB_NAMES[t] + '">' + TAB_ICONS[t] + '<span>' + TAB_NAMES[t] + '</span>' + badge + '</button>';
    }
    html += '<span class="tabs-spacer"></span>';
    if (tab !== 'tests') html += '<button class="icon-btn" data-collapse title="Collapse all">' + ICONS.collapse + '</button>';
    tabs.innerHTML = html;
  }

  // ---------------------------------------------------------------- rows
  function rowHtml(r, depth) {
    const indent = 4 + depth * 12;
    const ctx = r.section ? { webviewSection: r.section, uri: r.uri, preventDefaultContextMenuItems: true } : { preventDefaultContextMenuItems: true };
    const actions = (r.actions || []).map((a, i) => '<button data-act="' + i + '" title="' + esc(a.title) + '">' + (ICONS[a.icon] || '') + '</button>').join('');
    const chips = (r.chips || []).map((c) => '<span class="chip ' + c.tone + '">' + esc(c.text) + '</span>').join('');
    const pct = r.pctText !== undefined
      ? '<span class="pct">' + esc(r.pctText) + '</span><span class="bar lv-' + (r.level || 'none') + '"><i style="width:' + Math.max(0, Math.min(100, r.pct || 0)) + '%"></i></span>'
      : '';
    return '<div class="row' + (r.collapsible && isOpen(r) ? ' open' : '') + (r.bold ? ' bold' : '') + (r.dim ? ' dim' : '') + (selected === r.id ? ' selected' : '') + '"'
      + ' role="treeitem" data-id="' + esc(r.id) + '" style="padding-left:' + indent + 'px"'
      + ' title="' + esc(r.tooltip) + '" data-vscode-context=\'' + esc(JSON.stringify(ctx)) + '\'>'
      + '<span class="twisty">' + (r.collapsible ? ICONS.chevron : '') + '</span>'
      + (r.icon ? '<span class="icon">' + (ICONS[r.icon] || '') + '</span>' : '')
      + '<span class="label">' + esc(r.label) + '</span>' + chips
      + (r.extra ? '<span class="extra">' + esc(r.extra) + '</span>' : '')
      + '<span class="spacer"></span>'
      + (actions ? '<span class="actions">' + actions + '</span>' : '')
      + pct + '</div>';
  }

  function build(items, depth) {
    let html = '';
    for (const r of items) {
      byId.set(r.id, r);
      html += rowHtml(r, depth);
      if (r.collapsible && isOpen(r)) {
        if (r.children) html += '<div class="children" style="--guide:' + (12 + depth * 12) + 'px">' + build(r.children, depth + 1) + '</div>';
        else if (r.lazy) vscode.postMessage({ type: 'expand', id: r.id });
      }
    }
    return html;
  }

  // ---------------------------------------------------------------- tests tab
  function testsHtml(t) {
    let html = '';
    if (t.failures.length) {
      html += '<div class="section">Failed <span class="count">' + t.failures.length + '</span></div>';
      for (const c of t.failures) {
        byId.set(c.id, c);
        html += '<div class="card" data-card="' + esc(c.id) + '">'
          + '<div class="card-title">' + esc(c.title) + '</div>'
          + '<div class="card-test" title="' + esc(c.test) + '">' + esc(c.test) + '</div>'
          + (c.where ? '<a class="link loc" data-open="test">' + esc(c.where) + '</a>' : '')
          + (c.widget ? '<a class="link loc" data-open="widget">↳ ' + esc(c.widget.label) + '</a>' : '')
          + (c.items && c.items.length ? '<ul class="items">' + c.items.map((i) => '<li>' + esc(i) + '</li>').join('') + '</ul>' : '')
          + (c.expected ? '<div class="kv"><span>Expected</span>' + esc(c.expected) + '\n<span>Actual</span>' + esc(c.actual) + '</div>' : '')
          + (c.hint ? '<div class="hint"><b>💡</b><span>' + esc(c.hint) + '</span></div>' : '')
          + '<div class="card-actions">' + c.actions.map((a, i) => '<button data-cact="' + i + '">' + esc(a.label) + '</button>').join('') + '</div>'
          + '</div>';
      }
    } else if (t.hasResults) {
      html += '<div class="allgood">' + ICONS.check + '<span>All tests passed in the last run.</span></div>';
    }
    if (t.matrix && t.matrix.rows.length) {
      html += '<div class="section">Screen sizes <span class="count">' + esc(t.matrix.file) + '</span></div><div class="grid"><table><tr><th>Test</th>'
        + t.matrix.configs.map((c) => '<th title="' + esc(c) + '">' + esc(short(c)) + '</th>').join('') + '</tr>';
      t.matrix.rows.forEach((r) => {
        html += '<tr><td title="' + esc(r.test) + '">' + esc(r.test) + '</td>' + r.cells.map((c) => {
          if (c.open) byId.set(c.id, c);
          return '<td><span class="cell ' + c.status + '" ' + (c.status === 'failed' ? 'data-cell="' + esc(c.id) + '" ' : '') + 'title="' + esc(c.title || c.status) + '">' + (c.status === 'passed' ? '✓' : c.status === 'failed' ? '✗' : '–') + '</span></td>';
        }).join('') + '</tr>';
      });
      html += '</table></div>';
    }
    if (t.slowest.length) {
      html += '<div class="section">Slowest tests</div>';
      t.slowest.forEach((s, i) => {
        byId.set('slow' + i, s);
        html += '<div class="slow" data-slow="' + i + '" title="' + esc(s.name + '\n' + s.file) + '"><span class="name">' + esc(s.name) + '</span>'
          + (s.delta ? '<span class="delta' + (s.slower ? ' up' : '') + '" title="Compared with the previous run">' + esc(s.delta) + '</span>' : '')
          + '<span class="meter"><i style="width:' + s.width + '%"></i></span><span class="ms">' + esc(s.ms) + '</span></div>';
      });
    }
    if (t.pyramid) {
      const p = t.pyramid;
      const total = p.unit + p.widget + p.golden + p.integration;
      if (total) {
        const max = Math.max(p.unit, p.widget, p.golden, p.integration, 1);
        const w = (n) => Math.round(40 + (n / max) * 55) + '%';
        html += '<div class="section">Test pyramid <span class="count">' + total + ' tests</span></div><div class="pyramid">'
          + (p.integration ? '<div class="pyr i" style="width:' + w(p.integration) + '">Integration ' + p.integration + '</div>' : '')
          + (p.golden ? '<div class="pyr g" style="width:' + w(p.golden) + '">Golden ' + p.golden + '</div>' : '')
          + '<div class="pyr w" style="width:' + w(p.widget) + '">Widget ' + p.widget + '</div>'
          + '<div class="pyr u" style="width:' + w(p.unit) + '">Unit ' + p.unit + '</div></div>';
        if (p.widget + p.golden + p.integration > p.unit && total > 6) {
          html += '<div class="pyr-note">More UI tests than unit tests. Unit tests are faster and pin down logic more precisely; consider moving logic checks down.</div>';
        } else if (!p.widget && p.unit > 5) {
          html += '<div class="pyr-note">No widget tests yet. Even one per screen catches layout and wiring bugs unit tests miss.</div>';
        }
      }
    }
    if (t.pitfalls.length) {
      html += '<div class="section">Test pitfalls <span class="count">' + t.pitfalls.reduce((n, p) => n + p.warnings + p.infos, 0) + '</span></div>';
      t.pitfalls.forEach((p, i) => {
        byId.set('pit' + i, p);
        html += '<div class="pit" data-pit="' + i + '" title="' + esc(p.top) + '">' + (p.warnings ? ICONS.warn : ICONS.info) + '<span class="name">' + esc(p.file) + '</span>'
          + (p.warnings ? '<span class="chip warn">' + p.warnings + ' warning' + (p.warnings === 1 ? '' : 's') + '</span>' : '')
          + (p.infos ? '<span class="chip">' + p.infos + ' note' + (p.infos === 1 ? '' : 's') + '</span>' : '') + '</div>';
      });
    }
    if (!html) {
      html = '<div class="empty"><p>No test results yet.</p><p class="muted">Run your tests and failures show up here as short explanations with a fix hint, plus your slowest tests.</p><button data-cmd="dartboard.run">Run Tests with Coverage</button></div>';
    }
    return html;
  }

  function short(name) {
    return name.length > 9 ? name.split(/\s+/).map((w) => w[0]).join('').toUpperCase() : name;
  }

  // ---------------------------------------------------------------- render
  function render() {
    byId.clear();
    renderHero();
    renderTabs();
    if (!state) { list.innerHTML = ''; return; }
    if (!state.hasData && !state.hasPackages) {
      list.innerHTML = '<div class="empty"><p>Open a Flutter or Dart project to see its test coverage.</p><p class="muted">New here? <a data-cmd="dartboard.openWalkthrough">Take the 1-minute tour</a></p></div>';
      return;
    }
    if (!state.hasData && tab === 'files') {
      list.innerHTML = '<div class="empty"><p>No coverage data yet. Run your tests with coverage to see which files, widgets and states are tested.</p>'
        + '<button data-cmd="dartboard.run">Run Tests with Coverage</button>'
        + '<button class="secondary" data-cmd="dartboard.refresh">Load Existing Report</button>'
        + '<p style="margin-top:12px" class="muted">New here? <a data-cmd="dartboard.openWalkthrough">Take the 1-minute tour</a></p></div>';
      return;
    }
    const top = document.scrollingElement.scrollTop;
    let html;
    if (tab === 'tests') {
      html = testsHtml(state.tests);
    } else {
      const rows = state[tab] || [];
      html = rows.length ? build(rows, 0) : emptyFor(tab);
    }
    list.innerHTML = html;
    document.scrollingElement.scrollTop = top;
  }

  function emptyFor(t) {
    if (t === 'widgets') return '<div class="empty"><p>No widgets found.</p><p class="muted">Widgets with a build() method show up here with the parts of their tree that tests rendered.</p></div>';
    if (t === 'states') return '<div class="empty"><p>No state classes found.</p><p class="muted">Bloc, Cubit, Riverpod Notifier and ChangeNotifier classes show up here with the events, states and methods tests reached.</p></div>';
    return '<div class="empty"><p>Nothing to show.</p></div>';
  }

  function visibleRows() { return [...list.querySelectorAll('.row')]; }

  function select(id, scroll) {
    selected = id;
    persist();
    list.querySelectorAll('.row.selected').forEach((e) => e.classList.remove('selected'));
    const el = list.querySelector('.row[data-id="' + CSS.escape(id) + '"]');
    if (el) { el.classList.add('selected'); if (scroll) el.scrollIntoView({ block: 'nearest' }); }
  }

  function toggle(r, force) {
    if (!r || !r.collapsible) return;
    open.set(r.id, force === undefined ? !isOpen(r) : force);
    persist();
    render();
  }

  function activate(r) {
    if (r.command) run(r.command.command, r.command.args);
    else if (r.collapsible) toggle(r);
  }

  function setTab(t) {
    if (!TAB_NAMES[t]) return;
    tab = t;
    persist();
    document.scrollingElement.scrollTop = 0;
    render();
  }

  // ---------------------------------------------------------------- events
  document.addEventListener('click', (e) => {
    const cmdEl = e.target.closest('[data-cmd]');
    if (cmdEl) { run(cmdEl.dataset.cmd); return; }
    const tabEl = e.target.closest('[data-tab]');
    if (tabEl) { setTab(tabEl.dataset.tab); return; }
    if (e.target.closest('[data-collapse]')) { collapseAll(); return; }

    const cardEl = e.target.closest('[data-card]');
    if (cardEl) {
      const c = byId.get(cardEl.dataset.card);
      const openEl = e.target.closest('[data-open]');
      if (openEl) { const o = openEl.dataset.open === 'widget' ? c.widget.open : c.open; if (o) run(o.command, o.args); return; }
      const actEl = e.target.closest('[data-cact]');
      if (actEl) { const a = c.actions[Number(actEl.dataset.cact)]; run(a.command, a.args); }
      return;
    }
    const cellEl = e.target.closest('[data-cell]');
    if (cellEl) { const c = byId.get(cellEl.dataset.cell); if (c && c.open) run(c.open.command, c.open.args); else run('dartboard.showFailureOutput', [cellEl.dataset.cell]); return; }
    const slowEl = e.target.closest('[data-slow]');
    if (slowEl) { const s = byId.get('slow' + slowEl.dataset.slow); run(s.open.command, s.open.args); return; }
    const pitEl = e.target.closest('[data-pit]');
    if (pitEl) { const p = byId.get('pit' + pitEl.dataset.pit); run(p.open.command, p.open.args); return; }

    const rowEl = e.target.closest('.row');
    if (!rowEl) return;
    const r = byId.get(rowEl.dataset.id);
    if (!r) return;
    const act = e.target.closest('[data-act]');
    if (act) { const a = r.actions[Number(act.dataset.act)]; run(a.command, a.args); return; }
    select(r.id);
    if (e.target.closest('.twisty') && r.collapsible) { toggle(r); return; }
    activate(r);
  });
  list.addEventListener('dblclick', (e) => {
    const rowEl = e.target.closest('.row');
    const r = rowEl && byId.get(rowEl.dataset.id);
    if (r && r.collapsible && r.command) toggle(r);
  });
  list.addEventListener('contextmenu', (e) => {
    const rowEl = e.target.closest('.row');
    if (rowEl) select(rowEl.dataset.id);
  });
  list.addEventListener('keydown', (e) => {
    const els = visibleRows();
    const idx = els.findIndex((el) => el.dataset.id === selected);
    const r = byId.get(selected);
    if (e.key === 'ArrowDown') { const n = els[Math.min(els.length - 1, idx + 1)]; if (n) select(n.dataset.id, true); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { const n = els[Math.max(0, idx - 1)]; if (n) select(n.dataset.id, true); e.preventDefault(); }
    else if (e.key === 'ArrowRight' && r) { if (r.collapsible && !isOpen(r)) toggle(r, true); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' && r) { if (r.collapsible && isOpen(r)) toggle(r, false); e.preventDefault(); }
    else if ((e.key === 'Enter' || e.key === ' ') && r) { activate(r); e.preventDefault(); }
  });
  tabs.addEventListener('keydown', (e) => {
    const order = ['files', 'widgets', 'states', 'tests'];
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      setTab(order[(order.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : 3)) % 4]);
      const b = tabs.querySelector('.tab.on'); if (b) b.focus();
    }
  });

  function findPath(items, id, trail) {
    for (const r of items) {
      if (r.id === id) return [...trail, r];
      if (r.children) { const p = findPath(r.children, id, [...trail, r]); if (p) return p; }
    }
    return null;
  }

  function collapseAll() {
    const fold = (items) => items.forEach((r) => { if (r.collapsible) open.set(r.id, false); if (r.children) fold(r.children); });
    if (state) ['files', 'widgets', 'states'].forEach((t) => fold(state[t] || []));
    persist();
    render();
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') { state = m; render(); if (selected) select(selected); }
    else if (m.type === 'children') {
      const parent = byId.get(m.id);
      if (parent) { parent.children = m.rows; parent.lazy = false; render(); if (selected) select(selected); }
    } else if (m.type === 'collapseAll') {
      collapseAll();
    } else if (m.type === 'tab') {
      setTab(m.tab);
    } else if (m.type === 'reveal') {
      const rows = state ? state[tab] || [] : [];
      const path = findPath(rows, m.id, []);
      if (!path) return;
      path.slice(0, -1).forEach((r) => open.set(r.id, true));
      open.set(m.id, true);
      persist();
      render();
      select(m.id, true);
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
