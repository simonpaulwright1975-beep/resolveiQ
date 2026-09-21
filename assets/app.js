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
    saveNote: null,         // e.g. saved but not linked to a customer

    /* Cost of failure. cofEditing reopens the form on a case that already has
       a decision, so a figure can be corrected later without reopening the
       case itself. */
    cofEditing: false,
    cofSaving: false,
    cofError: null,
    cofDraft: { status: null, amount: '', reason: '', note: '' },
    cofReportLoading: false,

    feedbackUrl: null,
    feedbackError: null
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

  /* ---------- the cost of failure report ---------- */

  function gbp(n, pence) {
    var v = Number(n) || 0;
    return '\u00A3' + v.toLocaleString('en-GB', {
      minimumFractionDigits: pence ? 2 : 0,
      maximumFractionDigits: pence ? 2 : 0
    });
  }

  /* Formatted in London, not in whatever zone the browser or server happens to
     be in. The instant is London midnight on the 1st, which through BST is
     23:00 UTC on the LAST day of the previous month — so formatting it in UTC
     labels the whole of summer with the wrong month. */
  function monthName(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('en-GB', {
      timeZone: 'Europe/London', month: 'long', year: 'numeric'
    });
  }

  async function loadCofReport() {
    var target = $('cof-report');
    if (!target || state.cofReportLoading) return;
    state.cofReportLoading = true;
    target.innerHTML = '<p class="empty">Working out what failure cost…</p>';

    try {
      var res = await fetch('/api/cof');
      var body = await window.RESOLVEIQ_readJson(res);
      if (!res.ok) throw new Error(body.error || 'Could not build the report.');
      renderCofReport(body);
    } catch (error) {
      target.innerHTML = '<p class="empty">' + esc(error.message) + '</p>';
    } finally {
      state.cofReportLoading = false;
    }
  }

  function renderCofReport(r) {
    var target = $('cof-report');
    var period = $('cof-period');

    if (!r.configured) {
      if (period) period.textContent = '';
      target.innerHTML = '<p class="empty">' + esc(r.reason || 'Nothing to report yet.') + '</p>';
      return;
    }

    var now = r.thisMonth;
    var prev = r.lastMonth;
    if (period) period.textContent = monthName(now.from);

    /* Nothing closed at all reads differently from "closed plenty, none of it
       cost anything" — the second is good news and should say so. */
    if (!now.closedCount) {
      target.innerHTML = '<p class="empty">No cases closed yet this month, so there is nothing to cost.</p>';
      return;
    }

    var delta = '';
    if (prev.closedCount) {
      var diff = now.total - prev.total;
      delta = diff === 0
        ? 'level with ' + monthName(prev.from)
        : (diff > 0 ? '+' : '\u2212') + gbp(Math.abs(diff)) + ' vs ' + monthName(prev.from);
    }

    /* Stat tiles, not a chart: these are single headline figures. */
    var tiles = [
      { label: 'Cost this month', value: gbp(now.total), foot: delta },
      { label: 'Cases that cost us', value: String(now.costedCount),
        foot: now.costedPct + '% of ' + now.closedCount + ' closed' },
      { label: 'Average when it does', value: now.averageCost == null ? '\u2014' : gbp(now.averageCost, true),
        foot: now.costedCount ? 'across ' + now.costedCount + ' case' + (now.costedCount === 1 ? '' : 's') : '' }
    ];

    var html = '<div class="cof-tiles">' + tiles.map(function (t) {
      return '<div class="cof-tile">' +
        '<div class="label">' + esc(t.label) + '</div>' +
        '<div class="cof-tile__value num">' + esc(t.value) + '</div>' +
        '<div class="cof-tile__foot">' + esc(t.foot || '') + '</div>' +
      '</div>';
    }).join('') + '</div>';

    if (!now.costedCount) {
      html += '<p class="cof-none">Nothing has cost the business anything this month. ' +
        'All ' + now.closedCount + ' closed case' + (now.closedCount === 1 ? '' : 's') +
        ' were recorded as no cost.</p>';
      target.innerHTML = html;
      return;
    }

    /* One measure across categories, sorted by size: a ranked bar list, single
       hue. Colouring each reason differently would imply a meaning the data
       does not have. Every row carries its own figure, so the bar is a shape
       aid rather than the only way to read it. */
    var top = now.reasons[0].total || 1;
    html += '<div class="section"><span class="label">Where it went</span>' +
      '<div class="bars">' + now.reasons.map(function (x) {
        var share = Math.round((x.total / now.total) * 100);
        return '<div class="bar" title="' + esc(x.reason) + ' \u2014 ' +
            esc(gbp(x.total, true)) + ' across ' + x.count + ' case' +
            (x.count === 1 ? '' : 's') + ', ' + share + '% of the month">' +
          '<div class="bar__name"><span>' + esc(x.reason) + '</span></div>' +
          '<div class="bar__track"><div class="bar__fill" style="width:' +
            Math.max(2, Math.round((x.total / top) * 100)) + '%"></div></div>' +
          '<div class="bar__value">' + esc(gbp(x.total)) + ' \u00B7 ' + x.count + '</div>' +
        '</div>';
      }).join('') + '</div></div>';

    target.innerHTML = html;
  }

  /* ---------- cost of failure ---------- */

  function cofOf(t) { return t.cof || {}; }
  function cofDecided(t) { return cofOf(t).status === 'none' || cofOf(t).status === 'cost'; }

  function cofReasons() {
    var list = (DATA.metrics && DATA.metrics.cofReasons) || [];
    return Array.isArray(list) && list.length ? list : ['Other'];
  }

  function cofBody(t) {
    var c = cofOf(t);

    /* Settled: show what was recorded, with a way back in. Editing later is
       the normal case, not an exception — the credit note often lands days
       after the call. */
    if (cofDecided(t) && !state.cofEditing) {
      var summary = c.status === 'none'
        ? '<b>No cost</b> — this case did not cost the business anything.'
        : '<b>' + esc(cofMoney(c.amount)) + '</b> · ' + esc(c.reason || '');
      return '<p class="cof__settled">' + summary + '</p>' +
        (c.note ? '<p class="cof__note">' + esc(c.note) + '</p>' : '') +
        (c.recordedBy
          ? '<p class="cof__by">Recorded by ' + esc(c.recordedBy) + '</p>' : '') +
        '<button data-act="cof-edit">Change this</button>';
    }

    var status = state.cofDraft.status;
    var reasons = cofReasons();

    return '<p class="cof__hint">Did this case cost the business money?</p>' +
      '<div class="cof__choice">' +
        '<button data-act="cof-pick-none" class="cof__opt' +
          (status === 'none' ? ' cof__opt--on' : '') + '">No cost</button>' +
        '<button data-act="cof-pick-cost" class="cof__opt' +
          (status === 'cost' ? ' cof__opt--on' : '') + '">It cost us</button>' +
      '</div>' +

      (status === 'cost'
        ? '<div class="cof__fields">' +
            '<label class="cof__field"><span class="label">Amount</span>' +
              '<input id="cof-amount" type="number" min="0.01" step="0.01" inputmode="decimal" ' +
                'placeholder="0.00" value="' + esc(state.cofDraft.amount || '') + '"></label>' +
            '<label class="cof__field"><span class="label">Reason</span>' +
              '<select id="cof-reason">' +
                '<option value="">Choose a reason…</option>' +
                reasons.map(function (r) {
                  return '<option' + (state.cofDraft.reason === r ? ' selected' : '') +
                    '>' + esc(r) + '</option>';
                }).join('') +
              '</select></label>' +
          '</div>'
        : '') +

      (status
        ? '<label class="cof__field cof__field--wide"><span class="label">Note' +
            '<em> — optional</em></span>' +
            '<input id="cof-note" placeholder="Anything worth knowing later" value="' +
              esc(state.cofDraft.note || '') + '"></label>'
        : '') +

      (state.cofError ? '<p class="cof__error">' + esc(state.cofError) + '</p>' : '') +

      (status
        ? '<div class="cof__actions">' +
            '<button class="primary" data-act="cof-save"' +
              (state.cofSaving ? ' disabled' : '') + '>' +
              (state.cofSaving ? 'Saving…' : 'Save') + '</button>' +
            (cofDecided(t) ? '<button data-act="cof-cancel">Cancel</button>' : '') +
          '</div>'
        : '');
  }

  function cofMoney(n) {
    var v = Number(n);
    return '\u00A3' + (Number.isFinite(v) ? v.toFixed(2) : '0.00');
  }

  /* Read the fields before any re-render: rendering replaces the inputs, so
     reading them afterwards gets the defaults back. */
  function readCofFields() {
    var amount = $('cof-amount');
    var reason = $('cof-reason');
    var note = $('cof-note');
    if (amount) state.cofDraft.amount = amount.value.trim();
    if (reason) state.cofDraft.reason = reason.value;
    if (note) state.cofDraft.note = note.value.trim();
  }

  async function saveCof(t) {
    readCofFields();
    var d = state.cofDraft;
    state.cofError = null;

    if (d.status === 'cost') {
      var amount = Number(d.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        state.cofError = 'Enter what it cost, as a number greater than zero.';
        return openDrawer(t.id);
      }
      if (!d.reason) {
        state.cofError = 'Pick a reason — the figure is not much use without one.';
        return openDrawer(t.id);
      }
    }

    state.cofSaving = true;
    openDrawer(t.id);

    try {
      var res = await fetch('/api/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticket: t,
          agent: ME,
          cof: d.status === 'none'
            ? { status: 'none', note: d.note || null }
            : { status: 'cost', amount: Number(d.amount), reason: d.reason, note: d.note || null }
        })
      });
      var body = await window.RESOLVEIQ_readJson(res);
      if (!res.ok) throw new Error(body.error || 'Could not save the cost of failure.');

      t.cof = {
        status: d.status,
        amount: d.status === 'cost' ? Number(d.amount) : null,
        reason: d.status === 'cost' ? d.reason : null,
        note: d.note || null,
        recordedBy: ME
      };
      state.cofEditing = false;
      state.cofDraft = { status: null, amount: '', reason: '', note: '' };
      toast(d.status === 'none' ? 'Recorded as no cost.' : 'Cost of failure saved.');
    } catch (error) {
      state.cofError = error.message;
    } finally {
      state.cofSaving = false;
      openDrawer(t.id);
    }
  }

  function openDrawer(id) {
    var t = state.tickets.filter(function (x) { return x.id === id; })[0];
    if (!t) return;

    /* openDrawer doubles as the drawer's re-render, so only clear the
       cost-of-failure form when the case actually changes — resetting it on
       every re-render would wipe what she is part-way through typing. */
    if (state.selected !== id) {
      state.cofEditing = false;
      state.cofSaving = false;
      state.cofError = null;
      state.cofDraft = { status: null, amount: '', reason: '', note: '' };
    }

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

      /* Cost of failure. Shown on every case, open or closed: a decision can
         be made at the time or revisited later when the credit note lands. */
      '<div class="section cof' + (cofDecided(t) ? '' : ' cof--undecided') + '">' +
        '<span class="label">Cost of failure' +
          (cofDecided(t) ? '' : ' — needed before closing') + '</span>' +
        cofBody(t) +
      '</div>' +

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
          ? (cofDecided(t)
              ? '<button class="primary" data-act="resolve">Send reply &amp; resolve</button>'
              : '<button class="primary" disabled title="Record the cost of failure first">' +
                'Send reply &amp; resolve</button>') +
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
    var pairs = [['tab-queue', 'view-queue'], ['tab-cof', 'view-cof'], ['tab-kpis', 'view-kpis']];
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
      if (!tab) return;
      showTab(tab.id);
      /* Fetched when the tab is opened rather than on every queue refresh —
         it is a report, not a live figure, and it reads months of cases. */
      if (tab.id === 'tab-cof') loadCofReport();
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
      var a = btn.dataset.act;
      var t = state.selected && state.tickets.find(function (x) { return x.id === state.selected; });

      if (a === 'draft') draft();
      else if (a === 'copy-feedback') copyFeedbackLink();
      else if (a === 'cof-pick-none' || a === 'cof-pick-cost') {
        readCofFields();
        state.cofDraft.status = a === 'cof-pick-none' ? 'none' : 'cost';
        state.cofError = null;
        if (t) openDrawer(t.id);
      }
      else if (a === 'cof-edit') {
        var c = (t && t.cof) || {};
        state.cofEditing = true;
        state.cofError = null;
        state.cofDraft = {
          status: c.status || null,
          amount: c.amount == null ? '' : String(c.amount),
          reason: c.reason || '',
          note: c.note || ''
        };
        if (t) openDrawer(t.id);
      }
      else if (a === 'cof-cancel') {
        state.cofEditing = false;
        state.cofError = null;
        state.cofDraft = { status: null, amount: '', reason: '', note: '' };
        if (t) openDrawer(t.id);
      }
      else if (a === 'cof-save') { if (t) saveCof(t); }
      else act(a);
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
