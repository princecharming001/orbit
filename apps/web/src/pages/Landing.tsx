import type { User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, Gauge, HardDrive, Minus, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Logo } from '../components/AppShell';
import { BoardPreview, DraftsPreview, Point, PrepShowcase, Stage } from '../components/landing/Showcase';
import { TrustedBy } from '../components/landing/TrustedBy';
import { db } from '../db/schema';
import { createLocalUser, leaveDemoForOwnSetup, savedProfiles } from '../engine/account';
import { DEMO_USER_ID, demoResetPrompt, loadDemo } from '../engine/demo';
import { demoFace } from '../engine/demoFaces';
import { startGoogleSignIn } from '../integrations/orbitApi';
import { envGoogleClientId } from '../integrations/prefs';
import { useAccount } from '../state/account';
import { useSession } from '../state/session';
import { Avatar, Button, Chip, cx, Spinner } from '../ui';
import { onboardingPath } from './onboardingPath';

// the interactive map draws on a canvas with the app's map engine: loaded after the page itself
const NetworkDemo = lazy(() => import('../components/landing/NetworkDemo'));

export function Landing() {
  const nav = useNavigate();
  const account = useAccount();
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
  const primaryCta = (size: 'md' | 'lg' = 'md', variant: 'dark' | 'secondary' = 'dark') =>
    resolving ? null : (
      <Button size={size} variant={variant} onClick={start} disabled={!!busy}>
        {startLabel}
      </Button>
    );
  // offered mid-setup too: demo() asks before it discards the setup
  const demoCta = (size: 'md' | 'lg' = 'md', className?: string) =>
    resolving || onboarded ? null : (
      <Button size={size} variant="secondary" onClick={demo} disabled={!!busy} className={className}>
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
  // a build with Orbit accounts: someone who has one signs in with Google and lands in their own Orbit. Without
  // accounts, someone who logged out gets back to the profile saved in this browser (never a second, empty one).
  const saved = useLiveQuery(() => savedProfiles(DEMO_USER_ID), []);
  const logIn =
    account.mode && !account.signedIn ? (
      <Button
        variant="ghost"
        onClick={() => startGoogleSignIn()}
        disabled={!!busy}
        data-testid="landing-login"
      >
        Log in
      </Button>
    ) : !account.mode && (!userId || isDemo) && saved?.length ? (
      <Button variant="ghost" onClick={() => nav('/login')} disabled={!!busy} data-testid="landing-login">
        Log in
      </Button>
    ) : null;
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
            <a className="hover:text-ink transition-colors" href="#how">
              How it works
            </a>
            <a className="hover:text-ink transition-colors" href="#map">
              The map
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
                {logIn}
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
                {logIn}
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
        <section className="px-5 md:px-12 pt-14 md:pt-20 pb-12 grid gap-12 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] lg:items-center lg:gap-14">
          <div className="min-w-0">
            <Reveal delay={60}>
              <h1 className="display text-[44px] sm:text-[56px] md:text-[64px] lg:text-[58px] xl:text-[64px] max-w-[880px]">
                {/* "without" starts the second line on wider screens; a phone wraps it where it fits */}
                Every coffee chat, <br className="hidden sm:inline" />
                without the busywork.
              </h1>
            </Reveal>
            <Reveal delay={120}>
              <p className="mt-6 text-[16px] md:text-[17px] leading-[1.55] text-ink-3 max-w-[540px]">
                Orbit finds the people worth a coffee chat, drafts every message in your voice, and keeps
                track of each conversation. Nothing is sent without you.
              </p>
            </Reveal>
            <Reveal delay={160}>
              <div className="mt-8 flex flex-wrap items-center gap-2 min-h-11">
                {resolving ? <Spinner /> : primaryCta('lg')}
                {isDemo && onboarded && !resolving && (
                  <Button size="lg" variant="secondary" onClick={() => nav('/')}>
                    Back to the demo
                  </Button>
                )}
                {demoCta('lg')}
              </div>
            </Reveal>
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
          </div>
          <Reveal delay={220}>
            <TrustedBy />
          </Reveal>
        </section>

        <HowItWorks google={google} />

        <div id="features" className="scroll-mt-16">
          <Feature
            id="map"
            n="01"
            kicker="Find the way in"
            title="See who can get you in, before you write a word."
            points={[
              'Everyone you know, ranked by how well they fit your goals and how easy they are to reach.',
              'The warmest route to anyone, through people you already know, with a score for every hop.',
              'Try it below on a sample network: type a company or a person.',
            ]}
          >
            <Suspense
              fallback={
                <div className="h-[600px] rounded-[20px] border border-line bg-canvas animate-pulse" />
              }
            >
              <NetworkDemo />
            </Suspense>
          </Feature>

          <Feature
            n="02"
            kicker="Write"
            title="Every message drafted in your voice. Sent only when you say."
            points={[
              'Each draft starts from what you know about them: a post, a shared school, what they said last time.',
              'Thank-yous, follow-ups and times to meet are waiting for you each morning, most urgent first.',
              'You read it, change what you like and send it yourself.',
            ]}
          >
            <Stage tone="sand" testId="lp-stage-drafts">
              <div className="p-3 sm:p-8 lg:p-12">
                <DraftsPreview />
              </div>
            </Stage>
          </Feature>

          <Feature
            n="03"
            kicker="Track"
            title="Every chat on one board, each with its next step."
            points={[
              'Replies move a chat along by themselves: replied, scheduling, scheduled.',
              'A chat that goes quiet is flagged, with one short follow-up ready.',
              'After a call, the thank-you is drafted and the next nudge is on the calendar.',
            ]}
          >
            <Stage tone="mist" testId="lp-stage-board">
              <div className="p-3 sm:p-8 lg:p-10">
                <BoardPreview />
              </div>
            </Stage>
          </Feature>

          <Feature
            n="04"
            kicker="Prep"
            title="Walk into every call ready."
            points={[
              'A short deck for the minute before a call: who they are, what you share, where you left off.',
              'Your 30-second intro, openers and three questions worth asking.',
              'Deep research on a person when you want more, with every claim linked to its source.',
            ]}
          >
            <Stage tone="mint" testId="lp-stage-prep" interactive>
              <div className="p-4 sm:p-10 lg:p-14">
                <PrepShowcase />
              </div>
            </Stage>
          </Feature>
        </div>

        <section id="privacy" className="scroll-mt-16 px-5 md:px-12 py-20 md:py-28">
          <Reveal>
            <div className="grid lg:grid-cols-2 gap-6 lg:gap-12 items-end">
              <div>
                <p className="label-mono">Privacy and safety</p>
                <h2 className="display text-balance mt-3 text-[34px] md:text-[44px] max-w-[560px]">
                  You stay in charge of every word.
                </h2>
              </div>
              <p className="text-[15px] md:text-[16px] leading-[1.6] text-ink-3 max-w-[520px]">
                The people, notes and drafts you keep in Orbit live in your browser.{' '}
                {google
                  ? "Gmail, Calendar and LinkedIn connect only if you choose, through each one's own sign-in."
                  : 'It does not connect to your email or calendar: you send each message yourself.'}
              </p>
            </div>
          </Reveal>
          <Reveal delay={80}>
            <div className="mt-10 grid sm:grid-cols-2 lg:grid-cols-4 gap-3" data-testid="lp-promises">
              {PROMISES.map(({ icon: Icon, title, text }) => (
                <div
                  key={title}
                  className="rounded-[16px] border border-line bg-canvas p-5 md:p-6"
                  data-testid="lp-promise"
                >
                  <span className="w-9 h-9 rounded-full bg-accent-soft text-accent inline-flex items-center justify-center">
                    <Icon size={17} strokeWidth={1.75} />
                  </span>
                  <h3 className="mt-5 text-[16px] font-medium tracking-[-0.01em]">{title}</h3>
                  <p className="mt-2 text-[14px] leading-[1.55] text-ink-3">{text}</p>
                </div>
              ))}
            </div>
          </Reveal>
        </section>

        <Rule />

        <section
          id="faq"
          className="scroll-mt-16 px-5 md:px-12 py-20 md:py-28 grid md:grid-cols-[1fr_1.3fr] gap-10"
        >
          <Reveal>
            <p className="label-mono">Questions</p>
            <h2 className="display text-balance mt-3 text-[34px] md:text-[44px] max-w-[360px]">
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
                  'Is it safe for my LinkedIn account?',
                  "Orbit keeps to a person's pace: at most 10 LinkedIn messages a day unless you change it, three days between messages to one person, and it slows down the moment LinkedIn asks.",
                ],
                [
                  'What happens to my LinkedIn data?',
                  'You connect your LinkedIn account. Your connections are kept in your browser and only used to find people worth meeting.',
                ],
                [
                  'Can I look around before connecting anything?',
                  "Yes. Try the demo opens Orbit on a made-up student's season: their network, drafts, board and prep, with nothing real in it.",
                ],
                [
                  'Do I need an AI key?',
                  'No. Orbit comes with AI drafting to get you started, and you can add your own Claude key any time.',
                ],
                ['Is it free?', 'Yes, it is free to start.'],
              ]}
            />
          </Reveal>
        </section>

        <section className="px-3 md:px-8 pb-16 md:pb-24">
          <Reveal>
            <div className="relative overflow-hidden rounded-[28px] bg-accent text-white px-6 py-14 sm:px-12 md:py-20">
              <div
                className="absolute inset-0 opacity-[0.12] bg-[radial-gradient(rgba(255,255,255,0.9)_1px,transparent_1px)] [background-size:20px_20px] [mask-image:radial-gradient(ellipse_at_80%_20%,black,transparent_70%)]"
                aria-hidden
              />
              <div className="relative grid lg:grid-cols-[minmax(0,1fr)_auto] gap-10 items-end">
                <div>
                  <p className="text-[14px] text-white/70">Five minutes a day. The rest is on Orbit.</p>
                  <h2 className="display text-balance mt-3 text-[38px] sm:text-[52px] md:text-[60px] max-w-[760px]">
                    Your next coffee chat, drafted by tonight.
                  </h2>
                  <div className="mt-8 flex flex-wrap gap-2 min-h-11">
                    {primaryCta('lg', 'secondary')}
                    {demoCta('lg', 'border-white/25 bg-white/10 text-white hover:bg-white/15 shadow-none')}
                  </div>
                </div>
                <DemoFaces />
              </div>
            </div>
          </Reveal>
        </section>
      </div>

      <footer className="border-t border-line">
        <div className="max-w-[1280px] mx-auto px-5 md:px-12 pt-12 pb-10 grid gap-10 sm:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <span className="inline-flex items-center gap-2 text-ink">
              <Logo size={20} />
              <span className="font-medium text-[16px]">Orbit</span>
            </span>
            <p className="mt-3 text-[14px] leading-[1.55] text-ink-3 max-w-[300px]">
              Coffee chats for college recruiting: who to meet, how to get in, and every message in your
              voice.
            </p>
          </div>
          <nav className="text-[14px]" aria-label="Product">
            <p className="label-mono mb-3">Product</p>
            <ul className="space-y-2 text-ink-2">
              <li>
                <a className="hover:text-ink transition-colors" href="#how">
                  How it works
                </a>
              </li>
              <li>
                <a className="hover:text-ink transition-colors" href="#map">
                  The map
                </a>
              </li>
              <li>
                <a className="hover:text-ink transition-colors" href="#features">
                  Drafts, board and prep
                </a>
              </li>
            </ul>
          </nav>
          <nav className="text-[14px]" aria-label="Footer">
            <p className="label-mono mb-3">Trust</p>
            <ul className="space-y-2 text-ink-2">
              <li>
                <a className="hover:text-ink transition-colors" href="#privacy">
                  Privacy
                </a>
              </li>
              <li>
                <a className="hover:text-ink transition-colors" href="#faq">
                  FAQ
                </a>
              </li>
              <li>
                {/* static pages (public/privacy, public/terms), so Google and anyone else can read them */}
                <a
                  className="hover:text-ink transition-colors"
                  href={`${import.meta.env.BASE_URL}privacy/`}
                  data-testid="landing-privacy-policy"
                >
                  Privacy policy
                </a>
              </li>
              <li>
                <a className="hover:text-ink transition-colors" href={`${import.meta.env.BASE_URL}terms/`}>
                  Terms of service
                </a>
              </li>
              <li>
                <Link
                  className="hover:text-ink transition-colors"
                  to="/remove-me"
                  data-testid="landing-remove-me"
                >
                  Remove me from research
                </Link>
              </li>
            </ul>
          </nav>
        </div>
        <div className="max-w-[1280px] mx-auto px-5 md:px-12 pb-8 text-[13px] text-ink-3">
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

