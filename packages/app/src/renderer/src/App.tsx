import { useEffect, useState } from 'react';
import type { AppConfig, GameId, LogEvent } from '../../shared/ipc';
import { LaunchTab } from './tabs/LaunchTab';
import { ModManagerTab } from './tabs/ModManagerTab';
import { GeneratorTab } from './tabs/GeneratorTab';
import { ToolsTab } from './tabs/ToolsTab';
import { AboutTab } from './tabs/AboutTab';

const TABS = [
  { id: 'launch', label: 'Launch', icon: '◈' },
  { id: 'mods', label: 'Mod Manager', icon: '▤' },
  { id: 'generator', label: 'Mod Generator', icon: '✦' },
  { id: 'tools', label: 'Tools', icon: '⚙' },
  { id: 'about', label: 'About', icon: '☉' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const GAMES: { id: GameId; short: string }[] = [
  { id: 'XIII', short: 'XIII' },
  { id: 'XIII-2', short: 'XIII-2' },
  { id: 'XIII-LR', short: 'LR' },
];

export default function App() {
  const [tab, setTab] = useState<TabId>('launch');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [log, setLog] = useState<LogEvent[]>([]);

  useEffect(() => {
    window.nova.getConfig().then(setConfig);
    const off = window.nova.onLog((e) => setLog((l) => [...l.slice(-99), e]));
    return off;
  }, []);

  const update = async (patch: Partial<AppConfig>) => setConfig(await window.nova.setConfig(patch));

  if (!config) return <div className="grid h-full place-items-center text-nova-muted">Loading…</div>;

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="flex w-56 flex-col border-r border-nova-border bg-nova-bg/40 p-3">
        <div className="mb-6 px-2 pt-2">
          <div className="text-lg font-bold tracking-tight">
            open<span className="text-nova-accent">·</span>nova
          </div>
          <div className="text-[11px] text-nova-muted">FFXIII trilogy mod manager</div>
        </div>

        <div className="mb-4 px-1">
          <div className="mb-1.5 text-[11px] font-medium text-nova-muted">Active game</div>
          <div className="flex gap-1 rounded-lg bg-nova-bg/60 p-1">
            {GAMES.map((g) => (
              <button
                key={g.id}
                onClick={() => update({ selectedGame: g.id })}
                className={`flex-1 rounded-md py-1.5 text-xs font-semibold transition ${
                  config.selectedGame === g.id ? 'bg-nova-accent/20 text-nova-accent' : 'text-nova-muted hover:text-nova-text'
                }`}
              >
                {g.short}
              </button>
            ))}
          </div>
        </div>

        <nav className="flex flex-col gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                tab === t.id ? 'bg-nova-panel2 text-nova-text' : 'text-nova-muted hover:bg-nova-panel/60 hover:text-nova-text'
              }`}
            >
              <span className="text-nova-accent">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </nav>

        <div className="mt-auto px-2 text-[11px] text-nova-muted">v0.1.0 · GPL-3.0</div>
      </aside>

      {/* Main */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <main className="flex-1 overflow-y-auto p-6">
          {tab === 'launch' && <LaunchTab config={config} update={update} />}
          {tab === 'mods' && <ModManagerTab game={config.selectedGame} />}
          {tab === 'generator' && <GeneratorTab game={config.selectedGame} />}
          {tab === 'tools' && <ToolsTab game={config.selectedGame} />}
          {tab === 'about' && <AboutTab />}
        </main>

        {/* Log/console bar */}
        <footer className="h-28 shrink-0 border-t border-nova-border bg-nova-bg/60">
          <div className="flex items-center justify-between px-4 py-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-nova-muted">Console</span>
            <button className="text-[11px] text-nova-muted hover:text-nova-text" onClick={() => setLog([])}>
              Clear
            </button>
          </div>
          <div className="h-[72px] overflow-y-auto px-4 pb-2 font-mono text-xs leading-5">
            {log.length === 0 && <div className="text-nova-muted/60">Ready.</div>}
            {log.map((e, i) => (
              <div
                key={i}
                className={
                  e.level === 'error' ? 'text-nova-bad' : e.level === 'warn' ? 'text-nova-warn' : 'text-nova-muted'
                }
              >
                {e.message}
              </div>
            ))}
          </div>
        </footer>
      </div>
    </div>
  );
}
