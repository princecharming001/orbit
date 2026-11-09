/**
 * Messages in the people-card look (the inbox and the replies): one row a conversation, with the sender's face, their
 * name and LinkedIn mark, a quiet tag (unread, a reply class, how many they sent), the subject or the latest words,
 * and when. The whole row opens the conversation: the Gmail thread, or the person in Orbit.
 */
import { Linkedin, Mail } from 'lucide-react';
import { relDate } from '../../../ui';
import type { ResultEnvelope } from '../../types';
import { Dot, NameTag, PeopleFooter, PeopleShell, PersonLine, useRowFold } from './people';

export interface MessageRow {
  key: string;
  name: string;
  channel: 'email' | 'linkedin';
  personId?: string | null;
  photoUrl?: string | null;
  linkedinUrl?: string | null;
  subject?: string | null;
  snippet: string;
  /** ISO time of the latest message */
  at: string;
  count?: number;
  unread?: boolean;
  /** a word beside the name: the reply class, "Unread" */
  tag?: string;
  /** green for a tag worth acting on */
  good?: boolean;
  /** in-app (`/…`) or outside link */
  href: string;
}

export interface MessagesData {
  title: string;
  sub?: string;
  rows: MessageRow[];
}

export function readMessages(d: unknown): MessagesData | undefined {
  const ui = (d as { ui?: unknown } | undefined)?.ui as Partial<MessagesData> | undefined;
  if (!ui || typeof ui.title !== 'string' || !Array.isArray(ui.rows)) return undefined;
  return { title: ui.title, sub: ui.sub, rows: ui.rows as MessageRow[] };
}

export function MessagesCard({
  env,
  send,
}: {
  env: ResultEnvelope;
  send: (text: string) => Promise<void> | void;
}) {
  const data = readMessages(env.data);
  const rows = data?.rows ?? [];
  const fold = useRowFold(rows, 8);
  if (!data) return null;
  return (
    <PeopleShell title={data.title} sub={data.sub} testId="messages-card">
      <div className="px-1.5 pb-1.5">
        {fold.shown.map((r) => {
          const inApp = r.href.startsWith('/');
          const words = r.subject ? `${r.subject}: ${r.snippet}` : r.snippet;
          return (
            <PersonLine
              key={r.key}
              testId="message-line"
              name={r.name}
              avatar={{ id: r.personId ?? r.key, src: r.photoUrl ?? undefined }}
              linkedinUrl={r.linkedinUrl ?? undefined}
              tag={
                <>
                  {r.tag && <NameTag tone={r.good ? 'good' : 'quiet'}>{r.tag}</NameTag>}
                  {(r.count ?? 1) > 1 && <NameTag>{r.count} messages</NameTag>}
                </>
              }
              line={
                <>
                  {r.channel === 'email' ? (
                    <Mail size={12} className="shrink-0" aria-label="Email" />
                  ) : (
                    <Linkedin size={12} className="shrink-0" aria-label="LinkedIn" />
                  )}
                  <span className={r.unread ? 'min-w-0 truncate font-medium text-ink-2' : 'min-w-0 truncate'}>
                    {words}
                  </span>
                  <Dot />
                  <span className="shrink-0">{relDate(r.at)}</span>
                </>
              }
              to={inApp ? r.href : undefined}
              href={inApp ? undefined : r.href}
              goLabel={r.channel === 'email' && !inApp ? 'Open in Gmail' : 'Open'}
              linkLabel={`Open the conversation with ${r.name}`}
              data={{ channel: r.channel }}
            />
          );
        })}
      </div>
      <PeopleFooter
        fold={fold}
        total={rows.length}
        picked={0}
        onClear={() => undefined}
        pickedSteps={[]}
        steps={[]}
        send={send}
      />
    </PeopleShell>
  );
}
