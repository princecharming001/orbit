import { expect, type Page, test } from '@playwright/test';
import { type FakeOrbitApi, withFriend } from '../src/test/fakeOrbitApi';
import { withFakeApi } from './fakeApi';

/**
 * Friends (plan 29 Part A, A7 acceptance): two Orbit users pool their networks against the fake orbit-api. The fake
 * seeds Ana Okafor (120 shared people, six at the targets) through `withFriend`, with one open ask of the student
 * (Lena Novak at Ramp). Both sides run in one browser: the student is signed in, Ana's side is the fake's state.
 */

/** The demo student's people, as the fake's seed wants them (names only; the join is by name, A2.6). */
const STUDENT_PEOPLE = [
  {
    id: 'p_maya_chen',
    displayName: 'Maya Chen',
    currentTitle: 'Software Engineer',
    currentOrganizationRaw: 'Stripe',
  },
  {
    id: 'p_lena_novak',
    displayName: 'Lena Novak',
    currentTitle: 'Engineering Manager',
    currentOrganizationRaw: 'Ramp',
  },
];

/** Signed in to an account that finished setup elsewhere, with Ana as a friend. */
async function signedInWithAna(page: Page): Promise<FakeOrbitApi> {
  const api = await withFakeApi(page);
  withFriend(api, { id: api.state.user.id, firstName: api.state.user.firstName ?? 'Maya' }, STUDENT_PEOPLE);
  api.state.user.onboarding = { completed_at: '2026-10-05T12:00:00.000Z' };
  await page.goto('');
  await page.getByTestId('landing-login').click();
  await expect(page.getByTestId('greeting')).toBeVisible({ timeout: 20_000 });
  return api;
}

