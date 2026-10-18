import type { User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Compass,
  Inbox,
  Map as MapIcon,
  MessageSquare,
  Minus,
  NotebookPen,
  Plus,
  Search,
  SquarePen,
  Users,
} from 'lucide-react';
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Logo } from '../components/AppShell';
import { db } from '../db/schema';
import { createLocalUser, leaveDemoForOwnSetup } from '../engine/account';
import { DEMO_USER_ID, demoResetPrompt, loadDemo } from '../engine/demo';
import { envGoogleClientId } from '../integrations/prefs';
import { useSession } from '../state/session';
import { Button, cx, Spinner } from '../ui';
import { onboardingPath } from './Onboarding';

// the interactive map draws on a canvas with the app's map engine: loaded after the page itself
const NetworkDemo = lazy(() => import('../components/landing/NetworkDemo'));

export function Landing() {
  const nav = useNavigate();
  const { loading, userId, setUserId } = useSession();
  // The stored profile for the current session (null when there is none). Until it is known the page shows no
  // buttons: a click in that window would load the demo over real data without asking. The answer carries the id it
  // was read for, because a live query keeps returning its previous answer (the "no user" read made while the session
  // was loading) for a render after its key changes.
  const stored = useLiveQuery<{ for: string | undefined; user: User | null }>(
    async () => ({ for: userId, user: userId ? ((await db.users.get(userId)) ?? null) : null }),
    [userId],
  );
  const resolving = loading || !stored || stored.for !== userId;
  const user = resolving ? undefined : (stored?.user ?? undefined);
  const [busy, setBusy] = useState<string | undefined>();
  // the page promises only what this build does: Gmail and Calendar only when this build can connect them
  const google = !!envGoogleClientId();
  const onboarded = !!(userId && user?.onboardingCompletedAt);
  const midSetup = !!(userId && user && !user.onboardingCompletedAt);
  const isDemo = user?.id === DEMO_USER_ID;
  const demo = async () => {
    if (resolving) return;
    if (isDemo && onboarded) return nav('/');
    // Never wipe what someone has already set up without saying so.
    const prompt = demoResetPrompt(user);
    if (prompt && !window.confirm(prompt)) return;
    setBusy('Preparing demo…');
    const u = await loadDemo({ reset: true, onProgress: (m) => setBusy(`${m}…`) });
    await setUserId(u.id);
    nav('/');
  };
  const start = async () => {
    if (resolving) return;
    // the demo holds nothing of the student's: their own setup replaces it
    if (isDemo) {
      setBusy('Clearing the demo…');
      const u = await leaveDemoForOwnSetup();
      await setUserId(u.id);
      nav(onboardingPath(2));
      return;
    }
    // An existing user continues where they are; only a first visit creates a new local profile.
    if (onboarded) return nav('/');
    if (midSetup && user) return nav(onboardingPath(user.onboardingStep));
    setBusy('Creating your space…');
    const u = await createLocalUser();
    await setUserId(u.id);
    nav(onboardingPath(2));
  };
  const startLabel = isDemo
    ? 'Set up Orbit for me'
    : onboarded
      ? 'Open Orbit'
      : midSetup
        ? 'Continue setup'
        : 'Get started';
  const primaryCta = (size: 'md' | 'lg' = 'md') =>
    resolving ? null : (
      <Button size={size} variant="dark" onClick={start} disabled={!!busy}>
        {startLabel}
      </Button>
    );
  // offered mid-setup too: demo() asks before it discards the setup
  const demoCta = (size: 'md' | 'lg' = 'md') =>
    resolving || onboarded ? null : (
      <Button size={size} variant="secondary" onClick={demo} disabled={!!busy}>
        {/* the full progress message is in the status pill at the bottom; the button stays its own width */}
        {busy ? (
          <>
            <Spinner /> Loading…
          </>
        ) : (
          'Try the demo'
        )}
      </Button>
    );
  return (
    <div className="min-h-full bg-page text-ink">
      {busy && (
        // whichever button was pressed, the progress shows where the student is looking
        <div
          className="fixed bottom-6 inset-x-4 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 z-50 flex items-center justify-center gap-2 rounded-full bg-ink text-white px-4 py-2.5 text-[13px] shadow-[0_8px_30px_rgba(0,0,0,0.18)]"
          role="status"
          data-testid="landing-progress"
        >
          <Spinner className="border-white/30 border-t-white" /> {busy}
        </div>
      )}
      <header className="sticky top-0 z-40 bg-page/85 backdrop-blur-md">
        <div className="max-w-[1280px] mx-auto px-5 md:px-8 h-16 flex items-center gap-3">
          <a href="#top" className="inline-flex items-center gap-2" aria-label="Orbit">
            <Logo size={22} />
            <span className="font-medium tracking-[-0.01em] text-[16px]">Orbit</span>
          </a>
          <nav className="hidden lg:flex items-center gap-7 text-[14px] text-ink-2 absolute left-1/2 -translate-x-1/2">
            <a className="hover:text-ink transition-colors" href="#map">
              The map
            </a>
            <a className="hover:text-ink transition-colors" href="#how">
              How it works
            </a>
            <a className="hover:text-ink transition-colors" href="#features">
              Features
            </a>
            <a className="hover:text-ink transition-colors" href="#privacy">
              Privacy
            </a>
            <a className="hover:text-ink transition-colors" href="#faq">
              FAQ
            </a>
          </nav>
          <div className="ml-auto flex items-center gap-2" data-testid="landing-actions">
            {resolving ? null : isDemo && onboarded ? (
              <>
                {/* on a phone the hero below has this button too; the header keeps only the next step */}
                <span className="hidden sm:inline">
                  <Button variant="secondary" onClick={() => nav('/')}>
                    Back to the demo
                  </Button>
                </span>
                <Button variant="dark" onClick={start} disabled={!!busy}>
                  Set up Orbit for me
                </Button>
              </>
            ) : onboarded ? (
              <Button variant="dark" onClick={() => nav('/')}>
                Open Orbit
              </Button>
            ) : (
              <>
                {!midSetup && (
                  <Button variant="secondary" onClick={demo} disabled={!!busy}>
                    Try the demo
                  </Button>
                )}
                <Button variant="dark" onClick={start} disabled={!!busy}>
                  {startLabel}
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      <div id="top" className="max-w-[1280px] mx-auto">
        <section className="px-5 md:px-12 pt-14 md:pt-20 pb-12">
          <Reveal>
            <span className="inline-flex items-center gap-2 rounded-full border border-line bg-canvas px-3 h-8 text-[12.5px] text-ink-2 shadow-[var(--shadow-pill)]">
              <span className="w-4 h-4 rounded-[4px] bg-ember text-white text-[10px] font-semibold inline-flex items-center justify-center">
                O
              </span>
              Built for students who are recruiting
            </span>
          </Reveal>
          <Reveal delay={60}>
            <h1 className="display mt-6 text-[44px] sm:text-[56px] md:text-[64px] max-w-[880px]">
              Every coffee chat, without the busywork.
            </h1>
          </Reveal>
          <div className="mt-8 grid md:grid-cols-[1fr_auto] gap-8 md:gap-16 items-end">
            <Reveal delay={120}>
              <p className="text-[16px] md:text-[17px] leading-[1.55] text-ink-3 max-w-[560px]">
                Orbit finds the people in your network worth a coffee chat, drafts each message in your voice,
                reminds you when to follow up and say thank you, and keeps track of every conversation.
                Nothing is ever sent without you.
              </p>
            </Reveal>
            <Reveal delay={160}>
              <div className="flex flex-col items-start gap-2.5">
                <div className="flex flex-wrap items-center gap-2 min-h-11">
                  {resolving ? <Spinner /> : primaryCta('lg')}
                  {isDemo && onboarded && !resolving && (
                    <Button size="lg" variant="secondary" onClick={() => nav('/')}>
                      Back to the demo
                    </Button>
                  )}
                  {demoCta('lg')}
                </div>
                <p className="text-[13px] text-ink-3">Free to start. Runs in your browser.</p>
              </div>
            </Reveal>
          </div>
          {isDemo && onboarded && (
            <p className="mt-4 text-[13px] text-ink-2">
              You are in the demo, with a made-up student's data. Setting up your own clears it.
            </p>
          )}
          {onboarded && !isDemo && (
            <p className="mt-4 text-[13px] text-ink-2">
              Your data on this browser belongs to {user?.fullName || 'your profile'}. To try the demo
              instead, use Reset to demo in Settings under Data &amp; privacy.
            </p>
          )}
          <Reveal delay={200}>
            <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-ink-3">
              <span>Works with</span>
              <span className="inline-flex items-center gap-1.5 text-ink-2">
                <Users size={14} strokeWidth={1.75} /> LinkedIn connections
              </span>
              <span className="inline-flex items-center gap-1.5 text-ink-2">
                <NotebookPen size={14} strokeWidth={1.75} /> Your chat notes
              </span>
              <span className="inline-flex items-center gap-1.5 text-ink-2">
                <MessageSquare size={14} strokeWidth={1.75} /> Your own mail app
              </span>
            </div>
          </Reveal>
        </section>

        <section id="map" className="scroll-mt-16 px-3 md:px-8 pb-16 md:pb-24">
          <Reveal delay={120}>
            <div className="px-2 md:px-4 mb-6 md:mb-8 grid md:grid-cols-[1fr_auto] gap-3 md:gap-12 items-end">
              <div>
                <p className="label-mono mb-3">The map</p>
                <h2 className="display text-[30px] md:text-[40px] max-w-[640px]">
                  See who can get you in, before you write a word.
                </h2>
              </div>
              <p className="text-[15px] leading-[1.55] text-ink-3 max-w-[420px]">
                Search a company or a person. Orbit finds the warmest route through people you already know,
                says why each hop holds, and drafts the ask. Try it on a sample network.
              </p>
            </div>
          </Reveal>
          <Reveal delay={160}>
            <Suspense
              fallback={
                <div className="h-[600px] rounded-[20px] border border-line bg-canvas animate-pulse" />
              }
            >
              <NetworkDemo />
            </Suspense>
          </Reveal>
        </section>

        <Rule />
        <HowItWorks />
        <Rule />

        <section className="px-3 md:px-12 py-16 md:py-24">
          <Reveal>
            <div className="px-2 md:px-0 mb-8">
              <p className="label-mono mb-3">Your week</p>
              <h2 className="display text-[30px] md:text-[40px] max-w-[640px]">
                Every chat and every draft, in one place.
              </h2>
            </div>
          </Reveal>
          <Reveal delay={80}>
            <ProductMock />
          </Reveal>
        </section>

        <Rule />

        <section id="features" className="scroll-mt-16">
          <div className="px-5 md:px-12 pt-16 md:pt-20 pb-10">
            <Reveal>
              <p className="text-[14px] text-ink-3">Wherever you are in the season.</p>
              <h2 className="display mt-2 text-[30px] md:text-[36px]">
                One assistant. Every step of the chat.
              </h2>
            </Reveal>
          </div>
          <div className="grid md:grid-cols-2 border-t border-line">
            {[
              {
                n: '01 · chat',
                title: 'Ask, and it is done.',
                body: 'Who should I message today? Draft a thank-you to Lena. Find a route to Stripe. The chat answers with cards you can act on.',
              },
              {
                n: '02 · people',
                title: 'Every chat on one board.',
                body: google
                  ? 'From first message to thanked, see where each conversation stands and who went quiet. Replies and meetings move cards on their own.'
                  : 'From first message to thanked, see where each conversation stands and who went quiet. When someone replies, move their card and Orbit lines up your next step.',
              },
              {
                n: '03 · map',
                title: 'Your network as an orbit.',
                body: 'You in the centre, people by how well you know them, and the people they know. Search anyone and Orbit shows who could introduce you.',
              },
              {
                n: '04 · drafts',
                title: 'Drafts in your voice.',
                body: 'Every line comes from something you actually know about the person. You edit it, send it yourself, or skip it.',
              },
            ].map((f, i) => (
              <Reveal
                key={f.n}
                delay={i * 60}
                className={cx(
                  'p-6 md:p-10 border-line',
                  i % 2 === 0 && 'md:border-r',
                  i < 2 && 'border-b',
                  i === 2 && 'border-b md:border-b-0',
                )}
              >
                <div className="label-mono">{f.n}</div>
                <h3 className="mt-3 text-[22px] md:text-[26px] tracking-[-0.02em] leading-tight">
                  {f.title}
                </h3>
                <p className="mt-3 text-[14.5px] leading-relaxed text-ink-3 max-w-[440px]">{f.body}</p>
              </Reveal>
            ))}
          </div>
        </section>

        <Rule />

        <section
          id="privacy"
          className="scroll-mt-16 px-5 md:px-12 py-16 md:py-24 grid md:grid-cols-[1fr_1fr] gap-10"
        >
          <Reveal>
            <p className="text-[14px] text-ink-3">Privacy.</p>
            <h2 className="display mt-2 text-[30px] md:text-[36px]">Your inbox stays yours.</h2>
          </Reveal>
          <Reveal delay={80}>
            <p className="text-[15px] leading-relaxed text-ink-2">
              This version of Orbit runs entirely in your browser. The people, notes and LinkedIn connections
              you add are stored in your browser's local database and never uploaded.{' '}
              {google
                ? "Connecting Gmail and Calendar is optional and uses Google's own sign-in. "
                : 'It does not connect to your email or calendar: you send each message from your own mail app or LinkedIn, and tell Orbit when it went out. '}
              Claude drafting is optional and uses an API key you paste in, stored only on your device.
            </p>
            <ul className="mt-6 divide-y divide-line border-y border-line text-[14px]">
              {[
                ['Nothing is sent without you', 'What goes out is exactly the text you read.'],
                ['No scraping', 'LinkedIn comes from your own data export.'],
                ['Yours to take or wipe', 'Export or delete everything from Settings, any time.'],
              ].map(([a, b]) => (
                <li key={a} className="py-3 flex flex-wrap gap-x-3">
                  <span className="font-medium">{a}</span>
                  <span className="text-ink-3">{b}</span>
                </li>
              ))}
            </ul>
          </Reveal>
        </section>

        <Rule />

        <section
          id="faq"
          className="scroll-mt-16 px-5 md:px-12 py-16 md:py-24 grid md:grid-cols-[1fr_1.3fr] gap-10"
        >
          <Reveal>
            <p className="text-[14px] text-ink-3">Frequently asked.</p>
            <h2 className="display mt-2 text-[34px] md:text-[44px] max-w-[360px]">
              What students ask before starting.
            </h2>
          </Reveal>
          <Reveal delay={80}>
            <Faq
              items={[
                [
                  'Does Orbit send messages for me?',
                  'Never on its own. Orbit writes the draft; you read it, change what you like, and send it from your own account.',
                ],
                [
                  'Who should I reach out to first?',
                  'Orbit ranks people by how well their role and company fit your goals and how easy they are to reach: alumni, people you already know, and people one introduction away.',
                ],
                [
                  'What happens to my LinkedIn data?',
                  'You upload your own LinkedIn export. It stays in your browser and is only used to find people worth meeting.',
                ],
                [
                  'Do I need an AI key?',
                  'No. Orbit works with built-in templates. A Claude key, if you add one, lets the chat answer freely and write in your voice.',
                ],
                ['Is it free?', 'Yes, this version is free and runs entirely in your browser.'],
              ]}
            />
          </Reveal>
        </section>

        <Rule />

        <section className="px-5 md:px-12 py-16 md:py-24">
          <Reveal>
            <p className="text-[14px] text-ink-3">Five minutes a day. The rest is on Orbit.</p>
            <h2 className="display mt-3 text-[40px] sm:text-[56px] md:text-[64px] max-w-[820px]">
              Your next coffee chat, drafted by tonight.
            </h2>
            <div className="mt-8 flex flex-wrap gap-2 min-h-11">
              {primaryCta('lg')}
              {demoCta('lg')}
            </div>
          </Reveal>
        </section>
      </div>

      <footer className="border-t border-line">
        <div className="max-w-[1280px] mx-auto px-5 md:px-12 py-12 grid grid-cols-2 md:grid-cols-[1.4fr_1fr_1fr] gap-8 text-[13.5px]">
          <div className="col-span-2 md:col-span-1">
            <div className="inline-flex items-center gap-2">
              <Logo size={20} />
              <span className="font-medium">Orbit</span>
            </div>
            <p className="mt-3 text-ink-3 max-w-[260px]">
              A networking assistant for students who are recruiting.
            </p>
          </div>
          <div>
            <div className="font-medium mb-3">Product</div>
            <ul className="space-y-2 text-ink-3">
              <li>
                <a className="hover:text-ink transition-colors" href="#how">
                  How it works
                </a>
              </li>
              <li>
                <a className="hover:text-ink transition-colors" href="#features">
                  Features
                </a>
              </li>
              <li>
                <a className="hover:text-ink transition-colors" href="#faq">
                  FAQ
                </a>
              </li>
            </ul>
          </div>
          <div>
            <div className="font-medium mb-3">Trust</div>
            <ul className="space-y-2 text-ink-3">
              <li>
                <a className="hover:text-ink transition-colors" href="#privacy">
                  Privacy
                </a>
              </li>
            </ul>
          </div>
        </div>
        <div className="max-w-[1280px] mx-auto px-5 md:px-12 py-5 border-t border-line text-[12.5px] text-ink-3">
          © {new Date().getFullYear()} Orbit
        </div>
      </footer>
    </div>
  );
}

/** A hairline between sections, inset to the page's margins. */
function Rule() {
  return <div className="h-px bg-line mx-5 md:mx-12" aria-hidden />;
}

/** Fades content up the first time it scrolls into view; reduced motion and old browsers show it at once. */
function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return setShown(true);
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px -8% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className={cx('reveal', shown && 'is-in', className)}
      style={{ transitionDelay: shown ? `${delay}ms` : undefined }}
    >
      {children}
    </div>
  );
}

