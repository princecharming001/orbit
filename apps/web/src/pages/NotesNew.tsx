import { useLiveQuery } from 'dexie-react-hooks';
import { Mic } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
      toast.push({ text: 'Saved. Facts and follow-ups extracted.', tone: 'good' });
      nav(n.personIds[0] ? `/people/${n.personIds[0]}` : '/today');
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
            : 'Talk it out: what did you learn, what did they offer, what did you promise? Dictation (Wispr Flow or any) works here.'
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
            <div className="flex items-center gap-3 mt-2 text-[12px] text-ink-3">
              <span className="inline-flex items-center gap-1">
                <Mic size={12} /> Dictation-friendly
              </span>
              <label className="ml-auto cursor-pointer underline underline-offset-2">
                Upload .txt / .md
                <input
                  type="file"
                  accept=".txt,.md,.markdown"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
                />
              </label>
            </div>
          </div>
        )}
        <div className="grid sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2">
            <Label>Who was this with?</Label>
            <Select
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
          </div>
          <div>
            <Label>When</Label>
            <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </div>
        </div>
        {!existing && (
          <div className="flex items-center gap-2 text-[13px]">
            <span className="text-ink-3">Source</span>
            {(
              [
                ['manual', 'Typed'],
                ['wispr_capture', 'Dictated'],
                ['granola_email', 'Granola'],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                onClick={() => setSource(k)}
                className={`h-7 px-2.5 rounded-full border text-[12px] ${source === k ? 'border-ink bg-ink text-white' : 'border-line text-ink-2'}`}
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
            {busy ? 'Saving…' : existing ? 'Save match' : 'Save note'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
