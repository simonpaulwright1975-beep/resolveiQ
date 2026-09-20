/* The customer's rating page.

   Everything it needs is in the URL. It never learns anything about the case
   beyond the reference, because the person holding this link should not be
   able to read a customer record with it. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(window.location.search);
  var caseId = params.get('c');
  var token = params.get('t');
  var score = null;

  function show(which, message) {
    ['fb-form', 'fb-done', 'fb-problem'].forEach(function (id) {
      var el = $(id);
      if (el) el.hidden = id !== which;
    });
    if (which === 'fb-problem' && message) $('fb-problem-text').textContent = message;
  }

  function renderButtons() {
    var wrap = $('fb-buttons');
    var labels = ['Not at all', '', '', '', 'Very happy'];
    wrap.innerHTML = '';

    for (var i = 1; i <= 5; i++) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'fb__score';
      b.textContent = String(i);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.setAttribute('aria-label', i + ' out of 5' + (labels[i - 1] ? ' — ' + labels[i - 1] : ''));
      b.dataset.score = String(i);
      wrap.appendChild(b);
    }

    var ends = document.createElement('div');
    ends.className = 'fb__ends';
    ends.innerHTML = '<span>Not at all happy</span><span>Very happy</span>';
    wrap.parentNode.appendChild(ends);

    wrap.addEventListener('click', function (e) {
      var btn = e.target.closest('.fb__score');
      if (!btn) return;
      score = Number(btn.dataset.score);
      Array.prototype.forEach.call(wrap.children, function (el) {
        el.setAttribute('aria-checked', el === btn ? 'true' : 'false');
      });
      $('fb-send').disabled = false;
      $('fb-error').hidden = true;
    });
  }

  async function send() {
    if (score == null) return;
    var btn = $('fb-send');
    btn.disabled = true;
    btn.textContent = 'Sending…';

    try {
      var res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          c: caseId, t: token, score: score, comment: $('fb-comment').value
        })
      });
      var body = await window.RESOLVEIQ_readJson(res);
      if (!res.ok) throw new Error(body.error || 'Something went wrong.');

      if (body.alreadyRated) {
        $('fb-done-text').textContent = 'You have already rated this one — thank you.';
      }
      show('fb-done');
    } catch (error) {
      /* Let them try again rather than losing what they typed. */
      $('fb-error').textContent = error.message;
      $('fb-error').hidden = false;
      btn.disabled = false;
      btn.textContent = 'Send feedback';
    }
  }

  async function init() {
    if (!caseId || !token) {
      show('fb-problem', 'The link looks incomplete.');
      return;
    }

    try {
      var res = await fetch('/api/feedback/case?c=' + encodeURIComponent(caseId) +
                            '&t=' + encodeURIComponent(token));
      var body = await window.RESOLVEIQ_readJson(res);
      if (!res.ok) throw new Error(body.error || 'This link is not valid.');

      if (body.team) $('fb-team').textContent = body.team;

      if (body.alreadyRated) {
        $('fb-done-text').textContent = 'You have already rated this one — thank you.';
        show('fb-done');
        return;
      }

      $('fb-ref').textContent = body.caseRef || '';
      renderButtons();
      show('fb-form');
      $('fb-send').addEventListener('click', send);
    } catch (error) {
      show('fb-problem', error.message);
    }
  }

  init();
})();
