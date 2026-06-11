import { useState } from 'react';
import type { GameId, GenerateModSpec } from '../../../shared/ipc';
import { Panel, Button, Field } from '../ui';

export function GeneratorTab({ game }: { game: GameId }) {
  const [spec, setSpec] = useState<GenerateModSpec>({
    name: '',
    author: '',
    version: '1.0',
    game,
    summary: '',
    outputPath: '',
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const set = (patch: Partial<GenerateModSpec>) => setSpec((s) => ({ ...s, ...patch }));

  const pickDir = async (key: keyof GenerateModSpec) => {
    const d = await window.nova.browseForFolder('Select folder');
    if (d) set({ [key]: d } as Partial<GenerateModSpec>);
  };

  const valid = spec.name && spec.author && spec.version && (spec.dataDir || spec.externalDir || spec.codeFile);

  const generate = async () => {
    const out = await window.nova.browseForFile('Save .ncmp as', [{ name: 'Nova ModPack', extensions: ['ncmp'] }]);
    if (!out) return;
    setBusy(true);
    try {
      const r = await window.nova.generateMod({ ...spec, game, outputPath: out });
      setMsg(r.ok ? `Created ${r.outputPath}` : 'Failed to generate.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Panel title={`Create a .ncmp ModPack · ${game}`}>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name *">
            <input className="field" value={spec.name} onChange={(e) => set({ name: e.target.value })} placeholder="My Cool Mod" />
          </Field>
          <Field label="Author *">
            <input className="field" value={spec.author} onChange={(e) => set({ author: e.target.value })} placeholder="you" />
          </Field>
          <Field label="Version *">
            <input className="field" value={spec.version} onChange={(e) => set({ version: e.target.value })} />
          </Field>
          <Field label="Summary">
            <input className="field" value={spec.summary} onChange={(e) => set({ summary: e.target.value })} placeholder="What it does" />
          </Field>
        </div>
      </Panel>

      <Panel title="Contents (at least one required)">
        <div className="space-y-2">
          <PathPick label="Main Data folder" value={spec.dataDir} onPick={() => pickDir('dataDir')} onClear={() => set({ dataDir: undefined })} />
          <PathPick label="EN-Voice Data folder" value={spec.enDataDir} onPick={() => pickDir('enDataDir')} onClear={() => set({ enDataDir: undefined })} />
          <PathPick label="JP-Voice Data folder" value={spec.jpDataDir} onPick={() => pickDir('jpDataDir')} onClear={() => set({ jpDataDir: undefined })} />
          <PathPick label="External installer folder" value={spec.externalDir} onPick={() => pickDir('externalDir')} onClear={() => set({ externalDir: undefined })} />
        </div>
      </Panel>

      <Button variant="primary" className="w-full py-3" disabled={!valid || busy} onClick={generate}>
        ✦ Generate ModPack
      </Button>
      {msg && <p className="text-center text-xs text-nova-muted">{msg}</p>}
    </div>
  );
}

function PathPick({ label, value, onPick, onClear }: { label: string; value?: string; onPick: () => void; onClear: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-48 shrink-0 text-sm text-nova-muted">{label}</span>
      <span className="flex-1 truncate font-mono text-xs text-nova-text" title={value}>
        {value ?? '—'}
      </span>
      <Button onClick={onPick}>Browse…</Button>
      {value && (
        <Button variant="danger" onClick={onClear}>
          ✕
        </Button>
      )}
    </div>
  );
}
