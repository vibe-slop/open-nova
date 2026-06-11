import { useEffect, useState } from 'react';
import type { GameId, ModInfo, ModInstallOptions } from '../../../shared/ipc';
import { Panel, Button, StatusChip } from '../ui';

const DEFAULT_OPTS: ModInstallOptions = { data: true, enVoice: false, jpVoice: false, external: false, code: false };

export function ModManagerTab({ game }: { game: GameId }) {
  const [mods, setMods] = useState<ModInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => window.nova.listMods(game).then(setMods);
  useEffect(() => {
    setSelected(null);
    refresh();
  }, [game]);

  const sel = mods.find((m) => m.name === selected) ?? null;

  const importMod = async () => {
    const f = await window.nova.browseForFile('Select a .ncmp mod pack', [{ name: 'Nova ModPack', extensions: ['ncmp', 'zip'] }]);
    if (!f) return;
    setBusy(true);
    try {
      setMods(await window.nova.importMod(f));
    } finally {
      setBusy(false);
    }
  };

  const act = async (kind: 'install' | 'uninstall' | 'remove') => {
    if (!sel) return;
    setBusy(true);
    try {
      if (kind === 'install') await window.nova.installMod(game, sel.name, DEFAULT_OPTS);
      else if (kind === 'uninstall') await window.nova.uninstallMod(game, sel.name, DEFAULT_OPTS);
      else setMods(await window.nova.removeMod(game, sel.name));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid h-full grid-cols-[1fr_320px] gap-5">
      <Panel
        title={`Mods · ${game}`}
        right={
          <Button onClick={importMod} disabled={busy}>
            + Import .ncmp
          </Button>
        }
      >
        <div className="space-y-1">
          {mods.length === 0 && <div className="py-10 text-center text-sm text-nova-muted">No mods yet. Import a .ncmp pack to get started.</div>}
          {mods.map((m) => (
            <button
              key={m.name}
              onClick={() => setSelected(m.name)}
              className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left transition ${
                selected === m.name ? 'border-nova-accent bg-nova-accent/10' : 'border-transparent hover:bg-nova-panel2'
              }`}
            >
              <div>
                <div className="text-sm font-medium text-nova-text">{m.name}</div>
                <div className="text-xs text-nova-muted">
                  {m.author} · v{m.version}
                </div>
              </div>
              <StatusChip status={m.status} />
            </button>
          ))}
        </div>
      </Panel>

      <Panel title="Details">
        {!sel ? (
          <div className="py-10 text-center text-sm text-nova-muted">Select a mod.</div>
        ) : (
          <div className="space-y-4">
            <div>
              <div className="text-lg font-semibold">{sel.name}</div>
              <div className="text-xs text-nova-muted">
                {sel.author} · v{sel.version}
              </div>
            </div>
            <p className="text-sm text-nova-muted">{sel.summary || 'No description.'}</p>
            <StatusChip status={sel.status} />
            <div className="space-y-2 pt-2">
              {sel.installed ? (
                <Button className="w-full" disabled={busy} onClick={() => act('uninstall')}>
                  Uninstall
                </Button>
              ) : (
                <Button variant="primary" className="w-full" disabled={busy || sel.status === 'Wrong Game'} onClick={() => act('install')}>
                  Install
                </Button>
              )}
              <Button variant="danger" className="w-full" disabled={busy} onClick={() => act('remove')}>
                Remove from library
              </Button>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
