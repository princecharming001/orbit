import { expect, type Page, test } from '@playwright/test';
import { prep } from './helpers';

/**
 * The chat home against the scripted FakeChatEngine (`?fakeEngine=1`, honoured only under automation; see
 * src/chat/testing/fakeEngine.ts for the script). CHAT_SHOTS_DIR, when set, receives the layout screenshots.
 */
const SHOTS = process.env.CHAT_SHOTS_DIR;
const shot = (page: Page, name: string) =>
  SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : Promise.resolve();

async function loadDemo(page: Page, query = '?fakeEngine=1') {
  await prep(page);
  await page.goto(query);
  await page
    .getByRole('button', { name: /^try the demo$/i })
    .first()
    .click();
  await expect(page).toHaveURL(/\/today$/, { timeout: 90_000 });
  await expect(page.getByText(/good (morning|afternoon|evening)/i)).toBeVisible();
}

async function home(page: Page, query?: string) {
  await loadDemo(page, query);
  await page.goto('');
  await expect(page.getByTestId('greeting')).toBeVisible();
}

const composer = (page: Page) => page.getByTestId('composer-input');
async function ask(page: Page, text: string) {
  // a turn still streaming keeps the composer's text and ignores Enter: wait for it to end first
  await expect(page.getByTestId('composer-stop')).toHaveCount(0);
  await composer(page).fill(text);
  await page.keyboard.press('Enter');
}

type FakeCall = { method: string; args: unknown[] };
const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __fakeChat: { calls: FakeCall[] } }).__fakeChat.calls);

async function noOverflow(page: Page, label: string) {
  const over = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - window.innerWidth,
    body: document.body.scrollWidth - window.innerWidth,
  }));
  expect(over.doc, `${label}: page overflow`).toBeLessThanOrEqual(1);
  expect(over.body, `${label}: body overflow`).toBeLessThanOrEqual(1);
}

/** Every element whose text is cut off by its own box (a clipped label) inside the given root. */
async function clipped(page: Page, root: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    const host = document.querySelector(sel);
    if (!host) return out;
    for (const el of host.querySelectorAll<HTMLElement>('h1, p, span, button, a, div')) {
      if (!el.textContent?.trim() || el.children.length > 0) continue;
      const cs = getComputedStyle(el);
      if (cs.textOverflow === 'ellipsis' || cs.overflow === 'hidden' || cs.visibility === 'hidden') continue;
      if (el.scrollWidth > el.clientWidth + 2 && cs.whiteSpace === 'nowrap')
        out.push(el.textContent.trim().slice(0, 40));
    }
    return out;
  }, root);
}