/** One feature: its number and title on the left, what it does on the right, and the product itself below. */
function Feature({
  id,
  n,
  kicker,
  title,
  points,
  children,
}: {
  id?: string;
  n: string;
  kicker: string;
  title: string;
  points: string[];
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-16 px-3 md:px-8 pt-16 md:pt-24">
      <Reveal>
        <div className="px-2 md:px-4 grid lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] gap-6 lg:gap-16 items-start">
          <div>
            <p className="label-mono">
              <span className="text-ink">{n}</span> <span className="mx-1.5 text-line">/</span> {kicker}
            </p>
            <h2 className="display text-balance mt-3 text-[30px] sm:text-[36px] md:text-[42px] max-w-[600px]">
              {title}
            </h2>
          </div>
          <ul className="space-y-3 lg:pt-8 max-w-[520px]">
            {points.map((p) => (
              <Point key={p}>{p}</Point>
            ))}
          </ul>
        </div>
      </Reveal>
      <Reveal delay={100} className="mt-8 md:mt-10">
        {children}
      </Reveal>
    </section>
  );
}

/** LinkedIn, Gmail and Google Calendar as small app tiles, drawn inline (no image requests). */
function LinkedInIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-[18px] h-[18px]" aria-hidden>
      <rect width="24" height="24" rx="5" fill="#0A66C2" />
      <path
        fill="#fff"
        d="M7.1 9.6h2.6V18H7.1zM8.4 5.6a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM11.3 9.6h2.5v1.2h.04c.35-.66 1.2-1.36 2.47-1.36 2.64 0 3.13 1.74 3.13 4V18h-2.6v-4.04c0-.96-.02-2.2-1.34-2.2-1.34 0-1.55 1.05-1.55 2.13V18h-2.6z"
      />
    </svg>
  );
}
function GmailIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-[18px] h-[18px]" aria-hidden>
      <path fill="#4285F4" d="M3.6 19.5h2.7v-6.6L2.4 10v8.1c0 .77.63 1.4 1.2 1.4z" />
      <path fill="#34A853" d="M17.7 19.5h2.7c.57 0 1.2-.63 1.2-1.4V10l-3.9 2.9z" />
      <path fill="#FBBC04" d="M17.7 7.1v5.8l3.9-2.9V8.4c0-1.6-1.8-2.5-3.1-1.6z" />
      <path fill="#EA4335" d="M6.3 12.9V7.1L12 11.4l5.7-4.3v5.8L12 17.2z" />
      <path fill="#C5221F" d="M2.4 8.4V10l3.9 2.9V7.1l-.8-.6C4.2 5.9 2.4 6.8 2.4 8.4z" />
    </svg>
  );
}
function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-[18px] h-[18px]" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="3" fill="#fff" stroke="#DADCE0" />
      <path fill="#4285F4" d="M3 6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v2H3z" />
      <text
        x="12"
        y="17.6"
        textAnchor="middle"
        fontSize="8.5"
        fontWeight="700"
        fill="#1A73E8"
        fontFamily="Inter, sans-serif"
      >
        31
      </text>
    </svg>
  );
}

