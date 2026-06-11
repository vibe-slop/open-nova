import { useEffect, useState, type DragEvent } from 'react';
import type { GameId, LibraryMod } from '../../../shared/ipc';
import { Panel, Button, Toggle } from '../ui';

export function ModManagerTab({ game }: { game: GameId }) {
  const [mods, setMods] = useState<LibraryMod[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string>('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const refresh = () => window.nova.libraryList(game).then(setMods);
  useEffect(() => {
    refresh();
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

  // --- Drag-to-reorder. The list is shown low→high priority; a mod lower in the
  // list is applied later and wins file conflicts. Locked fixes (FF13 Fix) are
  // pinned first and never reorder. We mutate the array live for feedback, then
  // persist the new non-locked order on drop.
  const onDragStart = (i: number) => {
    if (mods[i].locked || busy) return;
    setDragIndex(i);
  };
  const onDragOver = (i: number, e: DragEvent) => {
    e.preventDefault();
    if (dragIndex === null || dragIndex === i || mods[i].locked) return;
    const next = [...mods];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(i, 0, moved);
    setMods(next);
    setDragIndex(i);
  };
  const onDrop = async () => {
    if (dragIndex === null) return;
    setDragIndex(null);
    const order = mods.filter((m) => !m.locked).map((m) => m.modName);
    setBusy('reorder');
    try {
      setMods(await window.nova.librarySetOrder(game, order));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <Panel
        title={`Mods · ${game}`}
        right={
          <button
            className="btn-hud px-4 py-2 font-display text-xs tracking-wide"
            onClick={importFile}
            disabled={busy === 'import'}
          >
            {busy === 'import' ? 'Importing…' : '+ Import file'}
          </button>
        }
      >
        {notice && <div className="mb-3 rounded-lg bg-nova-accent/10 px-3 py-2 text-xs text-nova-accent">{notice}</div>}
        <div className="space-y-2">
          {mods.length === 0 && (
            <div className="py-8 text-center text-sm text-nova-muted">
              No mods yet. Download a mod and use “+ Import file” to add the .zip / .ncmp / .7z / .rar.
            </div>
          )}
          {mods.map((m, i) => (
            <div
              key={m.modName}
              draggable={!m.locked && !busy}
              onDragStart={() => onDragStart(i)}
              onDragOver={(e) => onDragOver(i, e)}
              onDrop={onDrop}
              onDragEnd={() => setDragIndex(null)}
              className={`flex items-center gap-3 rounded-lg border border-nova-border bg-nova-panel2 px-3 py-2.5 transition-shadow ${
                dragIndex === i ? 'opacity-60 ring-1 ring-nova-accent/40' : ''
              } ${!m.locked && !busy ? 'cursor-grab active:cursor-grabbing' : ''}`}
            >
              <span
                className={`select-none text-base leading-none ${
                  m.locked ? 'cursor-not-allowed text-nova-muted/40' : 'text-nova-muted'
                }`}
                title={m.locked ? 'Required — pinned first, can’t be reordered' : 'Drag to reorder'}
              >
                ⠿
              </span>
              <span className="w-5 text-center text-xs text-nova-muted">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-nova-text">{m.name}</span>
                  <LayoutChip mod={m} />
                </div>
                <div className="truncate text-xs text-nova-muted">
                  {m.author && `${m.author} · `}
                  {m.version && `v${m.version} · `}
                  {m.source === 'ncmp' ? 'ModPack' : m.source === 'builtin' ? 'built-in' : 'local'}
                  {!m.installable && m.note ? ` · ${m.note}` : ''}
                </div>
              </div>
              <Toggle checked={m.enabled} onChange={(v) => toggle(m, v)} label={m.enabled ? 'On' : 'Off'} />
              <Button
                variant="danger"
                onClick={() => remove(m)}
                disabled={m.locked || busy === m.modName}
                title={m.locked ? 'Required — can’t be removed' : undefined}
              >
                ✕
              </Button>
            </div>
          ))}
        </div>
      </Panel>

      <p className="text-center text-xs text-nova-muted">
        Load order matters for FFXIII mods: mods <span className="text-nova-text">lower in the list</span> are applied last and
        win file conflicts. Drag a mod to reorder — changes apply instantly and reversibly.
      </p>
    </div>
  );
}

function LayoutChip({ mod }: { mod: LibraryMod }) {
  if (!mod.installable) return <span className="chip bg-nova-warn/15 text-nova-warn">needs manual install</span>;
  const tone = mod.layout === 'unknown' ? 'bg-nova-warn/15 text-nova-warn' : 'bg-nova-border/40 text-nova-muted';
  return <span className={`chip ${tone}`}>{mod.layout}</span>;
}
