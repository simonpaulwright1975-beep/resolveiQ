/* The "How it works" tour.

   Cards are trimmed from docs/how-to-tour-brief.md — that file is the source,
   this is the short version. When the journey changes, change the brief first.

   Deliberately not launched on every visit: it lives behind the "How it works"
   button, with a one-time nudge for someone who has never opened the app. */

(function () {
  'use strict';

  var SEEN_KEY = 'resolveiq.tour.seen.v1';

  /* Each step: where it points, what to do, why it matters, and any setup
     needed to get the app into the state the card describes. */
  var STEPS = [
    {
      hero: true,
      title: 'Finish the case here — every case, every time',
      why: 'It is the only thing that puts the customer’s story on their record. ' +
           'Reply from your inbox and, as far as the business is concerned, the ' +
           'conversation never happened.',
      anchor: null
    },
    {
      title: 'Check you’re looking at live work',
      do: 'Look at the badge up here. It should say CLIENTIQ · LIVE.',
      why: 'SAMPLE DATA means you’re in the demo queue and nothing you do is real. ' +
           'Tell whoever set the app up.',
      anchor: '#source-badge'
    },
    {
      title: 'Take the case at the top — don’t pick',
      do: 'Start with the first row and work down.',
      why: 'The list is already sorted by what matters: breached first, then about ' +
           'to breach, then longest waiting. Picking the easy ones is how the ones ' +
           'that were nearly late become late.',
      anchor: '#rows tr'
    },
    {
      title: 'Open the case',
      do: 'Click anywhere on the row. Escape closes it again.',
      why: 'Everything about that customer is in one place — you shouldn’t need ' +
           'another system to answer them.',
      anchor: '.drawer__head',
      setup: function () { app().openFirstTicket(); }
    },
    {
      title: 'Read their history before you reply',
      do: 'Look at Previous contact in the panel.',
      why: 'If they have been in touch before, saying so changes the whole ' +
           'conversation. Customers should never have to repeat themselves.',
      anchor: '.history',
      setup: function () { app().openFirstTicket(); }
    },
    {
      title: 'Ask for a draft',
      do: 'Click Draft a reply. It takes a few seconds.',
      why: 'It reads the case and writes a reply you can send, plus what to do in ' +
           'the CRM, so you start from something rather than a blank box.',
      anchor: '.suggestion',
      setup: function () { app().openFirstTicket(); }
    },
    {
      title: 'Check the draft — it is a draft',
      do: 'Read the confidence figure, look for an Escalate flag, and change ' +
          'anything that isn’t right.',
      why: 'It can be wrong, and it is told never to invent an order number, a ' +
           'refund amount or a policy. You are accountable for what goes out, not ' +
           'the app. A low confidence figure is it telling you it isn’t sure.',
      anchor: '.suggestion',
      setup: function () { app().openFirstTicket(); }
    },
    {
      title: 'Escalate when it says to',
      do: 'If the draft is flagged Escalate, pass it to a manager rather than ' +
          'answering it yourself.',
      why: 'It flags things needing authority you may not have — refunds beyond ' +
           'routine goodwill, anything legal or data protection, anything about safety.',
      anchor: '.suggestion',
      setup: function () { app().openFirstTicket(); }
    },
    {
      keystone: true,
      title: 'Finish the case here',
      do: 'Send your reply with Send reply & resolve, or Move to pending if ' +
          'you’re waiting on the customer. Never just close the tab.',
      why: 'This is the step the whole app depends on. It writes the case to the ' +
           'customer’s record, where the next person to speak to them will see ' +
           'it. If it can’t save, it will tell you and leave the case open — ' +
           'so a case marked done really is recorded.',
      /* Not '.actions' — the suggested-resolution block has one of those too,
         and it matched first, pointing the most important card at the wrong
         button. */
      anchor: '.actions--case',
      setup: function () { app().openFirstTicket(); }
    },
    {
      title: 'Where your work shows up',
      do: 'Watch the tiles along the top and the dial after you resolve something.',
      why: 'The dial is the number the department is judged on: the share of open ' +
           'cases still inside their time window.',
      anchor: '#kpis',
      setup: function () { app().closeDrawer(); }
    },
    {
      title: 'What happens by itself',
      do: 'Nothing — this is the automatic part.',
      why: 'The queue pulls cases in on its own and sorts them by urgency. Nothing ' +
           'is ever sent to a customer automatically: drafts are only written when ' +
           'you ask, and only go out when you send them.',
      anchor: null
    }
  ];

  function app() {
    return window.RESOLVEIQ_APP || { openFirstTicket: function () {}, closeDrawer: function () {} };
  }

  var index = 0;
  var veil, spot, card, previouslyFocused;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function remember() {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* fine */ }
  }

  function hasSeen() {
    try { return localStorage.getItem(SEEN_KEY) === '1'; } catch (e) { return true; }
  }

  function build() {
    veil = document.createElement('div');
    veil.className = 'tour-veil';

    spot = document.createElement('div');
    spot.className = 'tour-spot';

    card = document.createElement('div');
    card.className = 'tour-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'tour-title');
    card.tabIndex = -1;

    document.body.appendChild(veil);
    document.body.appendChild(spot);
    document.body.appendChild(card);

    card.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-tour]');
      if (!btn) return;
      var action = btn.dataset.tour;
      if (action === 'next') go(index + 1);
      else if (action === 'back') go(index - 1);
      else finish();
    });

    veil.addEventListener('click', finish);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
  }

  function onKey(e) {
    if (!card) return;
    if (e.key === 'Escape') { e.preventDefault(); finish(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(index + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(index - 1); }
  }

  function render() {
    var step = STEPS[index];
    var last = index === STEPS.length - 1;

    card.innerHTML =
      '<div class="tour-card__head">' +
        '<span class="tour-step">Step ' + (index + 1) + ' of ' + STEPS.length + '</span>' +
        '<button class="tour-skip" data-tour="skip">' + (last ? 'Close' : 'Skip') + '</button>' +
      '</div>' +
      (step.keystone || step.hero ? '<span class="tour-flag">The one that matters</span>' : '') +
      '<h2 class="tour-title" id="tour-title">' + esc(step.title) + '</h2>' +
      (step.do ? '<p class="tour-do"><strong>Do</strong> ' + esc(step.do) + '</p>' : '') +
      '<p class="tour-why">' + esc(step.why) + '</p>' +
      '<div class="tour-nav">' +
        '<div class="tour-dots">' +
          STEPS.map(function (_, i) {
            return '<span class="tour-dot' + (i === index ? ' is-on' : '') + '"></span>';
          }).join('') +
        '</div>' +
        (index > 0 ? '<button data-tour="back">Back</button>' : '') +
        '<button class="primary" data-tour="' + (last ? 'skip' : 'next') + '">' +
          (last ? 'Got it' : 'Next') +
        '</button>' +
      '</div>';
  }

  function reposition() {
    if (!card) return;
    var step = STEPS[index];
    var target = step.anchor ? document.querySelector(step.anchor) : null;

    if (!target) {
      veil.classList.remove('is-clear');
      spot.style.opacity = '0';
      card.style.top = '50%';
      card.style.left = '50%';
      card.style.transform = 'translate(-50%, -50%)';
      return;
    }

    var r = target.getBoundingClientRect();
    veil.classList.add('is-clear');
    spot.style.opacity = '1';
    spot.style.top = (r.top - 6) + 'px';
    spot.style.left = (r.left - 6) + 'px';
    spot.style.width = (r.width + 12) + 'px';
    spot.style.height = (r.height + 12) + 'px';

    card.style.transform = 'none';
    var cw = card.offsetWidth;
    var ch = card.offsetHeight;
    var gap = 16;

    /* Prefer below the target; flip above when there isn't room. */
    var top = r.bottom + gap;
    if (top + ch > window.innerHeight - 12) top = r.top - ch - gap;
    if (top < 12) top = Math.min(window.innerHeight - ch - 12, Math.max(12, r.bottom + gap));

    /* Prefer left-aligned; keep it on screen. */
    var left = r.left;
    if (left + cw > window.innerWidth - 12) left = window.innerWidth - cw - 12;
    if (left < 12) left = 12;

    card.style.top = Math.round(top) + 'px';
    card.style.left = Math.round(left) + 'px';
  }

  function go(next) {
    if (next < 0 || next >= STEPS.length) return;
    index = next;
    var step = STEPS[index];

    if (step.setup) {
      try { step.setup(); } catch (e) { /* a missing element must not stop the tour */ }
    }

    render();

    /* Let the app finish any DOM work the setup triggered before measuring. */
    requestAnimationFrame(function () {
      var target = step.anchor ? document.querySelector(step.anchor) : null;
      if (target && target.scrollIntoView) {
        target.scrollIntoView({ block: 'center', behavior: motionOk() ? 'smooth' : 'auto' });
      }
      requestAnimationFrame(reposition);
    });

    card.focus();
  }

  function motionOk() {
    return !window.matchMedia || !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function start() {
    if (card) return;
    previouslyFocused = document.activeElement;
    remember();
    dismissNudge();
    build();
    document.body.classList.add('tour-open');
    go(0);
  }

  function finish() {
    if (!card) return;
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
    [veil, spot, card].forEach(function (el) { if (el && el.parentNode) el.parentNode.removeChild(el); });
    veil = spot = card = null;
    document.body.classList.remove('tour-open');
    app().closeDrawer();
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
  }

  /* ---------- the one-time nudge ---------- */

  var nudge = null;

  function dismissNudge() {
    if (nudge && nudge.parentNode) nudge.parentNode.removeChild(nudge);
    nudge = null;
  }

  function showNudge() {
    var anchor = document.getElementById('how-it-works');
    if (!anchor) return;

    nudge = document.createElement('div');
    nudge.className = 'tour-nudge';
    /* Leads with the keystone — it is the behaviour the rollout depends on. */
    nudge.innerHTML =
      '<strong>New here?</strong> The one habit that matters: finish every case in ' +
      'ResolveIQ, not your inbox. ' +
      '<button class="tour-nudge__go">Show me how</button>' +
      '<button class="tour-nudge__x" aria-label="Dismiss">&times;</button>';

    document.body.appendChild(nudge);

    var r = anchor.getBoundingClientRect();
    nudge.style.top = (r.bottom + 10) + 'px';
    nudge.style.right = Math.max(12, window.innerWidth - r.right) + 'px';

    nudge.querySelector('.tour-nudge__go').addEventListener('click', start);
    nudge.querySelector('.tour-nudge__x').addEventListener('click', function () {
      remember();
      dismissNudge();
    });
  }

  window.RESOLVEIQ_TOUR = { start: start, hasSeen: hasSeen };

  document.addEventListener('DOMContentLoaded', function () {
    var button = document.getElementById('how-it-works');
    if (button) button.addEventListener('click', start);
    /* Never auto-launch. First-time visitors get a nudge they can ignore. */
    if (!hasSeen()) setTimeout(showNudge, 900);
  });
})();
