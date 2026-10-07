import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AddPersonDialog } from '../components/AddPerson';
import { db } from '../db/schema';
import { ingestNote, rematchNote } from '../engine/notes';
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
  useEffect(() => {
    if (noteId) return;
    if (!presetPerson && recentEvent?.attendeePersonIds[0] && !personId)
      setPersonId(recentEvent.attendeePersonIds[0]);
  }, [recentEvent, presetPerson, personId, noteId]);
  // matching a saved note: start from Orbit's guess, if it made one
  useEffect(() => {
    if (existing && existing.personIds.length === 1 && !presetPerson) setPersonId(existing.personIds[0]!);
  }, [existing, presetPerson]);
  useEffect(() => {
    const t = setTimeout(() => localStorage.setItem(DRAFT_KEY, text), 500);
    return () => clearTimeout(t);
  }, [text]);
  const sorted = useMemo(() => people.slice().sort((a, b) => b.strength - a.strength), [people]);
  const mentioned = sorted.filter((p) => candidateIds.includes(p.id));
  const rest = sorted.filter((p) => !candidateIds.includes(p.id));
  const person = people.find((p) => p.id === personId);
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
      toast.push({
        text: `Saved.${found.length ? ` Orbit noted ${found.join(' and ')}.` : ''}${thanks ? ' Your thank-you draft is ready.' : ''}`,
        tone: 'good',
        ttl: 8000,
        action: thanks
          ? { label: 'Open thank-you', onClick: () => nav(`/today?card=${thanks.id}`) }
          : undefined,
      });
      nav(n.personIds[0] ? `/people/${n.personIds[0]}${facts ? '?tab=facts' : ''}` : '/today');
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
            title="Helps Orbit read it: dictated notes and notetaker summaries are laid out differently from typed ones"
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
