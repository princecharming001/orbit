import type { User } from '@orbit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db/schema';
import { loadDemo } from '../../engine/demo';
import { clearPrefs } from '../../integrations/prefs';
import { execute } from '../registry';
import { makeCtx, NOW } from './helpers';

/**
 * The links the chat's tools hand the UI: Today is gone (its cards are in Drafts, its brief in the chat) and the
 * Pipeline is the People page's board, so no tool may point at either any more.
 */
let user: User;
beforeAll(async () => {
  await clearPrefs();
  user = await loadDemo({ reset: true, now: NOW });
}, 90_000);

describe('open_page', () => {
  it('opens People on the view asked for, with the Pipeline as an older name of its board', async () => {
    const href = async (input: Record<string, unknown>) =>
      (await execute('open_page', input, makeCtx(user))).href;
    expect(await href({ page: 'people' })).toBe('/people');
    expect(await href({ page: 'people', view: 'board' })).toBe('/people?view=board');
    expect(await href({ page: 'people', view: 'companies' })).toBe('/people?view=companies');
    expect(await href({ page: 'people', view: 'table' })).toBe('/people?view=list');
    expect(await href({ page: 'people', quiet: true })).toBe('/people?quiet=1');
    expect(await href({ page: 'pipeline' })).toBe('/people?view=board');
    expect(await href({ page: 'pipeline', view: 'table', quiet: true })).toBe('/people?view=list&quiet=1');
  });

  it('takes Today as Drafts, focused on the card or person it names', async () => {
    const env = await execute('open_page', { page: 'today' }, makeCtx(user));
    expect(env.href).toBe('/inbox');
    expect((env.data as { ui: { page: string } }).ui.page).toBe('drafts');
    expect((await execute('open_page', { page: 'today', cardId: 's_1' }, makeCtx(user))).href).toBe(
      '/inbox?card=s_1',
    );
    expect((await execute('open_page', { page: 'drafts', personId: 'p4' }, makeCtx(user))).href).toBe(
      '/inbox?person=p4',
    );
  });
});

describe('tool links', () => {
  it('the brief opens Drafts, and each card links to itself there', async () => {
    const env = await execute('get_today_brief', {}, makeCtx(user));
    expect(env.href).toBe('/inbox');
    const ui = (env.data as { ui: { cards: { href: string }[]; nextUp?: { startAt: string } } }).ui;
    for (const c of ui.cards) expect(c.href).toMatch(/^\/inbox\?card=/);
    // the demo has a chat coming up this week: the brief card names it
    expect(ui.nextUp?.startAt).toBeTruthy();
  });

  it('the pipeline, a stage and people searches open the People page', async () => {
    expect((await execute('list_pipeline', {}, makeCtx(user))).href).toBe('/people?view=board');
    expect((await execute('list_pipeline', { view: 'table' }, makeCtx(user))).href).toBe('/people?view=list');
    expect((await execute('list_pipeline', { quietOnly: true }, makeCtx(user))).href).toBe(
      '/people?view=board&quiet=1',
    );
    expect((await execute('list_pipeline', { view: 'companies' }, makeCtx(user))).href).toBe(
      '/people?view=companies',
    );
    expect((await execute('explain_stage', {}, makeCtx(user))).href).toBe('/people?view=board');
    expect((await execute('search_people', { query: 'a' }, makeCtx(user))).href).toBe('/people?view=list');
    const pipe = await execute('list_pipeline', {}, makeCtx(user));
    const rows = (pipe.data as { ui: { rows: { nextCard?: { href: string } }[] } }).ui.rows;
    const next = rows.find((r) => r.nextCard)?.nextCard;
    expect(next?.href).toMatch(/^\/inbox\?card=/);
  });

  it('no tool result names Today as a place', async () => {
    const chat = (await db.chats.where('userId').equals(user.id).toArray())[0]!;
    const results = [
      await execute('get_today_brief', {}, makeCtx(user)),
      await execute('list_pipeline', {}, makeCtx(user)),
      await execute('explain_stage', { stage: chat.stage }, makeCtx(user)),
      await execute('open_page', { page: 'today' }, makeCtx(user)),
    ];
    for (const env of results) {
      expect(env.href ?? '').not.toMatch(/\/today|\/pipeline/);
      expect(env.summary).not.toMatch(/on Today|Open Today/);
    }
  });
});