/** The quiet panel each step's picture sits in, all the same height so the four line up. */
function StepPanel({ children }: { children: ReactNode }) {
  return (
    <div className="w-full h-[124px] rounded-[12px] border border-line bg-canvas-2/50 p-3 flex flex-col justify-center">
      {children}
    </div>
  );
}

/** The four steps, from LinkedIn to a booked call, each with a small piece of the product. */
function HowItWorks({ google }: { google: boolean }) {
  const sources: { name: string; icon: ReactNode }[] = google
    ? [
        { name: 'LinkedIn', icon: <LinkedInIcon /> },
        { name: 'Gmail', icon: <GmailIcon /> },
        { name: 'Calendar', icon: <CalendarIcon /> },
      ]
    : [{ name: 'LinkedIn', icon: <LinkedInIcon /> }];
  const steps: { title: string; text: string; visual: ReactNode }[] = [
    {
      title: 'Connect',
      text: google
        ? 'Sign in to LinkedIn, and Gmail and Calendar if you like. Orbit learns who you know and how well.'
        : 'Sign in to LinkedIn. Orbit learns who you know and how well.',
      visual: (
        <StepPanel>
          <ul className="space-y-1.5">
            {sources.map((s) => (
              <li key={s.name} className="flex items-center gap-2.5 text-[12.5px]">
                <span className="w-7 h-7 rounded-[8px] border border-line bg-white inline-flex items-center justify-center shrink-0">
                  {s.icon}
                </span>
                <span className="flex-1 text-ink">{s.name}</span>
                <span className="inline-flex items-center gap-1 text-[11.5px] text-good">
                  <Check size={12} strokeWidth={2.5} aria-hidden /> Connected
                </span>
              </li>
            ))}
          </ul>
        </StepPanel>
      ),
    },
    {
      title: 'Find the way in',
      text: 'See who is worth a coffee chat and the warmest route to them, scored, through people you already know.',
      visual: (
        <StepPanel>
          {/* one line: you, the person who can introduce you, them; the score under it */}
          <div className="flex items-center justify-center gap-2">
            <span className="w-8 h-8 rounded-full bg-ink text-white inline-flex items-center justify-center text-[10.5px] font-medium shrink-0">
              You
            </span>
            <span className="w-7 h-px bg-ink-3/40" aria-hidden />
            <Avatar name="Maya Chen" src={demoFace('Maya')} size={32} />
            <span className="w-7 h-px bg-ink-3/40" aria-hidden />
            <Avatar name="Priya Ahmed" src={demoFace('Priya')} size={32} />
          </div>
          <div className="mt-3 flex items-center justify-center gap-2 text-[12px]">
            <span className="text-ink-3">Via Maya</span>
            <Chip tone="good" className="h-[20px] text-[11px]">
              Strong · 74
            </Chip>
          </div>
        </StepPanel>
      ),
    },
    {
      title: 'Write and approve',
      text: 'Every message drafted in your voice from what you know. Nothing goes out until you approve it.',
      visual: (
        <StepPanel>
          <div className="flex items-center gap-2 text-[11.5px] text-ink-3">
            <Avatar name="Lena Novak" src={demoFace('Lena')} size={18} />
            To Lena Novak
          </div>
          <p className="mt-1.5 text-[12px] leading-[1.45] text-ink-2 line-clamp-2">
            Thanks for Friday, and for the tip on telling one project story.
          </p>
          <div className="mt-2 flex justify-end gap-1.5">
            <span className="h-6 px-2.5 rounded-full border border-line bg-canvas inline-flex items-center text-[11px] text-ink-2">
              Edit
            </span>
            <span className="h-6 px-2.5 rounded-full bg-accent text-white inline-flex items-center text-[11px] font-medium">
              Approve
            </span>
          </div>
        </StepPanel>
      ),
    },
    {
      title: 'Prep and follow up',
      text: 'A prep deck before each call, the thank-you after it, and a nudge when a chat goes quiet.',
      visual: (
        <StepPanel>
          <ol className="relative space-y-1.5 text-[12px]">
            <span className="absolute left-[5px] top-2 bottom-2 w-px bg-line" aria-hidden />
            {[
              { when: 'Tue 1:55', what: 'Prep deck ready', tone: 'bg-accent' },
              { when: 'Tue 2:00', what: 'Chat with Omar', tone: 'bg-ink' },
              { when: 'Wed', what: 'Thank-you drafted', tone: 'bg-good' },
              { when: 'Later', what: 'Check-in if quiet', tone: 'bg-warn' },
            ].map((e) => (
              <li key={e.what} className="relative flex items-center gap-2.5">
                <span className={cx('w-[11px] h-[11px] rounded-full ring-2 ring-canvas shrink-0', e.tone)} />
                <span className="w-[62px] shrink-0 text-ink-3 tabular">{e.when}</span>
                <span className="text-ink truncate">{e.what}</span>
              </li>
            ))}
          </ol>
        </StepPanel>
      ),
    },
  ];
  return (
    <section id="how" className="scroll-mt-16 px-5 md:px-12 pt-8 md:pt-12 pb-4">
      <Reveal>
        <div className="grid lg:grid-cols-2 gap-6 lg:gap-12 items-end">
          <div>
            <p className="label-mono">How it works</p>
            <h2 className="display text-balance mt-3 text-[32px] md:text-[44px] max-w-[560px]">
              From LinkedIn to a booked call.
            </h2>
          </div>
          <p className="text-[15px] md:text-[16px] leading-[1.6] text-ink-3 max-w-[480px]">
            Orbit does the finding, the writing and the remembering. You decide who to meet and press send.
          </p>
        </div>
      </Reveal>
      <Reveal delay={80}>
        <ol
          className="mt-10 grid sm:grid-cols-2 xl:grid-cols-4 rounded-[18px] border border-line bg-canvas overflow-hidden"
          data-testid="lp-steps"
        >
          {steps.map((s, i) => (
            <li
              key={s.title}
              className={cx(
                'p-5 md:p-6 flex flex-col gap-4 border-line',
                i > 0 && 'border-t sm:border-t-0',
                i % 2 === 1 && 'sm:border-l',
                i >= 2 && 'sm:border-t xl:border-t-0',
                i === 2 && 'xl:border-l',
              )}
              data-testid="lp-step"
            >
              <span className="font-mono text-[11px] text-ink-3 tabular">
                {String(i + 1).padStart(2, '0')}
              </span>
              <div>
                <h3 className="text-[17px] font-medium tracking-[-0.01em]">{s.title}</h3>
                <p className="mt-1.5 text-[14px] leading-[1.55] text-ink-3">{s.text}</p>
              </div>
              <div className="mt-auto pt-2">{s.visual}</div>
            </li>
          ))}
        </ol>
      </Reveal>
    </section>
  );
}

