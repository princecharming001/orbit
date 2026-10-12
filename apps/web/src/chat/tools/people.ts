/** People writes: add, edit, hide, facts, prep questions, suggested contacts. */
import { FACT_TYPE_LABELS, RELATIONSHIP_LABELS, type RelationshipType } from '@orbit/core';
import { db } from '../../db/schema';
import { refreshPersonSummary } from '../../engine/brief';
import {
  addFact,
  deleteFact,
  MANUAL_FACT_TYPES,
  MAX_PREP_QUESTIONS,
  restoreFact,
  setPrepQuestions,
} from '../../engine/facts';
import { knownOrganisations, readSuggestedNames, saveSuggestedContacts } from '../../engine/introductions';
import {
  addPersonByHand,
  hidePerson,
  setRelationshipType,
  unhidePerson,
  updatePersonDetails,
} from '../../engine/people';
import { z } from '../../zod';
import {
  type AnyTool,
  chatFor,
  defineTool,
  ok,
  personRef,
  plural,
  requirePerson,
  toModel,
  wrapped,
} from './_shared';

const RELATIONSHIPS = Object.keys(RELATIONSHIP_LABELS) as [RelationshipType, ...RelationshipType[]];

export const addPerson = defineTool({
  name: 'add_person',
  kind: 'write',
  description:
    'Call this only when the student asks to add someone to Orbit by hand ("add Priya Shah, analyst at Evercore, priya@evercore.com"). Needs a name and a way to reach them: an email or a LinkedIn profile URL. A record with the same email or profile is updated, not duplicated. Today then lists them under the people to write to; use create_draft to start the first message.',
  input: z.object({
    name: z.string().min(1).describe('Full name.'),
    company: z.string().optional().describe('Where they work.'),
    title: z.string().optional().describe('Their role.'),
    email: z.string().optional().describe('Their email address.'),
    linkedinUrl: z.string().optional().describe('Their LinkedIn profile URL.'),
    school: z.string().optional().describe('Their school, if known.'),
  }),
  capabilities: ['person_add_by_hand', 'pipeline_add_person', 'note_add_person_inline'],
  progress: 'Adding them',
  async execute(input, ctx) {
    const email = input.email?.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new Error('That email address does not look right.');
    if (!email && !input.linkedinUrl?.trim())
      throw new Error(
        `Orbit needs a way to reach ${input.name.trim()}: an email address or a LinkedIn profile link.`,
      );
    const r = await addPersonByHand(ctx.user.id, { ...input, email }, ctx.user.school);
    if (!r) throw new Error('A name is needed.');
    const out = { ...personRef(r.person), created: r.created };
    return ok(
      'person',
      out,
      out,
      r.created
        ? `Added ${r.person.displayName}. Write to them from their page, or ask me to draft the first message.`
        : `${r.person.displayName} was already in Orbit; their record is updated.`,
      `/people/${r.person.id}`,
    );
  },
  toModel,
});

export const updatePerson = defineTool({
  name: 'update_person',
  kind: 'write',
  description:
    'Call this only when the student asks to change how they know a person (recruiter, alum, peer, mentor, professor, family friend, colleague), to show a hidden person again, to tag them, to keep a private note on them, or to refresh their summary and talking points. Hiding is hide_person.',
  input: z.object({
    personId: z.string().describe('The person id.'),
    relationshipType: z
      .enum(RELATIONSHIPS)
      .optional()
      .describe('How the student knows them; Orbit adjusts draft tone to it.'),
    unhide: z.boolean().optional().describe('true: show a hidden person again in People, Today and the Map.'),
    tags: z.array(z.string()).optional().describe('Replace their tags.'),
    notes: z
      .string()
      .optional()
      .describe('A private note kept on the person (not a meeting note; use add_note for those).'),
    refreshSummary: z
      .boolean()
      .optional()
      .describe('true: rewrite the summary and talking points from the facts and history.'),
  }),
  capabilities: ['person_set_relationship', 'person_unhide', 'person_refresh_summary'],
  progress: 'Updating their record',
  async execute(input, ctx) {
    const person = await requirePerson(ctx, input.personId);
    const did: string[] = [];
    if (input.relationshipType) {
      await setRelationshipType(person.id, input.relationshipType, ctx.now);
      did.push(`marked as ${RELATIONSHIP_LABELS[input.relationshipType].toLowerCase()}`);
    }
    if (input.unhide) {
      await unhidePerson(person.id);
      did.push('back in People, Today and the map');
    }
    if (input.tags || input.notes !== undefined) {
      await updatePersonDetails(person.id, { tags: input.tags, notes: input.notes }, ctx.now);
      did.push(input.tags ? `${plural(input.tags.length, 'tag')} saved` : 'note saved');
    }
    if (input.refreshSummary) {
      await refreshPersonSummary(ctx.user, person.id);
      did.push('summary refreshed');
    }
    if (!did.length)
      throw new Error('Say what to change: the relationship, unhide, tags, a note or the summary.');
    const fresh = (await db.people.get(person.id))!;
    const out = {
      ...personRef(fresh),
      relationship: RELATIONSHIP_LABELS[fresh.relationshipType],
      hidden: !!fresh.hiddenAt,
      tags: fresh.tags,
      summary: wrapped(ctx, 'summary', fresh.summary, 400),
      talkingPoints: fresh.talkingPoints?.map((t) => wrapped(ctx, 'talking_point', t, 200)),
    };
    return ok('person', out, out, `${fresh.displayName}: ${did.join(', ')}.`, `/people/${fresh.id}`);
  },
  toModel,
});

