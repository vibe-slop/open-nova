import { useEffect, useState } from 'react';
import type { GameId, UnpackPlan, ProgressEvent } from '../../../shared/ipc';
import { Panel, Button, ProgressBar, fmtBytes } from '../ui';
import { CrystalSpinner } from '../CrystalSpinner';

/**
 * First-run gate shown when a game is installed but not yet unpacked. Modding
 * requires the game's archives to be extracted into a loose tree once; this
 * screen explains that, shows the disk-space estimate (warning if tight), and
 * runs the unpack with a progress bar. The mod UI is only reachable once this
 * completes — so the user never hits the "enabled before unpacking" trap.
 */
export function UnpackGate({ game, gameName, onDone }: { game: GameId; gameName: string; onDone: () => void }) {
  const [plan, setPlan] = useState<UnpackPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    window.nova.getUnpackPlan(game).then(setPlan);
    const off = window.nova.onProgress((e) => {
      if (e.jobId === 'unpackGame') setProgress(e);
    });
    return off;
  }, [game]);

  const unpack = async (force: boolean) => {
    setBusy(true);
    setError('');
    setProgress(null);
    try {
      const r = await window.nova.unpackGame(game, force);
      if (r.ok) onDone();
      else setError(r.message);
    } finally {
      setBusy(false);
    }
  };

  const insufficient = !!plan && !plan.sufficient && plan.freeBytes > 0;

  return (
    <div className="mx-auto max-w-xl space-y-5 pt-4">
      <Panel title={`Set up ${gameName}`}>
        <p className="text-sm leading-relaxed text-nova-muted">
          Before you can add mods, open<span className="text-nova-accent">·</span>nova needs to{' '}
          <span className="text-nova-text">unpack</span> {gameName} once — it extracts the game's archives into editable
          files so mods can be applied and removed cleanly. It's a one-time step; afterwards you just enable mods and play.
        </p>

        <div className="mt-4 space-y-2 rounded-lg border border-nova-border bg-nova-panel2 p-3 text-sm">
          <Row label="Estimated unpacked size" value={plan ? fmtBytes(plan.estimateBytes) : '…'} />
          <Row
            label="Free on game drive"
            value={plan ? (plan.freeBytes > 0 ? fmtBytes(plan.freeBytes) : 'unknown') : '…'}
            tone={insufficient ? 'bad' : plan ? 'good' : undefined}
          />
        </div>

        {insufficient && (
          <div className="mt-3 rounded-lg bg-nova-bad/10 px-3 py-2 text-xs text-nova-bad">
            There may not be enough free space to unpack {gameName}. Free up some room first, or unpack anyway at your own
            risk (an out-of-space unpack can leave the game in a broken state).
          </div>
        )}
        {error && <div className="mt-3 rounded-lg bg-nova-bad/10 px-3 py-2 text-xs text-nova-bad">{error}</div>}

        {busy ? (
          <div className="mt-5 flex flex-col items-center gap-4">
            <CrystalSpinner />
            <ProgressBar value={progress ? progress.current / Math.max(1, progress.total) : 0} />
            <div className="text-center text-xs text-nova-muted">
              {progress ? `Unpacking… ${progress.current} / ${progress.total} archives` : 'Starting…'} — this can take a few
              minutes. Don't close the app.
            </div>
          </div>
        ) : (
          <div className="mt-5 flex gap-3">
            <Button variant="primary" className="flex-1 py-3" disabled={!plan?.installed} onClick={() => unpack(false)}>
              Unpack {gameName}
            </Button>
            {insufficient && (
              <Button onClick={() => unpack(true)} disabled={!plan?.installed}>
                Unpack anyway
              </Button>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs uppercase tracking-wider text-nova-muted">{label}</span>
      <span className={`font-display text-base ${tone === 'bad' ? 'text-nova-bad' : tone === 'good' ? 'text-nova-good' : 'text-nova-text'}`}>
        {value}
      </span>
    </div>
  );
}