const PROMISES = [
  {
    icon: ShieldCheck,
    title: 'Nothing is sent without you',
    text: 'Orbit drafts; you read, edit and send. What goes out is exactly the text you approved.',
  },
  {
    icon: Gauge,
    title: 'LinkedIn-safe pace',
    text: 'At most 10 LinkedIn messages a day unless you change it, three days between messages to one person, and a warm-up before writing to a stranger.',
  },
  {
    icon: HardDrive,
    title: 'Kept in your browser',
    text: 'Your people, notes and drafts stay on this device. Orbit reads your network only to find people worth meeting.',
  },
  {
    icon: Trash2,
    title: 'Yours to take or wipe',
    text: 'Export or delete everything from Settings, any time. Anyone can ask to be left out of research.',
  },
] as const;

/** The demo's made-up people, as a row of faces beside the last call to action. */
function DemoFaces() {
  const people: [string, string][] = [
    ['Maya', 'Maya Chen'],
    ['Daniel', 'Daniel Okafor'],
    ['Priya', 'Priya Ahmed'],
    ['Lena', 'Lena Novak'],
    ['Omar', 'Omar Haddad'],
    ['Hannah', 'Hannah Brooks'],
  ];
  return (
    <div className="lg:text-right" aria-hidden>
      <div className="flex lg:justify-end -space-x-2.5">
        {people.map(([first, name]) => (
          <span key={name} className="rounded-full ring-[3px] ring-accent">
            <Avatar name={name} src={demoFace(first)} size={44} />
          </span>
        ))}
      </div>
      <p
        className="mt-3 text-[13px] text-white/65 max-w-[300px] text-balance lg:ml-auto"
        data-testid="lp-students-line"
      >
        XXX students are already using Orbit to land jobs.
      </p>
    </div>
  );
}
