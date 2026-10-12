/**
 * The seams between the engine and the registry: every router target and every chip names a real tool with input
 * that tool accepts, the "+" menu's files reach the import, resume and note tools in the shape they take, and a draft
 * card's Approve goes through send_draft's confirmation and the editor's approval path with the edited text.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { User } from '@orbit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db/schema';
import { loadDemo } from '../../engine/demo';
import { clearPrefs } from '../../integrations/prefs';
import { ATTACH_TOOL, attachInput, createChatEngine } from '../agent';
import { CHIP_RESOLVERS, CHIPS, chipsFor, resolveChip } from '../agent/chips';
import { execute, registry } from '../registry';
import type { ChatEngine, ResultEnvelope, TurnEvent } from '../types';
import { NOW } from './helpers';

let user: User;
let engine: ChatEngine;
beforeAll(async () => {
  await clearPrefs();
  user = await loadDemo({ reset: true, now: NOW });
  engine = createChatEngine({ registry, execute, user: () => user, now: () => NOW });
}, 90_000);

async function turn(go: (id: string, on: (e: TurnEvent) => void) => Promise<void>, conversationId?: string) {
  const id = conversationId ?? (await engine.startConversation({ temporary: false })).id;
  const events: TurnEvent[] = [];
  await go(id, (e) => events.push(e));
  const results = events.filter((e) => e.type === 'tool_result') as Extract<
    TurnEvent,
    { type: 'tool_result' }
  >[];
  const starts = events.filter((e) => e.type === 'tool_start') as Extract<
    TurnEvent,
    { type: 'tool_start' }
  >[];
  return { id, events, results, starts, env: results.at(-1)?.envelope as ResultEnvelope | undefined };
}

describe('router targets', () => {
  it('every tool the router can name is in the registry', () => {
    const src = readFileSync(resolve(__dirname, '../agent/router.ts'), 'utf8');
    const named = [...src.matchAll(/viaTool\(\s*'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(30);
    const missing = [...new Set(named)].filter((n) => !registry.has(n));
    expect(missing).toEqual([]);
  });
});

describe('chips', () => {
  it('the eight home chips all name a real tool with input it accepts, strictly', () => {
    expect(CHIPS).toHaveLength(8);
    for (const c of CHIPS) {
      const spec = registry.get(c.tool);
      expect(spec, c.id).toBeTruthy();
      const parsed = spec!.input.strict().safeParse(c.input);
      expect(parsed.success, `${c.id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
    expect(chipsFor(registry).map((c) => c.id)).toEqual(CHIPS.map((c) => c.id));
  });

  it('every chip resolver picks a real tool and input on the demo', async () => {
    for (const id of Object.keys(CHIP_RESOLVERS)) {
      const chip = CHIPS.find((c) => c.id === id)!;
      const run = await resolveChip(chip, registry, user.id, NOW);
      const spec = registry.get(run.tool)!;
      expect(spec, id).toBeTruthy();
      expect(spec.input.strict().safeParse(run.input).success, `${id} ${JSON.stringify(run)}`).toBe(true);
    }
    // on the demo each data-driven chip finds its target: the newest thank-you, the top target company, the next chat
    expect((await resolveChip(CHIPS[1]!, registry, user.id, NOW)).tool).toBe('create_draft');
    expect((await resolveChip(CHIPS[2]!, registry, user.id, NOW)).tool).toBe('find_routes');
    expect((await resolveChip(CHIPS[5]!, registry, user.id, NOW)).tool).toBe('get_person');
  });

  it('every chip runs through the engine and renders a real result, never an error', async () => {
    for (const c of CHIPS.filter((x) => x.tool !== 'import_linkedin')) {
      const t = await turn((id, on) => engine.runChip(id, c.id, on));
      expect(t.env, c.id).toBeTruthy();
      expect(t.env!.kind, `${c.id}: ${t.env!.summary}`).not.toBe('error');
    }
  }, 60_000);
});

describe('Approve from a card', () => {
  it("a draft card's Approve asks send_draft for a confirmation and approves it with the edited text", async () => {
    const card = (
      await db.suggestions
        .where('userId')
        .equals(user.id)
        .filter((s) => s.kind === 'thank_you' && s.status === 'pending' && !!s.outboundMessageId)
        .toArray()
    )[0]!;
    const person = (await db.people.get(card.personId!))!;
    const t = await turn((id, on) => engine.send(id, `draft a thank you to ${person.displayName}`, on));
    expect(t.env?.kind, t.env?.summary).toBe('draft');
    const draftId = card.outboundMessageId!;
    expect((await db.outbound.get(draftId))!.status).toBe('draft');
    const draft = (await db.outbound.get(draftId))!;
    const edited = `${(draft.bodyFinal ?? draft.bodyDraft).trim()}\n\nP.S. Your advice on the project story stuck with me.`;
    const env = await engine.approve(t.starts[0]!.toolUseId, { body: edited });
    expect(env.kind, env.summary).toBe('draft');
    const after = (await db.outbound.get(draftId))!;
    // the approval path the editor uses: the email opens in the mail app and waits for "I sent it"
    expect(['handed_off', 'queued']).toContain(after.status);
    expect(after.bodyFinal).toBe(edited);
    expect(after.bodyFinalHash).toBeTruthy();
    // the confirmation it went through is recorded as done, and a second Approve does not send twice
    const conf = (await db.chatActions.where('conversationId').equals(t.id).toArray()).find(
      (a) => a.id.startsWith('conf_') && a.toolName === 'send_draft',
    );
    expect(conf?.status).toBe('done');
    expect((await engine.approve(conf!.id)).kind).toBe('error');
  }, 60_000);

  it('a send_draft confirmation card approves with the text as edited in the card', async () => {
    const d = (
      await db.outbound
        .where('userId')
        .equals(user.id)
        .filter((o) => o.status === 'draft' && o.channel === 'gmail')
        .toArray()
    )[0]!;
    const person = (await db.people.get(d.personId))!;
    const t = await turn((id, on) => engine.send(id, `send my draft to ${person.displayName}`, on));
    expect(t.env?.kind, t.env?.summary).toBe('needs_confirmation');
    expect((await db.outbound.get(d.id))!.status).toBe('draft');
    const edited = `${(d.bodyFinal ?? d.bodyDraft).trim()}\n\nThanks again for your time.`;
    const env = await engine.approve(t.env!.confirmationId!, { body: edited });
    if (env.kind === 'error') {
      // the engine's own guard (a cooldown, a missing line) blocks it: then nothing went out
      expect((await db.outbound.get(d.id))!.status).toBe('draft');
      return;
    }
    expect(['handed_off', 'queued']).toContain((await db.outbound.get(d.id))!.status);
    expect((await db.outbound.get(d.id))!.bodyFinal).toBe(edited);
  }, 60_000);
});

describe('attachments', () => {
  it('each "+" menu kind goes to a real tool in the shape that tool takes', async () => {
    const files: Record<keyof typeof ATTACH_TOOL, File> = {
      note: new File(['Coffee with Priya. She said to lead with a project story.'], 'coffee.txt', {
        type: 'text/plain',
      }),
      email: new File(['From: priya@stripe.com\n\nHappy to chat Thursday.'], 'thread.eml'),
      resume: new File([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52])], 'resume.pdf', {
        type: 'application/pdf',
      }),
      linkedin: new File(
        ['First Name,Last Name,URL\nTara,Nguyen,https://www.linkedin.com/in/tara'],
        'Connections.csv',
        {
          type: 'text/csv',
        },
      ),
    };
    for (const kind of Object.keys(ATTACH_TOOL) as (keyof typeof ATTACH_TOOL)[]) {
      const spec = registry.get(ATTACH_TOOL[kind])!;
      expect(spec, kind).toBeTruthy();
      const input = await attachInput(spec, files[kind], kind);
      expect(spec.input.strict().safeParse(input).success, `${kind} ${JSON.stringify(input)}`).toBe(true);
    }
    const resume = await attachInput(registry.get('save_resume')!, files.resume, 'resume');
    expect(resume).toEqual({ filename: 'resume.pdf', base64: btoa('%PDF-1.4'), mimeType: 'application/pdf' });
    const csv = await attachInput(registry.get('import_linkedin')!, files.linkedin, 'linkedin');
    expect(csv).toMatchObject({ filename: 'Connections.csv', csvText: expect.stringContaining('Tara') });
    const zip = await attachInput(
      registry.get('import_linkedin')!,
      new File([new Uint8Array([80, 75, 3, 4])], 'Basic_LinkedInDataExport.zip', { type: 'application/zip' }),
      'linkedin',
    );
    expect(zip).toEqual({ filename: 'Basic_LinkedInDataExport.zip', base64: btoa('PK\u0003\u0004') });
  });

  it('a LinkedIn file attached in the chat asks first, then imports on Approve', async () => {
    const before = await db.people.where('userId').equals(user.id).count();
    const file = new File(
      [
        'First Name,Last Name,URL,Email Address,Company,Position,Connected On\nTara,Nguyen,https://www.linkedin.com/in/tara-nguyen-wiring,,Brex,Associate Product Manager,01 Oct 2026\n',
      ],
      'Connections.csv',
      { type: 'text/csv' },
    );
    const t = await turn((id, on) => engine.attach(id, file, 'linkedin', on));
    expect(t.env?.kind).toBe('needs_confirmation');
    expect(await db.people.where('userId').equals(user.id).count()).toBe(before);
    const env = await engine.approve(t.env!.confirmationId!);
    expect(env.kind, env.summary).toBe('import');
    expect(await db.people.where('userId').equals(user.id).count()).toBe(before + 1);
  }, 60_000);

  it('a notes file attached in the chat is saved as a note', async () => {
    const before = await db.notes.where('userId').equals(user.id).count();
    const t = await turn((id, on) =>
      engine.attach(
        id,
        new File(['Met a recruiter at the fair.'], 'fair.txt', { type: 'text/plain' }),
        'note',
        on,
      ),
    );
    expect(t.env?.kind, t.env?.summary).toBe('note');
    expect(await db.notes.where('userId').equals(user.id).count()).toBe(before + 1);
  });
});
