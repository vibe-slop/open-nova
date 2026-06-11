import { useEffect, useState } from 'react';
import type { AppConfig, GameId, GameStatus, LogEvent, SteamInfo } from '../../shared/ipc';
import { GameScreen } from './tabs/GameScreen';
import { GeneratorTab } from './tabs/GeneratorTab';
import { ToolsTab } from './tabs/ToolsTab';
import { AboutTab } from './tabs/AboutTab';

const GAMES: { id: GameId; short: string; name: string }[] = [
  { id: 'XIII', short: 'XIII', name: 'FINAL FANTASY XIII' },
  { id: 'XIII-2', short: 'XIII-2', name: 'FINAL FANTASY XIII-2' },
  { id: 'XIII-LR', short: 'LR', name: 'LIGHTNING RETURNS' },
];

type View = 'game' | 'advanced' | 'about';

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [steam, setSteam] = useState<SteamInfo | null>(null);
  const [log, setLog] = useState<LogEvent[]>([]);
  const [view, setView] = useState<View>('game');

  useEffect(() => {
    window.nova.getConfig().then(setConfig);
    window.nova.detectSteam().then(setSteam);
    const off = window.nova.onLog((e) => setLog((l) => [...l.slice(-99), e]));
    return off;
  }, []);

  const update = async (patch: Partial<AppConfig>) => setConfig(await window.nova.setConfig(patch));
  const refreshSteam = async () => setSteam(await window.nova.detectSteam());

  if (!config) return <div className="grid h-full place-items-center text-nova-muted">Loading…</div>;

  const selectGame = (id: GameId) => {
    update({ selectedGame: id });
    setView('game');
  };
  const statusFor = (id: GameId): GameStatus | undefined => steam?.games.find((g) => g.id === id);
  const active = GAMES.find((g) => g.id === config.selectedGame) ?? GAMES[1];

  return (
    <div className="flex h-full">
      {/* Sidebar — one item per game */}
      <aside className="flex w-56 flex-col border-r border-nova-border bg-nova-bg/40 p-3">
        <div className="mb-6 px-2 pt-2">
          <div className="text-lg font-bold tracking-tight">
            open<span className="text-nova-accent">·</span>nova
          </div>
          <div className="text-[11px] text-nova-muted">FFXIII trilogy mod manager</div>
        </div>

        <nav className="flex flex-col gap-1">
          {GAMES.map((g) => {
            const s = statusFor(g.id);
            const selected = view === 'game' && config.selectedGame === g.id;
            return (
              <button
                key={g.id}
                onClick={() => selectGame(g.id)}
                className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition ${
                  selected ? 'bg-nova-panel2 text-nova-text' : 'text-nova-muted hover:bg-nova-panel/60 hover:text-nova-text'
                }`}
              >
                <StatusDot status={s} />
                <span className="flex-1 text-left font-medium">{g.short}</span>
              </button>
            );
          })}
        </nav>

        <div className="mt-auto space-y-2 px-1">
          <div className="flex gap-3 px-2 text-[11px]">
            <button
              className={view === 'advanced' ? 'text-nova-accent' : 'text-nova-muted hover:text-nova-text'}
              onClick={() => setView('advanced')}
            >
              Advanced
            </button>
            <button
              className={view === 'about' ? 'text-nova-accent' : 'text-nova-muted hover:text-nova-text'}
              onClick={() => setView('about')}
            >
              About
            </button>
          </div>
          <div className="px-2 text-[11px] text-nova-muted">v0.1.0 · GPL-3.0</div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <main className="flex-1 overflow-y-auto p-6">
          {view === 'game' && (
            <GameScreen
              key={config.selectedGame}
              game={config.selectedGame}
              gameName={active.name}
              status={statusFor(config.selectedGame)}
              config={config}
              update={update}
              onRefresh={refreshSteam}
            />
          )}
          {view === 'advanced' && (
            <div className="mx-auto max-w-3xl space-y-6">
              <div>
                <h1 className="mb-1 text-lg font-semibold">Advanced tools</h1>
                <p className="text-xs text-nova-muted">
                  Low-level archive tools and the ModPack generator. Most users never need these.
                </p>
              </div>
              <ToolsTab game={config.selectedGame} />
              <GeneratorTab game={config.selectedGame} />
            </div>
          )}
          {view === 'about' && (
            <div className="mx-auto max-w-3xl">
              <AboutTab />
            </div>
          )}
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

/** Per-game status indicator: green = ready, cyan = installed (needs setup), grey = not found. */
function StatusDot({ status }: { status: GameStatus | undefined }) {
  const tone = !status?.installed ? 'bg-nova-border' : status.unpacked ? 'bg-nova-good' : 'bg-nova-accent';
  const title = !status?.installed ? 'Not installed' : status.unpacked ? 'Ready' : 'Installed — needs one-time setup';
  return <span className={`h-2 w-2 rounded-full ${tone}`} title={title} />;
}
