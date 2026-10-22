import type { User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, MessageCircle } from 'lucide-react';
import { useState } from 'react';
import { forgetTexts, importTexts, textsStatus } from '../engine/imessage';
import { Button, relDate, Spinner, useToast } from '../ui';
import { AppMark, IntegrationRow, RowStatus } from './IntegrationRow';

/**
 * Settings, Integrations: the student's texts from Messages on a Mac. A website cannot read Messages itself, so the
 * student drops in the Messages database (and, if they like, their Contacts as a vCard so numbers have names); Orbit
 * reads both in this browser.
 */
export function TextsRow({ user }: { user: User }) {
  const toast = useToast();
  const status = useLiveQuery(() => textsStatus(user), [user.id]);
  const [open, setOpen] = useState(false);
  const [chatDb, setChatDb] = useState<File>();
  const [vcf, setVcf] = useState<File>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  if (!status) return null;
  const run = async () => {
    if (!chatDb) return;
    setError(undefined);
    setBusy('Reading…');
    try {
      const r = await importTexts(
        user,
        {
          messagesDb: new Uint8Array(await chatDb.arrayBuffer()),
          contactsVcf: vcf ? await vcf.text() : undefined,
        },
        { onProgress: (d, t) => setBusy(`Reading ${d} of ${t}…`) },
      );
      setOpen(false);
      toast.push({
        text:
          `Imported texts with ${r.people} ${r.people === 1 ? 'person' : 'people'}.` +
          (r.skippedUnnamed
            ? ` ${r.skippedUnnamed} number${r.skippedUnnamed === 1 ? ' was' : 's were'} not in ${vcf ? 'your Contacts' : 'Orbit'}${vcf ? '' : ' (add your Contacts to name them)'}.`
            : ''),
        tone: 'good',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That file could not be read.');
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <IntegrationRow
      testId="settings-imessage"
      mark={
        <AppMark>
          <MessageCircle size={15} className="text-good" />
        </AppMark>
      }
      name="iMessage"
      status={
        status.imported ? (
          <RowStatus testId="settings-imessage-status">
            <Check size={12} /> {status.people} {status.people === 1 ? 'person' : 'people'}
            {status.lastSyncedAt ? ` · imported ${relDate(status.lastSyncedAt)}` : ''}
          </RowStatus>
        ) : undefined
      }
      line="Texts on your Mac count toward how close you are. Read in this browser only."
      actions={
        <>
          {status.imported && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void forgetTexts(user)}
              data-testid="settings-imessage-forget"
            >
              Forget
            </Button>
          )}
          <Button
            size="sm"
            variant={open ? 'ghost' : 'secondary'}
            onClick={() => setOpen((o) => !o)}
            data-testid="settings-imessage-open"
          >
            {open ? 'Cancel' : status.imported ? 'Import again' : 'Import'}
          </Button>
        </>
      }
    >
      {open && (
        <div className="space-y-3" data-testid="settings-imessage-steps">
          <ol className="list-decimal space-y-1.5 pl-5 text-[12.5px] text-ink-2">
            <li>Quit Messages.</li>
            <li>
              In Finder, press <kbd className="font-mono">⇧⌘G</kbd>, go to{' '}
              <span className="font-mono">~/Library/Messages</span>, and pick{' '}
              <span className="font-mono">chat.db</span> below.
            </li>
            <li>
              Optional: in Contacts, select all, then File, Export, Export vCard, so numbers have names.
            </li>
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <FilePick
              label={chatDb ? chatDb.name : 'Choose chat.db'}
              accept=".db"
              onPick={setChatDb}
              testId="settings-imessage-db"
            />
            <FilePick
              label={vcf ? vcf.name : 'Contacts (.vcf)'}
              accept=".vcf,text/vcard"
              onPick={setVcf}
              testId="settings-imessage-vcf"
            />
            <Button
              size="sm"
              variant="primary"
              disabled={!chatDb || !!busy}
              onClick={() => void run()}
              data-testid="settings-imessage-import"
            >
              {busy ? (
                <>
                  <Spinner /> {busy}
                </>
              ) : (
                'Import'
              )}
            </Button>
          </div>
          {error && (
            <p className="text-[12.5px] text-bad" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </IntegrationRow>
  );
}

function FilePick({
  label,
  accept,
  onPick,
  testId,
}: {
  label: string;
  accept: string;
  onPick: (f: File | undefined) => void;
  testId: string;
}) {
  return (
    <label className="inline-flex h-8 cursor-pointer items-center rounded-full border border-line bg-canvas px-3 text-[12.5px] text-ink-2 hover:bg-canvas-2 focus-within:ring-2 focus-within:ring-accent/40">
      <input
        type="file"
        accept={accept}
        className="sr-only"
        onChange={(e) => onPick(e.target.files?.[0])}
        data-testid={testId}
      />
      <span className="max-w-[180px] truncate">{label}</span>
    </label>
  );
}
