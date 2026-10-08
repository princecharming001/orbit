import type { User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowRight, LayoutGrid, Mail, Map as MapIcon, NotebookPen, Sparkles, Sun } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Logo } from '../components/AppShell';
import { db } from '../db/schema';
import { createLocalUser, leaveDemoForOwnSetup } from '../engine/account';
import { DEMO_USER_ID, demoResetPrompt, loadDemo } from '../engine/demo';
import { envGoogleClientId } from '../integrations/prefs';
import { useSession } from '../state/session';
import { Button, Spinner } from '../ui';
import { onboardingPath } from './Onboarding';

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
    if (isDemo && onboarded) return nav('/today');
    // Never wipe what someone has already set up without saying so.
    const prompt = demoResetPrompt(user);
    if (prompt && !window.confirm(prompt)) return;
    setBusy('Preparing demo…');
    const u = await loadDemo({ reset: true, onProgress: (m) => setBusy(`${m}…`) });
    await setUserId(u.id);
    nav('/today');
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
    if (onboarded) return nav('/today');
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
  return (
    <div className="min-h-full bg-canvas">
      {busy && (
        // whichever button was pressed, the progress shows where the student is looking
        <div
          className="fixed bottom-6 inset-x-4 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 z-50 flex items-center justify-center gap-2 rounded-2xl bg-ink text-white px-4 py-2.5 text-[13px] shadow-lg"
          role="status"
          data-testid="landing-progress"
        >
          <Spinner /> {busy}
        </div>
      )}
      <header className="max-w-[1120px] mx-auto px-5 h-16 flex items-center gap-3">
        <Logo size={24} />
        <span className="font-semibold tracking-tight text-[16px]">Orbit</span>
        <nav className="ml-auto hidden sm:flex items-center gap-6 text-[14px] text-ink-2">
          <a href="#how">How it works</a>
          <a href="#privacy">Privacy</a>
        </nav>
        <div className="ml-auto sm:ml-4 flex items-center gap-2" data-testid="landing-actions">
          {resolving ? null : isDemo && onboarded ? (
            <>
              {/* on a phone the hero below has this button too; the header keeps only the next step */}
              <span className="hidden sm:inline">
                <Button variant="ghost" onClick={() => nav('/today')}>
                  Back to the demo
                </Button>
              </span>
              <Button variant="primary" onClick={start} disabled={!!busy}>
                Set up Orbit for me
              </Button>
            </>
          ) : onboarded ? (
            <Button variant="primary" onClick={() => nav('/today')}>
              Open Orbit
            </Button>
          ) : (
            <>
              {!midSetup && (
                <Button variant="ghost" onClick={demo} disabled={!!busy}>
                  Try the demo
                </Button>
              )}
              <Button variant="primary" onClick={start} disabled={!!busy}>
                {startLabel}
              </Button>
            </>
          )}
        </div>
      </header>

      <section className="max-w-[1120px] mx-auto px-5 pt-10 md:pt-12 pb-16 grid grid-cols-1 md:grid-cols-[1.05fr_1fr] gap-10 md:items-start">
        <div className="fade-up min-w-0">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 h-7 text-[12px] font-medium text-ink-2">
            <Sparkles size={13} className="text-accent" /> Built for students who are recruiting
          </span>
          <h1 className="mt-5 text-[44px] md:text-[56px] leading-[1.02] font-bold tracking-[-0.03em]">
            Coffee chats, <br />
            without the busywork.
          </h1>
          <p className="mt-5 text-[17px] text-ink-2 max-w-[520px] leading-relaxed">
            Orbit helps you network for internships. Add the people you want to meet, by hand or from your
            LinkedIn connections, and Orbit points out who is worth a coffee chat, drafts each message for you
            to edit, reminds you when to follow up and say thank you, and keeps track of every conversation.
            Nothing is ever sent without you.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3 min-h-11">
            {resolving ? (
              <Spinner />
            ) : (
              <Button size="lg" variant="primary" onClick={start} disabled={!!busy}>
                {startLabel} <ArrowRight size={16} />
              </Button>
            )}
            {isDemo && onboarded && !resolving && (
              <Button size="lg" variant="secondary" onClick={() => nav('/today')}>
                Back to the demo
              </Button>
            )}
            {!onboarded && !resolving && (
              <Button size="lg" variant="secondary" onClick={demo} disabled={!!busy}>
                {/* the full progress message is in the status pill at the bottom; the button stays its own width */}
                {busy ? (
                  <>
                    <Spinner /> Loading…
                  </>
                ) : (
                  'Try the demo'
                )}
              </Button>
            )}
          </div>
          {isDemo && onboarded && (
            <p className="mt-3 text-[13px] text-ink-2">
              You are in the demo, with a made-up student's data. Setting up your own clears it.
            </p>
          )}
          {onboarded && !isDemo && (
            <p className="mt-3 text-[13px] text-ink-2">
              Your data on this browser belongs to {user?.fullName || 'your profile'}. To try the demo
              instead, use Reset to demo in Settings under LinkedIn, resume &amp; AI.
            </p>
          )}
          <p className="mt-3 text-[12px] text-ink-3">
            Free. Runs in your browser; your data stays on your device.
          </p>
        </div>
        <div className="min-w-0 md:mt-8">
          <HeroMock />
        </div>
      </section>

      <section id="how" className="border-t border-line bg-canvas-2/60">
        <div className="max-w-[1120px] mx-auto px-5 py-16">
          <h2 className="text-[28px] font-semibold tracking-[-0.02em]">One loop, every morning.</h2>
          <p className="text-ink-2 mt-2 max-w-[560px]">
            Orbit does the remembering, the tracking and the first draft. You do the judgement, in about five
            minutes a day.
          </p>
          <div className="grid md:grid-cols-3 gap-4 mt-10">
            {[
              {
                icon: Sun,
                title: 'A short list for today',
                body: google
                  ? 'The few things worth doing today: follow up, say thank you, confirm a time, prep for a chat, reconnect. Each with a ready draft and the reason it is there. The rest waits until you want it.'
                  : 'The few things worth doing today: follow up, say thank you, prep for a chat, keep a promise, reconnect. Each with the reason it is there, and a ready draft when there is a message to send. The rest waits until you want it.',
              },
              {
                icon: Mail,
                title: 'Drafts in your voice',
                body: 'Every line comes from something you actually know about the person. You edit it, send it yourself, or skip it.',
              },
              {
                icon: LayoutGrid,
                title: 'Every chat in one place',
                body: google
                  ? 'See where each conversation stands, from first message to scheduled to thanked, and who has gone quiet.'
                  : 'See where each conversation stands, from first message to scheduled to thanked, and who has gone quiet. When someone replies, move their card and Today shows your next step, starting with a draft reply.',
              },
              {
                icon: MapIcon,
                title: 'Your network as an orbit',
                body: 'You in the centre, people by how well you know them. Pick anyone and Orbit shows who could introduce you.',
              },
              {
                icon: Sparkles,
                title: 'Warm before you write',
                body: 'For someone you only know from LinkedIn, Orbit suggests a few small steps first, like reacting to a post, so your name is familiar when you write.',
              },
              {
                icon: NotebookPen,
                title: 'Remembers every chat',
                body: 'Type, dictate or paste notes after a chat. What they said, what they offered and what you promised land on their profile.',
              },
            ].map(({ icon: Icon, title, body }) => (
              <div key={title} className="bg-canvas border border-line rounded-[12px] p-5">
                <Icon size={18} className="text-accent" />
                <h3 className="font-semibold mt-3">{title}</h3>
                <p className="text-ink-2 text-[13.5px] mt-1.5 leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="privacy" className="max-w-[1120px] mx-auto px-5 py-16 grid md:grid-cols-2 gap-10">
        <div>
          <h2 className="text-[28px] font-semibold tracking-[-0.02em]">Your inbox stays yours.</h2>
          <p className="text-ink-2 mt-3 leading-relaxed">
            This version of Orbit runs entirely in your browser. The people, notes and LinkedIn connections
            you add are stored in your browser's local database and never uploaded.{' '}
            {google
              ? "Connecting Gmail and Calendar is optional and uses Google's own sign-in. "
              : 'It does not connect to your email or calendar: you send each message from your own mail app or LinkedIn, and tell Orbit when it went out. '}
            Claude drafting is optional and uses an API key you paste in, stored only on your device.
          </p>
          <ul className="mt-5 space-y-2 text-[14px] text-ink-2">
            <li>• Nothing is sent without you. What goes out is exactly the text you read.</li>
            <li>• No scraping. LinkedIn comes from your own data export.</li>
            <li>• Export or wipe everything from Settings, any time.</li>
          </ul>
        </div>
        <div className="bg-canvas-2/60 border border-line rounded-[12px] p-6">
          <h3 className="font-semibold">Start in two minutes</h3>
          <ol className="mt-3 space-y-3 text-[14px] text-ink-2">
            <li>
              <span className="font-medium text-ink">1.</span> Tell Orbit what you're recruiting for and
              upload your resume.
            </li>
            <li>
              <span className="font-medium text-ink">2.</span> Add the people you want to meet, or import your
              LinkedIn connections. Or just try the demo.
            </li>
            <li>
              <span className="font-medium text-ink">3.</span> Open Today: it lists the few things to do
              first, with drafts ready to edit.
            </li>
          </ol>
          <div className="mt-5 flex gap-2 min-h-9">
            {!resolving && (
              <Button variant="primary" onClick={start} disabled={!!busy}>
                {startLabel}
              </Button>
            )}
            {!resolving && !onboarded && !midSetup && (
              <Button onClick={demo} disabled={!!busy}>
                Try the demo
              </Button>
            )}
          </div>
        </div>
      </section>
      <footer className="border-t border-line">
        <div className="max-w-[1120px] mx-auto px-5 h-14 flex items-center text-[12px] text-ink-3 gap-4">
          <span>© {new Date().getFullYear()} Orbit</span>
        </div>
      </footer>
    </div>
  );
}

function HeroMock() {
  const cards: { kind: string; who: string; reason: string; tone: string; ready?: string }[] = [
    {
      kind: 'Prep',
      who: 'Mei Chen · Product Manager at Figma',
      reason: 'Your chat is tomorrow at 2pm',
      tone: 'bg-good-soft text-good',
      ready: 'Notes ready',
    },
    {
      kind: 'Thank-you',
      who: 'Omar Hassan · Engineer at Stripe',
      reason: 'You spoke yesterday',
      tone: 'bg-good-soft text-good',
    },
    {
      kind: 'Follow-up',
      who: 'Priya Patel · Engineering Manager at Ramp',
      reason: 'No reply in 6 business days',
      tone: 'bg-warn-soft text-warn',
    },
    {
      kind: 'Warm-up',
      who: 'Jordan Lee · Designer at Linear',
      reason: 'React to one recent post before you message',
      tone: 'bg-canvas-2 text-ink-2',
      ready: 'Step 2 of 3',
    },
  ];
  return (
    <div className="relative fade-up" style={{ animationDelay: '80ms' }}>
      <div className="absolute -inset-6 hidden md:block bg-[radial-gradient(ellipse_at_center,_rgba(91,91,214,0.12),_transparent_60%)]" />
      <div className="relative z-10 rounded-[14px] border border-line bg-canvas shadow-[var(--shadow-card)] overflow-hidden">
        <div className="h-10 border-b border-line flex items-center px-4 gap-2 text-[12px] text-ink-3">
          <span className="w-2.5 h-2.5 rounded-full bg-line" />
          <span className="w-2.5 h-2.5 rounded-full bg-line" />
          <span className="w-2.5 h-2.5 rounded-full bg-line" />
          <span className="ml-3">Today · Tuesday</span>
        </div>
        <div className="p-4">
          <div className="text-[13px] text-ink-3">Good morning, Alex</div>
          <div className="font-semibold text-[16px] mt-0.5">4 things for today</div>
          <div className="mt-3 space-y-2">
            {cards.map((c) => (
              <div
                key={c.kind}
                className="rounded-[10px] border border-line p-3 flex items-start gap-3 min-w-0"
              >
                <span
                  className={`rounded-full px-2 h-5 inline-flex items-center text-[11px] font-medium whitespace-nowrap shrink-0 ${c.tone}`}
                >
                  {c.kind}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium truncate">{c.who}</div>
                  <div className="text-[12px] text-ink-3 truncate">{c.reason}</div>
                </div>
                <span className="text-[12px] text-ink-3 shrink-0">{c.ready ?? 'Draft ready'}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      {/* sits behind the preview card, so it never covers the names on it */}
      <div className="absolute -bottom-12 -right-4 z-0 hidden lg:block opacity-60" aria-hidden>
        <OrbitMini />
      </div>
    </div>
  );
}

function OrbitMini() {
  const dots = Array.from({ length: 14 }, (_, i) => ({
    r: [38, 62, 86][i % 3]!,
    a: (i / 14) * Math.PI * 2 + (i % 2 ? 0.3 : 0),
    c: ['#5B5BD6', '#1f8a4c', '#b7791f', '#3f4650'][i % 4]!,
  }));
  return (
    <svg
      width="200"
      height="200"
      viewBox="0 0 200 200"
      className="drop-shadow-[0_8px_24px_rgba(15,17,21,0.08)]"
    >
      <circle cx="100" cy="100" r="96" fill="#fff" stroke="#e6e8ec" />
      {[38, 62, 86].map((r) => (
        <circle key={r} cx="100" cy="100" r={r} fill="none" stroke="#eceef2" />
      ))}
      <circle cx="100" cy="100" r="9" fill="#5B5BD6" />
      {dots.map((d, i) => (
        <circle
          key={i}
          cx={100 + Math.cos(d.a) * d.r}
          cy={100 + Math.sin(d.a) * d.r}
          r={5 - (i % 3)}
          fill={d.c}
          opacity="0.85"
        />
      ))}
    </svg>
  );
}
