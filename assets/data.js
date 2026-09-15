/* Queue loader.

   Tries the server first (/api/tickets, which reads Sage CRM), and falls back
   to the bundled sample so the page still works when opened straight from
   disk with no server running. */

window.RESOLVEIQ_LOAD = async function loadQueue() {
  try {
    const response = await fetch('/api/tickets', { headers: { Accept: 'application/json' } });
    const data = await window.RESOLVEIQ_readJson(response);
    if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status);
    if (!Array.isArray(data.tickets)) throw new Error('unexpected payload');
    return data;
  } catch (error) {
    /* Falling back is right — the page should still render. But say which
       fallback this is. "No server" and "something else answered /api" look
       identical on screen and are fixed in completely different places. */
    console.warn('Queue API unavailable, using sample data:', error.message);
    const servedByStatic = /web page instead of data/.test(error.message);
    return Object.assign({}, window.RESOLVEIQ_DATA, {
      source: 'sample',
      reason: servedByStatic
        ? 'Sample data — /api is being answered by a static host, not ResolveIQ\u2019s ' +
          'server. Nothing here is live: run the server (npm start) to see the real queue.'
        : 'Sample data — start the server and connect ClientiQ to show your live queue.'
    });
  }
};