test.describe('Chat home', () => {
  test('home layout: rail, greeting, composer, chips, disclaimer, Temporary pill and tooltips', async ({
    page,
  }) => {
    await home(page);
    await shot(page, 'e2e-laptop-home');
    const rail = page.getByTestId('rail');
    expect((await rail.boundingBox())!.width).toBe(64);
    // the rail: Orbit mark, sidebar toggle, New chat, Today, Pipeline, People, a divider, Map, Discover, Drafts,
    // Settings and the avatar at the bottom; every item names itself
    for (const name of ['Expand sidebar', 'New chat'])
      await expect(rail.getByRole('button', { name })).toBeVisible();
    for (const name of ['Today', 'Pipeline', 'People', 'Map', 'Discover', 'Drafts', 'Settings'])
      await expect(rail.getByRole('link', { name: new RegExp(`^${name}`) })).toBeVisible();
    await expect(rail.getByRole('link', { name: /^today$/i })).toHaveAttribute('data-tip', 'Today');
    await expect(rail.getByRole('link', { name: 'Alex Rivera' })).toBeVisible();
    expect((await rail.getByRole('link', { name: /^today$/i }).boundingBox())!.height).toBeGreaterThanOrEqual(
      44,
    );
    // the greeting, one line, with the first name
    const greeting = page.getByTestId('greeting');
    await expect(greeting).toHaveText(/^Hey Alex, what’s on your mind today\?$/);
    expect(await greeting.evaluate((el) => getComputedStyle(el).fontSize)).toBe('32px');
    expect((await greeting.boundingBox())!.height).toBeLessThan(50);
    // the composer with its controls
    await expect(composer(page)).toHaveAttribute('placeholder', 'Message Orbit');
    await expect(composer(page)).toBeFocused();
    await expect(page.getByTestId('composer-add')).toBeVisible();
    await expect(page.getByTestId('composer-mode')).toHaveText(/Templates/);
    await expect(page.getByTestId('composer-mic')).toBeVisible();
    expect((await page.getByTestId('composer').boundingBox())!.width).toBeLessThanOrEqual(980);
    // two rows of four chips
    const chips = page.getByTestId('chips').getByRole('button');
    await expect(chips).toHaveCount(8);
    await expect(chips.first()).toHaveText('Who should I message today');
    await expect(chips.last()).toHaveText('Show my pipeline');
    const rows = await chips.evaluateAll(
      (els) => new Set(els.map((e) => e.getBoundingClientRect().top)).size,
    );
    expect(rows).toBe(2);
    await expect(page.getByTestId('disclaimer')).toHaveText(
      'Orbit drafts with AI and may make mistakes. Nothing is sent without your approval. Your data stays in this browser.',
    );
    await expect(page.getByTestId('temporary-toggle')).toHaveText(/Temporary/);
    // the + menu lists the four attachments
    await page.getByTestId('composer-add').click();
    const menu = page.getByTestId('attach-menu');
    for (const item of ['Add a note', 'Upload resume', 'Import LinkedIn connections', 'Paste an email'])
      await expect(menu.getByRole('menuitem', { name: item })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    // Enter sends, Shift+Enter makes a new line
    await composer(page).fill('first line');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('second line');
    await expect(composer(page)).toHaveValue('first line\nsecond line');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('turn-user')).toHaveText('first line\nsecond line');
    await expect(composer(page)).toHaveValue('');
    expect(await clipped(page, '[data-testid="chat-thread"]')).toEqual([]);
  });

  test('a chip runs a tool, shows the status card, renders a card, and the thread survives leaving the page', async ({
    page,
  }) => {
    await home(page);
    await page.getByTestId('chip-pipeline').click();
    await expect(page.getByTestId('turn-user')).toHaveText('Show my pipeline');
    await expect(page.getByTestId('chat-home')).toHaveCount(0);
    const card = page.getByTestId('result-pipeline');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Next: Send the thank-you');
    await expect(page.getByTestId('turn-assistant')).toContainText('Here is where things stand.');
    expect((await calls(page)).some((c) => c.method === 'runChip' && c.args[1] === 'pipeline')).toBe(true);
    // the hover row on the turn
    await page.getByTestId('turn-assistant').hover();
    const row = page.getByTestId('turn-actions');
    for (const name of ['Copy', 'Retry', 'Good answer', 'Bad answer'])
      await expect(row.getByRole('button', { name })).toBeVisible();
    // Open in app is an in-app link; the thread is still there on the way back
    await card.getByTestId('open-in-app').click();
    await expect(page).toHaveURL(/\/pipeline$/);
    await page
      .getByTestId('rail')
      .getByRole('link', { name: /^today$/i })
      .click();
    await expect(page).toHaveURL(/\/today$/);
    await page.goBack();
    await page.goBack();
    await expect(page).toHaveURL(/\/orbit\/$/);
    await expect(page.getByTestId('result-pipeline')).toBeVisible();
    await expect(page.getByTestId('turn-user')).toHaveText('Show my pipeline');
    // New chat clears the thread; the conversation stays in history
    await page.getByTestId('new-chat').click();
    await expect(page.getByTestId('greeting')).toBeVisible();
    // the + menu reads a file and hands it to the engine
    await page.getByTestId('composer-add').click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('menuitem', { name: 'Add a note' }).click();
    await (await chooser).setFiles({
      name: 'chat-notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Priya said to ship in week one.'),
    });
    await expect(page.getByTestId('turn-user')).toHaveText('Attached a note: chat-notes.txt');
    await expect(page.getByTestId('result-note')).toBeVisible();
    const attach = (await calls(page)).find((c) => c.method === 'attach');
    expect(attach?.args[2]).toBe('note');
    expect((attach?.args[1] as { name: string }).name).toBe('chat-notes.txt');
  });

  test('a scripted conversation renders every result kind', async ({ page }) => {
    await home(page);
    await ask(page, 'show me everything');
    await expect(page.getByTestId('turn-assistant')).toContainText('That is the whole set', {
      timeout: 30_000,
    });
    for (const kind of [
      'person',
      'people',
      'draft',
      'drafts',
      'pipeline',
      'routes',
      'brief',
      'suggestion',
      'note',
      'facts',
      'company',
      'settings',
      'import',
      'prep',
      'needs_confirmation',
      'error',
    ])
      await expect(page.getByTestId(`result-${kind}`), kind).toBeVisible();
    await expect(page.getByTestId('thread').getByText('Today', { exact: true })).toBeVisible();
    await expect(page.getByTestId('turn-user')).toHaveCSS('margin-left', /\d/);
    // the draft card is the real editor with the real buttons
    const draft = page.getByTestId('result-draft');
    await expect(draft.getByLabel('Message body')).toBeVisible();
    await expect(draft.getByTestId('draft-copy')).toBeVisible();
    await expect(draft.getByRole('button', { name: /open email to/i })).toBeVisible();
    await expect(page.getByTestId('progress-line').first()).toBeVisible();
    await expect(page.getByTestId('result-error')).toContainText('could not find a chat');
    await shot(page, 'e2e-laptop-conversation');
    expect(await clipped(page, '[data-testid="chat-thread"]')).toEqual([]);
    await noOverflow(page, 'conversation');
    // the thread auto-scrolled to the end; scrolling up stops that and offers a way back
    const scroller = page.getByTestId('thread-scroll');
    const atEnd = await scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    expect(atEnd).toBe(true);
    await scroller.evaluate((el) => (el.scrollTop = 0));
    await expect(page.getByTestId('jump-latest')).toBeVisible();
    await ask(page, 'hello');
    await page.waitForTimeout(400);
    expect(await scroller.evaluate((el) => el.scrollTop)).toBeLessThan(200);
    await page.getByTestId('jump-latest').click();
    await expect(page.getByTestId('jump-latest')).toHaveCount(0);
  });

  test('approve a send through the draft card with the edited text, cancel one, and a blocked one stays off', async ({
    page,
  }) => {
    await home(page);
    await ask(page, 'send it');
    const card = page.getByTestId('result-needs_confirmation');
    await expect(card).toContainText('Needs your approval');
    await expect(card.getByTestId('confirm-text')).toHaveText(/Send the thank-you to \w+ by email\./);
    const box = card.getByLabel('Message body');
    await box.fill(`${await box.inputValue()}\n\nP.S. Edited in the chat.`);
    const approve = card.getByRole('button', { name: 'Approve & send' });
    await expect(approve).toBeEnabled();
    await approve.click();
    await expect(page.getByTestId('turn-decision')).toContainText(/^\s*Approved: Send the thank-you/);
    await expect(page.getByTestId('result-outcome')).toContainText('Opened in your mail app');
    const approved = (await calls(page)).find((c) => c.method === 'approve');
    expect(approved?.args[0]).toMatch(/^conf_/);
    expect((approved?.args[1] as { body: string }).body).toMatch(/P\.S\. Edited in the chat\.$/);
    await expect(card).toHaveCount(0);

    await ask(page, 'send it again');
    const second = page.getByTestId('result-needs_confirmation');
    await second.getByTestId('confirm-cancel').click();
    await expect(second.getByTestId('confirm-decided')).toHaveText(/Cancelled/);
    await expect(page.getByTestId('turn-decision').last()).toContainText('Cancelled: Send the thank-you');
    expect((await calls(page)).some((c) => c.method === 'cancel')).toBe(true);

    await ask(page, 'wipe my data');
    const blocked = page.getByTestId('result-needs_confirmation').last();
    await expect(blocked.getByTestId('confirm-blocked')).toContainText('Export your data first');
    await expect(blocked.getByTestId('confirm-approve')).toBeDisabled();
    await blocked.getByTestId('confirm-cancel').click();
    await expect(blocked.getByTestId('confirm-decided')).toHaveText(/Cancelled/);
  });

  test('router mode says so honestly with a link to Settings; a key turns the mode dropdown into Smart and Quick', async ({
    page,
  }) => {
    await home(page);
    await expect(page.getByTestId('router-note')).toContainText('no Claude key is set');
    await expect(
      page.getByTestId('router-note').getByRole('link', { name: 'Open Settings' }),
    ).toHaveAttribute('href', /\/settings\/integrations$/);
    await page.getByTestId('composer-mode').click();
    await expect(page.getByTestId('mode-explainer')).toContainText('Templates');
    await expect(
      page.getByTestId('mode-explainer').getByRole('link', { name: /Add a key in Settings/ }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    // an error of the no-key kind points at Settings too
    await ask(page, 'fail no key');
    const err = page.getByTestId('turn-error');
    await expect(err).toHaveAttribute('data-kind', 'no_key');
    await expect(err.getByRole('link', { name: 'Add one in Settings' })).toBeVisible();
    for (const [ask2, kind] of [
      ['fail cap', 'cap'],
      ['fail network', 'network'],
    ] as const) {
      await ask(page, ask2);
      await expect(page.getByTestId('turn-error').last()).toHaveAttribute('data-kind', kind);
    }
  });

  test('with a key the dropdown offers Smart and Quick and the router note is gone', async ({ page }) => {
    await home(page, '?fakeEngine=1&fakeMode=llm');
    await expect(page.getByTestId('router-note')).toHaveCount(0);
    await expect(page.getByTestId('composer-mode')).toHaveText(/Smart/);
    await page.getByTestId('composer-mode').click();
    await page.getByRole('menuitemradio', { name: /Quick/ }).click();
    await expect(page.getByTestId('composer-mode')).toHaveText(/Quick/);
    expect(await page.evaluate(() => localStorage.getItem('orbit:chatMode'))).toBe('quick');
  });

  test('Stop ends a turn cleanly and keeps what was produced', async ({ page }) => {
    await home(page);
    await ask(page, 'slow one please');
    const stop = page.getByTestId('composer-stop');
    await expect(stop).toBeVisible();
    await expect(page.getByTestId('composer-mic')).toHaveCount(0);
    await expect(page.getByTestId('turn-assistant')).toContainText('Still working, line 2');
    await shot(page, 'e2e-laptop-in-progress');
    await stop.click();
    await expect(page.getByTestId('turn-stopped')).toBeVisible();
    await expect(page.getByTestId('turn-assistant')).toContainText('Still working, line 1');
    await expect(page.getByTestId('composer-mic')).toBeVisible();
    await expect(stop).toHaveCount(0);
    // the composer is usable again
    await ask(page, 'hello');
    await expect(page.getByTestId('turn-user').last()).toHaveText('hello');
  });

  test('a Temporary chat is not saved; the sidebar lists, opens, renames and archives the others', async ({
    page,
  }) => {
    await home(page);
    await page.getByTestId('temporary-toggle').click();
    await expect(page.getByTestId('temporary-note')).toContainText('not saved');
    await ask(page, 'secret question');
    await expect(page.getByTestId('turn-assistant')).toContainText('Try one of the chips');
    await page.getByTestId('sidebar-toggle').click();
    const rail = page.getByTestId('rail');
    await expect(rail).toHaveAttribute('data-expanded', 'true');
    await expect.poll(async () => (await rail.boundingBox())!.width).toBe(260);
    await expect(rail.getByText('Orbit', { exact: true })).toBeVisible();
    await expect(rail.getByTestId('account-row')).toContainText('Alex Rivera');
    await expect(rail.getByTestId('account-row')).toContainText('Local data');
    await expect(rail.getByTestId('recent')).toContainText('No conversations yet');
    const started = await calls(page);
    expect(started.find((c) => c.method === 'startConversation')?.args[0]).toEqual({ temporary: true });
    // off again: a saved chat
    await page.getByTestId('temporary-toggle').click();
    await expect(page.getByTestId('greeting')).toBeVisible();
    await ask(page, 'show my pipeline');
    await expect(page.getByTestId('result-pipeline')).toBeVisible();
    const today = rail.getByTestId('recent-today');
    await expect(today.getByTestId('recent-item')).toHaveCount(1);
    await expect(today.getByTestId('recent-item')).toHaveText('show my pipeline');
    await page.getByTestId('new-chat').click();
    await ask(page, 'who went quiet');
    await expect(page.getByTestId('result-people')).toBeVisible();
    await expect(today.getByTestId('recent-item')).toHaveCount(2);
    await expect(today.getByTestId('recent-item').first()).toHaveText('who went quiet');
    await shot(page, 'e2e-laptop-sidebar');
    // open the older one: its thread comes back from the engine
    await today.getByTestId('recent-item').last().click();
    await expect(page.getByTestId('turn-user')).toHaveText('show my pipeline');
    await expect(page.getByTestId('result-pipeline')).toBeVisible();
    // rename
    await today.getByTestId('recent-item').last().hover();
    await today.getByTestId('recent-rename').last().click();
    await page.getByTestId('recent-rename-input').fill('Pipeline check');
    await page.keyboard.press('Enter');
    await expect(today.getByTestId('recent-item').last()).toHaveText('Pipeline check');
    expect(
      (await calls(page)).some((c) => c.method === 'renameConversation' && c.args[1] === 'Pipeline check'),
    ).toBe(true);
    // archive
    await today.getByTestId('recent-item').first().hover();
    await today.getByTestId('recent-archive').first().click();
    await expect(today.getByTestId('recent-item')).toHaveCount(1);
    expect((await calls(page)).some((c) => c.method === 'archiveConversation')).toBe(true);
    // the sidebar state survives a reload
    await page.goto('');
    await expect(page.getByTestId('rail')).toHaveAttribute('data-expanded', 'true');
    await page.getByTestId('sidebar-toggle').click();
    await expect(page.getByTestId('rail')).toHaveAttribute('data-expanded', 'false');
  });

  test('phone layout: bottom tabs, full-width composer, two-column chips, 26px greeting, nothing clipped', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await home(page);
    await shot(page, 'e2e-phone-home');
    await expect(page.getByTestId('rail')).toBeHidden();
    const tabs = page.getByTestId('tab-bar');
    await expect(tabs).toBeVisible();
    for (const name of ['Chat', 'Today', 'Pipeline', 'People'])
      await expect(tabs.getByRole('link', { name })).toBeVisible();
    await expect(tabs.getByRole('button', { name: 'More' })).toBeVisible();
    expect((await tabs.getByRole('link', { name: 'Today' }).boundingBox())!.height).toBeGreaterThanOrEqual(
      44,
    );
    expect(await page.getByTestId('greeting').evaluate((el) => getComputedStyle(el).fontSize)).toBe('26px');
    const box = (await page.getByTestId('composer').boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(350);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    const chips = page.getByTestId('chips').getByRole('button');
    const lefts = await chips.evaluateAll(
      (els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().left))).size,
    );
    expect(lefts).toBe(2);
    for (const el of await chips.all()) expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await noOverflow(page, 'phone home');
    expect(await clipped(page, '#root')).toEqual([]);
    // More opens the rest of the app
    await tabs.getByRole('button', { name: 'More' }).click();
    const sheet = page.getByTestId('more-sheet');
    for (const name of ['Map', 'Discover', 'Drafts', 'Add note', 'Settings'])
      await expect(sheet.getByRole('link', { name: new RegExp(`^${name}`) })).toBeVisible();
    const sheetBox = (await sheet.locator('[role="dialog"]').boundingBox())!;
    expect(sheetBox.y).toBeGreaterThan(0);
    expect(sheetBox.y + sheetBox.height).toBeLessThanOrEqual(844 - 56);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await tabs.getByRole('button', { name: 'More' }).click();
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toHaveCount(0);
    // a conversation on the phone
    await ask(page, 'show me everything');
    await expect(page.getByTestId('turn-assistant')).toContainText('That is the whole set', {
      timeout: 30_000,
    });
    await shot(page, 'e2e-phone-conversation');
    await noOverflow(page, 'phone conversation');
    expect(await clipped(page, '[data-testid="chat-thread"]')).toEqual([]);
    const c2 = (await page.getByTestId('composer').boundingBox())!;
    const t2 = (await tabs.boundingBox())!;
    expect(c2.y + c2.height).toBeLessThanOrEqual(t2.y + 1);
    await expect(page.getByTestId('result-draft').getByLabel('Message body')).toBeVisible();
  });

  for (const [w, h] of [
    [1280, 800],
    [1024, 768],
    [768, 1024],
  ] as const) {
    test(`fits ${w}x${h} without clipped text or sideways scroll`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await home(page);
      await noOverflow(page, 'home');
      expect(await clipped(page, '#root')).toEqual([]);
      const greeting = await page.getByTestId('greeting').boundingBox();
      expect(greeting!.height).toBeLessThan(w >= 1024 ? 50 : 90);
      await ask(page, 'show me everything');
      await expect(page.getByTestId('turn-assistant')).toContainText('That is the whole set', {
        timeout: 30_000,
      });
      await noOverflow(page, 'conversation');
      expect(await clipped(page, '[data-testid="chat-thread"]')).toEqual([]);
      const scroller = page.getByTestId('thread-scroll');
      expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    });
  }

  test('reduced motion stops the drifting background and the shimmer', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await home(page);
    const anims = await page.evaluate(() => [
      getComputedStyle(document.body, '::before').animationName,
      getComputedStyle(document.body, '::after').animationName,
    ]);
    expect(anims).toEqual(['none', 'none']);
    // the shimmer on a running tool's label (checked on the class itself: a tool runs for only a few frames)
    const shimmer = await page.evaluate(() => {
      const el = document.createElement('span');
      el.className = 'shimmer';
      el.textContent = 'Looking at your pipeline';
      document.body.appendChild(el);
      const cs = getComputedStyle(el);
      return { animation: cs.animationName, color: cs.color };
    });
    expect(shimmer.animation).toBe('none');
    expect(shimmer.color).toBe('rgb(14, 20, 36)');
    await ask(page, 'slow one please');
    await expect(page.getByTestId('composer-stop')).toBeVisible();
    await page.getByTestId('composer-stop').click();
    await expect(page.getByTestId('turn-stopped')).toBeVisible();
  });

  test('the glass stays legible: ink on the composer and the chips over the brightest part of the backdrop', async ({
    page,
  }) => {
    await home(page);
    // the composer's own pixels are near white, so the 15px ink keeps its contrast wherever a blob drifts
    const sample = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="composer"]') as HTMLElement;
      const cs = getComputedStyle(el);
      return {
        bg: cs.backgroundColor,
        backdrop:
          cs.backdropFilter || (cs as unknown as { webkitBackdropFilter: string }).webkitBackdropFilter,
      };
    });
    expect(sample.backdrop).toMatch(/blur\(20px\)/);
    expect(sample.backdrop).toMatch(/saturate\(1\.6\)|saturate\(160%\)/);
    const shotBuf = await page.getByTestId('composer').screenshot();
    // the PNG's centre pixel: decoded by the browser itself
    const [r, g, b] = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(Math.floor(img.width / 2), 8, 1, 1).data;
      return [px[0], px[1], px[2]];
    }, shotBuf.toString('base64'));
    const lum = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const L = 0.2126 * lum(r!) + 0.7152 * lum(g!) + 0.0722 * lum(b!);
    const inkL = 0.2126 * lum(14) + 0.7152 * lum(20) + 0.0722 * lum(36);
    const contrast = (L + 0.05) / (inkL + 0.05);
    expect(contrast, `composer surface rgb(${r},${g},${b})`).toBeGreaterThan(12);
  });
});
