/* Draft a resolution for one ticket using Claude.

   The API key stays on this process — the browser calls /api/suggest and never
   sees a credential. Output is constrained by a schema so the UI can rely on
   the shape of what comes back rather than parsing prose. */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { config } from './config.mjs';

export const SuggestionSchema = z.object({
  intent: z
    .enum(['Billing', 'Delivery', 'Returns', 'Account', 'Technical', 'Sales', 'Other'])
    .describe('What the customer actually wants.'),
  sentiment: z
    .enum(['positive', 'neutral', 'frustrated', 'angry'])
    .describe('The tone of the customer, judged from their own words.'),
  summary: z.string().describe('One sentence stating the problem, for the agent, not the customer.'),
  reply: z.string().describe('The message to send to the customer. Ready to send as written.'),
  nextSteps: z.array(z.string()).describe('What the agent must do in the CRM or other systems.'),
  confidence: z.number().min(0).max(1).describe('How confident you are this resolves it.'),
  escalate: z.boolean().describe('True if this needs a manager or a specialist team.'),
  escalationReason: z.string().describe('Why it needs escalating, or an empty string if it does not.')
});

const SYSTEM = `You are helping a customer service agent at a UK company answer a support case.

You are drafting for the agent, not speaking to the customer directly. The agent reads your draft, edits if needed, and sends it.

Rules:
- Write the reply in British English, in a warm but efficient tone. No corporate padding.
- Address the specific problem. Never invent order numbers, refund amounts, dates, policy terms or account details that are not in the case.
- If a fact you need is missing, the reply should ask for it, and nextSteps should say what to check.
- Put anything the agent must do in the CRM in nextSteps, not in the customer reply.
- Set escalate when the case needs authority the agent may not have: refunds beyond routine goodwill, legal or data-protection threats, anything about injury or safety.
- confidence reflects whether this genuinely resolves the case. Be honest — a low score is more useful than a confident guess.`;

function ticketToPrompt(ticket) {
  const lines = [
    `Case reference: ${ticket.id}`,
    `Customer: ${ticket.customer}`,
    `Account: ${ticket.account}`,
    `Channel: ${ticket.channel}`,
    `Priority: ${ticket.priority || 'unspecified'}`,
    `Waiting: ${ticket.waitMins} minutes (SLA window ${ticket.slaMins} minutes)`,
    `Subject: ${ticket.subject}`
  ];

  if (ticket.value) lines.push(`Order value: £${Number(ticket.value).toFixed(2)}`);

  if (ticket.messages?.length) {
    lines.push('', 'Conversation so far:');
    for (const m of ticket.messages) lines.push(`${m.who}${m.at ? ` (${m.at})` : ''}: ${m.text}`);
  }

  if (ticket.history?.length) {
    lines.push('', 'Previous contact from this customer:');
    for (const h of ticket.history) lines.push(`${h.at}: ${h.text}`);
  } else {
    lines.push('', 'No previous contact on record.');
  }

  lines.push('', 'Draft the resolution.');
  return lines.join('\n');
}

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: config.claude.apiKey });
  return client;
}

export class SuggestionError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export async function suggestForTicket(ticket, { client: injected } = {}) {
  const anthropic = injected || getClient();

  const response = await anthropic.messages.parse({
    model: config.claude.model,
    max_tokens: config.claude.maxTokens,
    /* Adaptive thinking: the model decides how much reasoning the case needs. */
    thinking: { type: 'adaptive' },
    output_config: {
      effort: config.claude.effort,
      format: zodOutputFormat(SuggestionSchema)
    },
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: ticketToPrompt(ticket) }]
  });

  /* A policy decline returns HTTP 200 with stop_reason "refusal" — check it
     before reading content, or you read an empty draft as a real one. */
  if (response.stop_reason === 'refusal') {
    throw new SuggestionError(
      'Claude declined to draft a reply for this case. Write the response manually.',
      422
    );
  }

  if (!response.parsed_output) {
    throw new SuggestionError('Claude returned a draft that did not match the expected format.', 502);
  }

  return {
    ...response.parsed_output,
    model: response.model,
    usage: {
      input: response.usage?.input_tokens ?? 0,
      output: response.usage?.output_tokens ?? 0
    }
  };
}
