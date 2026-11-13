/**
 * Notes from the call itself (Zoom and Google Meet): the pieces the browser and the server share. Which app a join
 * link belongs to, the Zoom meeting id or Meet code in it, which recorded meeting is the coffee chat on the calendar,
 * Zoom's transcript (WebVTT) and Meet's transcript entries as speaker-labelled lines, and Zoom's AI Companion summary
 * as plain text. Pure: no fetch, no clock.
 */

export type CallApp = 'zoom' | 'google_meet';

/** A call's notes as the server found them, ready to be filed like a notetaker's meeting. */
export interface CallNote {
  app: CallApp;
  /** the calendar event (the browser's id) the notes are for */
  eventId: string;
  /** the app's own id for the recorded meeting (Zoom's meeting uuid, Meet's conference record name) */
  meetingId: string;
  title: string;
  startAt?: string;
  /** a link back to the recording or the transcript document */
  url?: string;
  /** Zoom AI Companion's summary, when the account has it */
  summary?: string;
  /** "Maya Chen: ..." lines */
  transcript?: string;
}

/** A coffee chat on the calendar, as much as the server needs to find its recording. */
export interface CallEventRef {
  id: string;
  startAt: string;
  endAt: string;
  title?: string;
  conferenceUrl?: string;
  /** the other people on the invite: names and addresses */
  attendees?: { name?: string; email?: string }[];
}

/** The longest transcript filed on a note; past it the rest is left out with a line saying so. */
export const MAX_TRANSCRIPT_CHARS = 24_000;
/** A recording counts for an event when it starts this close to the event (either way). */
export const CALL_MATCH_WINDOW_MS = 30 * 60_000;

const hostOf = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    return new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

const isZoomHost = (h: string) =>
  h === 'zoom.us' || h.endsWith('.zoom.us') || h === 'zoomgov.com' || h.endsWith('.zoomgov.com');

/** Which call app a join link is for. */
export function callAppOfUrl(url: string | undefined): CallApp | undefined {
  const h = hostOf(url);
  if (!h) return undefined;
  if (isZoomHost(h)) return 'zoom';
  if (h === 'meet.google.com') return 'google_meet';
  return undefined;
}

/** The Zoom meeting id in a join link (zoom.us/j/85012345678?pwd=..., /w/, /s/, /wc/join/), digits only. */
export function zoomMeetingIdFromUrl(url: string | undefined): string | undefined {
  if (callAppOfUrl(url) !== 'zoom') return undefined;
  const path = new URL(url!.trim()).pathname;
  const m = path.match(/\/(?:j|w|s|wc\/join|wc)\/(\d{9,12})(?:\/|$)/);
  return m?.[1];
}

/** The Meet code in a link (meet.google.com/abc-mnop-xyz). */
export function meetCodeFromUrl(url: string | undefined): string | undefined {
  if (callAppOfUrl(url) !== 'google_meet') return undefined;
  const m = new URL(url!.trim()).pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|$)/i);
  return m?.[1]?.toLowerCase();
}

// ---- WebVTT --------------------------------------------------------------------------------------------------------

export interface TranscriptLine {
  speaker?: string;
  text: string;
  /** seconds from the start of the recording */
  start?: number;
}

