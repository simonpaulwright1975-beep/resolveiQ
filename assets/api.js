/* Reading a JSON response, with a useful message when it isn't JSON.

   ResolveIQ's browser code talks only to its own Node server. If something
   else answers — a static host serving index.html for every path, a proxy
   login page, a tunnel error — the body is HTML, and response.json() fails
   with "Unexpected token '<'", which tells an advisor nothing and sends
   whoever is supporting her looking at the wrong layer.

   Loaded as a plain script so both app.js and the new-case module can use it. */
(function () {
  'use strict';

  function looksLikeHtml(text) {
    return /^\s*(<!doctype|<html|<head|<body|<\?xml)/i.test(text || '');
  }

  /* Reads the body once, parses it, and throws something diagnosable if it is
     not JSON. Returns the parsed object; the caller still checks response.ok. */
  async function readJson(response) {
    var text = await response.text();

    if (!text) {
      if (response.ok) return {};
      throw new Error('The server returned an empty response (' + response.status + ').');
    }

    try {
      return JSON.parse(text);
    } catch (parseError) {
      var type = response.headers.get('content-type') || 'none';

      if (looksLikeHtml(text)) {
        throw new Error(
          'The server returned a web page instead of data. ResolveIQ’s ' +
          'server is not answering /api — check it is running (npm start) ' +
          'and that you are not viewing a static copy of the page.'
        );
      }

      throw new Error(
        'The server returned something that is not JSON (' + response.status +
        ', content-type: ' + type + ').'
      );
    }
  }

  window.RESOLVEIQ_readJson = readJson;
})();
