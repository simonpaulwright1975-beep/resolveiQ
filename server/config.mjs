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

  sage: {
    /* Full SData base, e.g. https://crm.example.co.uk/sdata/CRMj/sagecrm2/-/
       Built from parts if SAGE_BASE_URL isn't given directly. */
    baseUrl: (process.env.SAGE_BASE_URL ||
      (process.env.SAGE_SERVER
        ? `${process.env.SAGE_SERVER.replace(/\/+$/, '')}/sdata/${process.env.SAGE_INSTALL || 'CRM'}j/sagecrm2/-/`
        : '')).replace(/\/*$/, '/'),
    user: process.env.SAGE_USER || '',
    password: process.env.SAGE_PASSWORD || '',
    /* How many cases to pull per refresh. */
    pageSize: num(process.env.SAGE_PAGE_SIZE, 50),
    /* Seconds to hold a queue response before re-querying the CRM. */
    cacheSeconds: num(process.env.SAGE_CACHE_SECONDS, 30),
    /* Reject self-signed certs unless explicitly told otherwise — many
       on-premise CRM boxes run an internal CA. */
    allowInsecureTls: process.env.SAGE_ALLOW_INSECURE_TLS === 'true'
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

export const sageConfigured = Boolean(config.sage.baseUrl && config.sage.user);
export const claudeConfigured = Boolean(config.claude.apiKey);
