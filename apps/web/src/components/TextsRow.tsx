/**
 * Texts from the Mac's Messages (plan 43 §6): the row in Settings, Integrations, under Network, and the setup the
 * onboarding step uses too. Shown only on a Mac, and only when this Orbit offers Texts.
 *
 * The row has one switch and the four states of plan 43 §3.1: Not connected, On (people, conversations, the last
 * update and Update), Off (everything kept, hidden from closeness and paths) and Removed ("Remove what Orbit took"
 * deletes it). Turning it on the first time opens the setup: where the Messages folder is, picking it (or the files),
 * then the exported contacts file.
 */
import type { User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, MessageCircle } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import {
  forgetTexts,
  hasSavedContacts,
  importTexts,
  setTextsOn,
  type TextImportResult,
  textsStatus,
} from '../engine/imessage';
import { useSources } from '../engine/sources';
import {
  canPickFolder,
  fromFiles,
  hasSavedFolder,
  isMac,
  MessagesPickError,
  type PickedMessages,
  pickMessagesFolder,
  readSavedFolder,
} from '../integrations/messagesFolder';
import { isServerUser } from '../integrations/orbitApi';
import { Button, Modal, relDate, Spinner, Switch, useToast } from '../ui';
import { AppMark, IntegrationRow, RowStatus } from './IntegrationRow';

/** Texts are shown to this student: on a Mac, when the owner offers them. Undefined while the answer loads. */
export function useTextsOffered(userId: string | undefined): boolean | undefined {
  const s = useSources(userId);
  if (!userId) return false;
  if (!s) return undefined;
  return isMac() && s.offered.includes('imessage');
}

/** What leaves the browser, said plainly: nothing in local mode, counts per day for an account. */
export function textsPrivacyLine(signedIn: boolean): string {
  return signedIn
    ? "Orbit's server gets, per person and per day, how many texts went each way, and for a friend only in your texts their name and number. Never the words."
    : 'Read here, in this browser. The words never leave it.';
}

export function importSummary(r: Pick<TextImportResult, 'people' | 'conversations'>): string {
  const people = `${r.people} ${r.people === 1 ? 'person' : 'people'}`;
  const convs = `${r.conversations} ${r.conversations === 1 ? 'conversation' : 'conversations'}`;
  return `${people}, ${convs}`;
}