test.describe('friends (plan 29 A7, fake orbit-api)', () => {
  test('A invites B by email, B accepts, A sees "shares N people"', async ({ page }) => {
    const api = await signedInWithAna(page);
    await page.goto('friends');
    await page.getByTestId('friends-invite-email').fill('noah.patel@cornell.edu');
    await page.getByTestId('friends-invite-send').click();
    await expect(page.getByTestId('friends-pending')).toContainText('noah.patel@cornell.edu');
    // the other side: the request arrives and is accepted, sharing everyone back
    expect(api.state.friendInvites.filter((i) => i.status === 'pending')).toHaveLength(1);
    await expect(page.getByTestId('friend-row').first()).toContainText('shares 120 people');
    await expect(page.getByTestId('friend-row').first()).toContainText('6 at your targets');
  });

  test("A finds a route to B's contact on the Map, drawn through the friend", async ({ page }) => {
    await signedInWithAna(page);
    await page.goto('map?reach=1&company=Stripe');
    const through = page.getByTestId('reach-through-friends');
    await expect(through).toContainText('Through friends: 2 people', { timeout: 20_000 });
    await expect(through).toContainText('Dan Lee');
    await expect(page.getByTestId('route-badge-friend').first()).toContainText('via Ana');
  });

  test('A asks B for the intro: the ask goes to Ana with a blurb, never a note to Dan', async ({ page }) => {
    const api = await signedInWithAna(page);
    await page.goto('friends');
    await page.getByTestId('friend-ask-intro').first().click();
    await page.getByTestId('friend-ask-target').fill('Dan Lee');
    await expect(page.getByTestId('friend-ask-picked')).toContainText('Dan Lee');
    await page
      .getByTestId('friend-ask-note')
      .fill('Junior at Cornell on payments infra, would love 15 minutes.');
    await page.getByTestId('friend-ask-send').click();
    await expect(page.getByTestId('friend-asks-mine')).toContainText('Ana · Dan Lee · asked');
    expect(api.state.friendAsks.filter((a) => a.askerUserId === api.state.user.id)).toHaveLength(1);
    // nothing to Dan: no draft addressed to him exists
    expect([...api.state.drafts.values()].some((d) => /Dan/.test(d.body))).toBe(false);
  });

  test("B sees the ask, forwards it, and A's Drafts shows the forwarded card", async ({ page }) => {
    const api = await signedInWithAna(page);
    await page.goto('friends');
    const ask = page.getByTestId('friend-ask-received').first();
    await expect(ask).toContainText('Ana wants to meet Lena Novak at Ramp');
    await ask.getByRole('button', { name: /^forward/i }).click();
    // the forward is a draft the student approves like any other, with Ana in cc
    await expect(page.getByTestId('draft-body')).toContainText("Cc'ing Ana");
    await page.getByTestId('draft-approve').click();
    await expect(page.getByTestId('friend-forward-approved')).toBeVisible();
    expect(api.state.friendAsks.find((a) => a.id === 'ask_ana_lena')?.status).toBe('forwarded');
    await expect(page.getByTestId('friend-asks-received')).toContainText('forwarded');
  });

  test('revoke sharing and the route through the friend is gone', async ({ page }) => {
    const api = await signedInWithAna(page);
    await page.goto('friends');
    await expect(page.getByTestId('friend-row').first()).toBeVisible();
    // what the student shares is set on the friend's own row
    await page.getByTestId('friend-row-share-mode').first().selectOption('none');
    await expect.poll(() => api.state.friends[0]?.myMode).toBe('none');
    // the other direction: ending the friendship removes Ana's people from Reach within the same load
    await page.getByTestId('friend-end').first().click();
    await page.getByRole('button', { name: /^end friendship/i }).click();
    await expect(page.getByTestId('friends-empty')).toBeVisible();
    await page.goto('map?reach=1&company=Stripe');
    await expect(page.getByTestId('company-none')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('reach-through-friends')).toHaveCount(0);
  });

  test('local mode: the tab is one paragraph and the sign-in', async ({ page }) => {
    // an account-capable build, nobody signed in: the demo student opens Friends
    await withFakeApi(page);
    await page.goto('');
    await page
      .getByRole('button', { name: /^try the demo$/i })
      .first()
      .click();
    await expect(page.getByTestId('greeting')).toContainText(/^Hey /, { timeout: 90_000 });
    await page.goto('friends');
    await expect(page.getByTestId('friends-needs-account')).toContainText('Friends pool their networks');
    await expect(page.getByTestId('ob-google-signin')).toBeVisible();
  });
});
test.describe('finding friends (plan 37 follow-up, fake orbit-api)', () => {
  test('people on Orbit you may know: Add turns to Requested, an incoming one is accepted in place', async ({
    page,
  }) => {
    const api = await signedInWithAna(page);
    api.state.friendInvites.push({
      id: 'fs_priya',
      direction: 'in',
      email: null,
      name: 'Priya Shah',
      status: 'pending',
      createdAt: '2026-10-06T08:00:00.000Z',
    });
    await page.goto('friends');
    const grid = page.getByTestId('friends-on-orbit');
    const tiles = grid.getByTestId('friend-suggestion');
    // Priya asked first: she is under Requests, not suggested again beside it
    await expect(tiles).toHaveCount(2);
    await expect(grid).not.toContainText('Priya Shah');
    await expect(tiles.first()).toContainText('Jordan Ellis');
    await expect(tiles.first()).toContainText('In your contacts');
    // no address ever shows
    await expect(grid).not.toContainText('@');
    // a name opens the person: their LinkedIn here, in a new tab
    await expect(tiles.nth(1).getByTestId('tile-name')).toHaveAttribute(
      'href',
      'https://www.linkedin.com/in/marcus-wei',
    );
    // someone to invite opens their page in Orbit
    await expect(page.getByTestId('friend-invitee').first().getByTestId('tile-name')).toHaveAttribute(
      'href',
      /\/people\/p_inv_sam$/,
    );
    await tiles.first().getByTestId('friend-suggestion-add').click();
    await expect(tiles.first().getByTestId('friend-suggestion-add')).toHaveText('Requested');
    expect(api.state.friendFinder.requests).toEqual(['u_jordan']);
    // found by search, her tile offers Accept, and accepting makes her a friend
    await page.getByTestId('friends-search-input').fill('priya');
    const priya = page.getByTestId('friends-search-results').getByTestId('friend-suggestion');
    await expect(priya.getByTestId('friend-suggestion-add')).toHaveText('Accept');
    await priya.getByTestId('friend-suggestion-add').click();
    await expect(priya.getByTestId('friend-suggestion-add')).toHaveText('Friends');
    await expect(page.getByTestId('friends-list')).toContainText('Priya Shah');
  });

  test('people to invite: Invite turns to Invited and the invite goes to the address Orbit has', async ({
    page,
  }) => {
    const api = await signedInWithAna(page);
    await page.goto('friends');
    const sam = page.getByTestId('friend-invitee').filter({ hasText: 'Sam Okafor' });
    await expect(sam).toContainText('You know them well');
    await sam.getByTestId('friend-invitee-invite').click();
    await expect(sam.getByTestId('friend-invitee-invite')).toHaveText('Invited');
    expect(api.state.friendFinder.invitedPeople).toEqual(['p_inv_sam']);
    // someone with no address: the invite goes as a LinkedIn message, and the toast says so
    const lee = page.getByTestId('friend-invitee').filter({ hasText: 'Lee Park' });
    await lee.getByTestId('friend-invitee-invite').click();
    await expect(lee.getByTestId('friend-invitee-invite')).toHaveText('Invited');
    await expect(page.getByTestId('toasts')).toContainText('Invite sent to Lee on LinkedIn.');
    // no photo: a plain silhouette, never letters made up from the name
    await expect(lee.getByTestId('tile-no-photo')).toBeVisible();
  });

  test('search: a name among people you may know, an exact address among everyone, and a plain miss', async ({
    page,
  }) => {
    await signedInWithAna(page);
    await page.goto('friends');
    const input = page.getByTestId('friends-search-input');
    await input.fill('jordan');
    const results = page.getByTestId('friends-search-results');
    await expect(results.getByTestId('friend-suggestion')).toHaveCount(1);
    await expect(results).toContainText('Jordan Ellis');
    await input.fill('noor@example.org');
    await expect(results).toContainText('Noor Haddad');
    await results.getByTestId('friend-suggestion-add').click();
    await expect(results.getByTestId('friend-suggestion-add')).toHaveText('Requested');
    await input.fill('zzzz');
    await expect(page.getByTestId('friends-search-none')).toContainText('Try their email');
  });

  test('the invite link: shown, copied, and a reset makes a new one', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await signedInWithAna(page);
    await page.goto('friends');
    const text = page.getByTestId('friends-link-text');
    await expect(text).toContainText('tryorbit.today/friends/join/standinglink0000000001');
    await page.getByTestId('friends-link-copy').click();
    await page.getByTestId('friends-link-reset').click();
    await expect(text).not.toContainText('standinglink0000000001');
  });

  test('there is always a way to see more people to invite, until there is nobody left', async ({ page }) => {
    const api = await signedInWithAna(page);
    // sixty connections worth inviting: more than one batch from the server (24 at a time)
    api.state.friendFinder.toInvite = Array.from({ length: 60 }, (_, i) => ({
      personId: `p_inv_${String(i).padStart(2, '0')}`,
      name: `Pat Number${String(i).padStart(2, '0')}`,
      photoUrl: null,
      headline: 'Engineer at Ramp',
      reason: 'You know them well',
      via: 'email' as const,
    }));
    await page.goto('friends');
    const grid = page.getByTestId('friends-to-invite');
    const tiles = grid.getByTestId('friend-invitee');
    const more = grid.getByTestId('friends-to-invite-more');
    // two rows first, and the count says there are more than the batch in hand
    await expect(tiles).toHaveCount(10);
    await expect(grid.getByTestId('friends-to-invite-count')).toHaveText('24+');
    await expect(more).toHaveText(/Show more/);
    // each tap adds three rows: from what is loaded, then from the server
    const calls = () => api.calls.filter((c) => c.route === '/friends/suggest').length;
    const before = calls();
    await more.click();
    await expect(tiles).toHaveCount(25);
    expect(calls()).toBe(before + 1);
    await more.click();
    await expect(tiles).toHaveCount(40);
    await more.click();
    await expect(tiles).toHaveCount(55);
    await more.click();
    await expect(tiles).toHaveCount(60);
    // everyone, once each, in the server's order
    const names = await tiles.getByTestId('tile-name').allTextContents();
    expect(new Set(names).size).toBe(60);
    expect(names[0]).toBe('Pat Number00');
    expect(names[59]).toBe('Pat Number59');
    // the end says so, and the count is the real one
    await expect(grid.getByTestId('friends-to-invite-end')).toHaveText('That is everyone');
    await expect(more).toHaveCount(0);
    await expect(grid.getByTestId('friends-to-invite-count')).toHaveText('60');
    // and it folds back to two rows
    await grid.getByTestId('friends-to-invite-fewer').click();
    await expect(tiles).toHaveCount(10);
    await expect(more).toBeVisible();
  });

  test('inviting someone and then asking for more never skips or repeats anyone', async ({ page }) => {
    const api = await signedInWithAna(page);
    api.state.friendFinder.toInvite = Array.from({ length: 30 }, (_, i) => ({
      personId: `p_inv_${String(i).padStart(2, '0')}`,
      name: `Pat Number${String(i).padStart(2, '0')}`,
      photoUrl: null,
      headline: 'Engineer at Ramp',
      reason: 'You know them well',
      via: 'email' as const,
    }));
    await page.goto('friends');
    const grid = page.getByTestId('friends-to-invite');
    const tiles = grid.getByTestId('friend-invitee');
    await expect(tiles).toHaveCount(10);
    // invite the first two: they leave the server's list, so the next batch starts two earlier
    await tiles
      .nth(0)
      .getByRole('button', { name: /invite/i })
      .click();
    await tiles
      .nth(1)
      .getByRole('button', { name: /invite/i })
      .click();
    await expect.poll(() => api.state.friendFinder.invitedPeople.length).toBe(2);
    await grid.getByTestId('friends-to-invite-more').click();
    await grid.getByTestId('friends-to-invite-more').click();
    await expect(tiles).toHaveCount(30);
    const names = await tiles.getByTestId('tile-name').allTextContents();
    expect(new Set(names).size).toBe(30);
    await expect(grid.getByTestId('friends-to-invite-end')).toBeVisible();
  });
});
