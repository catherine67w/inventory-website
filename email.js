'use strict';

// Drafting vendor emails.
//
// The person writing knows what they want to say — "chase the credit on the
// short beef delivery" — and wants it put into a sentence a supplier will act
// on. So the notes they type are the instruction, and this module's only job is
// to turn them into an email, never to invent a reason for writing. Facts about
// the vendor are passed in so a draft can name a real invoice instead of
// leaving a blank for one.

const Anthropic = require('@anthropic-ai/sdk');
const { apiKeyProblem, costOf, MODEL } = require('./parse');

const SYSTEM_PROMPT = `You write short business emails on behalf of a restaurant
to its food and supply vendors. The restaurant is Little Sheep Hot Pot, a
Mongolian hot pot restaurant at 1 American Dream Way, East Rutherford, NJ.

Rules:
- Write only what the notes ask for. Never invent facts, amounts, dates,
  invoice numbers, product names or promises that are not in the notes or in
  the supplied vendor details.
- If the notes are vague, write the plain version of the request rather than
  padding it with detail you do not have. Leave a short bracketed blank such as
  [invoice #] only where a specific fact is genuinely needed and not supplied.
- Plain, direct, courteous. No marketing language, no exclamation marks, no
  "I hope this email finds you well".
- Usually three short paragraphs or fewer. A list is fine for several items.
- Sign off as the restaurant, not as a named person, unless the notes give a
  name.
- Subject line: under 70 characters, specific, no "Re:" prefix.`;

const EMAIL_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string', description: 'Subject line, under 70 characters.' },
    body: { type: 'string', description: 'The email body as plain text, with blank lines between paragraphs.' },
  },
  required: ['subject', 'body'],
  additionalProperties: false,
};

// What the model is allowed to know. Built here rather than inside the prompt
// so it is obvious exactly which facts can reach a draft.
function vendorBrief(vendor, invoices = []) {
  const lines = [`Vendor name: ${vendor.name}`];
  if (vendor.email) lines.push(`Vendor email: ${vendor.email}`);
  if (vendor.phone) lines.push(`Vendor phone: ${vendor.phone}`);
  if (vendor.terms) lines.push(`Payment terms on file: ${vendor.terms}`);

  if (invoices.length) {
    lines.push('', 'Recent invoices from this vendor (most recent first):');
    for (const inv of invoices) {
      const parts = [];
      if (inv.invoice_number) parts.push(`invoice ${inv.invoice_number}`);
      if (inv.invoice_date) parts.push(`dated ${inv.invoice_date}`);
      if (inv.total !== null && inv.total !== undefined) {
        parts.push(`$${Number(inv.total).toFixed(2)}`);
      }
      lines.push(`- ${parts.join(', ')}`);
    }
  }
  return lines.join('\n');
}

async function draftEmail({ vendor, invoices = [], notes, previous = null }) {
  const problem = apiKeyProblem();
  if (problem) {
    const err = new Error(problem);
    err.code = 'BAD_API_KEY';
    throw err;
  }

  const client = new Anthropic();

  // A redraft carries the text already on the screen, so "make it firmer" is a
  // revision of that email rather than a fresh one that loses the edits.
  const parts = [
    `Vendor details:\n${vendorBrief(vendor, invoices)}`,
    `What the email needs to say (notes from the restaurant):\n${notes}`,
  ];
  if (previous && previous.trim()) {
    parts.push(
      'There is already a draft on the screen. Revise THIS text according to the '
      + `notes above, keeping anything the notes do not ask you to change:\n\n${previous.trim()}`,
    );
  }

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: EMAIL_SCHEMA },
      },
      messages: [{ role: 'user', content: parts.join('\n\n') }],
    });
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      throw new Error('Anthropic rejected the API key. Check it was copied in full, or create a new one.');
    }
    if (err.status === 400 && /credit|balance/i.test(err.message || '')) {
      throw new Error('Your Anthropic account is out of credit. Add credit at console.anthropic.com, then try again.');
    }
    if (err.status === 429) {
      throw new Error('Too many requests at once. Wait a moment and try again.');
    }
    if (err.status >= 500) {
      throw new Error('Anthropic had a temporary problem. Try again in a minute.');
    }
    throw new Error(`Could not write the email: ${err.message}`);
  }

  if (response.stop_reason === 'refusal') {
    throw new Error('That request was declined. Write this one by hand.');
  }

  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let draft;
  try {
    draft = JSON.parse(text);
  } catch {
    throw new Error('The draft came back unreadable. Try again.');
  }

  const u = response.usage || {};
  return {
    subject: String(draft.subject || '').trim(),
    body: String(draft.body || '').trim(),
    usage: {
      input_tokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
      output_tokens: u.output_tokens || 0,
      cost: costOf(u),
      model: MODEL,
    },
  };
}

module.exports = { draftEmail };
