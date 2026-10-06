import { ArrowRight, CalendarCheck, Mail, Map as MapIcon, Sparkles, Sun } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Logo } from '../components/AppShell';
import { createLocalUser } from '../engine/account';
import { DEMO_USER_ID, demoResetPrompt, loadDemo } from '../engine/demo';
import { useSession } from '../state/session';
import { Button, Spinner } from '../ui';

export function Landing() {
  const nav = useNavigate();
  const { userId, user, setUserId } = useSession();
  const [busy, setBusy] = useState<string | undefined>();
  const onboarded = !!(userId && user?.onboardingCompletedAt);
  const midSetup = !!(userId && user && !user.onboardingCompletedAt);
  const isDemo = user?.id === DEMO_USER_ID;
  const demo = async () => {
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
    // An existing user continues where they are; only a first visit creates a new local profile.
    if (onboarded) return nav('/today');
    if (midSetup && user) return nav(`/onboarding/${Math.max(2, user.onboardingStep)}`);
    setBusy('Creating your space…');
    const u = await createLocalUser();
    await setUserId(u.id);
    nav('/onboarding/2');
  };
  const startLabel = onboarded ? 'Open Orbit' : midSetup ? 'Continue setup' : 'Get started';
  return (
    <div className="min-h-full bg-canvas">
      <header className="max-w-[1120px] mx-auto px-5 h-16 flex items-center gap-3">
        <Logo size={24} />
        <span className="font-semibold tracking-tight text-[16px]">Orbit</span>
        <nav className="ml-auto hidden sm:flex items-center gap-6 text-[14px] text-ink-2">
          <a href="#how">How it works</a>
          <a href="#privacy">Privacy</a>
          <a
            href="https://github.com/princecharming001/orbit/tree/main/docs/plan"
            target="_blank"
            rel="noreferrer"
          >
            Docs
          </a>
        </nav>
        <div className="ml-auto sm:ml-4 flex items-center gap-2">
          {onboarded ? (
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

      <section className="max-w-[1120px] mx-auto px-5 pt-12 pb-16 grid md:grid-cols-[1.05fr_1fr] gap-10 items-center">
        <div className="fade-up">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 h-7 text-[12px] font-medium text-ink-2">
            <Sparkles size={13} className="text-accent" /> Built for students who are recruiting
          </span>
          <h1 className="mt-5 text-[44px] md:text-[56px] leading-[1.02] font-bold tracking-[-0.03em]">
            Coffee chats, <br />
            on autopilot.
          </h1>
          <p className="mt-5 text-[17px] text-ink-2 max-w-[520px] leading-relaxed">
            Orbit connects your Gmail, calendar and LinkedIn, learns what you're recruiting for, finds the
            right people, drafts in your voice, and hands you a morning brief of one-tap follow-ups. Nothing
            is ever sent without you.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Button size="lg" variant="primary" onClick={start} disabled={!!busy}>
              {startLabel} <ArrowRight size={16} />
            </Button>
            {!onboarded && (
              <Button size="lg" variant="secondary" onClick={demo} disabled={!!busy}>
                {busy ? (
                  <>
                    <Spinner /> {busy}
                  </>
                ) : (
                  'Try it with demo data'
                )}
              </Button>
            )}
          </div>
          {onboarded && !isDemo && (
            <p className="mt-3 text-[13px] text-ink-2">
              Your data on this browser belongs to {user?.fullName || 'your profile'}. To try the demo
              instead, use Reset to demo in Settings under Integrations.
            </p>
          )}
          <p className="mt-3 text-[12px] text-ink-3">
            Free. Runs in your browser; your data stays on your device.
          </p>
          <div className="mt-8 flex flex-wrap gap-2">
            {[
              'Morning brief',
              'Pipeline',
              'Orbit map',
              'Reach paths',
              'Warm-ups',
              'Granola notes',
              'Voice capture',
            ].map((t) => (
              <span
                key={t}
                className="rounded-full border border-line px-3 h-7 inline-flex items-center text-[12px] text-ink-2"
              >
                {t}
              </span>
            ))}
          </div>
        </div>
        <HeroMock />
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
                title: 'Morning brief',
                body: 'Five to seven things worth doing today: follow up, thank, confirm a time, prep for a chat, reconnect. Each with a ready draft and a reason.',
              },
              {
                icon: Mail,
                title: 'Drafts in your voice',
                body: 'Learned from your own sent mail. Every claim traces to something you actually know about the person. You approve, edit or skip.',
              },
              {
                icon: CalendarCheck,
                title: 'A pipeline that fills itself',
                body: 'Stages are inferred from email and calendar: outreach sent, replied, scheduling, scheduled, completed, followed up, nurturing.',
              },
              {
                icon: MapIcon,
                title: 'Your network as an orbit',
                body: 'You in the centre, people by closeness, companies as arcs. Ask for a path to anyone and Orbit shows who can introduce you.',
              },
              {
                icon: Sparkles,
                title: 'Warm before you write',
                body: 'For cold LinkedIn targets, Orbit schedules a few days of genuine engagement with their posts before suggesting the message.',
              },
              {
                icon: CalendarCheck,
                title: 'Remembers every chat',
                body: 'Share Granola notes by email, dictate with Wispr Flow into the capture box, or paste. Facts, offers and promises land on the profile.',
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
            This version of Orbit runs entirely in your browser. Email, calendar and LinkedIn data are stored
            in your browser's local database and never uploaded. Google access is optional and uses Google's
            own sign-in; Claude drafting is optional and uses an API key you paste in, stored only on your
            device.
          </p>
          <ul className="mt-5 space-y-2 text-[14px] text-ink-2">
            <li>• Nothing is sent without your tap. Approval binds the exact text.</li>
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
              <span className="font-medium text-ink">2.</span> Connect Google, or upload your LinkedIn export,
              or just try the demo.
            </li>
            <li>
              <span className="font-medium text-ink">3.</span> Open your first brief.
            </li>
          </ol>
          <div className="mt-5 flex gap-2">
            <Button variant="primary" onClick={start} disabled={!!busy}>
              {startLabel}
            </Button>
            {!onboarded && !midSetup && (
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
  const cards = [
    {
      kind: 'Confirm time',
      who: 'Mei Chen · Product Manager at Figma',
      reason: 'Mei suggested Thursday at 2pm',
      tone: 'bg-accent-soft text-accent',
    },
    {
      kind: 'Thank-you',
      who: 'Omar Hassan · Engineer at Stripe',
      reason: 'You spoke yesterday',
      tone: 'bg-good-soft text-good',
    },
    {
      kind: 'Follow up',
      who: 'Priya Patel · Engineering Manager at Ramp',
      reason: 'No reply in 6 business days',
      tone: 'bg-warn-soft text-warn',
    },
    {
      kind: 'Warm-up',
      who: 'Jordan Lee · Designer at Linear',
      reason: 'React to one recent post before you message',
      tone: 'bg-canvas-2 text-ink-2',
    },
  ];
  return (
    <div className="relative fade-up" style={{ animationDelay: '80ms' }}>
      <div className="absolute -inset-6 bg-[radial-gradient(ellipse_at_center,_rgba(91,91,214,0.12),_transparent_60%)]" />
      <div className="relative rounded-[14px] border border-line bg-canvas shadow-[var(--shadow-card)] overflow-hidden">
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
              <div key={c.kind} className="rounded-[10px] border border-line p-3 flex items-start gap-3">
                <span
                  className={`rounded-full px-2 h-5 inline-flex items-center text-[11px] font-medium ${c.tone}`}
                >
                  {c.kind}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium truncate">{c.who}</div>
                  <div className="text-[12px] text-ink-3 truncate">{c.reason}</div>
                </div>
                <span className="text-[12px] text-accent font-medium">Review</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="absolute -bottom-6 -left-6 hidden md:block">
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
