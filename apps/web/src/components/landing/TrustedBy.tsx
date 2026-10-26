import { useEffect, useRef, useState } from 'react';
import { cx } from '../../ui';
import { studentCount } from './studentCount';

/** [logo file in /logos, name] */
const SCHOOLS: [string, string][] = [
  ['harvard', 'Harvard'],
  ['stanford', 'Stanford'],
  ['mit', 'MIT'],
  ['yale', 'Yale'],
  ['princeton', 'Princeton'],
  ['columbia', 'Columbia'],
  ['penn', 'Penn'],
  ['cornell', 'Cornell'],
  ['berkeley', 'UC Berkeley'],
  ['brown', 'Brown'],
  ['uchicago', 'UChicago'],
  ['dartmouth', 'Dartmouth'],
  ['umich', 'Michigan'],
  ['ucla', 'UCLA'],
  ['duke', 'Duke'],
  ['northwestern', 'Northwestern'],
  ['nyu', 'NYU'],
  ['cmu', 'Carnegie Mellon'],
  ['georgetown', 'Georgetown'],
  ['jhu', 'Johns Hopkins'],
  ['caltech', 'Caltech'],
  ['utexas', 'UT Austin'],
  ['gatech', 'Georgia Tech'],
  ['usc', 'USC'],
  ['uva', 'UVA'],
  ['rice', 'Rice'],
  ['notredame', 'Notre Dame'],
  ['vanderbilt', 'Vanderbilt'],
  ['wustl', 'WashU'],
  ['illinois', 'Illinois'],
];

const COMPANIES: [string, string][] = [
  ['google', 'Google'],
  ['openai', 'OpenAI'],
  ['goldman', 'Goldman Sachs'],
  ['mckinsey', 'McKinsey'],
  ['apple', 'Apple'],
  ['janestreet', 'Jane Street'],
  ['anthropic', 'Anthropic'],
  ['stripe', 'Stripe'],
  ['bcg', 'BCG'],
  ['meta', 'Meta'],
  ['citadel', 'Citadel'],
  ['nvidia', 'NVIDIA'],
  ['blackstone', 'Blackstone'],
  ['figma', 'Figma'],
  ['microsoft', 'Microsoft'],
  ['jpmorgan', 'J.P. Morgan'],
  ['bain', 'Bain'],
  ['databricks', 'Databricks'],
  ['amazon', 'Amazon'],
  ['twosigma', 'Two Sigma'],
  ['ramp', 'Ramp'],
  ['morganstanley', 'Morgan Stanley'],
  ['netflix', 'Netflix'],
  ['palantir', 'Palantir'],
  ['airbnb', 'Airbnb'],
  ['scale', 'Scale AI'],
  ['tesla', 'Tesla'],
  ['notion', 'Notion'],
  ['linear', 'Linear'],
];

const logo = (slug: string) => `${import.meta.env.BASE_URL}logos/${slug}.png`;

/**
 * One digit that rolls to its new value, like an odometer. An invisible digit sets its width and its baseline, and
 * clip-path (not overflow, which would move the baseline) hides the rest of the strip, so it sits in line with the
 * words around it.
 */
function Digit({ d }: { d: number }) {
  return (
    <span className="relative inline-block leading-[1.2] [clip-path:inset(0)]">
      <span className="invisible">0</span>
      <span
        className="odometer-strip absolute inset-x-0 top-0 flex flex-col"
        style={{ transform: `translateY(-${d * 10}%)` }}
      >
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} className="block h-[1.2em] leading-[1.2] text-center">
            {i}
          </span>
        ))}
      </span>
    </span>
  );
}

/** 1,833 with each digit rolling when the count goes up; screen readers hear the number once. */
function Odometer({ value }: { value: number }) {
  const text = value.toLocaleString('en-US');
  const chars = [...text];
  return (
    <span className="tabular" aria-hidden>
      {chars.map((c, i) =>
        /\d/.test(c) ? (
          // keyed from the right, so the ones digit stays the ones digit when a new place appears
          <Digit key={chars.length - i} d={Number(c)} />
        ) : (
          <span key={`sep-${chars.length - i}`}>{c}</span>
        ),
      )}
    </span>
  );
}

/**
 * The live count: what the shared schedule says now, counted up from a little lower the first time the section is
 * seen, then rolling up by itself whenever the next students arrive while the page is open.
 */
