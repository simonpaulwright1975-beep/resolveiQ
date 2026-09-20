/* ResolveIQ console.
   Vanilla JS, no build step. State lives in memory; the agent's own changes
   (claim / resolve / snooze) are mirrored into localStorage so a refresh
   doesn't lose them. */

(function () {
  'use strict';

  var DATA = null;              // resolved by init() from /api/tickets
  var STORE_KEY = 'resolveiq.overrides.v1';
  var ME = 'You';

  var state = {
    status: 'active',       // active | new | open | pending | resolved | all
    query: '',
    selected: null,
    tickets: [],
    drafting: false,        // a /api/suggest call is in flight
    draftError: null,
    saving: false,          // a /api/cases call is in flight
    saveError: null,
    saveNote: null          // e.g. saved but not linked to a customer
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
    var m = DATA.metrics || {};
    var open = state.tickets.filter(isOpen);
    var breaching = open.filter(function (t) { return slaState(t) !== 'ok'; }).length;

    var has = function (v) { return v !== null && v !== undefined && !isNaN(v); };

    /* A delta needs both halves. Missing either means we say nothing rather
       than inventing a comparison. */
    var delta = function (now, before, unit, higherIsBetter) {
      if (!has(now) || !has(before)) return { text: 'no source for this yet', tone: 'muted' };
      var d = now - before;
      var better = higherIsBetter ? d >= 0 : d <= 0;
      return {
        text: (d >= 0 ? '↑ +' : '↓ ') + Math.abs(d).toFixed(unit === 'pts' ? 0 : 1) +
              (unit ? ' ' + unit : ''),
        tone: better ? 'good' : 'bad'
      };
    };

    var show = function (v, suffix, decimals) {
      return has(v) ? Number(v).toFixed(decimals || 0) + (suffix || '') : '—';
    };

    var cards = [
      {
        label: 'Open tickets',
        value: open.length,
        delta: breaching + ' need attention',
        tone: breaching ? 'bad' : 'good'
      },
      {
        label: 'Resolved today',
        value: show(m.resolvedToday),
        delta: (function (d) { return d.tone === 'muted' ? 'from open cases' : d.text + ' vs yesterday'; })(
          delta(m.resolvedToday, m.resolvedYesterday, '', true)),
        tone: delta(m.resolvedToday, m.resolvedYesterday, '', true).tone
      },
      {
        /* Not "auto-resolved": nothing resolves itself here. This is the share
           of today's resolved cases where the drafted reply was used. */
        label: 'AI-assisted',
        value: show(m.aiAssistedPct, '%'),
        delta: delta(m.aiAssistedPct, m.aiAssistedPrevPct, 'pts', true).text,
        tone: delta(m.aiAssistedPct, m.aiAssistedPrevPct, 'pts', true).tone
      },
      {
        label: 'Avg handling time',
        value: show(m.avgHandleMins, 'm', 1),
        delta: delta(m.avgHandleMins, m.prevHandleMins, 'm', false).text,
        tone: delta(m.avgHandleMins, m.prevHandleMins, 'm', false).tone
      },
      {
        label: 'CSAT',
        value: show(m.csat, '', 1),
        delta: delta(m.csat, m.prevCsat, '', true).text,
        tone: delta(m.csat, m.prevCsat, '', true).tone
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
    var target = (DATA.metrics && DATA.metrics.slaTargetPct) || 95;
    arc.setAttribute('stroke', pct >= target ? 'var(--good)' : 'var(--accent)');

    $('gauge-pct').textContent = pct + '%';
    $('gauge-foot').innerHTML = '<strong>' + within + '</strong> of ' + open.length +
      ' open tickets inside target · goal ' + target + '%';
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

  /* ---------- transient status ---------- */

  var toastTimer = null;

  /* Resolving closes the drawer, so anything said there is never read. The
     Sage CRM copy is queued rather than sent, and the advisor needs to know
     that — so it is said out here, where it survives the drawer closing. */
  function toast(message, tone) {
    if (!message) return;
    var el = $('toast');
    el.textContent = message;
    el.className = 'toast is-on' + (tone ? ' toast--' + tone : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.className = 'toast';
      setTimeout(function () { el.hidden = true; }, 200);
    }, 6000);
  }

  /* ---------- previous contact ---------- */

  /* Fetched when a case is opened rather than for the whole queue: one call per
     case the advisor actually looks at, not 40 they don't. */
  async function loadHistory(ticket) {
    if (!ticket.companyId || ticket._historyLoaded) return;
    ticket._historyLoaded = true;
    try {
      var response = await fetch('/api/history?company_id=' + encodeURIComponent(ticket.companyId));
      if (!response.ok) return;
      var body = await window.RESOLVEIQ_readJson(response);
      if (Array.isArray(body.history) && body.history.length) {
        ticket.history = body.history;
        if (state.selected === ticket.id) openDrawer(ticket.id);
      }
    } catch (e) {
      /* The panel already says "no previous contact on record"; leave it. */
    }
  }

  /* ---------- writing to the customer record ---------- */

  /* Returns { ok, warning } or { ok: false, error }. Never throws — the caller
     decides what to do about a failure, and a failure must never be silent. */
  async function saveCase(ticket, overrides) {
    var payload = {
      ticket: Object.assign({}, ticket, overrides || {}),
      agent: ME,
      resolution: ticket.aiSuggestion || null
    };

    try {
      var response = await fetch('/api/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      var body = await window.RESOLVEIQ_readJson(response).catch(function () { return {}; });
      if (!response.ok) {
        return { ok: false, error: body.error || ('Could not save — HTTP ' + response.status) };
      }
      return { ok: true, warning: body.warning || null, queuedToSage: Boolean(body.queued_to_sage) };
    } catch (error) {
      return { ok: false, error: 'Could not save to the customer record — ' + error.message };
    }
  }

  /* ---------- suggested resolution ---------- */

  function suggestionHtml(t) {
    if (state.drafting) {
      return '<div class="suggestion"><p>Reading the case and drafting a reply…</p></div>';
    }

    var error = state.draftError
      ? '<p class="draft-error">' + esc(state.draftError) + '</p>'
      : '';

    if (!t.aiSuggestion) {
      return '<div class="suggestion">' +
        '<p>No draft yet.</p>' + error +
        '<div class="actions"><button data-act="draft">Draft a reply</button></div>' +
        '</div>';
    }

    var confidence = t.aiConfidence == null ? null : Math.round(t.aiConfidence * 100);
    var steps = (t.nextSteps || []).map(function (n) {
      return '<li>' + esc(n) + '</li>';
    }).join('');

    return '<div class="suggestion">' +
      (confidence == null ? '' : '<span class="pill pill--accent">' + confidence + '% confidence</span>') +
      (t.escalate ? ' <span class="pill pill--bad">Escalate</span>' : '') +
      (t.aiSummary ? '<p><strong>' + esc(t.aiSummary) + '</strong></p>' : '') +
      '<p>' + esc(t.aiSuggestion).replace(/\n/g, '<br>') + '</p>' +
      (steps ? '<span class="label">Next steps</span><ul class="steps">' + steps + '</ul>' : '') +
      (t.escalate && t.escalationReason
        ? '<p class="draft-error">' + esc(t.escalationReason) + '</p>' : '') +
      error +
      '<div class="actions"><button data-act="draft">Redraft</button></div>' +
      '</div>';
  }

  async function draft() {
    var t = state.tickets.filter(function (x) { return x.id === state.selected; })[0];
    if (!t || state.drafting) return;

    state.drafting = true;
    state.draftError = null;
    openDrawer(t.id);

    try {
      var response = await fetch('/api/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket: t })
      });
      var body = await window.RESOLVEIQ_readJson(response);
      if (!response.ok) throw new Error(body.error || ('HTTP ' + response.status));

      t.aiSuggestion = body.reply;
      t.aiSummary = body.summary;
      t.aiConfidence = body.confidence;
      t.nextSteps = body.nextSteps;
      t.escalate = body.escalate;
      t.escalationReason = body.escalationReason;
      /* The model's read of intent and tone beats the keyword guess. */
      if (body.intent) t.intent = body.intent;
      if (body.sentiment) t.sentiment = body.sentiment;
    } catch (error) {
      state.draftError = error.message;
    } finally {
      state.drafting = false;
      renderAll();
      openDrawer(t.id);
    }
  }

  /* ---------- drawer ---------- */

  var lastFocused = null;

  /* Fetched per case rather than for the whole queue: minting a link is
     signing work, and only the open case needs one. */
  async function loadFeedbackLink(t) {
    if (!t.caseId || t._feedbackLoaded) return;
    /* openDrawer re-renders by calling itself, so without this the loader
       would fetch, re-render, fetch again, for ever. */
    t._feedbackLoaded = true;
    state.feedbackUrl = null;
    state.feedbackError = null;

    try {
      var res = await fetch('/api/feedback/link?case_id=' + encodeURIComponent(t.caseId));
      var body = await window.RESOLVEIQ_readJson(res);
      if (!res.ok) throw new Error(body.error || 'Could not build a feedback link.');
      state.feedbackUrl = body.url;
    } catch (error) {
      state.feedbackError = error.message;
    }
    if (state.selected === t.id) openDrawer(t.id);
  }

  /* Copy, with a fallback: the clipboard API needs a secure context, and this
     app may well be served over plain http on an internal box. Selecting the
     text is a worse experience than a silent failure is a bug. */
  async function copyFeedbackLink() {
    var input = $('fb-url');
    if (!input || !state.feedbackUrl) return;
    try {
      await navigator.clipboard.writeText(state.feedbackUrl);
      toast('Feedback link copied — paste it at the end of your reply.');
    } catch (e) {
      input.focus();
      input.select();
      toast('Press Ctrl+C to copy the link.');
    }
  }

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
        suggestionHtml(t) +
      '</div>' +

      '<div class="section">' +
        '<span class="label">Previous contact' + (t.history.length ? '' : ' — none') + '</span>' +
        (t.history.length
          ? '<ul class="history">' + t.history.map(function (h) {
              return '<li>' + esc(h.text) + '<span>' + esc(h.at) + '</span></li>';
            }).join('') + '</ul>'
          : '<p class="msg"><em>First time this customer has contacted us.</em></p>') +
      '</div>' +

      (state.saveError
        ? '<p class="draft-error">' + esc(state.saveError) + '</p>' +
          '<p class="draft-error">The case has NOT been resolved. Try again, or tell whoever runs the app.</p>'
        : '') +
      (state.saveNote ? '<p class="save-note">' + esc(state.saveNote) + '</p>' : '') +

      /* The CSAT link. ResolveIQ cannot email the customer, so the way a score
         gets asked for is Cerian pasting this into the reply she is already
         sending. Rendered only for a case the database knows about — a link
         for a case that does not exist yet would 404 for the customer. */
      (t.caseId
        ? '<div class="section feedback-link">' +
            '<span class="label">Ask for a rating</span>' +
            '<p class="feedback-link__hint">Paste this at the end of your reply. ' +
            'One tap, scores 1 to 5, and it lands on this case.</p>' +
            '<div class="feedback-link__row">' +
              '<input class="feedback-link__url" id="fb-url" readonly value="' +
                esc(state.feedbackUrl || 'Loading…') + '">' +
              '<button data-act="copy-feedback"' +
                (state.feedbackUrl ? '' : ' disabled') + '>Copy</button>' +
            '</div>' +
            (state.feedbackError
              ? '<p class="feedback-link__off">' + esc(state.feedbackError) + '</p>' : '') +
          '</div>'
        : '') +

      '<div class="actions actions--case">' +
        (state.saving
          ? '<button class="primary" disabled>Saving to the customer record…</button>'
          : isOpen(t)
          ? '<button class="primary" data-act="resolve">Send reply &amp; resolve</button>' +
            (t.assignee === ME ? '' : '<button data-act="claim">Assign to me</button>') +
            (t.status === 'pending' ? '' : '<button data-act="pending">Move to pending</button>')
          : '<button data-act="reopen">Reopen ticket</button>') +
      '</div>';

    loadHistory(t);
    loadFeedbackLink(t);

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

  async function act(kind) {
    var t = state.tickets.filter(function (x) { return x.id === state.selected; })[0];
    if (!t || state.saving) return;

    if (kind === 'resolve') {
      /* Write to the customer record FIRST. If it doesn't save there, the
         case is not resolved — showing it as done when nothing was recorded
         is the one failure this app exists to prevent. */
      state.saving = true;
      state.saveError = null;
      state.saveNote = null;
      openDrawer(t.id);

      var outcome = await saveCase(t, { status: 'resolved' });
      state.saving = false;

      if (!outcome.ok) {
        state.saveError = outcome.error;
        openDrawer(t.id);
        return;
      }

      state.saveNote = outcome.warning || null;
      toast(
        outcome.warning ||
          (outcome.queuedToSage
            ? 'Saved. The Sage CRM copy is queued and lands within about five minutes.'
            : 'Saved to the customer record.'),
        outcome.warning ? 'warn' : null
      );
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

  function renderSource() {
    var source = DATA.source || 'sample';
    var text = source === 'clientiq' ? 'CLIENTIQ · LIVE'
      : source === 'clientiq-stale' ? 'CLIENTIQ · STALE'
      : 'SAMPLE DATA';
    $('source-text').textContent = text;
    $('source-badge').querySelector('.live__dot').style.background =
      source === 'clientiq' ? 'var(--good)' : source === 'clientiq-stale' ? 'var(--warn)' : 'var(--muted)';

    $('footnote').textContent = DATA.reason
      ? DATA.reason
      : 'Live from ClientiQ. Resolving a case also queues a Sage CRM note, applied within about five minutes.';
  }

  /* The SLA windows are read from the server rather than written into the
     guide, so changing SLA_POLICY cannot leave the explanation describing
     windows the app no longer uses. */
  function renderSlaWindows() {
    var list = $('sla-windows');
    if (!list) return;
    var policy = (DATA.metrics && DATA.metrics.slaPolicy) || {};
    var order = ['High', 'Medium', 'Low'];
    var entries = order
      .filter(function (k) { return typeof policy[k] === 'number'; })
      .map(function (k) { return { name: k, mins: policy[k] }; });

    if (!entries.length) {
      list.innerHTML = '<li>Windows are set on the server.</li>';
      return;
    }

    list.innerHTML = entries.map(function (e) {
      var label = e.mins >= 60 && e.mins % 60 === 0
        ? (e.mins / 60) + (e.mins === 60 ? ' hour' : ' hours')
        : e.mins + ' minutes';
      return '<li>' + esc(e.name) + ' \u2014 ' + esc(label) + '</li>';
    }).join('');
  }

  /* Tabs. The queue stays in the DOM when hidden so the tour, which anchors to
     elements inside it, is unaffected by which tab is showing. */
  function showTab(which) {
    var pairs = [['tab-queue', 'view-queue'], ['tab-kpis', 'view-kpis']];
    pairs.forEach(function (pair) {
      var on = pair[0] === which;
      var tab = $(pair[0]);
      var view = $(pair[1]);
      if (tab) tab.setAttribute('aria-selected', on ? 'true' : 'false');
      if (view) view.hidden = !on;
    });
  }

  function renderAll() {
    renderKpis();
    renderBars();
    renderGauge();
    renderChips();
    renderRows();
    renderSlaWindows();
  }

  async function init() {
    DATA = await window.RESOLVEIQ_LOAD();
    ME = DATA.currentAgent || 'You';
    /* The team strapline was replaced by the logo, which says it already.
       Kept tolerant so a missing element can never break the render. */
    var teamLine = $('team-line');
    if (teamLine) teamLine.textContent = DATA.team || 'Customer Care';
    renderSource();
    hydrate();
    renderAll();

    document.querySelector('.tabs').addEventListener('click', function (e) {
      var tab = e.target.closest('.tab');
      if (tab) showTab(tab.id);
    });

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
      if (!btn) return;
      if (btn.dataset.act === 'draft') draft();
      else if (btn.dataset.act === 'copy-feedback') copyFeedbackLink();
      else act(btn.dataset.act);
    });

    $('drawer-close').addEventListener('click', closeDrawer);
    $('scrim').addEventListener('click', closeDrawer);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.selected) closeDrawer();
    });

    /* The tour drives the app through these rather than faking clicks. */
    window.RESOLVEIQ_APP = {
      openFirstTicket: function () {
        if (state.selected) return;
        var first = visibleTickets()[0];
        if (first) openDrawer(first.id);
      },
      closeDrawer: function () { if (state.selected) closeDrawer(); },

      /* Called after a case is raised: pull the queue again and open the new
         case, so the agent lands on the thing they just created. */
      reload: async function (caseRef) {
        DATA = await window.RESOLVEIQ_LOAD();
        hydrate();
        renderSource();
        renderAll();
        toast(caseRef ? 'Case ' + caseRef + ' raised.' : 'Case raised.');
        if (caseRef && state.tickets.some(function (t) { return t.id === caseRef; })) {
          openDrawer(caseRef);
        }
      }
    };

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
