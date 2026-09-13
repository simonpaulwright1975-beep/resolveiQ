/* Configuration, read once at boot from the environment.
   Nothing here is ever sent to the browser. */

import { readFileSync, existsSync } from 'node:fs';

/* Minimal .env loader so there's no dotenv dependency. Values may be quoted;
   anything after a leading # is a comment line. */
function loadDotEnv(path = '.env') {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: num(process.env.PORT, 3000),

  /* Seconds a queue response is reused before re-querying ClientiQ. */
  cacheSeconds: num(process.env.RESOLVEIQ_CACHE_SECONDS, 30),


  /* ClientiQ — the customer database. Publishable key plus a signed-in WG
     account; the service-role key is deliberately not read here, because it
     bypasses every permission check. */
  clientiq: {
    url: process.env.SUPABASE_URL || 'https://hlfhyzqkzqgyuohhmzzu.supabase.co',
    key: process.env.SUPABASE_PUBLISHABLE_KEY || '',
    email: process.env.RESOLVEIQ_SUPABASE_EMAIL || '',
    password: process.env.RESOLVEIQ_SUPABASE_PASSWORD || ''
  },

  claude: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.RESOLVEIQ_MODEL || 'claude-opus-5',
    /* low | medium | high | xhigh | max — drafting a support reply is not a
       hard reasoning problem, so medium keeps latency and cost sensible. */
    effort: process.env.RESOLVEIQ_EFFORT || 'medium',
    maxTokens: num(process.env.RESOLVEIQ_MAX_TOKENS, 4000)
  },

  /* SLA window in minutes per CRM priority value. Override as JSON, e.g.
     SLA_POLICY='{"High":15,"Medium":45,"Low":180}' */
  slaPolicy: (() => {
    const fallback = { High: 20, Medium: 60, Low: 240, Default: 60 };
    if (!process.env.SLA_POLICY) return fallback;
    try {
      return { ...fallback, ...JSON.parse(process.env.SLA_POLICY) };
    } catch {
      console.warn('SLA_POLICY is not valid JSON — using defaults');
      return fallback;
    }
  })()
};

export const clientiqConfigured = Boolean(
  config.clientiq.url && config.clientiq.key && config.clientiq.email && config.clientiq.password
);

/* Loud, because a service key in the environment means someone is about to use
   a credential this app is not supposed to hold. */
if (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    'WARNING: a Supabase service-role key is set in the environment. ResolveIQ does not use it ' +
    'and must not — it bypasses every permission check. Remove it from this app\'s .env.'
  );
}
export const claudeConfigured = Boolean(config.claude.apiKey);
