import { STAGE_LABELS } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AddPersonDialog } from '../components/AddPerson';
import { db } from '../db/schema';
import { ingestNote, previewNoteMatch, rematchNote } from '../engine/notes';
import { useSession } from '../state/session';
import { Avatar, Button, Card, Input, Label, PageHeader, Select, Textarea, useToast } from '../ui';

const DRAFT_KEY = 'orbit.capture.draft';

export function NotesNew() {
  const { user, userId } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const noteId = params.get('note') ?? undefined;
  const presetPerson = params.get('person') ?? undefined;
  const [text, setText] = useState(() => localStorage.getItem(DRAFT_KEY) ?? '');
  const [personId, setPersonId] = useState<string>(presetPerson ?? '');
  const [when, setWhen] = useState(() =>
    new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16),
  );
  const [source, setSource] = useState<'manual' | 'wispr_capture' | 'granola_email' | 'upload'>('manual');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const people =
    useLiveQuery(
      () =>
        userId
          ? db.people
              .where('userId')
              .equals(userId)
              .filter((p) => p.isHuman && !p.hiddenAt)
              .toArray()
          : [],
      [userId],
    ) ?? [];
  const existing = useLiveQuery(() => (noteId ? db.notes.get(noteId) : undefined), [noteId]);
  // people the note mentions, from the match card: offered first
  const matchCard = useLiveQuery(
    () => (noteId ? db.suggestions.where('dedupeKey').equals(`note:${noteId}`).first() : undefined),
    [noteId],
  );
  const candidateIds = useMemo(
    () => [
      ...new Set([
        ...(existing?.personIds ?? []),
        ...((matchCard?.payload.candidatePersonIds as string[] | undefined) ?? []),
      ]),
    ],
    [existing, matchCard],
  );
  const recentEvent = useLiveQuery(
    () =>
      userId
        ? db.events
            .where('userId')
            .equals(userId)
            .filter(
              (e) =>
                e.attendeePersonIds.length > 0 &&
                Math.abs(Date.now() - new Date(e.endAt).getTime()) < 6 * 3_600_000,
            )
            .first()
        : undefined,
    [userId],
  );
  // the picker is never filled in behind the student's back: "Let Orbit figure it out" stays chosen, and the line
  // under it says who Orbit will file the note with (a name in the note, or the chat on the calendar that just ended)
  const calendarPerson = people.find((p) => p.id === recentEvent?.attendeePersonIds[0]);
  // matching a saved note: start from Orbit's guess, if it made one
  useEffect(() => {
    if (existing && existing.personIds.length === 1 && !presetPerson) setPersonId(existing.personIds[0]!);
  }, [existing, presetPerson]);
  useEffect(() => {
    const t = setTimeout(() => localStorage.setItem(DRAFT_KEY, text), 500);
    return () => clearTimeout(t);
  }, [text]);
  const [filter, setFilter] = useState('');
  const sorted = useMemo(
    () => people.slice().sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [people],
  );
  const mentioned = sorted.filter((p) => candidateIds.includes(p.id));
  const q = filter.trim().toLowerCase();
  const rest = sorted.filter(
    (p) =>
      !candidateIds.includes(p.id) &&
      (!q ||
        p.id === personId ||
        `${p.displayName} ${p.currentOrganizationRaw ?? ''}`.toLowerCase().includes(q)),
  );
  const person = people.find((p) => p.id === personId);
  const preview = useMemo(
    () => (!existing && !personId && user ? previewNoteMatch(text, people, user, calendarPerson) : undefined),
    [existing, personId, user, text, people, calendarPerson],
  );
  if (!user) return null;
  const save = async () => {
    setBusy(true);
    try {
      if (existing) {
        await rematchNote(user, existing.id, personId || undefined);
        toast.push({ text: personId ? 'Note matched.' : 'Saved without a person.', tone: 'good' });
        nav(personId ? `/people/${personId}` : '/today');
        return;
      }
      const stageOf = async (pid?: string) =>
        pid
          ? (await db.chats.where('personId').equals(pid).toArray()).sort((a, b) =>
              b.updatedAt.localeCompare(a.updatedAt),
            )[0]?.stage
          : undefined;
      const guessed = personId || (preview?.kind === 'person' ? preview.person.id : undefined);
      const before = await stageOf(guessed);
      const n = await ingestNote(user, {
        text,
        source,
        personIds: personId ? [personId] : undefined,
        occurredAt: new Date(when).toISOString(),
      });
      localStorage.removeItem(DRAFT_KEY);
      if (n.matchStatus === 'unmatched') {
        // Orbit is not sure who it was with: ask now, on the note itself
        toast.push({
          text: n.personIds.length ? 'Saved. Check who this was with.' : 'Saved. Who was this with?',
          tone: 'good',
        });
        nav(`/notes/new?note=${n.id}`);
        return;
      }
      // say what Orbit took from the note, and where the thank-you it drafted is
      const [facts, promises] = await Promise.all([
        db.facts
          .where('personId')
          .anyOf(n.personIds)
          .filter((f) => f.sourceId === n.id)
          .count(),
        db.actionItems
          .where('userId')
          .equals(user.id)
          .filter((a) => a.sourceId === n.id)
          .count(),
      ]);
      const thanks = n.personIds[0]
        ? await db.suggestions
            .where('userId')
            .equals(user.id)
            .filter((x) => x.status === 'pending' && x.kind === 'thank_you' && x.personId === n.personIds[0])
            .first()
        : undefined;
      const found = [
        facts ? `${facts} thing${facts === 1 ? '' : 's'} to remember` : '',
        promises ? `${promises} promise${promises === 1 ? '' : 's'} you made` : '',
      ].filter(Boolean);
      const who = people.find((p) => p.id === n.personIds[0]);
      const after = await stageOf(n.personIds[0]);
      const moved =
        after && after !== before && who ? ` Moved ${who.firstName} to ${STAGE_LABELS[after]}.` : '';
      toast.push({
        text: `Saved${who ? ` for ${who.displayName}` : ''}.${found.length ? ` Orbit noted ${found.join(' and ')}.` : ''}${moved}${thanks ? ' Your thank-you draft is at the top of the page.' : ''}`,
        tone: 'good',
        ttl: 8000,
      });
      // the person page shows the thank-you draft at its top, so the student lands on it
      nav(n.personIds[0] ? `/people/${n.personIds[0]}${facts && !thanks ? '?tab=facts' : ''}` : '/today');
    } finally {
      setBusy(false);
    }
  };
  const onFile = async (f: File) => {
    const t = await f.text();
    setText(t);
    setSource('upload');
  };
  return (
    <div className="max-w-[760px]">
      <PageHeader
        title={existing ? 'Who was this note with?' : 'Add a note'}
        subtitle={
          existing
            ? existing.title
            : 'Right after a chat: what did you learn, what did they offer, what did you promise? Type, dictate or paste notes from another app.'
        }
      />
      <Card className="space-y-4">
        {existing ? (
          <div className="rounded-lg bg-canvas-2 p-3 text-[13px] whitespace-pre-line max-h-64 overflow-y-auto">
            {existing.rawText.slice(0, 2000)}
          </div>
        ) : (
          <div>
            <Textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={12}
              placeholder={
                'e.g. Priya leads payments onboarding. She recommended one concrete project story for interviews. They are hiring interns in January. She offered to refer me. I will send my resume by Friday.'
              }
              data-testid="capture-text"
            />
            <div className="flex flex-wrap items-center gap-3 mt-2 text-[12px] text-ink-3">
              <span>Tip: your phone's or computer's dictation works in this box.</span>
              <label className="ml-auto cursor-pointer underline underline-offset-2 rounded focus-within:ring-2 focus-within:ring-accent/40">
                Upload .txt / .md
                <input
                  type="file"
                  accept=".txt,.md,.markdown"
                  className="sr-only"
                  onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
                />
              </label>
            </div>
          </div>
        )}
        <div className="grid sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2">
            <Label htmlFor="capture-person">Who was this with?</Label>
            {people.length > 12 && (
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Type a name to narrow the list"
                aria-label="Narrow the list of people"
                className="w-full mb-1.5"
                data-testid="capture-person-filter"
              />
            )}
            <Select
              id="capture-person"
              value={personId}
              onChange={(e) => setPersonId(e.target.value)}
              className="w-full"
              data-testid="capture-person"
            >
              <option value="">{existing ? 'Nobody I track' : 'Let Orbit figure it out'}</option>
              {mentioned.length > 0 && (
                <optgroup label="Mentioned in the note">
                  {mentioned.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                      {p.currentOrganizationRaw ? ` · ${p.currentOrganizationRaw}` : ''}
                    </option>
                  ))}
                </optgroup>
              )}
              {rest.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                  {p.currentOrganizationRaw ? ` · ${p.currentOrganizationRaw}` : ''}
                </option>
              ))}
            </Select>
            {preview && (
              <p
                className="mt-1.5 text-[12px] text-ink-2"
                data-testid="capture-match-preview"
                aria-live="polite"
              >
                {preview.kind === 'person' ? (
                  <>
                    Orbit will file this with{' '}
                    <strong className="font-medium">{preview.person.displayName}</strong>
                    {preview.why === 'calendar'
                      ? ', from the chat on your calendar that just ended.'
                      : ', who the note names.'}{' '}
                    <button
                      type="button"
                      className="underline underline-offset-2"
                      onClick={() => setPersonId(preview.person.id)}
                    >
                      Pick {preview.person.firstName}
                    </button>{' '}
                    to be sure, or choose someone else above.
                  </>
                ) : preview.kind === 'several' ? (
                  <>
                    The note names {preview.people.map((p) => p.firstName).join(', ')}. Pick who it was with,
                    or Orbit asks you after you save.
                  </>
                ) : text.trim() ? (
                  'No name in the note yet. Orbit asks you who it was with after you save.'
                ) : null}
              </p>
            )}
            <button
              type="button"
              className="mt-1.5 text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink"
              onClick={() => setAdding(true)}
              data-testid="capture-add-person"
            >
              Not in Orbit yet? Add them
            </button>
            {adding && <AddPersonDialog onClose={() => setAdding(false)} onAdded={(id) => setPersonId(id)} />}
          </div>
          <div>
            <Label htmlFor="capture-when">When</Label>
            <Input
              id="capture-when"
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
          </div>
        </div>
        {!existing && (
          <div
            className="flex flex-wrap items-center gap-2 text-[13px]"
            role="group"
            aria-label="How you took this note"
          >
            <span className="text-ink-3">How you took it</span>
            {(
              [
                ['manual', 'Typed'],
                ['wispr_capture', 'Dictated'],
                ['granola_email', 'Notetaker app'],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                onClick={() => setSource(k)}
                aria-pressed={source === k}
                className={`h-8 px-3 rounded-full border text-[12px] ${source === k ? 'border-ink bg-ink text-white' : 'border-line text-ink-2'}`}
              >
                {l}
              </button>
            ))}
            <span className="basis-full text-[12px] text-ink-3">
              {source === 'wispr_capture'
                ? "Use your phone's or computer's dictation in the box above. This only tells Orbit the note has no punctuation."
                : source === 'granola_email'
                  ? 'Paste the summary your notetaker app wrote. Orbit reads its title line and sections.'
                  : 'This only helps Orbit read the note. Nothing else changes.'}
            </span>
          </div>
        )}
        <div className="flex items-center gap-3">
          {person && (
            <span className="inline-flex items-center gap-2 text-[13px] text-ink-2">
              <Avatar name={person.displayName} id={person.id} size={22} /> {person.displayName}
            </span>
          )}
          <Button
            variant="primary"
            className="ml-auto"
            disabled={busy || (!existing && !text.trim())}
            onClick={save}
            data-testid="capture-save"
          >
            {busy
              ? 'Saving…'
              : existing
                ? personId
                  ? `Save note for ${person?.firstName ?? 'them'}`
                  : 'Save without a person'
                : 'Save note'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