function Faq({ items }: { items: [string, string][] }) {
  const [open, setOpen] = useState(0);
  return (
    <div className="border-t border-line">
      {items.map(([q, a], i) => {
        const on = open === i;
        return (
          <div key={q} className="border-b border-line">
            <button
              type="button"
              onClick={() => setOpen(on ? -1 : i)}
              aria-expanded={on}
              className="w-full py-5 flex items-center justify-between gap-4 text-left text-[16px] md:text-[17px] tracking-[-0.01em] focus-visible:outline-none focus-visible:underline"
            >
              {q}
              <span className="w-6 h-6 rounded-full border border-line inline-flex items-center justify-center shrink-0 text-ink-2">
                {on ? <Minus size={12} /> : <Plus size={12} />}
              </span>
            </button>
            <div
              className={cx(
                'grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]',
                on ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
              )}
            >
              <p className="overflow-hidden text-[14.5px] leading-relaxed text-ink-3 pr-10">
                <span className="block pb-5">{a}</span>
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const STAGES = [
  {
    key: 'find',
    label: 'Find',
    lead: 'Orbit reads your LinkedIn connections and goals, and ranks who is worth a coffee chat: alumni, people at your target companies, and people one introduction away.',
    title: 'The right people, ranked. You reach out first.',
    side: [
      { n: '02 · fit', title: 'Matched to your goals' },
      { n: '03 · reach', title: 'Who could introduce you' },
    ],
  },
  {
    key: 'write',
    label: 'Write',
    lead: 'Every draft starts from what you actually know about the person: a post, a shared school, what they said last time. You edit it and send it yourself.',
    title: 'A first message in your voice, not a template.',
    side: [
      { n: '02 · checks', title: 'Short, one ask, nothing invented' },
      { n: '03 · approval', title: 'Nothing goes out without you' },
    ],
  },
  {
    key: 'follow',
    label: 'Follow up',
    lead: 'A short bump after a week of silence, a thank-you the day after a chat, a reconnect before the referral window. Orbit keeps the timing so you do not have to.',
    title: 'Every follow-up, on time.',
    side: [
      { n: '02 · timing', title: 'Bumps after 7 quiet business days' },
      { n: '03 · limits', title: 'Never more than two bumps' },
    ],
  },
  {
    key: 'remember',
    label: 'Remember',
    lead: 'Type, dictate or paste notes after a chat. What they said, offered and asked of you lands on their profile, ready for the next message.',
    title: 'Chat fourteen remembers chat one.',
    side: [
      { n: '02 · notes', title: 'Facts pulled from your notes' },
      { n: '03 · promises', title: 'What you owe, and when' },
    ],
  },
] as const;

/** Tsenta's "four stages" block: numbered pill tabs on a line, a dark lead card and two quiet side cards. */
function HowItWorks() {
  const [i, setI] = useState(0);
  const stage = STAGES[i]!;
  return (
    <section id="how" className="scroll-mt-16 px-5 md:px-12 py-16 md:py-24">
      <Reveal>
        <p className="text-[14px] text-ink-3">How it works.</p>
        <h2 className="display mt-2 text-[30px] md:text-[40px] max-w-[620px]">
          Four steps. One assistant. Zero spreadsheets.
        </h2>
      </Reveal>
      <div className="mt-10 relative">
        <div className="absolute left-0 right-0 top-1/2 h-px bg-line hidden sm:block" aria-hidden />
        <div
          className="absolute left-0 top-1/2 h-px bg-ink hidden sm:block transition-[width] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
          style={{ width: `${(i / (STAGES.length - 1)) * 100}%` }}
          aria-hidden
        />
        <div
          className="relative flex flex-wrap sm:flex-nowrap justify-between gap-2"
          role="tablist"
          aria-label="How it works"
        >
          {STAGES.map((s, k) => (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={k === i}
              onClick={() => setI(k)}
              className={cx(
                'h-10 px-4 rounded-full border inline-flex items-center gap-2 text-[14px] transition-colors duration-300',
                k === i
                  ? 'bg-ink border-ink text-white'
                  : 'bg-page border-line text-ink-2 hover:text-ink hover:border-[#cfcfcf]',
              )}
            >
              <span className={cx('font-mono text-[11px]', k === i ? 'text-white/60' : 'text-ink-3')}>
                {String(k + 1).padStart(2, '0')}
              </span>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <p
        key={`${stage.key}-lead`}
        className="fade-up mt-8 text-[15px] leading-relaxed text-ink-3 max-w-[640px]"
      >
        {stage.lead}
      </p>
      <div className="mt-8 grid grid-cols-1 lg:grid-cols-[1.25fr_1fr] gap-4">
        <div
          key={stage.key}
          className="fade-up min-w-0 rounded-[16px] bg-ink text-white p-6 md:p-8 min-h-[300px] flex flex-col"
        >
          <div className="font-mono text-[11px] tracking-[0.08em] uppercase text-white/50">
            01 · {stage.label}
          </div>
          <div className="mt-4 text-[22px] md:text-[26px] tracking-[-0.02em] leading-snug max-w-[420px]">
            {stage.title}
          </div>
          <StageVisual stage={stage.key} />
        </div>
        <div className="grid gap-4">
          {stage.side.map((c, k) => (
            <div
              key={`${stage.key}-${c.n}`}
              className="fade-up rounded-[16px] border border-line bg-canvas p-6"
              style={{ animationDelay: `${80 + k * 60}ms` }}
            >
              <div className="label-mono">{c.n}</div>
              <div className="mt-2 text-[16px] tracking-[-0.01em]">{c.title}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function StageVisual({ stage }: { stage: (typeof STAGES)[number]['key'] }) {
  const line = (a: string, b: string, hot?: boolean) => (
    <div
      className={cx(
        'flex items-center justify-between gap-3 rounded-[8px] px-3 h-9 font-mono text-[12px]',
        hot ? 'bg-ember/15 text-[#ffb08f]' : 'text-white/45',
      )}
    >
      <span className="min-w-0 truncate">{a}</span>
      <span className="shrink-0">{b}</span>
    </div>
  );
  return (
    <div className="mt-auto pt-6 rounded-[12px] border border-white/10 bg-white/[0.03] p-3 space-y-1">
      {stage === 'find' && (
        <>
          {line('Maya Chen · Software Engineer · Stripe', 'reach 72')}
          {line('Priya Ahmed · Cornell alum · Stripe', 'reach 81', true)}
          {line('Diego Mehta · Anthropic · via Sana', 'reach 64')}
        </>
      )}
      {stage === 'write' && (
        <>
          {line('Hi Priya, I saw your post on payments onboarding', 'hook')}
          {line('Would you have 15 minutes in the next two weeks?', 'one ask', true)}
          {line('62 words · reading grade 6', 'checks ok')}
        </>
      )}
      {stage === 'follow' && (
        <>
          {line('Daniel Okafor · no reply in 7 business days', 'bump', true)}
          {line('Lena Novak · spoke yesterday', 'thank-you')}
          {line('Omar Haddad · proposed Thursday 2pm', 'confirm')}
        </>
      )}
      {stage === 'remember' && (
        <>
          {line('Lena offered to pass your name to the recruiter', 'offer', true)}
          {line('You promised the project link by Friday', 'to do')}
          {line('She recommended applying before October', 'fact')}
        </>
      )}
    </div>
  );
}

/** The product, drawn after Tsenta's hero dashboard: Orbit's sidebar, today's cards on pastel tiles and the chats. */
function ProductMock() {
  const cards = [
    { co: 'Figma', who: 'Mei Chen · Prep', reach: 82, tone: 'bg-pastel-yellow', action: 'Open notes' },
    { co: 'Ramp', who: 'Lena Novak · Thank-you', reach: 74, tone: 'bg-pastel-mint', action: 'Review' },
    { co: 'Stripe', who: 'Daniel Okafor · Follow-up', reach: 61, tone: 'bg-pastel-lilac', action: 'Review' },
    { co: 'Linear', who: 'Jordan Lee · Warm-up', reach: 48, tone: 'bg-pastel-rose', action: 'Next step' },
  ];
  const rows: { name: string; role: string; stage: string; tone: string; when: string }[] = [
    {
      name: 'Priya Ahmed',
      role: 'Software Engineer · Stripe',
      stage: 'Replied',
      tone: 'good',
      when: '2 days ago',
    },
    {
      name: 'Omar Haddad',
      role: 'Associate PM · Notion',
      stage: 'Scheduling',
      tone: 'accent',
      when: 'today',
    },
    {
      name: 'Caleb Weber',
      role: 'Software Engineer · Notion',
      stage: 'First message sent',
      tone: 'neutral',
      when: '7 days ago',
    },
    {
      name: 'Daniel Okafor',
      role: 'Software Engineer · Stripe',
      stage: 'Went quiet',
      tone: 'bad',
      when: '11 days ago',
    },
    {
      name: 'Hannah Brooks',
      role: 'Product Manager · Figma',
      stage: 'Scheduled',
      tone: 'warn',
      when: 'Thu 2:00 pm',
    },
  ];
  const dot = {
    good: 'bg-good',
    accent: 'bg-accent',
    neutral: 'bg-ink-3',
    bad: 'bg-bad',
    warn: 'bg-warn',
  } as const;
  const pill = {
    good: 'bg-good-soft text-good',
    accent: 'bg-accent-soft text-accent',
    neutral: 'bg-canvas-2 text-ink-2',
    bad: 'bg-bad-soft text-bad',
    warn: 'bg-warn-soft text-warn',
  } as const;
  return (
    <div
      className="rounded-[18px] border border-line bg-canvas shadow-[0_30px_80px_-30px_rgba(0,0,0,0.18)] overflow-hidden flex text-left"
      aria-hidden
    >
      <div className="hidden md:flex w-[200px] shrink-0 flex-col border-r border-line p-3">
        <div className="flex items-center gap-2 px-1.5 h-9">
          <Logo size={18} />
          <span className="text-[14px] font-medium">Orbit</span>
        </div>
        <div className="label-mono px-2 mt-3 mb-1.5">Workspace</div>
        {[
          [SquarePen, 'New chat', ''],
          [Users, 'People', ''],
          [Inbox, 'Drafts', '5'],
          [MapIcon, 'Map', ''],
          [Compass, 'Discover', ''],
        ].map(([Icon, label, count], k) => {
          const I = Icon as typeof Users;
          return (
            <div
              key={label as string}
              className={cx(
                'relative h-8 px-2 rounded-[8px] flex items-center gap-2 text-[12.5px]',
                k === 1 ? 'bg-[#f0efed] text-ink font-medium' : 'text-ink-2',
              )}
            >
              <I size={14} strokeWidth={1.75} />
              {label as string}
              {count && (
                <span className="ml-auto text-[10px] min-w-[18px] h-[16px] rounded-full bg-accent-soft text-accent inline-flex items-center justify-center">
                  {count as string}
                </span>
              )}
            </div>
          );
        })}
        <div className="mt-auto rounded-[10px] bg-accent text-white px-2.5 h-11 flex items-center gap-2 text-[12px]">
          <span className="w-6 h-6 rounded-full bg-white/20 inline-flex items-center justify-center text-[10px]">
            AR
          </span>
          <div>
            <div className="font-medium leading-tight">Alex Rivera</div>
            <div className="text-white/60 text-[10.5px] leading-tight">Cornell · class of 2028</div>
          </div>
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="h-12 border-b border-line flex items-center px-4 gap-3">
          <span className="text-[14px] font-medium">People</span>
          <span className="hidden sm:flex ml-auto w-[260px] h-8 rounded-full bg-canvas-2 items-center gap-2 px-3 text-[12px] text-ink-3">
            <Search size={13} /> Search people, companies…
          </span>
        </div>
        <div className="p-4">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium">Worth doing today</span>
            <span className="text-[12px] text-ink-3">Open Drafts ›</span>
          </div>
          <div className="mt-3 grid grid-cols-2 lg:grid-cols-4 gap-2.5">
            {cards.map((c) => (
              <div key={c.co} className="rounded-[12px] border border-line p-1.5">
                <div
                  className={cx('rounded-[9px] p-3 h-[92px] flex items-start justify-between gap-2', c.tone)}
                >
                  <div className="min-w-0">
                    <div className="text-[11px] text-ink-3">{c.co}</div>
                    <div className="text-[12.5px] font-medium leading-snug">{c.who}</div>
                  </div>
                  <Ring value={c.reach} />
                </div>
                <div className="flex items-center justify-between px-1.5 pt-2 pb-0.5">
                  <span className="text-[11px] text-ink-3">{c.co}</span>
                  <span className="h-6 px-2.5 rounded-full bg-accent text-white text-[11px] inline-flex items-center">
                    {c.action}
                  </span>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-5 flex items-center justify-between gap-3">
            <span className="text-[13px] font-medium">All chats</span>
            <span className="h-7 px-3 rounded-full bg-accent text-white text-[11.5px] inline-flex items-center">
              Add a person
            </span>
          </div>
          <div className="mt-2.5 flex gap-1.5">
            {['All', 'Waiting', 'Booked', 'Went quiet'].map((f, k) => (
              <span
                key={f}
                className={cx(
                  'h-7 px-3 rounded-full border text-[11.5px] inline-flex items-center',
                  k === 0 ? 'bg-ink border-ink text-white' : 'border-line text-ink-2',
                )}
              >
                {f}
              </span>
            ))}
          </div>
          <div className="mt-3 rounded-[12px] border border-line overflow-hidden">
            <div className="hidden sm:grid grid-cols-[1.6fr_1fr_0.8fr] bg-[#fafaf9] border-b border-line px-3 h-8 items-center label-mono !text-[10px]">
              <span>Person</span>
              <span>Stage</span>
              <span className="text-right">Last touch</span>
            </div>
            {rows.map((r) => (
              <div
                key={r.name}
                className="grid grid-cols-[1fr_auto] sm:grid-cols-[1.6fr_1fr_0.8fr] items-center px-3 h-12 border-b border-line last:border-b-0 text-[12px]"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="w-7 h-7 rounded-full bg-canvas-2 border border-line inline-flex items-center justify-center text-[10px] font-medium shrink-0">
                    {r.name
                      .split(' ')
                      .map((x) => x[0])
                      .join('')}
                  </span>
                  <div className="min-w-0">
                    <div className="font-medium truncate">{r.name}</div>
                    <div className="text-ink-3 text-[11px] truncate">{r.role}</div>
                  </div>
                </div>
                <span>
                  <span
                    className={cx(
                      'inline-flex items-center gap-1.5 h-5 px-2 rounded-full text-[10.5px]',
                      pill[r.tone as keyof typeof pill],
                    )}
                  >
                    <span className={cx('w-1.5 h-1.5 rounded-full', dot[r.tone as keyof typeof dot])} />
                    {r.stage}
                  </span>
                </span>
                <span className="hidden sm:block text-right text-ink-3">{r.when}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Ring({ value }: { value: number }) {
  const r = 14;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative w-9 h-9 shrink-0 inline-flex items-center justify-center">
      <svg width="36" height="36" viewBox="0 0 36 36" className="-rotate-90">
        <circle cx="18" cy="18" r={r} fill="none" stroke="rgba(0,0,0,0.08)" strokeWidth="2.5" />
        <circle
          cx="18"
          cy="18"
          r={r}
          fill="none"
          stroke="#0a0a0a"
          strokeWidth="2.5"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - value / 100)}
          strokeLinecap="round"
        />
      </svg>
      <span className="absolute text-[9px] font-semibold">{value}</span>
    </span>
  );
}
