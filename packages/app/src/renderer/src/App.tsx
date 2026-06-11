import { useEffect, useState } from 'react';
import type { AppConfig, GameId, GameStatus, SteamInfo } from '../../shared/ipc';
import { GameScreen } from './tabs/GameScreen';

const GAMES: { id: GameId; short: string; name: string }[] = [
  { id: 'XIII', short: 'XIII', name: 'FINAL FANTASY XIII' },
  { id: 'XIII-2', short: 'XIII-2', name: 'FINAL FANTASY XIII-2' },
  { id: 'XIII-LR', short: 'LR', name: 'LIGHTNING RETURNS' },
];

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [steam, setSteam] = useState<SteamInfo | null>(null);

  useEffect(() => {
    window.nova.getConfig().then(setConfig);
    window.nova.detectSteam().then(setSteam);
  }, []);

  const update = async (patch: Partial<AppConfig>) => setConfig(await window.nova.setConfig(patch));
  const refreshSteam = async () => setSteam(await window.nova.detectSteam());

  if (!config) return <div className="grid h-full place-items-center text-nova-muted">Loading…</div>;

  const selectGame = (id: GameId) => update({ selectedGame: id });
  const statusFor = (id: GameId): GameStatus | undefined => steam?.games.find((g) => g.id === id);
  const active = GAMES.find((g) => g.id === config.selectedGame) ?? GAMES[0];

  return (
    <div className="flex h-full">
      {/* Sidebar — one item per game */}
      <aside className="flex w-56 flex-col border-r border-nova-border bg-nova-panel2 p-3">
        <div className="mb-6 px-2 pt-2">
          <div className="font-display text-lg font-bold tracking-tight">
            open<span className="text-nova-accent">·</span>nova
          </div>
          <div className="text-[11px] text-nova-muted">FFXIII trilogy mod manager</div>
        </div>

        <nav className="flex flex-col gap-1">
          {GAMES.map((g) => {
            const s = statusFor(g.id);
            const selected = config.selectedGame === g.id;
            return (
              <button
                key={g.id}
                onClick={() => selectGame(g.id)}
                className={`group relative flex items-center gap-2.5 rounded-md py-2.5 pl-4 pr-3 text-sm transition ${
                  selected
                    ? 'bg-gradient-to-r from-nova-accent/15 to-transparent text-nova-text'
                    : 'text-nova-muted hover:bg-nova-panel/50 hover:text-nova-text'
                }`}
              >
                <span
                  className={`absolute left-0 top-1/2 -translate-y-1/2 rounded-r-sm bg-nova-accent transition-all ${
                    selected ? 'h-5 w-[3px]' : 'h-0 w-0'
                  }`}
                />
                <StatusDot status={s} />
                <span className="flex-1 text-left font-medium tracking-[0.12em]">{g.short}</span>
                <span
                  className={`text-nova-accent transition ${selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-30'}`}
                >
                  ›
                </span>
              </button>
            );
          })}
        </nav>

        <div className="mt-auto px-3 text-[11px] text-nova-muted">v0.1.0</div>
      </aside>

      {/* Main */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <main className="flex-1 overflow-y-auto p-6">
          <GameScreen
            key={config.selectedGame}
            game={config.selectedGame}
            gameName={active.name}
            status={statusFor(config.selectedGame)}
            config={config}
            update={update}
            onRefresh={refreshSteam}
          />
        </main>
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
