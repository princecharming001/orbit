import { cx } from '../../ui';

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
 * Who uses Orbit: a Live mark, then two columns drifting past each other, the universities students study at going
 * up and the companies they have offers from coming down. Sits beside the hero's headline on a wide screen and under
 * it on a phone.
 */
export function TrustedBy() {
  return (
    <div className="min-w-0" data-testid="trusted-by" role="group" aria-label="Who uses Orbit">
      <div className="flex items-center gap-2 px-1 text-[12.5px] text-ink-3">
        <span className="relative flex h-2 w-2" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-good opacity-40" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-good" />
        </span>
        Live
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2.5 sm:gap-3">
        <Column items={SCHOOLS} label="Studying @" testId="trusted-schools" />
        <Column items={COMPANIES} label="With offers @" down testId="trusted-companies" />
      </div>
    </div>
  );
}
