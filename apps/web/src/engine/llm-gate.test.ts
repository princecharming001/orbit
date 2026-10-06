import Anthropic from '@anthropic-ai/sdk';
import type { User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { setLlmClientFactoryForTests } from '../integrations/anthropic';
import { clearPrefs, writePrefs } from '../integrations/prefs';
import { createLocalUser } from './account';
import { surfaceLlmFailure } from './brief';
import { ingestEmails, type RawEmail } from './ingest';

const NETWORKING = { category: 'networking', is_networking: true, topic: 'chat', confidence: 0.9 };
let calls: string[] = [];
function fake(respond: () => unknown) {
  setLlmClientFactoryForTests(
    () =>
      ({
        messages: {
          parse: async (p: { messages: { content: string }[] }) => {
            calls.push(p.messages[0]!.content);
            const r = respond();
            if (r instanceof Error) throw r;
            return {
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
              parsed_output: r,
            };
          },
        },
      }) as never,
  );
}

let user: User;
const now = new Date();
const ago = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
function raw(id: string, from: string, body: string, subject: string): RawEmail {
  return {
    externalMessageId: id,
    externalThreadId: `t-${id}`,
    from,
    to: ['sam@cornell.edu'],
    cc: [],
    subject,
    sentAt: ago(5),
    bodyText: body,
    headers: {},
  };
}
// The rules call this one with confidence: two networking phrases.
const confident = raw(
  'c1',
  'Ana Ruiz <ana@acme.com>',
  'Hi Sam, happy to do a coffee chat and share some advice about my path.',
  'Coffee chat',
);
// The rules cannot tell what this is.
const unclear = raw('u1', 'Bo Kim <bo@acme.com>', 'Hey Sam, are you around next week?', 'Next week');

beforeEach(async () => {
  await wipeDatabase();
  await clearPrefs();
  calls = [];
  user = await createLocalUser({
    email: 'sam@cornell.edu',
    firstName: 'Sam',
    fullName: 'Sam Lee',
    school: 'Cornell',
  });
  writePrefs({ anthropicApiKey: 'sk-ant-test' });
});
afterEach(() => setLlmClientFactoryForTests(undefined));

describe('email and Claude', () => {
  it('sends no email to Anthropic by default, even with a key saved', async () => {
    fake(() => NETWORKING);
    await ingestEmails(user, [confident, unclear], { now });
    expect(calls).toHaveLength(0);
    const threads = await db.threads.toArray();
    expect(threads.every((t) => t.classifiedBy === 'heuristic')).toBe(true);
  });

  it('when turned on, sends only threads the rules cannot classify with confidence', async () => {
    writePrefs({ llmFeatures: { emailTriage: true } });
    fake(() => NETWORKING);
    await ingestEmails(user, [confident, unclear], { now });
    const triage = calls.filter((c) => c.includes('email_subject'));
    expect(triage).toHaveLength(1);
    expect(triage[0]).toContain('are you around next week');
    const byId = new Map((await db.threads.toArray()).map((t) => [t.externalThreadId, t]));
    expect(byId.get('t-c1')?.classifiedBy).toBe('heuristic');
    expect(byId.get('t-u1')?.classifiedBy).toBe('llm');
  });

  it('a revoked key raises one notification with the reason, and ingestion falls back to the rules', async () => {
    writePrefs({ llmFeatures: { emailTriage: true } });
    fake(() => new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', new Headers()));
    const many = Array.from({ length: 4 }, (_, i) =>
      raw(`x${i}`, `P${i} <p${i}@acme.com>`, `Hey Sam, are you around ${i}?`, `Question ${i}`),
    );
    const stats = await ingestEmails(user, many, { now });
    expect(stats.messages).toBe(4);
    expect(calls.length).toBeGreaterThan(1);
    const notes = (await db.notifications.toArray()).filter((n) => n.kind === 'integration_problem');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      title: 'Your Claude key stopped working',
      link: '/settings/integrations',
    });
    expect(notes[0]!.body).toMatch(/Anthropic rejected the API key/);
    expect((await db.threads.toArray()).every((t) => t.classifiedBy === 'heuristic')).toBe(true);
  });

  it('notifies again for the same reason only after the first notice was read', async () => {
    const err = new Anthropic.APIConnectionError({ message: 'fetch failed' });
    await Promise.all([surfaceLlmFailure(user.id, err), surfaceLlmFailure(user.id, err)]);
    await surfaceLlmFailure(user.id, err);
    let notes = await db.notifications.toArray();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe('Could not reach Claude');
    await db.notifications.update(notes[0]!.id, { readAt: new Date().toISOString() });
    await surfaceLlmFailure(user.id, err);
    notes = await db.notifications.toArray();
    expect(notes).toHaveLength(2);
  });
});
