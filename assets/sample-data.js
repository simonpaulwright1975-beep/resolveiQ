/* Sample queue data for ResolveIQ.
   Swap this file for a fetch() against your helpdesk API — the rest of the app
   only depends on the shape of the objects below. */

window.RESOLVEIQ_DATA = {
  team: 'Customer Care · Tier 1',
  currentAgent: 'You',

  /* Rolling numbers the KPI row reads. Replace with live aggregates. */
  metrics: {
    resolvedToday: 218,
    resolvedYesterday: 194,
    autoResolvedPct: 71,
    autoResolvedPrevPct: 64,
    avgHandleMins: 6.4,
    prevHandleMins: 9.4,
    csat: 4.6,
    prevCsat: 4.1,
    slaTargetPct: 95
  },

  /* status: new | open | pending | resolved
     sentiment: positive | neutral | frustrated | angry
     waitMins: minutes since the customer last had a reply
     slaMins: minutes allowed before the SLA is breached */
  tickets: [
    {
      id: 'RQ-4821',
      customer: 'Hannah Booth',
      account: 'Retail · Order #88213',
      channel: 'Chat',
      subject: 'Parcel marked delivered but nothing arrived',
      intent: 'Delivery',
      sentiment: 'frustrated',
      status: 'new',
      waitMins: 4,
      slaMins: 15,
      assignee: null,
      aiConfidence: 0.93,
      aiSuggestion: 'Courier GPS shows the parcel left at a neighbouring address. Offer an immediate free replacement dispatched next-day, and open a courier investigation. Replacement stock is available.',
      value: 68.40,
      messages: [
        { who: 'Hannah Booth', at: '09:12', text: 'Tracking says delivered at 8:40 but there is no parcel here and no card through the door.' },
        { who: 'ResolveIQ', at: '09:12', text: 'Thanks Hannah — I can see order #88213. Checking the courier record now.', agent: true }
      ],
      history: [
        { at: '12 Aug', text: 'Late delivery — resolved, goodwill credit £5' },
        { at: '04 Jun', text: 'Sizing question — resolved same day' }
      ]
    },
    {
      id: 'RQ-4820',
      customer: 'Dev Patel',
      account: 'SaaS · Pro plan',
      channel: 'Email',
      subject: 'Charged twice for the March invoice',
      intent: 'Billing',
      sentiment: 'angry',
      status: 'open',
      waitMins: 22,
      slaMins: 20,
      assignee: 'Priya S.',
      aiConfidence: 0.88,
      aiSuggestion: 'Two successful charges on 01 Mar for £49.00. The duplicate is a retry after a webhook timeout. Refund the second charge and confirm the 3–5 working day window.',
      value: 98.00,
      messages: [
        { who: 'Dev Patel', at: '08:41', text: 'This is the second month running. I have been charged £49 twice and nobody has come back to me.' }
      ],
      history: [
        { at: '02 Feb', text: 'Duplicate charge — refunded' },
        { at: '19 Jan', text: 'Plan upgrade — resolved' }
      ]
    },
    {
      id: 'RQ-4819',
      customer: 'Marie Okafor',
      account: 'Retail · Order #88104',
      channel: 'Chat',
      subject: 'Wants to return an unopened item past 30 days',
      intent: 'Returns',
      sentiment: 'neutral',
      status: 'open',
      waitMins: 9,
      slaMins: 30,
      assignee: 'You',
      aiConfidence: 0.79,
      aiSuggestion: 'Purchased 34 days ago, just outside policy. Customer has a clean returns record and £1,240 lifetime spend — policy allows a discretionary exception at Tier 1.',
      value: 42.99,
      messages: [
        { who: 'Marie Okafor', at: '09:02', text: 'I bought this as a gift and it was never opened. Can I still send it back?' }
      ],
      history: [
        { at: '11 Mar', text: 'Delivery address change — resolved' }
      ]
    },
    {
      id: 'RQ-4818',
      customer: 'Tom Whitfield',
      account: 'SaaS · Team plan',
      channel: 'Voice',
      subject: 'Cannot reset password, MFA device lost',
      intent: 'Account',
      sentiment: 'frustrated',
      status: 'open',
      waitMins: 16,
      slaMins: 20,
      assignee: null,
      aiConfidence: 0.71,
      aiSuggestion: 'Identity partially verified by phone. Requires a second factor before MFA reset — request the last four digits of the card on file, then trigger the recovery flow.',
      value: 0,
      messages: [
        { who: 'Tom Whitfield', at: '08:58', text: 'New phone, old authenticator gone. I have a board pack to send this morning.' }
      ],
      history: [
        { at: '27 Feb', text: 'Seat added — resolved' }
      ]
    },
    {
      id: 'RQ-4817',
      customer: 'Aisha Rahman',
      account: 'FMCG · Trade account',
      channel: 'Email',
      subject: 'Bulk order quote for 400 units',
      intent: 'Sales',
      sentiment: 'positive',
      status: 'pending',
      waitMins: 41,
      slaMins: 240,
      assignee: 'Jordan M.',
      aiConfidence: 0.64,
      aiSuggestion: 'Trade pricing sits outside Tier 1 authority above 250 units. Draft the quote at the standard trade band and route to the accounts team for sign-off.',
      value: 3480.00,
      messages: [
        { who: 'Aisha Rahman', at: '08:20', text: 'Could you quote for 400 units delivered to our Leeds depot before month end?' }
      ],
      history: [
        { at: '02 Apr', text: 'Quarterly order placed — resolved' },
        { at: '14 Jan', text: 'Credit terms query — resolved' }
      ]
    },
    {
      id: 'RQ-4816',
      customer: 'Greg Sanderson',
      account: 'Retail · Order #87990',
      channel: 'Chat',
      subject: 'Item arrived damaged in transit',
      intent: 'Delivery',
      sentiment: 'frustrated',
      status: 'new',
      waitMins: 2,
      slaMins: 15,
      assignee: null,
      aiConfidence: 0.95,
      aiSuggestion: 'Photo attached shows crushed packaging. Auto-approve a replacement under the damage policy and issue a returns label — no need to recover the damaged unit.',
      value: 129.00,
      messages: [
        { who: 'Greg Sanderson', at: '09:15', text: 'Box was crushed and the screen is cracked. Photo attached.' }
      ],
      history: []
    },
    {
      id: 'RQ-4815',
      customer: 'Lucy Fenwick',
      account: 'SaaS · Starter plan',
      channel: 'Email',
      subject: 'How do I export my data to CSV?',
      intent: 'Technical',
      sentiment: 'neutral',
      status: 'resolved',
      waitMins: 0,
      slaMins: 120,
      assignee: 'Auto',
      aiConfidence: 0.97,
      aiSuggestion: 'Answered from the knowledge base: Settings → Data → Export. Confirmed delivered and marked resolved automatically.',
      value: 0,
      messages: [
        { who: 'Lucy Fenwick', at: '07:44', text: 'Where is the CSV export hiding?' },
        { who: 'ResolveIQ', at: '07:44', text: 'Settings → Data → Export, then pick a date range. The file lands in your inbox in a couple of minutes.', agent: true }
      ],
      history: []
    },
    {
      id: 'RQ-4814',
      customer: 'Owen Blake',
      account: 'Retail · Order #87881',
      channel: 'Voice',
      subject: 'Refund not received after 10 days',
      intent: 'Billing',
      sentiment: 'angry',
      status: 'open',
      waitMins: 34,
      slaMins: 20,
      assignee: 'Priya S.',
      aiConfidence: 0.83,
      aiSuggestion: 'Refund was issued 10 days ago but failed at the acquirer — the card has since expired. Take updated card details or offer a bank transfer.',
      value: 214.50,
      messages: [
        { who: 'Owen Blake', at: '08:30', text: 'Ten days and still nothing back. I want to know exactly when this is landing.' }
      ],
      history: [
        { at: '18 Apr', text: 'Refund requested — approved' },
        { at: '02 Apr', text: 'Order query — resolved' }
      ]
    },
    {
      id: 'RQ-4813',
      customer: 'Sofia Nkemelu',
      account: 'SaaS · Pro plan',
      channel: 'Chat',
      subject: 'API returning 429 on batch imports',
      intent: 'Technical',
      sentiment: 'neutral',
      status: 'pending',
      waitMins: 52,
      slaMins: 120,
      assignee: 'You',
      aiConfidence: 0.58,
      aiSuggestion: 'Account is hitting the 600 req/min ceiling in bursts. Suggest client-side batching; a limit increase needs platform sign-off — draft raised for review.',
      value: 0,
      messages: [
        { who: 'Sofia Nkemelu', at: '08:12', text: 'Our nightly import keeps dying about 40% of the way through with 429s.' }
      ],
      history: [
        { at: '29 Mar', text: 'Webhook retries — resolved' }
      ]
    },
    {
      id: 'RQ-4812',
      customer: 'Callum Reid',
      account: 'Retail · Order #87840',
      channel: 'Email',
      subject: 'Wrong size dispatched',
      intent: 'Returns',
      sentiment: 'neutral',
      status: 'resolved',
      waitMins: 0,
      slaMins: 60,
      assignee: 'Auto',
      aiConfidence: 0.91,
      aiSuggestion: 'Pick error confirmed against the packing record. Correct size dispatched free of charge with a prepaid return label.',
      value: 55.00,
      messages: [
        { who: 'Callum Reid', at: '07:20', text: 'Ordered a medium, a small turned up.' }
      ],
      history: []
    },
    {
      id: 'RQ-4811',
      customer: 'Priyanka Shah',
      account: 'FMCG · Trade account',
      channel: 'Email',
      subject: 'Invoice copy needed for August',
      intent: 'Billing',
      sentiment: 'positive',
      status: 'resolved',
      waitMins: 0,
      slaMins: 240,
      assignee: 'Auto',
      aiConfidence: 0.99,
      aiSuggestion: 'Invoice located and emailed to the address on file. No further action needed.',
      value: 0,
      messages: [
        { who: 'Priyanka Shah', at: '07:05', text: 'Please could you resend the August invoice for our records?' }
      ],
      history: []
    },
    {
      id: 'RQ-4810',
      customer: 'Nathan Ellery',
      account: 'Retail · Order #87802',
      channel: 'Chat',
      subject: 'Discount code rejected at checkout',
      intent: 'Other',
      sentiment: 'frustrated',
      status: 'open',
      waitMins: 12,
      slaMins: 30,
      assignee: null,
      aiConfidence: 0.86,
      aiSuggestion: 'Code SUMMER20 expired two days ago. Goodwill policy allows a one-off equivalent credit for customers with three or more orders — this customer has six.',
      value: 76.20,
      messages: [
        { who: 'Nathan Ellery', at: '09:05', text: 'The code from your email will not apply. Am I doing something wrong?' }
      ],
      history: [
        { at: '21 May', text: 'Loyalty points query — resolved' }
      ]
    }
  ]
};
