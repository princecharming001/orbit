/**
 * Drafts, To send: a draft the student started, or a message waiting for "I sent it", is a compact row that opens in
 * place on a click and closes on a second click on its header or Escape. The name stays a link, one draft is open at
 * a time, and a message waiting for "I sent it" starts open.
 */
import type { OutboundMessage, Person } from '@orbit/core';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../ui';
import { MessageRow, useOpenRows } from './DraftMessage';

// the editor is tested on its own; here it only has to show where it is, and close when asked
vi.mock('./DraftEditor', () => ({
  DraftEditor: ({
    draft,
    onCancel,
  }: {
    draft: OutboundMessage;
    extraActions?: ReactNode;
    onCancel?: (r: { kept: boolean }) => void;
  }) => (
    <div>
      {draft.status === 'handed_off' ? (
        <button type="button">I sent it</button>
      ) : (
        <textarea aria-label="Message body" defaultValue={draft.bodyFinal ?? draft.bodyDraft} />
      )}
      <button type="button" onClick={() => onCancel?.({ kept: true })}>
        Close
      </button>
    </div>
  ),
}));
vi.mock('../state/session', () => ({ useSession: () => ({ user: { id: 'u_me', timezone: 'UTC' } }) }));
const discard = vi.fn(async (_id: string) => true);
vi.mock('../engine/drafts', () => ({
  discardDraft: (id: string) => discard(id),
  restoreDraft: async () => true,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const person = (id: string, name: string) =>
  ({ id, displayName: name, firstName: name.split(' ')[0] }) as unknown as Person;
const message = (id: string, personId: string, body: string, status: OutboundMessage['status'] = 'draft') =>
  ({
    id,
    personId,
    kind: 'nurture',
    channel: id === 'o_li' ? 'linkedin' : 'gmail',
    status,
    bodyDraft: body,
    createdAt: new Date(Date.now() - 4 * 86_400_000).toISOString(),
  }) as unknown as OutboundMessage;

const people = new Map(
  [
    person('p_kelly', 'Kelly Gieryn'),
    person('p_meghana', 'Meghana Rao'),
    person('p_daniel', 'Daniel Kim'),
  ].map((p) => [p.id, p]),
);
const messages = [
  message('o_li', 'p_kelly', 'Hi Kelly, great to connect.', 'handed_off'),
  message('o_1', 'p_meghana', 'Hey Meghana,\n\nIt has been a while since we talked.'),
  message('o_2', 'p_daniel', 'Hi Daniel,\n\nThanks again for the chat.'),
];

function List() {
  const { isOpen, setOpen } = useOpenRows(messages);
  return (
    <ul>
      {messages.map((o) => (
        <MessageRow
          key={o.id}
          o={o}
          person={people.get(o.personId)}
          open={isOpen(o)}
          onOpenChange={(v) => setOpen(o, v)}
        />
      ))}
    </ul>
  );
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  discard.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <MemoryRouter initialEntries={['/inbox']}>
        <ToastProvider>
          <Routes>
            <Route path="/inbox" element={<List />} />
            <Route path="/people/:id" element={<div data-testid="person-page" />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const rows = () => [...host.querySelectorAll<HTMLElement>('[data-testid="started-draft"]')];
const toggle = (row: HTMLElement) =>
  row.querySelector<HTMLButtonElement>('[data-testid="started-draft-toggle"]')!;
const editor = (row: HTMLElement) => row.querySelector('[data-testid="started-draft-editor"]');
const click = (el: Element) =>
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
const key = (el: Element, k: string) =>
  act(() => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })));

describe('MessageRow', () => {
  it('is a compact row: name, kind, one line of the text, and no buttons until it is opened', () => {
    const [first] = rows();
    expect(toggle(first!).getAttribute('aria-expanded')).toBe('false');
    expect(editor(first!)).toBeNull();
    // the blank line after "Hey Meghana," does not push the text out of the one-line preview
    expect(first!.querySelector('[data-testid="started-draft-preview"]')!.textContent).toBe(
      'Hey Meghana, It has been a while since we talked.',
    );
    expect(first!.textContent).toMatch(/started 4 days ago/);
    expect(first!.textContent).not.toMatch(/continue writing|discard draft/i);
  });

  it('opens on a click on the row, closes on a second click on its header, and opens again', () => {
    const [first] = rows();
    click(toggle(first!));
    expect(editor(first!)).not.toBeNull();
    expect(toggle(first!).getAttribute('aria-expanded')).toBe('true');
    // Discard is there once it is open
    expect(first!.querySelector('[data-testid="started-draft-discard"]')).not.toBeNull();
    click(toggle(first!));
    expect(editor(first!)).toBeNull();
    expect(toggle(first!).getAttribute('aria-expanded')).toBe('false');
    click(toggle(first!));
    expect(editor(first!)).not.toBeNull();
  });

  it('closes on Escape and on the editor Close, with the focus back on the header', () => {
    const [first] = rows();
    click(toggle(first!));
    const box = first!.querySelector('textarea')!;
    act(() => box.focus());
    key(box, 'Escape');
    expect(editor(first!)).toBeNull();
    expect(document.activeElement).toBe(toggle(first!));
    click(toggle(first!));
    click([...first!.querySelectorAll('button')].find((b) => b.textContent === 'Close')!);
    expect(editor(first!)).toBeNull();
  });

  it('keeps one draft open at a time, and a message waiting for I sent it starts open', () => {
    const waiting = host.querySelector<HTMLElement>('[data-testid="outbox-item"]')!;
    expect(waiting.querySelector('[data-testid="outbox-item-body"]')?.textContent).toMatch(/I sent it/);
    // no tag for where it goes: a subject line says email
    expect(waiting.textContent).not.toMatch(/LinkedIn/);
    const [first, second] = rows();
    click(toggle(first!));
    click(toggle(second!));
    expect(editor(first!)).toBeNull();
    expect(editor(second!)).not.toBeNull();
    // the hand-off still needs the student: opening a draft leaves it open
    expect(waiting.querySelector('[data-testid="outbox-item-body"]')).not.toBeNull();
    // and it closes like the others
    click(waiting.querySelector('[data-testid="outbox-item-toggle"]')!);
    expect(waiting.querySelector('[data-testid="outbox-item-body"]')).toBeNull();
  });

  it('follows the name to their page without opening the draft', () => {
    const [first] = rows();
    const link = first!.querySelector('a')!;
    expect(link.textContent).toBe('Meghana Rao');
    click(link);
    expect(host.querySelector('[data-testid="person-page"]')).not.toBeNull();
  });

  it('discards from inside the open row', async () => {
    const [first] = rows();
    click(toggle(first!));
    await act(async () => {
      first!
        .querySelector('[data-testid="started-draft-discard"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(discard).toHaveBeenCalledWith('o_1');
    expect(editor(first!)).toBeNull();
  });
});
