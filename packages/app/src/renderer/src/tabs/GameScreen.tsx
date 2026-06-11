import { useState, type CSSProperties } from 'react';
import type { AppConfig, GameId, GameStatus } from '../../../shared/ipc';
import { Panel, Button, Field, Select, Toggle } from '../ui';
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

  if (!status?.installed) return <InstallPrompt game={game} gameName={gameName} onRefresh={onRefresh} />;
  if (!status.unpacked) return <UnpackGate game={game} gameName={gameName} onDone={onRefresh} />;

  const launch = async () => {
    setBusy(true);
    try {
      await window.nova.launchGame(game);
    } finally {
      setBusy(false);
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

        {showSettings && (
          <div className="mt-4 grid grid-cols-2 gap-4 border-t border-nova-border pt-4">
            <Field label="Text language">
              <Select value={config.textLanguage} onChange={(v) => update({ textLanguage: Number(v) })} options={LANGS} />
            </Field>
            <Field label="Resolution">
              <Select
                value={config.width ? `${config.width}x${config.height}` : 'desktop'}
                onChange={(v) => {
                  if (v === 'desktop') return update({ width: null, height: null });
                  const [w, h] = v.split('x').map(Number);
                  update({ width: w, height: h });
                }}
                options={[
                  { value: 'desktop', label: 'Desktop resolution' },
                  { value: '1280x720', label: '1280 × 720' },
                  { value: '1920x1080', label: '1920 × 1080' },
                  { value: '2560x1440', label: '2560 × 1440' },
                ]}
              />
            </Field>
            <div className="col-span-2 flex flex-wrap gap-6 pt-1">
              <Toggle checked={config.fullscreen} onChange={(v) => update({ fullscreen: v })} label="Fullscreen" />
              <Toggle checked={config.voiceJP} onChange={(v) => update({ voiceJP: v })} label="Japanese voices" />
            </div>
            {status.installPath && (
              <div className="col-span-2 truncate text-xs text-nova-muted" title={status.installPath}>
                Install: <span className="font-mono text-nova-text">{status.installPath}</span>
              </div>
            )}
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
