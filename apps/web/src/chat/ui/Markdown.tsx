import { Fragment, type ReactNode } from 'react';

/** Markdown-lite for assistant text: paragraphs, bullet and numbered lists, bold, inline code. Nothing else. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = text.split(/\n{2,}/).filter((b) => b.trim());
  return (
    <div className={className}>
      {blocks.map((block, i) => {
        const lines = block.split('\n');
        if (lines.every((l) => /^\s*[-*]\s+/.test(l)))
          return (
            <ul key={i} className="list-disc pl-5 my-2 space-y-1">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*[-*]\s+/, ''))}</li>
              ))}
            </ul>
          );
        if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l)))
          return (
            <ol key={i} className="list-decimal pl-5 my-2 space-y-1">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>
              ))}
            </ol>
          );
        return (
          <p key={i} className="my-2 first:mt-0 last:mb-0 whitespace-pre-wrap">
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

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null = re.exec(s);
  while (m) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={m.index}>{tok.slice(2, -2)}</strong>);
    else
      out.push(
        <code key={m.index} className="rounded bg-canvas-2 px-1 text-[0.92em]">
          {tok.slice(1, -1)}
        </code>,
      );
    last = m.index + tok.length;
    m = re.exec(s);
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
