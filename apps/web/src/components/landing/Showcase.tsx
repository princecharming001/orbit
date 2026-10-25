import { Check, ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { demoFace } from '../../engine/demoFaces';
import { Avatar, Chip, cx } from '../../ui';
import { STAGE_COLOR } from '../people/shared';

/**
 * The landing page's still pictures of the product: Drafts, the board and the Prep deck, drawn with the app's own
 * pieces (Avatar, Chip, the stage colours, the company logos) and the demo's made-up people, so what the page shows is
 * what the demo opens on. They are pictures: nothing in them is a control.
 */

const logo = (slug: string) => `${import.meta.env.BASE_URL}logos/${slug}.png`;

function Co({ slug, name }: { slug: string; name: string }) {
  return (
    <img
      src={logo(slug)}
      alt=""
      title={name}
      className="w-3.5 h-3.5 rounded-[3px] object-contain shrink-0"
      loading="lazy"
    />
  );
}

/** A soft backdrop that a picture of the product sits on, with a faint dot grid. */
export function Stage({
  tone = 'sand',
  children,
  className,
  testId,
}: {
  tone?: 'sand' | 'mint' | 'mist';
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const bg = { sand: 'bg-[#f4f1ec]', mint: 'bg-[#eaf1ed]', mist: 'bg-[#eef0f3]' }[tone];
  return (
    <div
      className={cx('relative overflow-hidden rounded-[22px] border border-line', bg, className)}
      data-testid={testId}
      aria-hidden
    >
      <div className="absolute inset-0 bg-[radial-gradient(rgba(10,10,10,0.07)_1px,transparent_1px)] [background-size:18px_18px] [mask-image:radial-gradient(ellipse_at_center,black_40%,transparent_85%)]" />
      <div className="relative">{children}</div>
    </div>
  );
}

const card = 'rounded-[12px] border border-line bg-canvas shadow-[0_1px_2px_rgba(0,0,0,0.04)]';
const lift = 'shadow-[0_24px_60px_-24px_rgba(10,10,10,0.25),0_1px_2px_rgba(0,0,0,0.05)]';

// ---------- Drafts ----------

const DRAFT_ROWS: {
  first: string;
  name: string;
  co: [string, string];
  chip: string;
  tone: 'good' | 'warn' | 'accent';
  why: string;
}[] = [
  {
    first: 'Lena',
    name: 'Lena Novak',
    co: ['ramp', 'Ramp'],
    chip: 'Thank-you',
    tone: 'good',
    why: 'You spoke 2 days ago. Send a thank-you while it is fresh.',
  },
  {
    first: 'Daniel',
    name: 'Daniel Okafor',
    co: ['stripe', 'Stripe'],
    chip: 'Follow-up',
    tone: 'warn',
    why: 'No reply in 6 business days; one short bump is fine.',
  },
  {
    first: 'Omar',
    name: 'Omar Haddad',
    co: ['notion', 'Notion'],
    chip: 'Confirm time',
    tone: 'accent',
    why: 'Omar suggested Tuesday at 2pm; confirm it and send the invite.',
  },
  {
    first: 'Hannah',
    name: 'Hannah Brooks',
    co: ['figma', 'Figma'],
    chip: 'Find a time',
    tone: 'accent',
    why: 'Hannah replied and said yes; propose two times that work.',
  },
];

/** Drafts: the day's list and one draft open, written from the student's notes. */
export function DraftsPreview() {
  return (
    <div className="grid md:grid-cols-[260px_minmax(0,1fr)] gap-3 text-left" data-testid="lp-drafts">
      <div className="hidden md:block min-w-0">
        <div className="text-[11px] uppercase tracking-wide text-ink-3 mb-1.5 px-1 flex items-center gap-2">
          To send <span className="tabular">6</span>
        </div>
        <ul className={cx(card, 'divide-y divide-line-2 overflow-hidden')}>
          {DRAFT_ROWS.map((r, i) => (
            <li
              key={r.name}
              className={cx('flex items-start gap-2.5 px-3 py-2.5', i === 0 && 'bg-[#f3f7f5]')}
            >
              <Avatar name={r.name} src={demoFace(r.first)} size={28} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className={cx('text-[13px]', i === 0 ? 'font-semibold' : 'font-medium')}>
                    {r.name}
                  </span>
                  <Co slug={r.co[0]} name={r.co[1]} />
                </span>
                <span className="flex items-center gap-1.5 mt-0.5 min-w-0">
                  <Chip tone={r.tone} className="h-[18px] text-[10.5px] px-1.5">
                    {r.chip}
                  </Chip>
                  <span className="text-[11.5px] text-ink-3 truncate">{r.why}</span>
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className={cx(card, lift, 'min-w-0 p-4 sm:p-5')}>
        <div className="flex items-start gap-3">
          <Avatar name="Lena Novak" src={demoFace('Lena')} size={36} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Chip tone="good">Thank-you</Chip>
              <span className="text-[14px] font-medium">Lena Novak</span>
              <Co slug="ramp" name="Ramp" />
              <span className="text-[13px] text-ink-3">Engineering Manager</span>
            </div>
            <p className="mt-1 text-[13px] text-ink-2">
              You spoke 2 days ago. Send a thank-you while it is fresh.
            </p>
          </div>
        </div>
        <div className="mt-4 rounded-[10px] border border-line px-3.5 py-3 text-[13px] sm:text-[13.5px] leading-[1.6] text-ink">
          <p>Hi Lena,</p>
          <p className="mt-2.5">
            Thank you for making time on Friday, and especially for{' '}
            <mark className="rounded-[3px] bg-accent-soft text-ink [box-decoration-break:clone]">
              your point that it comes down to one concrete project story
            </mark>
            . I'll send the marketplace project link by Friday, as promised.
          </p>
          <p className="mt-2.5">I'll let you know how recruiting goes.</p>
          <p className="mt-2.5">
            Thanks,
            <br />
            Alex
          </p>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          <span className="h-8 px-3 inline-flex items-center text-[12.5px] text-ink-2">Close</span>
          <span className="h-8 px-3 rounded-full border border-line inline-flex items-center text-[12.5px] text-ink-2">
            Copy text
          </span>
          <span className="h-8 px-3.5 rounded-full bg-accent text-white inline-flex items-center text-[12.5px] font-medium">
            Open email to Lena
          </span>
        </div>
        <p className="mt-3 text-[11.5px] text-ink-3">
          Parts come from your notes: read it once as Lena will.
        </p>
      </div>
    </div>
  );
}

// ---------- the board ----------

type BoardCard = {
  first: string;
  name: string;
  co: [string, string];
  title: string;
  meta: ReactNode;
  chip?: string;
  warmUp?: number;
};

const BOARD: { key: keyof typeof STAGE_COLOR; label: string; cards: BoardCard[] }[] = [
  {
    key: 'warming',
    label: 'Warming up',
    cards: [
      {
        first: 'Noah',
        name: 'Noah Kim',
        co: ['figma', 'Figma'],
        title: 'Software Engineer',
        meta: '4 days in stage',
        warmUp: 1,
      },
    ],
  },
  {
    key: 'outreach_sent',
    label: 'First message sent',
    cards: [
      {
        first: 'Caleb',
        name: 'Caleb Weber',
        co: ['notion', 'Notion'],
        title: 'Software Engineer',
        meta: '9 days in stage',
      },
      {
        first: 'Daniel',
        name: 'Daniel Okafor',
        co: ['stripe', 'Stripe'],
        title: 'Software Engineer',
        meta: (
          <>
            You wrote 10 days ago · <span className="text-warn">quiet</span>
          </>
        ),
        chip: 'Follow-up',
      },
    ],
  },
  {
    key: 'replied',
    label: 'Replied',
    cards: [
      {
        first: 'Hannah',
        name: 'Hannah Brooks',
        co: ['figma', 'Figma'],
        title: 'Product Manager',
        meta: '1 day in stage',
        chip: 'Find a time',
      },
    ],
  },
  {
    key: 'scheduled',
    label: 'Scheduled',
    cards: [
      {
        first: 'Omar',
        name: 'Omar Haddad',
        co: ['notion', 'Notion'],
        title: 'Associate Product Manager',
        meta: 'Tue 2:00 pm',
        chip: 'Open prep',
      },
      {
        first: 'Maya',
        name: 'Maya Chen',
        co: ['stripe', 'Stripe'],
        title: 'Software Engineer',
        meta: 'Thu 11:30 am',
      },
    ],
  },
];

/** People: the board, one column per stage, each card with its next step. */
export function BoardPreview() {
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2.5 items-start text-left" data-testid="lp-board">
      {BOARD.map((col, i) => (
        <div key={col.key} className={cx('min-w-0', i >= 2 && 'hidden sm:block')}>
          <div className="flex items-center gap-2 px-1 mb-2 text-[13px]">
            <span className="w-2 h-2 rounded-full" style={{ background: STAGE_COLOR[col.key] }} />
            <span className="font-medium">{col.label}</span>
            <span className="text-ink-3 tabular">{col.cards.length}</span>
          </div>
          <div className="rounded-[12px] bg-black/[0.035] p-1.5 space-y-1.5">
            {col.cards.map((c) => (
              <div key={c.name} className={cx(card, 'p-3')} data-testid="lp-board-card">
                <div className="flex items-start gap-2.5">
                  <Avatar name={c.name} src={demoFace(c.first)} size={28} />
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-medium leading-snug">{c.name}</div>
                    <div className="flex items-start gap-1.5 text-[12px] text-ink-3 leading-snug mt-0.5">
                      <span className="mt-[2px]">
                        <Co slug={c.co[0]} name={c.co[1]} />
                      </span>
                      <span>{c.title}</span>
                    </div>
                  </div>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
                  <span className="text-[12px] text-ink-3">{c.meta}</span>
                  {c.chip && <Chip tone="accent">{c.chip}</Chip>}
                </div>
                {c.warmUp !== undefined && (
                  <div className="mt-2">
                    <div className="text-[11px] text-ink-3">Warm-up: {c.warmUp} of 3 steps</div>
                    <div className="mt-1 h-1 rounded-full bg-line overflow-hidden">
                      <div
                        className="h-full w-1/3 rounded-full"
                        style={{ background: STAGE_COLOR.warming }}
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- the Prep deck ----------

/** The Prep deck, open on its intro card, with the cards still to come stacked behind. */
export function PrepPreview() {
  const at = 5;
  return (
    <div className="relative mx-auto w-full max-w-[460px] pt-5 text-left" data-testid="lp-prep">
      <div className="absolute inset-x-8 top-0 h-full rounded-[16px] border border-line bg-canvas/70" />
      <div className="absolute inset-x-4 top-2.5 h-full rounded-[16px] border border-line bg-canvas/90" />
      <div className={cx('relative rounded-[16px] border border-line bg-canvas overflow-hidden', lift)}>
        <div className="px-4 md:px-5 pt-4 pb-2 flex items-center gap-2">
          <span className="flex-1 flex gap-1">
            {PREP_CARDS.map((c, k) => (
              <span
                key={c}
                className={cx(
                  'h-[3px] flex-1 rounded-full',
                  k === at ? 'bg-ink' : k < at ? 'bg-ink-3' : 'bg-line',
                )}
              />
            ))}
          </span>
          <span className="text-[12px] text-ink-3 tabular shrink-0">
            {at + 1} of {PREP_CARDS.length}
          </span>
          <span className="w-8 h-8 rounded-full inline-flex items-center justify-center text-ink-3">
            <X size={16} />
          </span>
        </div>
        <div className="px-5 md:px-6 pb-5">
          <div className="flex items-center gap-2 text-[12px] text-ink-3 mb-2">
            <Avatar name="Omar Haddad" src={demoFace('Omar')} size={20} />
            Omar Haddad
          </div>
          <div className="text-[22px] leading-tight font-medium tracking-[-0.01em]">Your 30-second intro</div>
          <p className="mt-1.5 text-[14px] text-ink-2">Say it out loud once before the call.</p>
          <p className="mt-4 text-[16px] sm:text-[17px] leading-relaxed text-ink">
            I'm a CS junior at Cornell. I spent the summer at Brex on the payments team, and I'm choosing
            between engineering and product for next summer. The APM path is the one I know least about.
          </p>
        </div>
        <div className="px-3 md:px-4 py-3 border-t border-line-2 flex items-center gap-2">
          <span className="w-9 h-9 rounded-full inline-flex items-center justify-center text-ink-2">
            <ChevronLeft size={17} />
          </span>
          <span className="min-w-0 flex-1 text-[11.5px] text-ink-3 hidden sm:block">
            ← → to move · Esc to close
          </span>
          <span className="flex-1 sm:hidden" />
          <span className="h-8 px-3 rounded-full bg-accent text-white inline-flex items-center gap-1 text-[13px] font-medium">
            Next <ChevronRight size={14} />
          </span>
        </div>
      </div>
    </div>
  );
}

/** The deck's cards, in the order a call runs. */
export const PREP_CARDS = [
  'The call',
  'Who they are',
  'Lately',
  'What you share',
  'Where you left off',
  'Your 30-second intro',
  'Openers',
  'Questions',
  'Keep in mind',
  'After the call',
] as const;

/** A tick and a line, for the lists beside each picture. */
export function Point({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2.5 text-[14.5px] leading-[1.5] text-ink-2">
      <span className="mt-[3px] w-[18px] h-[18px] rounded-full bg-accent-soft text-accent inline-flex items-center justify-center shrink-0">
        <Check size={11} strokeWidth={2.5} />
      </span>
      <span>{children}</span>
    </li>
  );
}
