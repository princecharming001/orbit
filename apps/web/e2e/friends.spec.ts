import { expect, type Page, test } from '@playwright/test';
import { type FakeOrbitApi, fakeFriend, withFriend } from '../src/test/fakeOrbitApi';
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
    // the invite waits under Requested, with the one line that is true of someone not on Orbit yet
    const requested = page.getByTestId('friends-requested');
    await expect(requested.getByTestId('friends-requested-count')).toHaveText('1');
    const row = requested.getByTestId('friends-requested-row');
    await expect(row.getByTestId('friends-requested-row-name')).toHaveText('noah.patel@cornell.edu');
    await expect(row.getByTestId('friends-requested-row-line')).toHaveText(
      'Invite emailed, not on Orbit yet',
    );
    await expect(page.getByTestId('toasts')).toContainText(
      'Invite sent to noah.patel@cornell.edu from your Gmail.',
    );
    // the same address again is the invite already waiting: still one line, and it says nothing was sent again
    await page.getByTestId('friends-invite-email').fill('Noah.Patel@cornell.edu');
    await page.getByTestId('friends-invite-send').click();
    await expect(page.getByTestId('toasts')).toContainText('You already invited');
    await expect(requested.getByTestId('friends-requested-count')).toHaveText('1');
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
    // nothing sent yet: the side column has no Requested section
    await expect(page.getByTestId('friends-requested')).toHaveCount(0);
    await tiles.first().getByTestId('friend-suggestion-add').click();
    await expect(tiles.first().getByTestId('friend-suggestion-add')).toHaveText('Requested');
    expect(api.state.friendFinder.requests).toEqual(['u_jordan']);
    // and the request shows in the side column, waiting on Jordan
    const sent = page.getByTestId('friends-requested').getByTestId('friends-requested-row');
    await expect(sent).toHaveCount(1);
    await expect(sent.getByTestId('friends-requested-row-name')).toHaveText('Jordan Ellis');
    await expect(sent.getByTestId('friends-requested-row-line')).toHaveText('Request sent');
    await expect(page.getByTestId('friends-requested-count')).toHaveText('1');
    // found by search, her tile offers Accept, and accepting makes her a friend
    await page.getByTestId('friends-search-input').fill('priya');
    const priya = page.getByTestId('friends-search-results').getByTestId('friend-suggestion');
    await expect(priya.getByTestId('friend-suggestion-add')).toHaveText('Accept');
    await priya.getByTestId('friend-suggestion-add').click();
    await expect(priya.getByTestId('friend-suggestion-add')).toHaveText('Friends');
    await expect(page.getByTestId('friends-yours')).toContainText('Priya Shah');
    await expect(page.getByTestId('friends-yours-count')).toHaveText('2');
    // her request is answered: it is no longer waiting in the side column
    await expect(page.getByTestId('friends-requests')).toHaveCount(0);
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

  test('the invite link: shown in one field, copied whole, and reset only after it asks', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const api = await signedInWithAna(page);
    // a browser dialog would be a failure: the question is asked in the page
    let dialogs = 0;
    page.on('dialog', (d) => {
      dialogs++;
      void d.dismiss();
    });
    await page.goto('friends');
    const section = page.getByTestId('friends-invite-link');
    await expect(section.getByRole('heading', { name: 'Invite link' })).toBeVisible();
    await expect(section).toContainText('Share it in a group chat to add friends.');
    const text = page.getByTestId('friends-link-text');
    await expect(text).toHaveText('tryorbit.today/friends/join/standinglink0000000001');
    // one line that never runs out of its field, with Copy inside the field on the right
    const copy = page.getByTestId('friends-invite-copy');
    const [textBox, copyBox, sectionBox] = await Promise.all([
      text.boundingBox(),
      copy.boundingBox(),
      section.boundingBox(),
    ]);
    expect(textBox!.height).toBeLessThan(28);
    expect(textBox!.x + textBox!.width).toBeLessThanOrEqual(copyBox!.x);
    expect(copyBox!.x + copyBox!.width).toBeLessThanOrEqual(sectionBox!.x + sectionBox!.width);
    await copy.click();
    await expect(copy).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'https://tryorbit.today/friends/join/standinglink0000000001',
    );
    // Reset link asks first; Cancel leaves the link as it was and the server unasked
    const resets = () => api.calls.filter((c) => c.route === '/friends/link' && c.body.reset === true).length;
    await page.getByTestId('friends-invite-reset').click();
    await expect(page.getByTestId('friends-invite-reset-ask')).toContainText(
      'Reset? The old link stops working.',
    );
    await page.getByTestId('friends-invite-reset-cancel').click();
    await expect(page.getByTestId('friends-invite-reset-ask')).toHaveCount(0);
    await expect(text).toContainText('standinglink0000000001');
    expect(resets()).toBe(0);
    // Reset, then Reset: a new link in the field, and the old one is gone
    await page.getByTestId('friends-invite-reset').click();
    await page.getByTestId('friends-invite-reset-confirm').click();
    await expect(text).not.toContainText('standinglink0000000001');
    await expect(text).toContainText('tryorbit.today/friends/join/');
    await expect(page.getByTestId('friends-invite-reset-ask')).toHaveCount(0);
    await expect(page.getByTestId('toasts')).toContainText('The old one no longer works.');
    expect(resets()).toBe(1);
    expect(dialogs).toBe(0);
  });

  test('the side column: the link, who you asked, and your friends with where each one stands', async ({
    page,
  }) => {
    const api = await signedInWithAna(page);
    // seven friends in all: Ana (ready), one still syncing, one sharing nothing, one with nobody visible yet
    const filler = { ...api.state.friends[0]!.people[0]!, personId: 'x_p_1' };
    api.state.friends.push(
      fakeFriend({
        friendshipId: 'fr_ben',
        userId: 'u_ben',
        name: 'Ben Ito',
        people: [filler],
        syncing: true,
      }),
      fakeFriend({ friendshipId: 'fr_cara', userId: 'u_cara', name: 'Cara Diaz', theirMode: 'none' }),
      fakeFriend({ friendshipId: 'fr_dev', userId: 'u_dev', name: 'Dev Rao' }),
      fakeFriend({ friendshipId: 'fr_eli', userId: 'u_eli', name: 'Eli Marsh', people: [filler] }),
      fakeFriend({ friendshipId: 'fr_fay', userId: 'u_fay', name: 'Fay Quinn', people: [filler] }),
      fakeFriend({
        friendshipId: 'fr_gus',
        userId: 'u_gus',
        name: 'Gus Hale',
        people: [filler],
        linkedinUrl: 'https://www.linkedin.com/in/gus-hale',
      }),
    );
    api.state.friendInvites.push({
      id: 'inv_noah',
      direction: 'out',
      email: 'noah.patel@cornell.edu',
      name: null,
      status: 'pending',
      createdAt: '2026-10-06T08:00:00.000Z',
    });
    api.state.friendFinder.requests.push('u_marcus');
    await page.goto('friends');
    const column = page.getByTestId('friends-column');
    // top to bottom: the link, what was asked, the friends
    await expect(column.locator('h2')).toHaveText([/^Invite link$/, /^Requested\s*2$/, /^Your friends\s*7$/]);
    const requested = column.getByTestId('friends-requested-row');
    await expect(requested).toHaveCount(2);
    await expect(requested.nth(1)).toContainText('Marcus Wei');
    await expect(requested.nth(1)).toContainText('Request sent');
    await expect(requested.nth(1).getByTestId('friends-requested-row-name')).toHaveAttribute(
      'href',
      'https://www.linkedin.com/in/marcus-wei',
    );
    // five friends first, each a square photo with the name and one line under it
    const rows = column.getByTestId('friends-yours-row');
    await expect(rows).toHaveCount(5);
    await expect(rows.getByTestId('friends-yours-row-name')).toHaveText([
      'Ana Okafor',
      'Ben Ito',
      'Cara Diaz',
      'Dev Rao',
      'Eli Marsh',
    ]);
    await expect(rows.getByTestId('friends-yours-row-line')).toHaveText([
      'Ready to search',
      'Still syncing',
      'Not sharing their network',
      'Nothing to search yet',
      'Ready to search',
    ]);
    const photo = await rows.first().locator('[data-shape="square"]').boundingBox();
    expect(Math.round(photo!.width)).toBe(56);
    expect(Math.round(photo!.height)).toBe(56);
    // See more shows everyone; with nothing more to show, the button to see more is gone
    await column.getByTestId('friends-yours-more').click();
    await expect(rows).toHaveCount(7);
    await expect(column.getByTestId('friends-yours-more')).toHaveCount(0);
    await expect(rows.last().getByTestId('friends-yours-row-name')).toHaveAttribute(
      'href',
      'https://www.linkedin.com/in/gus-hale',
    );
    await column.getByTestId('friends-yours-fewer').click();
    await expect(rows).toHaveCount(5);
    // a photo jumps to that friend's full row, where the intro and what you share live
    await rows.nth(1).getByTestId('friends-yours-row-photo').click();
    await expect(page.locator('[data-testid="friend-row"][data-friend-id="u_ben"]')).toBeInViewport();
    // nothing in the column runs wider than the column, and the page never scrolls sideways
    const wide = await page.evaluate(() => {
      const col = document.querySelector('[data-testid="friends-column"]')!;
      const right = col.getBoundingClientRect().right;
      const over = [...col.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > right + 1);
      return {
        over: over.length,
        sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(wide.over).toBe(0);
    expect(wide.sideways).toBeLessThanOrEqual(0);
    // house rules: no long dashes and no exclamation marks anywhere in the column
    expect(await column.innerText()).not.toMatch(/[—–!]/);
  });

  test('with five friends or fewer there is no See more', async ({ page }) => {
    await signedInWithAna(page);
    await page.goto('friends');
    await expect(page.getByTestId('friends-yours-row')).toHaveCount(1);
    await expect(page.getByTestId('friends-yours-count')).toHaveText('1');
    await expect(page.getByTestId('friends-yours-more')).toHaveCount(0);
    await expect(page.getByTestId('friends-requested')).toHaveCount(0);
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
