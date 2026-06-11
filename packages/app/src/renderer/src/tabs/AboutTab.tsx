import { Panel } from '../ui';

export function AboutTab() {
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Panel>
        <div className="space-y-2">
          <div className="text-2xl font-bold tracking-tight">
            open<span className="text-nova-accent">·</span>nova
          </div>
          <p className="text-sm text-nova-muted">
            A cross-platform, open-source mod manager and archive toolkit for the FINAL FANTASY XIII trilogy —
            built to run natively on Linux and the Steam Deck, where the original Windows-only tools can&apos;t go.
          </p>
        </div>
      </Panel>

      <Panel title="How it works">
        <ul className="space-y-2 text-sm text-nova-muted">
          <li>• The game&apos;s encrypted <code className="text-nova-accent">filelist</code> archives are decrypted and unpacked by a pure-TypeScript engine (no Wine, no .NET).</li>
          <li>• Mods are overlaid onto the unpacked game tree, with originals backed up so any change is reversible.</li>
          <li>• The game launches through Steam/Proton.</li>
        </ul>
      </Panel>

      <Panel title="Credits & license">
        <p className="text-sm text-nova-muted">
          GPL-3.0-or-later. An interoperability reimplementation; ships none of the original tool&apos;s code or assets.
          Format research credits to the FF13 modding community (LR Research Team, Surihix, and the author of Nova Chrysalia).
          You must own the games.
        </p>
      </Panel>
    </div>
  );
}
