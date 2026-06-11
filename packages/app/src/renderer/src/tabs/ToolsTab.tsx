import { useState } from 'react';
import type { GameId } from '../../../shared/ipc';
import { Panel, Button } from '../ui';

export function ToolsTab({ game }: { game: GameId }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>('');

  const pickFile = (filters?: { name: string; extensions: string[] }[]) => window.nova.browseForFile('Select file', filters);

  const decrypt = async () => {
    const f = await pickFile([{ name: 'Filelist', extensions: ['bin'] }]);
    if (!f) return;
    setBusy(true);
    try {
      const r = await window.nova.decryptFilelist(f, f + '.dec');
      setResult(r.ok ? `Decrypted → ${f}.dec (checksum ${r.checksumOk ? 'OK' : 'MISMATCH'})` : 'Failed.');
    } finally {
      setBusy(false);
    }
  };

  const unpack = async () => {
    const filelist = await pickFile([{ name: 'Filelist', extensions: ['bin'] }]);
    if (!filelist) return;
    const img = await pickFile([{ name: 'White image', extensions: ['bin'] }]);
    if (!img) return;
    const out = await window.nova.browseForFolder('Output folder');
    if (!out) return;
    setBusy(true);
    try {
      const r = await window.nova.unpackArchive(filelist, img, out, game);
      setResult(r.ok ? `Unpacked ${r.fileCount} files → ${out}` : 'Failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Panel title="Archive tools">
        <div className="grid grid-cols-2 gap-3">
          <ToolButton title="Decrypt filelist" desc="Decrypt a filelist*.win32.bin index." onClick={decrypt} disabled={busy} />
          <ToolButton title="Unpack archive" desc="Extract a filelist + white_img pair to a folder." onClick={unpack} disabled={busy} />
          <ToolButton title="Repack archive" desc="Rebuild a filelist + white_img from a folder. (Coming soon)" onClick={() => {}} disabled />
          <ToolButton title="WPD unpack/repack" desc="Edit files inside a packed container. (Coming soon)" onClick={() => {}} disabled />
        </div>
      </Panel>
      <Panel title="Output">
        <pre className="min-h-[3rem] whitespace-pre-wrap font-mono text-xs text-nova-muted">{result || 'No output yet.'}</pre>
      </Panel>
    </div>
  );
}

function ToolButton({ title, desc, onClick, disabled }: { title: string; desc: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-xl border border-nova-border bg-nova-panel2 p-4 text-left transition hover:border-nova-accent disabled:opacity-40"
    >
      <div className="text-sm font-semibold text-nova-text">{title}</div>
      <div className="mt-1 text-xs text-nova-muted">{desc}</div>
    </button>
  );
}
