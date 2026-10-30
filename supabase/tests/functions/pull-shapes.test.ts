/**
 * Every field a core mapper (packages/core/src/server/mappers.ts) reads straight from a column must reach the browser
 * under the same name through /sync/pull's generic shaping: a field the browser's screens read that the pull sends
 * under another name is simply missing in account mode (a role with no company, a merge suggestion with no people).
 */
import { describe, expect, it } from 'vitest';
import * as M from '../../../packages/core/src/server/mappers.ts';
import { PULL_BY_NAME, shapeRow } from '../../functions/orbit-api/tables.ts';

const COLUMNS: Record<string, [string[], (r: never) => unknown]> = {
  affiliations: [
    [
      'id',
      'user_id',
      'person_id',
      'org_id',
      'org_raw',
      'kind',
      'title',
      'degree',
      'field',
      'start_date',
      'end_date',
      'source',
    ],
    M.affiliationFromRow as never,
  ],
  merge_suggestions: [
    ['id', 'user_id', 'person_a', 'person_b', 'created_at'],
    M.mergeSuggestionFromRow as never,
  ],
  threads: [
    ['id', 'user_id', 'provider', 'external_id', 'subject', 'first_at', 'last_at', 'category', 'chat_id'],
    ((r: never) => M.threadFromRow(r)) as never,
  ],
  calendar_events: [
    [
      'id',
      'user_id',
      'external_id',
      'title',
      'description',
      'start_at',
      'end_at',
      'conference_url',
      'chat_id',
    ],
    M.calendarEventFromRow as never,
  ],
  chats: [
    ['id', 'user_id', 'person_id', 'goal_id', 'org_id', 'stage', 'stage_entered_at'],
    M.chatFromRow as never,
  ],
  people: [
    [
      'id',
      'user_id',
      'display_name',
      'name_norm',
      'primary_email',
      'headline',
      'title',
      'org_id',
      'org_raw',
      'location',
    ],
    ((r: never) => M.personFromRow(r)) as never,
  ],
  organizations: [
    ['id', 'user_id', 'name', 'name_norm', 'linkedin_slug', 'industry'],
    M.organizationFromRow as never,
  ],
};

describe('pull shapes', () => {
  for (const [table, [cols, fromRow]] of Object.entries(COLUMNS))
    it(`${table} sends every column-backed field under the browser's name`, () => {
      const row: Record<string, unknown> = {
        data: {},
        attendees: [],
        attendee_person_ids: [],
        participant_person_ids: [],
        domains: [],
        sources: [],
        tags: [],
      };
      for (const c of cols) row[c] = `v:${c}`;
      const want = fromRow(row as never) as Record<string, unknown>;
      const got = shapeRow(PULL_BY_NAME.get(table)!, row);
      const missing = Object.entries(want)
        .filter(([k, v]) => typeof v === 'string' && v.startsWith('v:') && got[k] !== v)
        .map(([k]) => k);
      expect(missing).toEqual([]);
    });

  it('merge suggestions arrive with the browser status', () => {
    const t = PULL_BY_NAME.get('merge_suggestions')!;
    expect(shapeRow(t, { status: 'open' }).status).toBe('pending');
    expect(shapeRow(t, { status: 'merged' }).status).toBe('accepted');
    expect(shapeRow(t, { status: 'rejected' }).status).toBe('rejected');
  });
});