export function TextsRow({ user }: { user: User }) {
  const toast = useToast();
  const offered = useTextsOffered(user.id);
  const status = useLiveQuery(() => textsStatus(user), [user.id]);
  const saved = useLiveQuery(
    async () => ({ folder: await hasSavedFolder(user.id), contacts: await hasSavedContacts(user.id) }),
    [user.id],
  );
  const [setup, setSetup] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  if (!offered || !status) return null;
  const signedIn = isServerUser(user.id);
  const { state } = status;
  const on = state === 'on' && status.imported;
  const off = state === 'off' && status.imported;
  const switchTo = async (next: boolean) => {
    setError(undefined);
    // nothing kept yet: on starts with the setup
    if (next && !status.imported) {
      setSetup(true);
      return;
    }
    setBusy(next ? 'Turning on' : 'Turning off');
    try {
      const r = await setTextsOn(user, next);
      if (!r.ok) setError(r.message);
      else
        toast.push({
          text: next
            ? 'Texts are on. They count in closeness again.'
            : 'Texts are off. Kept, and left out of closeness and paths.',
        });
    } finally {
      setBusy(undefined);
    }
  };
  // one click when the folder is kept; otherwise the setup asks for it again
  const update = async () => {
    setError(undefined);
    let picked: PickedMessages | undefined;
    try {
      picked = saved?.folder ? await readSavedFolder(user.id) : undefined;
    } catch (e) {
      setError(String((e as Error).message ?? e));
      return;
    }
    if (!picked) {
      setSetup(true);
      return;
    }
    setBusy('Reading your texts');
    try {
      const r = await importTexts(user, { messagesDb: picked.db, messagesWal: picked.wal });
      toast.push({ text: `Texts updated: ${importSummary(r)}.`, tone: 'good' });
      if (r.uploadError) setError(r.uploadError);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(undefined);
    }
  };
  const remove = async () => {
    setBusy('Removing');
    try {
      const r = await forgetTexts(user);
      setConfirming(false);
      if (!r.ok) setError(r.message);
      else toast.push({ text: 'Removed what Orbit took from your texts.' });
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <>
      <IntegrationRow
        testId="settings-texts"
        mark={
          <AppMark>
            <MessageCircle size={16} aria-hidden />
          </AppMark>
        }
        name="Texts"
        status={
          busy ? (
            <RowStatus tone="muted" testId="settings-texts-status">
              <Spinner /> {busy}
            </RowStatus>
          ) : on ? (
            <RowStatus tone={status.error ? 'bad' : 'good'} testId="settings-texts-status">
              <Check size={12} /> On · {importSummary(status)}
              {status.lastSyncedAt ? ` · updated ${relDate(status.lastSyncedAt)}` : ''}
              {status.error ? " · not sent to Orbit's server" : ''}
            </RowStatus>
          ) : off ? (
            <RowStatus tone="muted" testId="settings-texts-status">
              Off · kept, left out of closeness and paths
            </RowStatus>
          ) : (
            <RowStatus tone="muted" testId="settings-texts-status">
              {state === 'removed' ? 'Removed · nothing from your texts is kept' : 'Not connected'}
            </RowStatus>
          )
        }
        line={<span data-testid="settings-texts-privacy">{textsPrivacyLine(signedIn)}</span>}
        actions={
          <>
            {on && !setup && (
              <Button
                size="sm"
                variant="ghost"
                onClick={update}
                disabled={!!busy}
                data-testid="settings-texts-update"
              >
                Update
              </Button>
            )}
            <Switch
              checked={on}
              label="Texts"
              busy={!!busy}
              title={on ? 'Turn texts off' : 'Turn texts on'}
              onChange={(next) => void switchTo(next)}
              data-testid="settings-texts-switch"
            />
          </>
        }
      >
        {setup && (
          <TextsSetup
            user={user}
            contactsKept={!!saved?.contacts}
            onDone={(r) => {
              setSetup(false);
              toast.push({ text: `Texts imported: ${importSummary(r)}.`, tone: 'good' });
            }}
            onCancel={() => setSetup(false)}
          />
        )}
        {(on || off) && !setup && (
          <button
            type="button"
            className="text-[12.5px] text-ink-3 underline underline-offset-2 hover:text-bad"
            onClick={() => setConfirming(true)}
            disabled={!!busy}
            data-testid="settings-texts-remove"
          >
            Remove what Orbit took
          </button>
        )}
        {error && (
          <p className="mt-2 text-[12.5px] text-bad" role="alert" data-testid="settings-texts-error">
            {error}
          </p>
        )}
      </IntegrationRow>
      <Modal open={confirming} onClose={() => setConfirming(false)} title="Remove your texts?" width={440}>
        <div className="space-y-3 text-[13.5px] text-ink-2" data-testid="settings-texts-confirm">
          <p>
            Orbit deletes the days and counts it read from your texts, the last few messages on each person's
            page, and the handles from your contacts file
            {signedIn ? ", here and on Orbit's server" : ''}. People you only text, with nothing else in
            Orbit, are removed too. Everyone else stays.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={remove}
              loading={busy === 'Removing'}
              data-testid="settings-texts-confirm-remove"
            >
              Remove
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

/**
 * Setting texts up: where the Messages folder is, picking it (or chat.db and chat.db-wal), then the contacts file.
 * Used under the Settings row and as the onboarding step.
 */
export function TextsSetup({
  user,
  contactsKept,
  onDone,
  onCancel,
  importLabel = 'Import texts',
}: {
  user: User;
  /** a contacts file from an earlier import is kept: picking one again is optional */
  contactsKept?: boolean;
  onDone: (r: TextImportResult) => void;
  onCancel?: () => void;
  importLabel?: string;
}) {
  const filesRef = useRef<HTMLInputElement>(null);
  const contactsRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<PickedMessages>();
  const [contacts, setContacts] = useState<{ name: string; text: string }>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const folder = canPickFolder();
  const signedIn = isServerUser(user.id);
  const pickFolder = async () => {
    setError(undefined);
    try {
      const p = await pickMessagesFolder(user.id);
      if (p) setPicked(p);
    } catch (e) {
      setError(e instanceof MessagesPickError ? e.message : String((e as Error).message ?? e));
    }
  };
  const run = async () => {
    if (!picked) return;
    setError(undefined);
    setBusy('Reading your texts');
    try {
      const r = await importTexts(
        user,
        { messagesDb: picked.db, messagesWal: picked.wal, contactsVcf: contacts?.text },
        { onProgress: (d, t) => setBusy(`Reading your texts ${d} of ${t}`) },
      );
      if (r.uploadError) setError(r.uploadError);
      onDone(r);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="text-[13px] text-ink-2" data-testid="texts-setup">
      <ol className="divide-y divide-line-2 border-y border-line-2">
        <Step n={1} title="Find the Messages folder">
          In Finder, press <Kbd>Cmd-Shift-G</Kbd> and go to{' '}
          <code className="text-ink">~/Library/Messages</code>. If you do not see Library, press{' '}
          <Kbd>Cmd-Shift-.</Kbd> to show hidden folders.
        </Step>
        <Step n={2} title="Pick it here">
          <div className="flex flex-wrap items-center gap-2">
            {folder && (
              <Button size="sm" onClick={pickFolder} disabled={!!busy} data-testid="texts-pick-folder">
                Choose the Messages folder
              </Button>
            )}
            <Button
              size="sm"
              variant={folder ? 'ghost' : 'secondary'}
              onClick={() => filesRef.current?.click()}
              disabled={!!busy}
            >
              {folder ? 'Or choose chat.db and chat.db-wal' : 'Choose chat.db and chat.db-wal'}
            </Button>
            <input
              ref={filesRef}
              type="file"
              multiple
              className="sr-only"
              tabIndex={-1}
              aria-label="chat.db and chat.db-wal"
              onChange={async (e) => {
                const files = e.target.files ? [...e.target.files] : [];
                e.target.value = '';
                if (!files.length) return;
                setError(undefined);
                try {
                  setPicked(await fromFiles(files));
                } catch (err) {
                  setError(String((err as Error).message ?? err));
                }
              }}
              data-testid="texts-files"
            />
            {picked && (
              <span className="text-ink-3" data-testid="texts-picked">
                <Check size={12} className="inline text-good" aria-hidden /> {picked.from}
              </span>
            )}
          </div>
          <p className="mt-2 text-[12.5px] text-ink-3">
            If the folder will not open, macOS may need Full Disk Access for your browser: System Settings,
            Privacy and Security, Full Disk Access. Or copy chat.db and chat.db-wal to your Desktop and pick
            them there.
          </p>
        </Step>
        <Step n={3} title="Your contacts, so Orbit can name who you text">
          In Contacts, select all, then File, Export, Export vCard.{' '}
          {contactsKept && !contacts
            ? 'Your last contacts file is kept here; pick a newer one if you like.'
            : ''}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => contactsRef.current?.click()} disabled={!!busy}>
              Choose the contacts file
            </Button>
            <input
              ref={contactsRef}
              type="file"
              accept=".vcf,text/vcard,text/x-vcard"
              className="sr-only"
              tabIndex={-1}
              aria-label="Contacts file"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) setContacts({ name: f.name, text: await f.text() });
              }}
              data-testid="texts-contacts"
            />
            {contacts && (
              <span className="text-ink-3" data-testid="texts-contacts-picked">
                <Check size={12} className="inline text-good" aria-hidden /> {contacts.name}
              </span>
            )}
          </div>
        </Step>
      </ol>
      <p className="mt-3 text-[12.5px] text-ink-3" data-testid="texts-sent">
        {textsPrivacyLine(signedIn)} Orbit reads one-to-one chats and groups of up to eight, from the last two
        years.
      </p>
      {error && (
        <p className="mt-2 text-[12.5px] text-bad" role="alert" data-testid="texts-error">
          {error}
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          onClick={run}
          disabled={!picked || !!busy}
          loading={!!busy}
          data-testid="texts-import"
        >
          {busy ?? importLabel}
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={!!busy}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3 py-3">
      <span className="w-4 shrink-0 text-[12.5px] font-medium text-ink-3 tabular-nums">{n}</span>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-ink">{title}</div>
        <div className="mt-0.5 leading-[1.5]">{children}</div>
      </div>
    </li>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="font-mono text-[12px] text-ink">{children}</kbd>;
}
