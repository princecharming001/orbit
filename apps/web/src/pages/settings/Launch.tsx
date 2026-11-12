/**
 * Settings, Launch: the owner's switch for each optional source (plan 43 §3.1, the owner's instruction to launch each
 * one with a single switch and no redeploy). Shown only to the owner's account (`isOwner`), and only when the server
 * answers GET /admin/sources (anyone else gets 404).
 *
 * One row per source with "Offered to students", whether it is ready in plain words, and how many students have it
 * on. Taking a source away asks first. Students read what is offered from GET /sources, so a source switched on here
 * shows up for them on their next read, with nothing rebuilt.
 */
import type { OptionalSource } from '@orbit/core';
import { Instagram, MessageCircle, Twitter } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { AppMark, IntegrationRow, RowGroup, RowStatus } from '../../components/IntegrationRow';
import { SettingsHeader } from '../../components/settings/kit';
import { loadSources } from '../../engine/sources';
import {
  type AdminSourcesResponse,
  accountUser,
  callApi,
  isSignedIn,
  refreshOwner,
  subscribeSession,
} from '../../integrations/orbitApi';
import { Button, Modal, SkeletonRows, Switch, useToast } from '../../ui';

type Row = AdminSourcesResponse['sources'][number];

const NAMES: Record<OptionalSource, string> = { instagram: 'Instagram', x: 'X', imessage: 'Texts' };

/** "Ready", or what the server says is missing, in its own plain words. */
export function readinessWords(r: Pick<Row, 'ready' | 'missing'>): string {
  if (r.ready && !r.missing.length) return 'Ready';
  if (!r.missing.length) return 'Not ready yet';
  const words = r.missing.map((m) => m.charAt(0).toLowerCase() + m.slice(1).replace(/\.$/, ''));
  const list = words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
  return `Needs ${list}`;
}

/** "3 students have it on · 5 connected" */
export function studentsWords(s: Row['students']): string {
  const on = `${s.on} ${s.on === 1 ? 'student has' : 'students have'} it on`;
  return s.connected > s.on ? `${on} · ${s.connected} connected` : on;
}

/** The Launch section is in the menu for the owner's account only. */
export function isOwnerAccount(): boolean {
  return accountUser()?.isOwner === true;
}

let askedOwner = false;

/** Whether this is the owner's account, asked of the server once a visit and followed as the session changes. */
export function useIsOwner(): boolean {
  const [owner, setOwner] = useState(isOwnerAccount);
  useEffect(() => {
    const off = subscribeSession(() => setOwner(isOwnerAccount()));
    if (isSignedIn() && !askedOwner) {
      askedOwner = true;
      void refreshOwner().then(setOwner, () => {
        askedOwner = false;
      });
    }
    return off;
  }, []);
  return owner;
}

const MARKS: Record<OptionalSource, ReactNode> = {
  instagram: <Instagram size={16} aria-hidden />,
  x: <Twitter size={16} aria-hidden />,
  imessage: <MessageCircle size={16} aria-hidden />,
};
const LOGOS: Partial<Record<OptionalSource, string>> = { instagram: 'instagram.com', x: 'x.com' };

export function LaunchSection() {
  const toast = useToast();
  const [rows, setRows] = useState<Row[] | null>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<OptionalSource>();
  const [taking, setTaking] = useState<OptionalSource>();
  const load = useCallback(async () => {
    const r = await callApi('/admin/sources', {});
    if (r.ok) {
      setRows(r.value.sources);
      setError(undefined);
    } else if (r.status === 404 || r.status === 403) setRows(null);
    else setError(r.message);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const set = async (source: OptionalSource, offered: boolean) => {
    setBusy(source);
    setError(undefined);
    try {
      const r = await callApi(`/admin/sources/${source}`, { offered });
      if (!r.ok) {
        const row = rows?.find((x) => x.source === source);
        const missing = (r.body?.missing as string[] | undefined) ?? row?.missing ?? [];
        setError(
          r.code === 'not_ready'
            ? `${NAMES[source]} cannot be offered yet. ${readinessWords({ ready: false, missing })}.`
            : r.code === 'env_listed'
              ? `${NAMES[source]} is set on the server (ORBIT_EXTRA_SOURCES), so it stays on until that setting changes.`
              : r.message,
        );
        await load();
        return;
      }
      toast.push({
        text: offered
          ? `${NAMES[source]} is offered to students. They see it the next time Orbit asks.`
          : `${NAMES[source]} is taken away. It stops being read.`,
        tone: offered ? 'good' : undefined,
      });
      await load();
      // the owner is a student too: their own Settings follows at once
      await loadSources().catch(() => undefined);
    } finally {
      setBusy(undefined);
      setTaking(undefined);
    }
  };
  const header = (
    <SettingsHeader
      title="Launch"
      description="Offer an optional source to every student, or take it away. Nothing is rebuilt: students see the change the next time Orbit asks."
    />
  );
  // not the owner after all (the server says so): nothing to show
  if (rows === null) return header;
  if (rows === undefined && !error)
    return (
      <>
        {header}
        <SkeletonRows rows={3} avatar={36} divided testId="launch-loading" />
      </>
    );
  return (
    <div className="pb-10" data-testid="settings-launch">
      {header}
      <RowGroup title="Optional sources">
        {(rows ?? []).map((r) => (
          <IntegrationRow
            key={r.source}
            testId={`launch-${r.source}`}
            mark={<AppMark logo={LOGOS[r.source]}>{MARKS[r.source]}</AppMark>}
            name={NAMES[r.source]}
            status={
              <RowStatus tone={r.ready ? 'good' : 'muted'} testId={`launch-${r.source}-ready`}>
                {readinessWords(r)}
              </RowStatus>
            }
            line={
              <span data-testid={`launch-${r.source}-students`}>
                {studentsWords(r.students)}
                {r.env ? ' · Set on the server' : ''}
              </span>
            }
            actions={
              <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
                Offered to students
                <Switch
                  checked={r.offered}
                  label={`Offer ${NAMES[r.source]} to students`}
                  busy={busy === r.source}
                  // a source that is not ready cannot be offered; one already offered can always be taken away
                  disabled={(!r.offered && !r.ready) || r.env}
                  title={!r.offered && !r.ready ? readinessWords(r) : r.offered ? 'Take it away' : 'Offer it'}
                  onChange={(next) => (next ? void set(r.source, true) : setTaking(r.source))}
                  data-testid={`launch-${r.source}-switch`}
                />
              </label>
            }
          />
        ))}
      </RowGroup>
      {error && (
        <p className="mt-3 text-[12.5px] text-bad" role="alert" data-testid="launch-error">
          {error}
        </p>
      )}
      <Modal
        open={!!taking}
        onClose={() => setTaking(undefined)}
        title={taking ? `Take ${NAMES[taking]} away from students?` : ''}
        width={440}
      >
        <div className="space-y-3 text-[13.5px] text-ink-2" data-testid="launch-confirm">
          <p>
            Students who connected it keep what Orbit took, and it stops being read. They are told once. Turn
            it on again within 30 days and it comes back as it was.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setTaking(undefined)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={!!busy}
              onClick={() => taking && void set(taking, false)}
              data-testid="launch-confirm-take"
            >
              Take it away
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