export const hidePersonTool = defineTool({
  name: 'hide_person',
  kind: 'risky',
  description:
    "Call this only when the student asks to hide someone from their lists. A hidden person leaves People, Today, the Map and Discover, and Orbit refuses to send to them until they are shown again (update_person with unhide). Needs the student's approval.",
  input: z.object({
    personId: z.string().describe('The person id.'),
  }),
  capabilities: ['person_hide'],
  progress: 'Hiding them',
  async summarizeIntent(input, ctx) {
    const p = await requirePerson(ctx, input.personId);
    return {
      text: `Hide ${p.displayName} from People, Today, the Map and Discover. They stay in Orbit under Hidden and can be shown again.`,
      blockedReason: p.hiddenAt ? 'They are already hidden.' : undefined,
    };
  },
  async execute(input, ctx) {
    const p = await requirePerson(ctx, input.personId);
    if (p.hiddenAt) throw new Error(`${p.displayName} is already hidden.`);
    await hidePerson(p.id, ctx.now);
    const out = {
      ...personRef(p),
      hidden: true,
      undo: { tool: 'update_person', input: { personId: p.id, unhide: true } },
    };
    return ok(
      'person',
      out,
      out,
      `Hid ${p.displayName}. Find them under Hidden in People, or ask me to show them again.`,
      '/people',
    );
  },
  toModel,
});

export const manageFact = defineTool({
  name: 'manage_fact',
  kind: 'write',
  description:
    'Call this only when the student tells you something to remember about a person ("note that Priya is training for a marathon", "Omar offered to refer me") or asks to bring back a deleted fact. add needs a type (hook: worth bringing up, advice, offer, personal, role_detail, background) and the text; restore needs the fact id. Deleting is delete_fact. Drafts of thank-yous, check-ins and referral asks pick facts up.',
  input: z.object({
    personId: z.string().describe('The person the fact is about.'),
    action: z.enum(['add', 'restore']).describe('add a fact, or restore a deleted one.'),
    type: z.enum(MANUAL_FACT_TYPES).optional().describe('For add: the kind of fact.'),
    text: z.string().optional().describe('For add: the fact, one sentence, as the student said it.'),
    factId: z.string().optional().describe('For restore: the fact id.'),
  }),
  capabilities: ['person_fact_add'],
  progress: 'Saving the fact',
  async execute(input, ctx) {
    const person = await requirePerson(ctx, input.personId);
    if (input.action === 'add') {
      if (!input.type || !input.text?.trim()) throw new Error('A fact needs a type and the text.');
      const f = await addFact(ctx.user.id, person.id, input.type, input.text, ctx.now);
      if (!f) throw new Error('The fact could not be saved.');
      const out = {
        factId: f.id,
        person: personRef(person),
        type: f.type,
        typeLabel: FACT_TYPE_LABELS[f.type],
        text: wrapped(ctx, 'fact', f.text, 300),
      };
      return ok(
        'facts',
        out,
        out,
        `Noted under ${FACT_TYPE_LABELS[f.type]} for ${person.firstName}. Drafts to them can use it.`,
        `/people/${person.id}?tab=facts`,
      );
    }
    if (!input.factId) throw new Error('Say which fact to restore.');
    const f = await db.facts.get(input.factId);
    if (!f || f.personId !== person.id) throw new Error('That fact is not on this person.');
    if (!(await restoreFact(f.id))) throw new Error('That fact is not deleted.');
    const out = {
      factId: f.id,
      person: personRef(person),
      type: f.type,
      typeLabel: FACT_TYPE_LABELS[f.type],
      text: wrapped(ctx, 'fact', f.text, 300),
    };
    return ok('facts', out, out, 'Fact restored. Drafts can use it again.', `/people/${person.id}?tab=facts`);
  },
  toModel,
});

export const deleteFactTool = defineTool({
  name: 'delete_fact',
  kind: 'risky',
  description:
    'Call this only when the student says a fact about a person is wrong and should go ("delete the fact that says she is in Boston"). Get the fact id from get_person facts. The fact is hidden from drafts and can be restored with manage_fact. Needs the student\'s approval.',
  input: z.object({
    factId: z.string().describe('The fact id (from get_person).'),
  }),
  capabilities: ['person_fact_delete'],
  progress: 'Deleting the fact',
  async summarizeIntent(input, ctx) {
    const f = await db.facts.get(input.factId);
    if (!f || f.userId !== ctx.user.id)
      return { text: 'Delete a fact.', blockedReason: 'Orbit has no fact with that id.' };
    const p = await db.people.get(f.personId);
    return {
      text: `Delete the ${FACT_TYPE_LABELS[f.type].toLowerCase()} fact on ${p?.displayName ?? 'this person'}: "${f.text.slice(0, 120)}". Drafts will not use it.`,
      blockedReason: f.deletedAt ? 'It is already deleted.' : undefined,
    };
  },
  async execute(input, ctx) {
    const f = await db.facts.get(input.factId);
    if (!f || f.userId !== ctx.user.id) throw new Error('Orbit has no fact with that id.');
    if (!(await deleteFact(ctx.user.id, f.id, ctx.now))) throw new Error('That fact is already deleted.');
    const out = {
      factId: f.id,
      personId: f.personId,
      undo: { tool: 'manage_fact', input: { personId: f.personId, action: 'restore', factId: f.id } },
    };
    return ok(
      'facts',
      out,
      out,
      'Fact deleted. Drafts will not use it. Ask me to restore it if that was wrong.',
      `/people/${f.personId}?tab=facts`,
    );
  },
  toModel,
});

