import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cx } from '../../ui';
import type { NamedPerson } from './names';

/**
 * Markdown-lite for assistant text: paragraphs, bullet and numbered lists, bold, inline code. Nothing else. The people
 * the turn's results named come out bold and linked (LinkedIn when known), wherever the words mention them.
 */
export function Markdown({
  text,
  className,
  people,
}: {
  text: string;
  className?: string;
  people?: NamedPerson[];
}) {
  const inline = (s: string) => inlineWith(s, people ?? []);
  const blocks = text.split(/\n{2,}/).filter((b) => b.trim());
  return (
    <div className={cx('leading-[1.7] my-3 first:mt-0 last:mb-0', className)} data-testid="md">
      {blocks.map((block, i) => {
        const lines = block.split('\n');
        if (lines.every((l) => /^\s*[-*]\s+/.test(l)))
          return (
            <ul key={i} className="list-disc pl-5 my-3 space-y-1.5 first:mt-0 last:mb-0">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*[-*]\s+/, ''))}</li>
              ))}
            </ul>
          );
        if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l)))
          return (
            <ol key={i} className="list-decimal pl-5 my-3 space-y-1.5 first:mt-0 last:mb-0">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>
              ))}
            </ol>
          );
        return (
          <p key={i} className="my-3 first:mt-0 last:mb-0 whitespace-pre-wrap">
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function inlineWith(s: string, people: NamedPerson[]): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null = re.exec(s);
  while (m) {
    if (m.index > last) out.push(...names(s.slice(last, m.index), people, `t${last}`));
    const tok = m[0];
    if (tok.startsWith('**')) {
      const inner = tok.slice(2, -2);
      const who = people.find((p) => p.name.toLowerCase() === inner.trim().toLowerCase());
      out.push(who ? personLink(who, inner, `b${m.index}`) : <strong key={m.index}>{inner}</strong>);
    } else
      out.push(
        <code key={m.index} className="rounded bg-canvas-2 px-1 text-[0.92em]">
          {tok.slice(1, -1)}
        </code>,
      );
    last = m.index + tok.length;
    m = re.exec(s);
  }
  if (last < s.length) out.push(...names(s.slice(last), people, `t${last}`));
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Plain text with each named person's name bold and linked. */
function names(text: string, people: NamedPerson[], key: string): ReactNode[] {
  if (!people.length || !text) return [text];
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])(${people.map((p) => escapeRe(p.name)).join('|')})(?![\\p{L}\\p{N}])`,
    'giu',
  );
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const who = people.find((p) => p.name.toLowerCase() === m[0].toLowerCase());
    if (!who || m.index === undefined) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(personLink(who, m[0], `${key}-${m.index}`));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function personLink(p: NamedPerson, label: string, key: string): ReactNode {
  const cls = 'font-semibold text-ink underline decoration-line underline-offset-[3px] hover:decoration-ink';
  return p.external ? (
    <a
      key={key}
      href={p.href}
      target="_blank"
      rel="noreferrer noopener"
      className={cls}
      data-testid="md-person"
    >
      {label}
    </a>
  ) : (
    <Link key={key} to={p.href} className={cls} data-testid="md-person">
      {label}
    </Link>
  );
}
