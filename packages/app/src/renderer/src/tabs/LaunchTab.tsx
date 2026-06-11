import { useEffect, useState } from 'react';
import type { AppConfig, SteamInfo } from '../../../shared/ipc';
import { Panel, Button, Field, Select, Toggle } from '../ui';

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

export function LaunchTab({ config, update }: { config: AppConfig; update: (p: Partial<AppConfig>) => void }) {
  const [steam, setSteam] = useState<SteamInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => window.nova.detectSteam().then(setSteam);
  useEffect(() => {
    refresh();
  }, []);

  const game = steam?.games.find((g) => g.id === config.selectedGame);

  const browse = async () => {
    const dir = await window.nova.browseForFolder('Select game install folder');
    if (dir) setSteam(await window.nova.setGamePath(config.selectedGame, dir));
  };

  const run = async (fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Panel title="Game" right={<Button onClick={refresh}>Detect Steam</Button>}>
        <div className="space-y-2 text-sm">
          <Row label="Steam root" value={steam?.steamRoot ?? '— not found —'} />
          <Row label="Install path" value={game?.installPath ?? '— not detected —'} action={<Button onClick={browse}>Browse…</Button>} />
          <div className="flex gap-2 pt-1">
            <Badge ok={!!game?.installed}>{game?.installed ? 'Installed' : 'Not found'}</Badge>
            <Badge ok={!!game?.unpacked}>{game?.unpacked ? 'Unpacked mode' : 'Packed (not unpacked)'}</Badge>
          </div>
        </div>
      </Panel>

      <Panel title="Settings">
        <div className="grid grid-cols-2 gap-4">
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
          <div className="col-span-2 flex gap-6 pt-1">
            <Toggle checked={config.fullscreen} onChange={(v) => update({ fullscreen: v })} label="Fullscreen" />
            <Toggle checked={config.voiceJP} onChange={(v) => update({ voiceJP: v })} label="Japanese voices" />
            <Toggle
              checked={config.filesystemMode === 'unpacked'}
              onChange={(v) => update({ filesystemMode: v ? 'unpacked' : 'packed' })}
              label="Unpacked mode"
            />
          </div>
        </div>
      </Panel>

      <div className="flex gap-3">
        <Button variant="primary" className="flex-1 py-3" disabled={!game?.installed || busy} onClick={() => run(() => window.nova.launchGame(config.selectedGame))}>
          ▶ Launch {config.selectedGame}
        </Button>
        <Button disabled={!game?.installed || game?.unpacked || busy} onClick={() => run(() => window.nova.unpackGame(config.selectedGame))}>
          Unpack game data
        </Button>
      </div>
      <p className="text-center text-xs text-nova-muted">
        On Steam Deck the game launches via <code className="text-nova-accent">steam://rungameid</code> under Proton.
      </p>
    </div>
  );
}

function Row({ label, value, action }: { label: string; value: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-nova-muted">{label}</span>
      <span className="flex items-center gap-2">
        <span className="truncate font-mono text-xs text-nova-text" title={value}>
          {value}
        </span>
        {action}
      </span>
    </div>
  );
}

function Badge({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <span className={`chip ${ok ? 'bg-nova-good/15 text-nova-good' : 'bg-nova-border/40 text-nova-muted'}`}>{children}</span>;
}