export const pickPrepQuestions = defineTool({
  name: 'pick_prep_questions',
  kind: 'write',
  description:
    'Call this only when the student picks (or unpicks) questions to lead with in a coming chat, from the prep questions get_person returns. At most three; pass the full list to keep. Needs a chat with the person.',
  input: z.object({
    personId: z.string().optional().describe('The person the chat is with.'),
    chatId: z.string().optional().describe('The chat id.'),
    questions: z
      .array(z.string())
      .max(MAX_PREP_QUESTIONS)
      .describe('The questions to keep, exactly as get_person listed them (at most three).'),
  }),
  capabilities: ['person_prep_pick_question'],
  progress: 'Saving your questions',
  async execute(input, ctx) {
    const chat = await chatFor(ctx, input);
    if (!chat) throw new Error('Picks are kept on a chat, and this person has no chat yet.');
    const picked = await setPrepQuestions(chat.id, input.questions, ctx.now);
    const out = { chatId: chat.id, personId: chat.personId, picked: picked ?? [] };
    return ok(
      'prep',
      out,
      out,
      picked?.length
        ? `${plural(picked.length, 'question')} picked for this chat.`
        : 'No questions picked for this chat.',
      `/people/${chat.personId}?tab=prep`,
    );
  },
  toModel,
});

export const saveSuggestedContactsTool = defineTool({
  name: 'save_suggested_contacts',
  kind: 'write',
  description:
    'Call this only when the student says who a person suggested they talk to ("Priya suggested I talk to Tom Lee at Stripe and Maya Wu"). Pass the text: clear names are saved as people with a "suggested by" fact and a saved recommendation; names Orbit is unsure of come back under confirm and are saved only when the student says yes (pass them in names). Not a person at all comes back under skipped.',
  input: z.object({
    personId: z.string().describe('The person who made the suggestions.'),
    text: z
      .string()
      .optional()
      .describe('What they said, with full names ("Priya Shah at Stripe, Tom Lee").'),
    names: z
      .array(
        z.object({
          name: z.string().describe('Full name.'),
          org: z.string().optional().describe('Their company, if said.'),
        }),
      )
      .optional()
      .describe('Names the student confirmed (from a previous confirm list), saved as given.'),
  }),
  capabilities: ['person_prep_suggested_names'],
  progress: 'Saving who they suggested',
  async execute(input, ctx) {
    const from = await requirePerson(ctx, input.personId);
    const saved: { id: string; name: string; href: string }[] = [];
    let confirm: { name: string; org?: string }[] = [];
    let skipped: string[] = [];
    if (input.text?.trim()) {
      const knownOrgs = await knownOrganisations(ctx.user.id);
      const read = readSuggestedNames(input.text, { knownOrgs });
      const people = await saveSuggestedContacts(ctx.user.id, from.id, read.names, ctx.now);
      saved.push(...people.map((p) => ({ id: p.id, name: p.displayName, href: `/people/${p.id}` })));
      confirm = read.confirm;
      skipped = read.skipped;
    }
    if (input.names?.length) {
      const people = await saveSuggestedContacts(ctx.user.id, from.id, input.names, ctx.now);
      saved.push(...people.map((p) => ({ id: p.id, name: p.displayName, href: `/people/${p.id}` })));
    }
    if (!input.text?.trim() && !input.names?.length) throw new Error('Say who they suggested.');
    const out = { from: personRef(from), saved, confirm, skipped };
    const parts = [
      saved.length
        ? `Saved to Discover as suggested by ${from.firstName}: ${saved.map((s) => s.name).join(', ')}.`
        : '',
      confirm.length
        ? `Not sure these are people: ${confirm.map((c) => (c.org ? `${c.name} at ${c.org}` : c.name)).join(', ')}. Ask before saving them.`
        : '',
      skipped.length ? `Not saved: ${skipped.join(', ')}. Each needs a full name.` : '',
    ].filter(Boolean);
    return ok('people', out, out, parts.join(' ') || 'Nothing to save.', '/discover');
  },
  toModel,
});

export const peopleTools: AnyTool[] = [
  addPerson,
  updatePerson,
  hidePersonTool,
  manageFact,
  deleteFactTool,
  pickPrepQuestions,
  saveSuggestedContactsTool,
];
