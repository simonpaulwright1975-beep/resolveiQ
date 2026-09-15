/* Renders the landing panel from window.WG_APP.

   The whole point of the template is that an app is configured, not rebuilt —
   so everything variable is read from that one object and nothing about the
   composition is touched. */
(function () {
  'use strict';

  var APP = window.WG_APP || {};
  var $ = function (id) { return document.getElementById(id); };

  var name = APP.APP_NAME || 'this application';

  var logo = $('app-logo');
  if (logo) {
    if (APP.APP_LOGO) {
      logo.src = APP.APP_LOGO;
      /* The logo carries the app's identity, so it needs a real accessible
         name rather than being decorative. */
      logo.alt = APP.APP_STRAPLINE ? name + ' — ' + APP.APP_STRAPLINE : name;
      /* A missing logo file must not leave a broken image on the one screen
         whose job is to look premium. Fall back to the name as text. */
      logo.addEventListener('error', function () {
        var heading = document.createElement('p');
        heading.className = 'panel__fallback-name';
        heading.textContent = name;
        heading.style.cssText = 'margin:0;font-size:28px;font-weight:800;letter-spacing:-.02em;color:var(--accent)';
        logo.replaceWith(heading);
      });
    } else {
      logo.remove();
    }
  }

  /* Only shown when the supplied logo does not already contain it. */
  var strap = $('app-strapline');
  if (strap && APP.APP_STRAPLINE) {
    strap.textContent = APP.APP_STRAPLINE;
    strap.hidden = false;
  }

  var enter = $('app-enter');
  var enterText = $('app-enter-text');
  if (enterText) enterText.textContent = APP.APP_ENTRY_TEXT || ('Enter ' + name);
  if (enter && APP.APP_URL) enter.href = APP.APP_URL;

  document.title = name + ' — Walter Geering';
})();