function useLiveCount(visible: boolean): { value: number; bump?: { n: number; key: number } } {
  const [value, setValue] = useState(() => studentCount().count - 48);
  const [bump, setBump] = useState<{ n: number; key: number }>();
  const intro = useRef(false);
  useEffect(() => {
    if (!visible || intro.current) return;
    intro.current = true;
    const target = studentCount().count;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return setValue(target);
    // a quick count up to today's number, the first time it comes into view
    const from = target - 48;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 1400);
      setValue(Math.round(from + (target - from) * (1 - (1 - k) ** 3)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [visible]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const { nextAt } = studentCount();
      if (!nextAt) return;
      // timers longer than ~24 days overflow; check back daily at most
      timer = setTimeout(
        () => {
          const now = studentCount().count;
          setValue((v) => {
            if (now > v) setBump({ n: now - v, key: Date.now() });
            return Math.max(v, now);
          });
          schedule();
        },
        Math.min(Math.max(0, nextAt - Date.now()) + 50, 86_400_000),
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);
  return { value, bump };
}

/**
 * A column of logo tiles that drifts upward (or downward) forever, fading in and out at its ends. It stops while
 * hovered, and stays still for reduced motion.
 */
function Column({
  items,
  label,
  down,
  testId,
}: {
  items: [string, string][];
  label: string;
  down?: boolean;
  testId: string;
}) {
  const list = (hidden?: boolean) => (
    <ul className="flex flex-col gap-2.5 pb-2.5" aria-hidden={hidden || undefined}>
      {items.map(([slug, name]) => (
        <li
          key={slug}
          className="flex h-11 items-center gap-2 rounded-[13px] border border-line/80 bg-canvas px-2.5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] sm:h-12 sm:gap-3 sm:rounded-[14px] sm:px-3.5"
        >
          <img
            src={logo(slug)}
            alt=""
            width={26}
            height={26}
            loading="lazy"
            decoding="async"
            className="h-[22px] w-[22px] shrink-0 rounded-[6px] object-contain sm:h-[26px] sm:w-[26px] sm:rounded-[7px]"
          />
          <span className="truncate text-[13px] font-medium tracking-[-0.01em] text-ink sm:text-[14px]">
            {name}
          </span>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="min-w-0">
      <p className="mb-3 px-1 text-[12.5px] text-ink-3" aria-hidden>
        {label}
      </p>
      <div className="trusted-column relative h-[300px] overflow-hidden lg:h-[380px]" data-testid={testId}>
        {/* "Studying @" reads as "Studying at sign": screen readers get the words */}
        <span className="sr-only">
          {label.replace('@', 'at')}: {items.map(([, n]) => n).join(', ')}
        </span>
        <div
          className={cx('trusted-climb', down && 'trusted-climb-down')}
          style={{ animationDuration: `${items.length * 3.2}s` }}
        >
          {list()}
          {list(true)}
        </div>
      </div>
    </div>
  );
}

/**
 * "1,833 students": a live count that rolls up as students join, over two columns drifting past each other, the
 * universities they study at going up and the companies they have offers from coming down. Sits beside the
 * hero's headline on a wide screen and under it on a phone.
 */
export function TrustedBy() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return setVisible(true);
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && setVisible(true), { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const { value, bump } = useLiveCount(visible);
  return (
    <div ref={ref} className="min-w-0" data-testid="trusted-by" role="group" aria-label="Who uses Orbit">
      <div className="flex items-center gap-2 px-1 text-[12.5px] text-ink-3">
        <span className="relative flex h-2 w-2" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-good opacity-40" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-good" />
        </span>
        Live
      </div>
      <p className="mt-2 px-1 display text-[34px] md:text-[40px] leading-[1.05]">
        <span className="relative inline-block" data-testid="trusted-count">
          <span className="sr-only">{value.toLocaleString('en-US')}</span>
          <Odometer value={value} />
          {bump && (
            <span
              key={bump.key}
              className="trusted-bump absolute -right-2 top-0 translate-x-full rounded-full bg-good/10 px-1.5 py-0.5 font-sans text-[12px] font-semibold tracking-normal text-good"
              aria-hidden
            >
              +{bump.n}
            </span>
          )}
        </span>{' '}
        <span className="text-ink-3">students</span>
      </p>
      <div className="mt-6 grid grid-cols-2 gap-2.5 sm:gap-3">
        <Column items={SCHOOLS} label="Studying @" testId="trusted-schools" />
        <Column items={COMPANIES} label="With offers @" down testId="trusted-companies" />
      </div>
    </div>
  );
}

/**
 * The student count as a plain number for anywhere else on the page: the same schedule as the count above, so the
 * two always agree, and it moves when the next students arrive while the page is open.
 */
export function useStudentCount(): number {
  const [count, setCount] = useState(() => studentCount().count);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const { nextAt } = studentCount();
      if (!nextAt) return;
      timer = setTimeout(
        () => {
          setCount(studentCount().count);
          schedule();
        },
        Math.min(Math.max(0, nextAt - Date.now()) + 50, 86_400_000),
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);
  return count;
}
