/* Queue loader.

   Tries the server first (/api/tickets, which reads Sage CRM), and falls back
   to the bundled sample so the page still works when opened straight from
   disk with no server running. */

window.RESOLVEIQ_LOAD = async function loadQueue() {
  try {
    const response = await fetch('/api/tickets', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    if (!Array.isArray(data.tickets)) throw new Error('unexpected payload');
    return data;
  } catch (error) {
    console.warn('Queue API unavailable, using sample data:', error.message);
    return Object.assign({}, window.RESOLVEIQ_DATA, {
      source: 'sample',
      reason: 'Sample data — start the server and connect Sage CRM to show your live queue.'
    });
  }
};
