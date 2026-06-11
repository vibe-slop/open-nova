import { useEffect, useState } from 'react';
import type { GameId, LibraryMod, NexusAuth } from '../../../shared/ipc';
import { Panel, Button, Toggle } from '../ui';

export function ModManagerTab({ game }: { game: GameId }) {
  const [mods, setMods] = useState<LibraryMod[]>([]);
  const [auth, setAuth] = useState<NexusAuth | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string>('');

  const refresh = () => window.nova.libraryList(game).then(setMods);
  useEffect(() => {
    refresh();
    window.nova.getNexusAuth().then(setAuth);
    // An nxm:// "Download with Manager" install completing should refresh + notify.
    const off = window.nova.onNxm((e) => {
      setNotice(e.message);
      if (e.status === 'installed' || e.status === 'error') refresh();
    });
    return off;
  }, [game]);

  const toggle = async (mod: LibraryMod, enabled: boolean) => {
    setBusy(mod.modName);
    try {
      const r = await window.nova.librarySetEnabled(game, mod.modName, enabled);
      setMods(r.mods);
      if (!r.ok) setNotice(r.message);
    } finally {
      setBusy(null);
    }
  };

  const importFile = async () => {
    setBusy('import');
    try {
      const r = await window.nova.libraryImportFile(game);
      setMods(r.mods);
      setNotice(r.message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (mod: LibraryMod) => {
    setBusy(mod.modName);
    try {
      setMods(await window.nova.libraryRemove(game, mod.modName));
    } finally {
      setBusy(null);
    }
  };

  // Move a mod up/down in load order. The list is shown low→high priority; a
  // mod lower in the list is applied later and wins file conflicts.
  const move = async (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= mods.length) return;
    const order = mods.map((m) => m.modName);
    [order[index], order[target]] = [order[target], order[index]];
    setBusy(mods[index].modName);
    try {
      setMods(await window.nova.librarySetOrder(game, order));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <NexusBar game={game} auth={auth} onAuth={setAuth} />

      <Panel
        title={`Mods · ${game}`}
        right={
          <Button onClick={importFile} disabled={busy === 'import'}>
            {busy === 'import' ? 'Importing…' : '+ Import file'}
          </Button>
        }
      >
        {notice && <div className="mb-3 rounded-lg bg-nova-accent/10 px-3 py-2 text-xs text-nova-accent">{notice}</div>}
        <div className="space-y-2">
          {mods.length === 0 && (
            <div className="py-8 text-center text-sm text-nova-muted">
              No mods yet. Connect Nexus and use “Download with Manager” on a mod page, or import a file.
            </div>
          )}
          {mods.map((m, i) => (
            <div key={m.modName} className="flex items-center gap-3 rounded-lg border border-nova-border bg-nova-panel2 px-3 py-2.5">
              <div className="flex flex-col">
                <button className="text-nova-muted hover:text-nova-accent disabled:opacity-30" onClick={() => move(i, -1)} disabled={i === 0 || busy !== null} title="Apply earlier (lower priority)">▲</button>
                <button className="text-nova-muted hover:text-nova-accent disabled:opacity-30" onClick={() => move(i, 1)} disabled={i === mods.length - 1 || busy !== null} title="Apply later (wins conflicts)">▼</button>
              </div>
              <span className="w-5 text-center text-xs text-nova-muted">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-nova-text">{m.name}</span>
                  <LayoutChip mod={m} />
                </div>
                <div className="truncate text-xs text-nova-muted">
                  {m.author && `${m.author} · `}
                  {m.version && `v${m.version} · `}
                  {m.source === 'nexus' ? 'Nexus' : m.source === 'ncmp' ? 'ModPack' : 'local'}
                  {!m.installable && m.note ? ` · ${m.note}` : ''}
                </div>
              </div>
              <Toggle checked={m.enabled} onChange={(v) => toggle(m, v)} label={m.enabled ? 'On' : 'Off'} />
              <Button variant="danger" onClick={() => remove(m)} disabled={busy === m.modName}>
                ✕
              </Button>
            </div>
          ))}
        </div>
      </Panel>

      <p className="text-center text-xs text-nova-muted">
        Load order matters for FFXIII mods: mods <span className="text-nova-text">lower in the list</span> are applied last and
        win file conflicts. Use ▲▼ to reorder — changes re-apply instantly and reversibly. Enabling needs the game unpacked
        (Launch → Unpack game data).
      </p>
    </div>
  );
}

function LayoutChip({ mod }: { mod: LibraryMod }) {
  if (!mod.installable) return <span className="chip bg-nova-warn/15 text-nova-warn">needs manual install</span>;
  const tone = mod.layout === 'unknown' ? 'bg-nova-warn/15 text-nova-warn' : 'bg-nova-border/40 text-nova-muted';
  return <span className={`chip ${tone}`}>{mod.layout}</span>;
}

function NexusBar({ game, auth, onAuth }: { game: GameId; auth: NexusAuth | null; onAuth: (a: NexusAuth) => void }) {
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!key.trim()) return;
    setSaving(true);
    try {
      onAuth(await window.nova.setNexusApiKey(key.trim()));
      setKey('');
    } finally {
      setSaving(false);
    }
  };

  if (auth?.hasKey && auth.userName) {
    return (
      <Panel title="Nexus Mods">
        <div className="flex items-center justify-between">
          <div className="text-sm">
            Connected as <span className="font-medium text-nova-text">{auth.userName}</span>{' '}
            <span className={`chip ml-1 ${auth.premium ? 'bg-nova-good/15 text-nova-good' : 'bg-nova-border/40 text-nova-muted'}`}>
              {auth.premium ? 'Premium' : 'Free'}
            </span>
          </div>
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => window.nova.openNexusModsPage(game)}>
              Browse {game} mods ↗
            </Button>
            <Button onClick={async () => onAuth(await window.nova.clearNexusApiKey())}>Sign out</Button>
          </div>
        </div>
        <p className="mt-3 text-xs text-nova-muted">
          On a mod page, click <span className="text-nova-text">“Download: Mod Manager”</span> — open-nova catches it, downloads,
          and adds it below to enable. {auth.premium ? '' : '(Free accounts must use the Mod Manager button; direct in-app download needs Premium.)'}
        </p>
      </Panel>
    );
  }

  return (
    <Panel title="Connect Nexus Mods">
      <p className="mb-3 text-xs text-nova-muted">
        Paste your personal API key from{' '}
        <button className="text-nova-accent underline" onClick={() => window.nova.openNexusModsPage(game)}>
          nexusmods.com → My account → API
        </button>
        . Stored encrypted on this device.
      </p>
      <div className="flex gap-2">
        <input
          className="field font-mono"
          type="password"
          placeholder="Nexus personal API key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        <Button variant="primary" onClick={save} disabled={saving || !key.trim()}>
          {saving ? 'Validating…' : 'Connect'}
        </Button>
      </div>
    </Panel>
  );
}
