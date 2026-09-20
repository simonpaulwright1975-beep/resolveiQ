/* CSAT — signed feedback links.

   ResolveIQ sends no email, so it cannot send a survey. What it can do is mint
   a link that Cerian pastes into the reply she is already sending from the
   customer service mailbox. The customer clicks it, scores the case, and the
   score lands on resolveiq_cases.satisfaction_score.

   The link is signed rather than stored. A token is an HMAC over the case id
   and an issue time, so there is no new column, no table to clean up, and no
   row to leak — the server can verify a link it has never seen before.

   The secret must be set. There is deliberately no default: a fallback secret
   would be in this file, and anyone reading it could forge a score for any
   case. With no secret the feature is off and says so. */

import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { config } from './config.mjs';

export class FeedbackError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/* A function rather than a constant read at import time: config can be changed
   after load (tests do exactly that), and a frozen boolean would then disagree
   with the secret actually in use. */
export const feedbackConfigured = () => Boolean(config.feedback.secret);

const b64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function sign(caseId, issuedAt) {
  return b64url(
    createHmac('sha256', config.feedback.secret).update(`${caseId}.${issuedAt}`).digest()
  ).slice(0, 32);
}

/* v1.<issued at, seconds>.<signature> */
export function mintToken(caseId, now = Date.now()) {
  if (!feedbackConfigured()) {
    throw new FeedbackError('Feedback links are not configured — set RESOLVEIQ_FEEDBACK_SECRET.', 503);
  }
  if (!caseId) throw new FeedbackError('a case id is required', 400);
  const issuedAt = Math.floor(now / 1000);
  return `v1.${issuedAt}.${sign(caseId, issuedAt)}`;
}

export function verifyToken(caseId, token, now = Date.now()) {
  if (!feedbackConfigured()) {
    throw new FeedbackError('Feedback links are not configured.', 503);
  }
  if (!caseId || !token) throw new FeedbackError('This link is not valid.', 400);

  const parts = String(token).split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new FeedbackError('This link is not valid.', 400);

  const issuedAt = Number(parts[1]);
  if (!Number.isInteger(issuedAt)) throw new FeedbackError('This link is not valid.', 400);

  const expected = Buffer.from(sign(caseId, issuedAt));
  const given = Buffer.from(parts[2]);
  /* Compare in constant time, and only when the lengths already match —
     timingSafeEqual throws on a length mismatch, which would itself leak. */
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new FeedbackError('This link is not valid.', 400);
  }

  const ageDays = (now / 1000 - issuedAt) / 86400;
  if (ageDays > config.feedback.maxAgeDays) {
    throw new FeedbackError('This feedback link has expired.', 410);
  }
  if (ageDays < -1) {
    /* Issued in the future: a clock problem or a forged timestamp. */
    throw new FeedbackError('This link is not valid.', 400);
  }
  return true;
}

/* The absolute link to give the advisor. Falls back to the request's own host
   so it still works before anyone sets a public URL. */
export function feedbackUrl(caseId, { origin } = {}) {
  const base = (config.feedback.publicUrl || origin || '').replace(/\/+$/, '');
  const token = mintToken(caseId);
  return `${base}/feedback?c=${encodeURIComponent(caseId)}&t=${encodeURIComponent(token)}`;
}

/* 1-5. Anything else is a bug or a probe, not a rating. */
export function parseScore(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    throw new FeedbackError('A score must be a whole number from 1 to 5.', 400);
  }
  return n;
}

/* Free text from a public form. Trimmed, capped, and stored as-is — it is
   rendered as text content in the console, never as markup. */
export function parseComment(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > 2000) throw new FeedbackError('That comment is too long.', 400);
  return text;
}

export { randomUUID };
