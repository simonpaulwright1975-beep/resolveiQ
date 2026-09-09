/* ResolveIQ console.
   Vanilla JS, no build step. State lives in memory; the agent's own changes
   (claim / resolve / snooze) are mirrored into localStorage so a refresh
   doesn't lose them. */

(function () {
  'use strict';

  var DATA = window.RESOLVEIQ_DATA;
  var STORE_KEY = 'resolveiq.overrides.v1';
  var ME = DATA.currentAgent;

  var state = {
    status: 'active',       // active | new | open | pending | resolved | all
    query: '',
    selected: null,
    tickets: []
  };

  /* ---------- persistence (best effort — private mode, blocked storage) ---------- */

  function loadOverrides() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function saveOverrides() {
    var out = {};
    state.tickets.forEach(function (t) {
      if (t._touched) out[t.id] = { status: t.status, assignee: t.assignee, waitMins: t.waitMins };
    });
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(out));
    } catch (e) { /* nothing to do — the session just won't survive a refresh */ }
  }

  function hydrate() {
    var saved = loadOverrides();
    state.tickets = DATA.tickets.map(function (t) {
      var copy = Object.assign({}, t);
      if (saved[t.id]) {
        Object.assign(copy, saved[t.id]);
        copy._touched = true;
      }
      return copy;
    });
  }

  /* ---------- helpers ---------- */

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function isOpen(t) { return t.status !== 'resolved'; }

  /* An SLA is breached once the customer has waited longer than the window. */
  function slaState(t) {
    if (!isOpen(t)) return 'ok';
    var used = t.waitMins / t.slaMins;
    if (used >= 1) return 'breach';
    if (used >= 0.7) return 'soon';
    return 'ok';
  }

  function slaLabel(t) {
    if (!isOpen(t)) return 'met';
    var left = t.slaMins - t.waitMins;
    return left <= 0 ? 'breached' : left + 'm left';
  }

  function mins(n) { return n < 60 ? n + 'm' : Math.floor(n / 60) + 'h ' + (n % 60) + 'm'; }

  function money(n) {
    return '£' + n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /* ---------- KPI row ---------- */

  function renderKpis() {
    var m = DATA.metrics;
    var open = state.tickets.filter(isOpen);
    var breaching = open.filter(function (t) { return slaState(t) !== 'ok'; }).length;

    var cards = [
      {
        label: 'Open tickets',
        value: open.length,
        delta: breaching + ' need attention',
        tone: breaching ? 'bad' : 'good'
      },
      {
        label: 'Resolved today',
        value: m.resolvedToday,
        delta: '↑ +' + (m.resolvedToday - m.resolvedYesterday) + ' vs yesterday',
        tone: 'good'
      },
      {
        label: 'Auto-resolved',
        value: m.autoResolvedPct + '%',
        delta: '↑ +' + (m.autoResolvedPct - m.autoResolvedPrevPct) + ' pts this month',
        tone: 'good'
      },
      {
        label: 'Avg handling time',
        value: m.avgHandleMins + 'm',
        delta: '↓ ' + (m.prevHandleMins - m.avgHandleMins).toFixed(1) + 'm faster',
        tone: 'good'
      },
      {
        label: 'CSAT',
        value: m.csat.toFixed(1),
        delta: '↑ from ' + m.prevCsat.toFixed(1) + ' last quarter',
        tone: 'good'
      }
    ];

    $('kpis').innerHTML = cards.map(function (c) {
      return '<div class="card kpi">' +
        '<div class="label">' + esc(c.label) + '</div>' +
        '<div class="kpi__value num">' + esc(c.value) + '</div>' +
        '<div class="kpi__delta kpi__delta--' + c.tone + '">' + esc(c.delta) + '</div>' +
        '</div>';
    }).join('');
  }

  /* ---------- intent bars ---------- */

  function renderBars() {
    var open = state.tickets.filter(isOpen);
    var counts = {};
    open.forEach(function (t) { counts[t.intent] = (counts[t.intent] || 0) + 1; });

    var rows = Object.keys(counts).map(function (k) {
      return { name: k, n: counts[k] };
    }).sort(function (a, b) { return b.n - a.n; });

    var max = rows.reduce(function (m, r) { return Math.max(m, r.n); }, 1);
    $('intent-total').textContent = open.length + ' open';

    if (!rows.length) {
      $('bars').innerHTML = '<p class="empty">Queue is clear. Nice work.</p>';
      return;
    }

    $('bars').innerHTML = rows.map(function (r) {
      var pct = Math.round((r.n / max) * 100);
      var share = Math.round((r.n / open.length) * 100);
      return '<div class="bar">' +
        '<div class="bar__name"><span>' + esc(r.name) + '</span></div>' +
        '<div class="bar__track"><div class="bar__fill" style="width:' + pct + '%"></div></div>' +
        '<div class="bar__value num">' + r.n + ' · ' + share + '%</div>' +
        '</div>';
    }).join('');
  }

  /* ---------- SLA gauge ---------- */

  function renderGauge() {
    var open = state.tickets.filter(isOpen);
    var within = open.filter(function (t) { return slaState(t) !== 'breach'; }).length;
    var pct = open.length ? Math.round((within / open.length) * 100) : 100;

    var r = 66;
    var circumference = 2 * Math.PI * r;
    var arc = $('gauge-arc');
    arc.setAttribute('stroke-dasharray', (circumference * pct / 100).toFixed(1) + ' ' + circumference.toFixed(1));
    arc.setAttribute('stroke', pct >= DATA.metrics.slaTargetPct ? 'var(--good)' : 'var(--accent)');

    $('gauge-pct').textContent = pct + '%';
    $('gauge-foot').innerHTML = '<strong>' + within + '</strong> of ' + open.length +
      ' open tickets inside target · goal ' + DATA.metrics.slaTargetPct + '%';
  }

  /* ---------- queue table ---------- */

  var FILTERS = [
    { key: 'active', text: 'Active' },
    { key: 'new', text: 'New' },
    { key: 'open', text: 'Open' },
    { key: 'pending', text: 'Pending' },
    { key: 'resolved', text: 'Resolved' },
    { key: 'all', text: 'All' }
  ];

  function renderChips() {
    $('chips').innerHTML = FILTERS.map(function (f) {
      return '<button class="chip" data-status="' + f.key + '" aria-pressed="' +
        (state.status === f.key) + '">' + esc(f.text) + '</button>';
    }).join('');
  }

  function visibleTickets() {
    var q = state.query.trim().toLowerCase();
    return state.tickets.filter(function (t) {
      var statusOk =
        state.status === 'all' ? true :
        state.status === 'active' ? isOpen(t) :
        t.status === state.status;
      if (!statusOk) return false;
      if (!q) return true;
      return (t.customer + ' ' + t.subject + ' ' + t.id + ' ' + t.intent + ' ' + t.account)
        .toLowerCase().indexOf(q) !== -1;
    }).sort(function (a, b) {
      /* Most urgent first: breaching before at-risk, then longest wait. */
      var rank = { breach: 0, soon: 1, ok: 2 };
      var d = rank[slaState(a)] - rank[slaState(b)];
      if (d) return d;
      return b.waitMins - a.waitMins;
    });
  }

  function renderRows() {
    var list = visibleTickets();
    $('queue-count').textContent = list.length + (list.length === 1 ? ' ticket' : ' tickets');
    $('empty').hidden = list.length > 0;

    $('rows').innerHTML = list.map(function (t) {
      var st = slaState(t);
      return '<tr data-id="' + t.id + '" tabindex="0" aria-selected="' + (state.selected === t.id) + '">' +
        '<td class="num">' + esc(t.id) + '</td>' +
        '<td class="cust">' + esc(t.customer) + '<small>' + esc(t.account) + '</small></td>' +
        '<td class="subject">' + esc(t.subject) + '</td>' +
        '<td><span class="pill pill--neutral"><span class="dot dot--' + t.sentiment + '"></span>' +
          esc(t.intent) + '</span></td>' +
        '<td>' + esc(t.channel) + '</td>' +
        '<td class="num">' + (isOpen(t) ? mins(t.waitMins) : '—') + '</td>' +
        '<td class="sla sla--' + st + '">' + esc(slaLabel(t)) + '</td>' +
        '<td>' + (t.assignee ? esc(t.assignee) : '<span class="pill pill--accent">Unassigned</span>') + '</td>' +
        '</tr>';
    }).join('');
  }

  /* ---------- drawer ---------- */

  var lastFocused = null;

  function openDrawer(id) {
    var t = state.tickets.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    state.selected = id;
    lastFocused = document.activeElement;

    $('drawer-id').textContent = t.id + ' · ' + t.channel;
    $('drawer-title').textContent = t.subject;
    $('drawer-pills').innerHTML =
      '<span class="pill pill--neutral"><span class="dot dot--' + t.sentiment + '"></span>' +
        esc(t.sentiment) + '</span>' +
      '<span class="pill pill--neutral">' + esc(t.intent) + '</span>' +
      '<span class="pill pill--' + (slaState(t) === 'breach' ? 'bad' : slaState(t) === 'soon' ? 'warn' : 'good') +
        '">' + esc(slaLabel(t)) + '</span>';

    var confidence = Math.round(t.aiConfidence * 100);

    $('drawer-body').innerHTML =
      '<div class="section">' +
        '<div class="facts">' +
          '<div><span class="label">Customer</span><b>' + esc(t.customer) + '</b></div>' +
          '<div><span class="label">Account</span><b>' + esc(t.account) + '</b></div>' +
          '<div><span class="label">Waiting</span><b class="num">' + (isOpen(t) ? mins(t.waitMins) : 'Resolved') + '</b></div>' +
          '<div><span class="label">Order value</span><b class="num">' + (t.value ? money(t.value) : '—') + '</b></div>' +
        '</div>' +
      '</div>' +

      '<div class="section">' +
        '<span class="label">Conversation</span>' +
        t.messages.map(function (m) {
          return '<div class="msg' + (m.agent ? ' msg--agent' : '') + '">' +
            '<div class="msg__who">' + esc(m.who) + ' · ' + esc(m.at) + '</div>' +
            '<p>' + esc(m.text) + '</p></div>';
        }).join('') +
      '</div>' +

      '<div class="section">' +
        '<span class="label">Suggested resolution</span>' +
        '<div class="suggestion">' +
          '<span class="pill pill--accent">' + confidence + '% confidence</span>' +
          '<p>' + esc(t.aiSuggestion) + '</p>' +
        '</div>' +
      '</div>' +

      '<div class="section">' +
        '<span class="label">Previous contact' + (t.history.length ? '' : ' — none') + '</span>' +
        (t.history.length
          ? '<ul class="history">' + t.history.map(function (h) {
              return '<li>' + esc(h.text) + '<span>' + esc(h.at) + '</span></li>';
            }).join('') + '</ul>'
          : '<p class="msg"><em>First time this customer has contacted us.</em></p>') +
      '</div>' +

      '<div class="actions">' +
        (isOpen(t)
          ? '<button class="primary" data-act="resolve">Send reply &amp; resolve</button>' +
            (t.assignee === ME ? '' : '<button data-act="claim">Assign to me</button>') +
            (t.status === 'pending' ? '' : '<button data-act="pending">Move to pending</button>')
          : '<button data-act="reopen">Reopen ticket</button>') +
      '</div>';

    $('drawer').classList.add('open');
    $('drawer').setAttribute('aria-hidden', 'false');
    $('scrim').classList.add('open');
    $('drawer-close').focus();
    renderRows();
  }

  function closeDrawer() {
    state.selected = null;
    $('drawer').classList.remove('open');
    $('drawer').setAttribute('aria-hidden', 'true');
    $('scrim').classList.remove('open');
    renderRows();
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  function act(kind) {
    var t = state.tickets.filter(function (x) { return x.id === state.selected; })[0];
    if (!t) return;

    if (kind === 'resolve') {
      t.status = 'resolved';
      t.waitMins = 0;
      if (!t.assignee) t.assignee = ME;
      DATA.metrics.resolvedToday += 1;
    } else if (kind === 'claim') {
      t.assignee = ME;
      if (t.status === 'new') t.status = 'open';
    } else if (kind === 'pending') {
      t.status = 'pending';
      if (!t.assignee) t.assignee = ME;
    } else if (kind === 'reopen') {
      t.status = 'open';
      t.waitMins = 1;
      DATA.metrics.resolvedToday = Math.max(0, DATA.metrics.resolvedToday - 1);
    }

    t._touched = true;
    saveOverrides();
    renderAll();

    if (kind === 'resolve') closeDrawer();
    else openDrawer(t.id);
  }

  /* ---------- wiring ---------- */

  function renderAll() {
    renderKpis();
    renderBars();
    renderGauge();
    renderChips();
    renderRows();
  }

  function init() {
    $('team-line').textContent = DATA.team;
    hydrate();
    renderAll();

    $('search').addEventListener('input', function (e) {
      state.query = e.target.value;
      renderRows();
    });

    $('chips').addEventListener('click', function (e) {
      var btn = e.target.closest('.chip');
      if (!btn) return;
      state.status = btn.dataset.status;
      renderChips();
      renderRows();
    });

    $('rows').addEventListener('click', function (e) {
      var tr = e.target.closest('tr');
      if (tr) openDrawer(tr.dataset.id);
    });

    $('rows').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var tr = e.target.closest('tr');
      if (tr) { e.preventDefault(); openDrawer(tr.dataset.id); }
    });

    $('drawer-body').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (btn) act(btn.dataset.act);
    });

    $('drawer-close').addEventListener('click', closeDrawer);
    $('scrim').addEventListener('click', closeDrawer);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.selected) closeDrawer();
    });

    $('reset').addEventListener('click', function () {
      try { localStorage.removeItem(STORE_KEY); } catch (err) { /* ignore */ }
      hydrate();
      renderAll();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
