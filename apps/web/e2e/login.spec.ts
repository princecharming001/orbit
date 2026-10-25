import { expect, type Page, test } from '@playwright/test';
import { loadDemo } from './helpers';

/** Add a finished local profile beside the demo, straight into IndexedDB, as if someone had set Orbit up here. */
async function addSavedProfile(page: Page, name: string) {
  await page.evaluate(async (fullName) => {
    const open = indexedDB.open('orbit');
    const idb: IDBDatabase = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
    const demo: Record<string, unknown> = await new Promise((res) => {
      const r = idb.transaction('users').objectStore('users').get('demo-user');
      r.onsuccess = () => res(r.result);
    });
    const [firstName, lastName] = fullName.split(' ');
    await new Promise<void>((res, rej) => {
      const tx = idb.transaction('users', 'readwrite');
      tx.objectStore('users').put({
        ...demo,
        id: 'u_saved',
        fullName,
        firstName,
        lastName,
        email: 'sam@umich.edu',
      });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }, name);
}

test.describe('Log out and log in', () => {
  test('log out from the sidebar menu, then log back in to the profile saved in this browser', async ({
    page,
  }) => {
    await loadDemo(page);
    await addSavedProfile(page, 'Sam Lee');
    // Dexie only sees writes it made itself: a reload reads the new profile
    await page.goto('');
    await expect(page.getByTestId('greeting')).toBeVisible({ timeout: 30_000 });
    // the sidebar's account row opens a menu with Log out
    const rail = page.getByTestId('rail');
    await rail.getByTestId('account-row').click();
    await expect(page.getByTestId('account-menu')).toBeVisible();
    await page.getByTestId('log-out').click();
    await expect(page.getByText(/^Logged out\./)).toBeVisible();
    await expect(page.getByRole('button', { name: /^try the demo$/i }).first()).toBeVisible();
    // the landing page offers Log in, which lists the saved profile (never the demo)
    await page.getByTestId('landing-login').click();
    await expect(page).toHaveURL(/\/login$/);
    const profiles = page.getByTestId('login-profile');
    await expect(profiles).toHaveCount(1);
    await expect(profiles.first()).toContainText('Sam Lee');
    await profiles.first().click();
    await expect(page.getByTestId('greeting')).toBeVisible({ timeout: 30_000 });
    await expect(rail.getByTestId('account-row')).toContainText('Sam Lee');
    // logged in already: /login has nothing to do
    await page.goto('login');
    await expect(page.getByTestId('greeting')).toBeVisible({ timeout: 30_000 });
  });

  test('with nothing saved in this browser, Log in says so instead of making a second profile', async ({
    page,
  }) => {
    await page.goto('login');
    await expect(page.getByTestId('login-none')).toBeVisible();
    await expect(page.getByTestId('login-profile')).toHaveCount(0);
    await expect(page.getByTestId('login')).not.toHaveText(/[–—]/);
  });
});