const toSeconds = (t: string): number | undefined => {
  const m = t.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4] ?? '0'}`);
};

const stripTags = (s: string) =>
  s
    .replace(/<\/?[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();

/**
 * The cues of a WebVTT file, each with who spoke when the cue names them. Zoom writes "Maya Chen: text"; other files
 * use a voice tag (`<v Maya Chen>text`). Header, NOTE and STYLE blocks and cue numbers are skipped.
 */
export function parseVtt(vtt: string | undefined): TranscriptLine[] {
  if (!vtt) return [];
  const blocks = vtt
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/);
  const out: TranscriptLine[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const start = toSeconds(lines[at]!.split('-->')[0]!);
    const raw = lines
      .slice(at + 1)
      .join(' ')
      .trim();
    if (!raw) continue;
    let speaker: string | undefined;
    let text = raw;
    const voice = raw.match(/^<v(?:\.[^\s>]+)*\s+([^>]+)>([\s\S]*)$/);
    if (voice) {
      speaker = voice[1]!.trim();
      text = voice[2]!;
    } else {
      const named = raw.match(/^([^:<>]{1,60}?):\s+([\s\S]+)$/);
      // "Note: ..." or a time like "10: 30" is not a name
      if (named && /\p{L}/u.test(named[1]!) && !/^\d/.test(named[1]!)) {
        speaker = named[1]!.trim();
        text = named[2]!;
      }
    }
    text = stripTags(text);
    if (text) out.push({ speaker, text, start });
  }
  return out;
}

/** Lines as "Speaker: what they said", one turn per line: a speaker's cues in a row are joined into one turn. */
export function transcriptText(lines: TranscriptLine[], maxChars = MAX_TRANSCRIPT_CHARS): string {
  const turns: { speaker?: string; text: string }[] = [];
  for (const l of lines) {
    const last = turns.at(-1);
    if (last && last.speaker === l.speaker) last.text = `${last.text} ${l.text}`;
    else turns.push({ speaker: l.speaker, text: l.text });
  }
  let out = '';
  for (const t of turns) {
    const line = t.speaker ? `${t.speaker}: ${t.text.trim()}` : t.text.trim();
    if (out.length + line.length + 1 > maxChars) {
      out += `${out ? '\n' : ''}(The rest of the transcript is longer than Orbit keeps.)`;
      break;
    }
    out += `${out ? '\n' : ''}${line}`;
  }
  return out;
}

/** A WebVTT file straight to speaker-labelled text. */
export const vttToText = (vtt: string | undefined, maxChars?: number) =>
  transcriptText(parseVtt(vtt), maxChars);

// ---- Google Meet ---------------------------------------------------------------------------------------------------

/** One entry of a Meet transcript (transcripts.entries), with the participant's resource name. */
export interface MeetEntry {
  participant?: string;
  text?: string;
  startTime?: string;
}

/**
 * Meet's transcript entries as speaker-labelled text. `names` maps a participant's resource name to their display
 * name (from conferenceRecords.participants); an unknown one reads as "Someone".
 */
export function meetEntriesToText(
  entries: MeetEntry[],
  names: Record<string, string>,
  maxChars = MAX_TRANSCRIPT_CHARS,
): string {
  const sorted = [...entries]
    .filter((e) => e.text?.trim())
    .sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''));
  return transcriptText(
    sorted.map((e) => ({
      speaker: (e.participant && names[e.participant]) || 'Someone',
      text: e.text!.trim(),
    })),
    maxChars,
  );
}

/** A Meet participant's display name, whichever kind of participant it is. */
export function meetParticipantName(p: Record<string, unknown>): string | undefined {
  for (const k of ['signedinUser', 'anonymousUser', 'phoneUser']) {
    const v = (p[k] as { displayName?: unknown } | undefined)?.displayName;
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

// ---- Zoom AI Companion summary -------------------------------------------------------------------------------------

/** Zoom's meeting summary (GET /meetings/{uuid}/meeting_summary) as plain text, or undefined when it says nothing. */
export function zoomSummaryText(j: Record<string, unknown> | undefined): string | undefined {
  if (!j) return undefined;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const parts: string[] = [];
  const content = s(j.summary_content);
  if (content) parts.push(content);
  else {
    const overview = s(j.summary_overview);
    if (overview) parts.push(overview);
    for (const d of Array.isArray(j.summary_details) ? j.summary_details : []) {
      const o = d as { label?: unknown; summary?: unknown };
      const text = s(o.summary);
      if (text) parts.push(s(o.label) ? `${s(o.label)}: ${text}` : text);
    }
  }
  const steps = (Array.isArray(j.next_steps) ? j.next_steps : []).map(s).filter(Boolean) as string[];
  if (steps.length) parts.push(['Next steps:', ...steps.map((x) => `- ${x}`)].join('\n'));
  return parts.length ? parts.join('\n\n') : undefined;
}

// ---- which recorded meeting is the coffee chat ------------------------------------------------------------------------

/** A recorded meeting the app listed: its own ids, when it started, what it was called. */
export interface RecordedMeeting {
  /** Zoom: the meeting number; Meet: the meeting code */
  joinId?: string;
  startAt?: string;
  topic?: string;
}

const lowerWords = (s: string | undefined) =>
  (s ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1);

/**
 * The recorded meeting that is this event: the one with the event's own meeting id or code (the join link), else the
 * one that started within half an hour of it, preferring one whose title names someone on the invite, then the
 * closest in time. Undefined when none fits.
 */
export function matchCallToEvent<M extends RecordedMeeting>(
  meetings: M[],
  ev: CallEventRef,
  app: CallApp,
): M | undefined {
  const joinId = app === 'zoom' ? zoomMeetingIdFromUrl(ev.conferenceUrl) : meetCodeFromUrl(ev.conferenceUrl);
  const start = Date.parse(ev.startAt);
  const end = Date.parse(ev.endAt);
  const dist = (m: M) => Math.abs(Date.parse(m.startAt ?? '') - start);
  // a meeting reopened on the same link the next week is a different chat: the id must also fit the day
  const inWindow = (m: M) => {
    const t = Date.parse(m.startAt ?? '');
    return (
      Number.isFinite(t) &&
      t >= start - CALL_MATCH_WINDOW_MS &&
      t <= Math.max(end, start) + CALL_MATCH_WINDOW_MS
    );
  };
  const near = meetings.filter(inWindow);
  if (joinId) {
    const same = near.filter((m) => m.joinId?.replace(/\s/g, '').toLowerCase() === joinId);
    if (same.length) return same.sort((a, b) => dist(a) - dist(b))[0];
    // the event has its own link: a recording of another meeting is not this chat
    return undefined;
  }
  if (!near.length) return undefined;
  const names = new Set(
    (ev.attendees ?? []).flatMap((a) => [...lowerWords(a.name), ...lowerWords(a.email?.split('@')[0])]),
  );
  const titled = near.filter((m) => lowerWords(m.topic).some((w) => names.has(w)));
  const pool = titled.length ? titled : near;
  return pool.sort((a, b) => dist(a) - dist(b))[0];
}
