import { useState, type CSSProperties } from 'react';
import type { AppConfig, GameId, GameStatus } from '../../../shared/ipc';
import { Panel, Button, Field, Select } from '../ui';
import { UnpackGate } from './UnpackGate';
import { ModManagerTab } from './ModManagerTab';

/**
 * Per-game Play-button gradient, drawn from each game's logo/box-art identity:
 *   XIII   — icy crystal blue/cyan
 *   XIII-2 — Serah pink -> Caius purple
 *   LR     — savior gold -> doomsday crimson
 */
const PLAY_THEME: Record<GameId, { a: string; b: string; c: string; glow: string; glow2: string }> = {
  XIII: { a: '#34c6ec', b: '#1f86d6', c: '#2353c6', glow: 'rgba(31,134,214,0.45)', glow2: 'rgba(35,83,198,0.5)' },
  'XIII-2': { a: '#ef5fb0', b: '#d6489e', c: '#7a3fd0', glow: 'rgba(214,72,158,0.42)', glow2: 'rgba(122,63,208,0.5)' },
  'XIII-LR': { a: '#f0c046', b: '#e2902c', c: '#cf3b2c', glow: 'rgba(226,144,44,0.45)', glow2: 'rgba(207,59,44,0.5)' },
};

const LANGS = [
  { value: 1, label: 'English' },
  { value: 2, label: 'French' },
  { value: 3, label: 'German' },
  { value: 4, label: 'Italian' },
  { value: 5, label: 'Spanish' },
  { value: 6, label: 'Japanese' },
  { value: 7, label: 'Chinese' },
  { value: 8, label: 'Korean' },
];

/**
 * The single per-game screen. It gates on status:
 *   not installed  -> locate-install prompt
 *   not unpacked   -> first-run UnpackGate (forced before any mod UI)
 *   ready          -> Play + settings + the mod list/import/reorder
 */
export function GameScreen({
  game,
  gameName,
  status,
  config,
  update,
  onRefresh,
}: {
  game: GameId;
  gameName: string;
  status: GameStatus | undefined;
  config: AppConfig;
  update: (p: Partial<AppConfig>) => void;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState('');
  const [launchNote, setLaunchNote] = useState<{ ok: boolean; message: string } | null>(null);

  if (!status?.installed) return <InstallPrompt game={game} gameName={gameName} onRefresh={onRefresh} />;
  if (!status.unpacked) return <UnpackGate game={game} gameName={gameName} onDone={onRefresh} />;

  const launch = async () => {
    setBusy(true);
    setLaunchNote(null);
    try {
      setLaunchNote(await window.nova.launchGame(game));
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    setRestoring(true);
    setRestoreMsg('');
    try {
      const r = await window.nova.restoreGame(game);
      setRestoreMsg(r.message);
      // Restore cleared the unpacked flag, so the game is no longer in a
      // modding-ready state — re-detect so the screen reflects that (it drops to
      // the first-run "Set up / unpack" gate) instead of a stale, inert mod list.
      await onRefresh();
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Panel title={gameName}>
        <div className="flex items-center gap-3">
          <button
            className="btn-play flex-1 px-5 py-3 font-display text-sm font-bold"
            style={
              {
                '--play-a': PLAY_THEME[game].a,
                '--play-b': PLAY_THEME[game].b,
                '--play-c': PLAY_THEME[game].c,
                '--play-glow': PLAY_THEME[game].glow,
                '--play-glow2': PLAY_THEME[game].glow2,
              } as CSSProperties
            }
            disabled={busy}
            onClick={launch}
          >
            ▶ Play {gameName}
          </button>
          <button
            className="btn-hud px-4 py-3 font-display text-sm tracking-wide"
            onClick={() => setShowSettings((s) => !s)}
          >
            {showSettings ? 'Hide Settings' : 'Show Settings'}
          </button>
        </div>

        {launchNote && (
          <div
            className={`mt-3 rounded-lg px-3 py-2 text-xs leading-relaxed ${
              launchNote.ok ? 'bg-nova-accent/10 text-nova-accent' : 'bg-nova-bad/10 text-nova-bad'
            }`}
          >
            {launchNote.message}
          </div>
        )}

        {showSettings && (
          <div className="mt-4 space-y-4 border-t border-nova-border pt-4">
            <Field label="Text language">
              <Select value={config.textLanguage} onChange={(v) => update({ textLanguage: Number(v) })} options={LANGS} />
            </Field>
            {status.installPath && (
              <div className="truncate text-xs text-nova-muted" title={status.installPath}>
                Install: <span className="font-mono text-nova-text">{status.installPath}</span>
              </div>
            )}
            <div className="mt-1 border-t border-nova-border pt-3">
              <div className="flex items-center justify-between gap-4">
                <p className="text-xs leading-relaxed text-nova-muted">
                  Game won't launch or acts up? <span className="text-nova-text">Restore to normal</span> un-patches the
                  game and turns off unpacked mode. Your mods stay saved and nothing is deleted.
                </p>
                <Button variant="danger" onClick={restore} disabled={restoring}>
                  {restoring ? 'Restoring…' : 'Restore game to normal'}
                </Button>
              </div>
              {restoreMsg && (
                <div className="mt-2 rounded-lg bg-nova-accent/10 px-3 py-2 text-xs leading-relaxed text-nova-accent">
                  {restoreMsg}
                </div>
              )}
            </div>
          </div>
        )}
      </Panel>

      <ModManagerTab game={game} />
    </div>
  );
}

function InstallPrompt({ game, gameName, onRefresh }: { game: GameId; gameName: string; onRefresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const browse = async () => {
    const dir = await window.nova.browseForFolder(`Select the ${gameName} install folder`);
    if (!dir) return;
    setBusy(true);
    try {
      await window.nova.setGamePath(game, dir);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-xl space-y-5 pt-4">
      <Panel title={gameName}>
        <p className="text-sm leading-relaxed text-nova-muted">
          open<span className="text-nova-accent">·</span>nova couldn't find {gameName} in your Steam libraries. If you own
          it, point it at the game's install folder (the one containing the data folder).
        </p>
        <div className="mt-4 flex gap-3">
          <Button variant="primary" className="flex-1" onClick={browse} disabled={busy}>
            Locate install folder
          </Button>
          <Button className="flex-1" onClick={() => onRefresh()} disabled={busy}>
            Re-detect Steam
          </Button>
        </div>
      </Panel>
    </div>
  );
}
