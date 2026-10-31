import { expect, type Page, test } from '@playwright/test';
import { type FakeOrbitApi, withFriend } from '../src/test/fakeOrbitApi';
import { withFakeApi } from './fakeApi';

/**
 * Friends (plan 29 Part A, A7 acceptance): two Orbit users pool their networks against the fake orbit-api. The flows
 * are written down here as the tests they will become; each is `fixme` until phase 2 lands the Friends tab, the
 * routes and the chat tools (C1). The fake already seeds Ana Okafor (120 shared people, six at the targets) through
 * `withFriend`, so every row has its data the day the screen exists.
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

async function signedInWithAna(page: Page): Promise<FakeOrbitApi> {
  const api = await withFakeApi(page);
  withFriend(api, { id: api.state.user.id, firstName: api.state.user.firstName ?? 'Maya' }, STUDENT_PEOPLE);
  await page.goto('');
  return api;
}

test.describe('friends (plan 29 A7, fake orbit-api)', () => {
  test.fixme('A invites B by email, B accepts, A sees "shares N people"', async ({ page }) => {
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

  test.fixme("A finds a route to B's contact on the Map, drawn through the friend", async ({ page }) => {
    await signedInWithAna(page);
    await page.goto('reach/stripe');
    const through = page.getByTestId('reach-through-friends');
    await expect(through).toContainText('Through friends: 2 people');
    await expect(through).toContainText('Dan Lee');
    await expect(page.getByTestId('route-badge-friend').first()).toContainText('via Ana');
  });

  test.fixme('A asks B for the intro: the ask goes to Ana with a blurb, never a note to Dan', async ({
    page,
  }) => {
    const api = await signedInWithAna(page);
    await page.goto('friends');
    await page.getByTestId('friend-ask-intro').first().click();
    await page.getByTestId('friend-ask-target').fill('Dan Lee');
    await page
      .getByTestId('friend-ask-note')
      .fill('Junior at Cornell on payments infra, would love 15 minutes.');
    await page.getByTestId('friend-ask-send').click();
    await expect(page.getByTestId('friend-asks-mine')).toContainText('Ana · Dan Lee · asked');
    expect(api.state.friendAsks.filter((a) => a.askerUserId === api.state.user.id)).toHaveLength(1);
    // nothing to Dan: no draft addressed to him exists
    expect([...api.state.drafts.values()].some((d) => /Dan/.test(d.body))).toBe(false);
  });

  test.fixme("B sees the ask, forwards it, and A's Drafts shows the forwarded card", async ({ page }) => {
    const api = await signedInWithAna(page);
    await page.goto('friends');
    const ask = page.getByTestId('friend-ask-received').first();
    await expect(ask).toContainText('Ana wants to meet Lena Novak at Ramp');
    await ask.getByRole('button', { name: /^forward/i }).click();
    // the forward is a draft the student approves like any other, with Ana in cc
    await expect(page.getByTestId('draft-body')).toContainText("Cc'ing Ana");
    await page.getByTestId('draft-approve').click();
    expect(api.state.friendAsks.find((a) => a.id === 'ask_ana_lena')?.status).toBe('forwarded');
    await expect(page.getByTestId('friend-asks-received')).toContainText('forwarded');
  });

  test.fixme('revoke sharing and the route through the friend is gone', async ({ page }) => {
    const api = await signedInWithAna(page);
    await page.goto('friends');
    await page.getByTestId('friend-share-mode').first().selectOption('none');
    await expect(page.getByTestId('friend-share-preview')).toContainText('Ana sees nothing yet');
    expect(api.state.friendShareMode).toBe('none');
    // the other direction: ending the friendship removes Ana's people from Reach within the same load
    await page.getByTestId('friend-end').first().click();
    await page.getByRole('button', { name: /^end friendship/i }).click();
    await page.goto('reach/stripe');
    await expect(page.getByTestId('reach-through-friends')).toHaveCount(0);
  });

  test.fixme('the preview equals the projection row for row, and never carries an address', async ({
    page,
  }) => {
    const api = await signedInWithAna(page);
    await page.goto('friends');
    await page.getByTestId('friend-share-preview-open').click();
    const rows = page.getByTestId('share-preview-row');
    await expect(rows).toHaveCount(api.state.ownShares.length);
    for (const row of api.state.ownShares) await expect(page.getByText(row.displayName)).toBeVisible();
    await expect(page.getByTestId('share-preview')).not.toContainText('@');
  });

  test.fixme('local mode: the tab is one paragraph and the sign-in', async ({ page }) => {
    await page.goto('friends');
    await expect(page.getByTestId('friends-needs-account')).toContainText('Friends pool their networks');
    await expect(page.getByTestId('ob-google-signin')).toBeVisible();
  });
});
