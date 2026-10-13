import type { User } from '@orbit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db/schema';
import { loadDemo } from '../../engine/demo';
import { clearPrefs, writePrefs } from '../../integrations/prefs';
import { execute, modelResult } from '../registry';
import { makeCtx, NOW } from './helpers';

const DASHES = /[—–]/;

let user: User;
beforeAll(async () => {
  await clearPrefs();
  user = await loadDemo({ reset: true, now: NOW });
}, 90_000);

describe('offer_choices', () => {
  it('returns the options for the pills and tells the model only that they were shown', async () => {
    const env = await execute(
      'offer_choices',
      {
        options: [
          { label: "Let's do it", message: "Let's do it" },
          { label: 'What else?', message: 'What else can you do?' },
        ],
      },
      makeCtx(user),
    );
    expect(env.kind).toBe('choices');
    expect(env.href).toBeUndefined();
    expect(env.data).toEqual({
      options: [
        { label: "Let's do it", message: "Let's do it" },
        { label: 'What else?', message: 'What else can you do?' },
      ],
    });
    expect(env.summary.trim().length).toBeGreaterThan(0);
    expect(modelResult('offer_choices', env).data).toBe('shown');
  });

  it('refuses fewer than two or more than three options and labels over 28 characters', async () => {
    const opt = (label: string) => ({ label, message: 'ok' });
    const ctx = makeCtx(user);
    expect((await execute('offer_choices', { options: [opt('One')] }, ctx)).kind).toBe('error');
    expect(
      (await execute('offer_choices', { options: [opt('A'), opt('B'), opt('C'), opt('D')] }, ctx)).kind,
    ).toBe('error');
    const long = await execute('offer_choices', { options: [opt('x'.repeat(29)), opt('B')] }, ctx);
    expect(long.kind).toBe('error');
    const ok28 = await execute('offer_choices', { options: [opt('x'.repeat(28)), opt('B')] }, ctx);
    expect(ok28.kind).toBe('choices');
  });

  it('keeps dashes out of what the student sees', async () => {
    const env = await execute(
      'offer_choices',
      {
        options: [
          { label: 'Yes — do it', message: 'Yes — go ahead!' },
          { label: 'Not now', message: 'Not now' },
        ],
      },
      makeCtx(user),
    );
    const json = JSON.stringify(env.data);
    expect(json).not.toMatch(DASHES);
    expect(json).not.toContain('!');
  });
});

describe('show_setup', () => {
  it('google: reports whether it is connected and whether a client id exists', async () => {
    const env = await execute('show_setup', { what: 'google' }, makeCtx(user));
    expect(env.kind).toBe('setup');
    const d = env.data as { what: string; connected: boolean; clientIdConfigured: boolean; demo: boolean };
    expect(d.what).toBe('google');
    expect(d.connected).toBe(false);
    expect(d.demo).toBe(true);
    expect(d.clientIdConfigured).toBe(false);
    writePrefs({ googleClientId: 'abc.apps.googleusercontent.com' });
    const again = (await execute('show_setup', { what: 'google' }, makeCtx(user))).data as typeof d;
    expect(again.clientIdConfigured).toBe(true);
    writePrefs({ googleClientId: undefined });
  });

  it('linkedin: counts the people and the last import', async () => {
    const d = (await execute('show_setup', { what: 'linkedin' }, makeCtx(user))).data as {
      what: string;
      people: number;
    };
    expect(d.what).toBe('linkedin');
    expect(d.people).toBeGreaterThan(5);
  });

  it('claude_key: says whether a key is saved and never carries the key', async () => {
    const none = (await execute('show_setup', { what: 'claude_key' }, makeCtx(user))).data as {
      keySaved: boolean;
    };
    expect(none.keySaved).toBe(false);
    writePrefs({ anthropicApiKey: 'sk-ant-secret-value-123' });
    const env = await execute('show_setup', { what: 'claude_key' }, makeCtx(user));
    expect((env.data as { keySaved: boolean }).keySaved).toBe(true);
    expect(JSON.stringify(env)).not.toContain('secret-value');
    expect(JSON.stringify(modelResult('show_setup', env))).not.toContain('secret-value');
    writePrefs({ anthropicApiKey: undefined });
  });

  it('resume: reports the resume on file', async () => {
    const d = (await execute('show_setup', { what: 'resume' }, makeCtx(user))).data as {
      what: string;
      onFile: boolean;
      filename?: string;
    };
    expect(d.what).toBe('resume');
    const rows = (await db.resumes.where('userId').equals(user.id).toArray()).filter((r) => r.isCurrent);
    expect(d.onFile).toBe(rows.length > 0);
    if (rows.length) expect(d.filename).toBe(rows[0]!.filename);
  });

  it('rejects a widget it does not have', async () => {
    expect((await execute('show_setup', { what: 'slack' }, makeCtx(user))).kind).toBe('error');
  });
});

describe('auto-open flags', () => {
  it('open_page opens its link in the panel by itself', async () => {
    const env = await execute('open_page', { page: 'people', view: 'list' }, makeCtx(user));
    expect(env.autoOpen).toBe(true);
    expect(env.href).toBe('/people?view=list');
  });

  it('create_draft and redraft_with_inputs open the draft; a reading tool does not', async () => {
    const people = await db.people.where('userId').equals(user.id).toArray();
    const chats = await db.chats.where('userId').equals(user.id).toArray();
    const target = people.find(
      (p) => p.isHuman && !p.hiddenAt && !chats.some((c) => c.personId === p.id) && p.primaryEmail,
    )!;
    const made = await execute(
      'create_draft',
      { personId: target.id, kind: 'outreach', connection: 'I read your post about payments onboarding' },
      makeCtx(user),
    );
    expect(made.kind).toBe('draft');
    expect(made.autoOpen).toBe(true);
    expect(made.href).toBeTruthy();
    const draftId = (made.data as { ui: { id: string } }).ui.id;
    expect(draftId).toBeTruthy();
    const again = await execute(
      'redraft_with_inputs',
      { draftId, update: 'I just joined the finance society' },
      makeCtx(user),
    );
    expect(again.kind).toBe('draft');
    expect(again.autoOpen).toBe(true);
    expect(again.href).toBe(`/inbox?draft=${draftId}`);
    const list = await execute('list_drafts', { list: 'all' }, makeCtx(user));
    expect(list.autoOpen).toBeUndefined();
  });
});
