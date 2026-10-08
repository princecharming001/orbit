import { Upload } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { connectionsText, importLinkedInExport } from '../engine/linkedin';
import { useSession } from '../state/session';
import { cx, Spinner, useToast } from '../ui';

const VARIANTS = {
  primary: 'bg-accent text-white hover:bg-accent-2',
  secondary: 'bg-canvas text-ink border border-line hover:bg-canvas-2',
  ghost: 'bg-transparent text-ink-2 hover:bg-canvas-2 hover:text-ink',
} as const;

/**
 * Upload LinkedIn's Connections.csv right where the student is (an empty Today, People or Discover, or Settings):
 * the button opens the file picker itself, the file input is reachable with the keyboard, and when the import is
 * done the toast says who is worth meeting and links to them.
 */
export function LinkedInImportButton({
  label = 'Import LinkedIn connections',
  variant = 'secondary',
  testId = 'linkedin-import',
  className,
}: {
  label?: string;
  variant?: keyof typeof VARIANTS;
  testId?: string;
  className?: string;
}) {
  const { user } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState<string>();
  if (!user) return null;
  const onFile = async (f: File) => {
    setBusy('Importing…');
    try {
      const r = await importLinkedInExport(user, await connectionsText(f), (d, t) =>
        setBusy(`Importing ${d} of ${t}…`),
      );
      const added = `${r.imported} ${r.imported === 1 ? 'person' : 'people'} added, ${r.updated} updated.`;
      if (r.imported + r.updated === 0)
        toast.push({
          text: 'Orbit found nobody in that file. Upload Connections.csv from the LinkedIn export.',
          tone: 'bad',
          ttl: 8000,
        });
      else
        toast.push({
          text: r.recommended
            ? `${added} ${r.recommended} worth a coffee chat are on Discover.`
            : `${added} Add your target companies in Settings so Orbit can say who to meet first.`,
          tone: 'good',
          ttl: 9000,
          sticky: true,
          action: r.recommended
            ? { label: 'See who to meet', onClick: () => nav('/discover') }
            : { label: 'Set goals', onClick: () => nav('/settings/goals') },
        });
    } catch (e) {
      toast.push({ text: String((e as Error).message ?? e), tone: 'bad', ttl: 9000 });
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <label
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium h-9 px-3.5 text-[14px] cursor-pointer whitespace-nowrap focus-within:ring-2 focus-within:ring-accent/40',
        VARIANTS[variant],
        busy && 'opacity-60 pointer-events-none',
        className,
      )}
    >
      <input
        type="file"
        accept=".csv,.zip"
        className="sr-only"
        data-testid={testId}
        disabled={!!busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void onFile(f);
        }}
      />
      {busy ? <Spinner /> : <Upload size={14} />} {busy ?? label}
    </label>
  );
}
