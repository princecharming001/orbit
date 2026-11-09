/**
 * Settings, Costs (plan 34 E3): the owner's view of what Orbit spends, one row a day from the worker's morning digest
 * (`cost.digest` in orbit.audit_log, read through /admin/costs). Per day: dollars and units per provider, the chat
 * cache share, and which thresholds were crossed. Not in the section list: the owner opens /settings/costs, and anyone
 * else sees the empty state because the route answers 404 to them.
 */
import { useEffect, useState } from 'react';
import { SettingsCard, SettingsHeader, SettingsStack } from '../../components/settings/kit';
import { type CostDigestResponse, callApi } from '../../integrations/orbitApi';
import { Spinner } from '../../ui';

export interface ProviderDay {
  provider: string;
  usd: number;
  units: number;
  calls: number;
}

export interface CostDay {
  day: string;
  totalUsd: number;
  providers: ProviderDay[];
  /** share of chat input read from the prompt cache, 0 to 1, when the digest has it */
  cacheShare: number | undefined;
  /** the thresholds crossed that day, in the digest's own words */
  alerts: string[];
  /** the limits the digest checked against, by name */
  thresholds: Record<string, number>;
}

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};

/** Each provider's line from either digest shape: a list of rows, or an object keyed by provider. */
function providersOf(raw: unknown): ProviderDay[] {
  const rows: ProviderDay[] = [];
  const one = (provider: string, v: Record<string, unknown>) =>
    rows.push({
      provider,
      usd: num(v.usd ?? v.cost_usd ?? v.costUsd),
      units: num(v.units),
      calls: num(v.calls ?? v.requests),
    });
  if (Array.isArray(raw)) {
    for (const r of raw)
      if (r && typeof r === 'object' && typeof (r as { provider?: unknown }).provider === 'string')
        one((r as { provider: string }).provider, r as Record<string, unknown>);
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>))
      if (v && typeof v === 'object') one(k, v as Record<string, unknown>);
      else one(k, { usd: v });
  }
  return rows.sort((a, b) => b.usd - a.usd || a.provider.localeCompare(b.provider));
}

/** The cache share as 0 to 1, whether the digest wrote a fraction or a percentage. */
function shareOf(details: Record<string, unknown>): number | undefined {
  const chat = (details.chat ?? {}) as Record<string, unknown>;
  const raw =
    chat.cacheReadShare ?? chat.cacheShare ?? chat.cache_share ?? details.cacheShare ?? details.cache_share;
  if (raw === undefined || raw === null) return undefined;
  const n = num(raw);
  return n > 1 ? n / 100 : n;
}

function alertText(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a && typeof a === 'object') {
    const o = a as { text?: unknown; message?: unknown; name?: unknown };
    return String(o.text ?? o.message ?? o.name ?? '');
  }
  return '';
}

/** The digest rows as days the page can show, newest first. Unknown fields are ignored. */
export function costDays(rows: CostDigestResponse['rows']): CostDay[] {
  return rows.map((r) => {
    const d = r.details ?? {};
    const providers = providersOf(d.providers ?? d.byProvider ?? d.by_provider);
    const alertsRaw = d.alerts ?? d.crossed;
    const thresholdsRaw =
      d.thresholds && typeof d.thresholds === 'object' ? (d.thresholds as Record<string, unknown>) : {};
    const total = d.totalUsd ?? d.total_usd;
    return {
      day: typeof d.day === 'string' ? d.day : r.at.slice(0, 10),
      totalUsd: total !== undefined ? num(total) : providers.reduce((s, p) => s + p.usd, 0),
      providers,
      cacheShare: shareOf(d),
      alerts: Array.isArray(alertsRaw) ? alertsRaw.map(alertText).filter(Boolean) : [],
      thresholds: Object.fromEntries(
        Object.entries(thresholdsRaw)
          .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
          .map(([k, v]) => [k, num(v)]),
      ),
    };
  });
}

const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);

export function CostsSection() {
  const [days, setDays] = useState<CostDay[]>();
  const [note, setNote] = useState<string>();
  useEffect(() => {
    let live = true;
    void callApi('/admin/costs', {}).then((r) => {
      if (!live) return;
      if (r.ok) setDays(costDays(r.value.rows));
      else {
        setDays([]);
        setNote(r.status === 404 ? 'Only the owner of this Orbit can see its costs.' : r.message);
      }
    });
    return () => {
      live = false;
    };
  }, []);

  const latest = days?.[0];
  return (
    <>
      <SettingsHeader
        title="Costs"
        description="What Orbit spent each day, from the digest the server writes every morning."
      />
      {!days ? (
        <Spinner />
      ) : !days.length ? (
        <SettingsCard data-testid="costs-empty">
          <p className="px-5 py-4 text-[13.5px] text-ink-3">
            {note ?? 'No digest yet. The first one arrives the morning after the digest job starts.'}
          </p>
        </SettingsCard>
      ) : (
        <SettingsStack>
          {latest && latest.alerts.length > 0 && (
            <SettingsCard title="Crossed on the latest day" data-testid="costs-alerts">
              <ul className="px-5 py-4 space-y-1.5">
                {latest.alerts.map((a) => (
                  <li key={a} className="text-[13.5px] text-ink">
                    {a}
                  </li>
                ))}
              </ul>
            </SettingsCard>
          )}
          <SettingsCard
            title="By day"
            description="Dollars per provider. Cache share is the part of chat input read from the prompt cache."
            data-testid="costs-days"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-[12px] text-ink-3">
                    <th className="px-5 py-2 font-medium">Day</th>
                    <th className="px-3 py-2 font-medium">Total</th>
                    <th className="px-3 py-2 font-medium">Providers</th>
                    <th className="px-5 py-2 font-medium">Cache share</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((d) => (
                    <tr key={d.day} className="align-top" data-testid="costs-day">
                      <td className="px-5 py-2 whitespace-nowrap text-ink">{d.day}</td>
                      <td className="px-3 py-2 tabular-nums text-ink">{usd(d.totalUsd)}</td>
                      <td className="px-3 py-2 text-ink-2">
                        {d.providers.length
                          ? d.providers
                              .map((p) => `${p.provider} ${usd(p.usd)}${p.units ? `, ${p.units} units` : ''}`)
                              .join('; ')
                          : 'Nothing spent'}
                      </td>
                      <td className="px-5 py-2 tabular-nums text-ink-2">
                        {d.cacheShare === undefined ? 'Not measured' : `${Math.round(d.cacheShare * 100)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SettingsCard>
          {latest && Object.keys(latest.thresholds).length > 0 && (
            <SettingsCard
              title="Thresholds"
              description="The digest mails the owner when a day crosses one of these."
              data-testid="costs-thresholds"
            >
              <ul className="px-5 py-4 space-y-1.5">
                {Object.entries(latest.thresholds).map(([k, v]) => (
                  <li key={k} className="flex justify-between gap-4 text-[13.5px]">
                    <span className="text-ink-2">{k.replace(/_/g, ' ')}</span>
                    <span className="tabular-nums text-ink">{v}</span>
                  </li>
                ))}
              </ul>
            </SettingsCard>
          )}
        </SettingsStack>
      )}
    </>
  );
}
