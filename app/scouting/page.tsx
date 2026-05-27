'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Sparkles, User, Users, X } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { Skeleton } from '@/components/Skeleton';
import {
  Legend,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
} from 'recharts';

type Player = {
  player_id: number;
  player: string | null;
  team: string | null;
  position: string | null;
  position_group: string | null;
  minutes: number;
  goals_per90: number;
  xg_per90: number;
  assists_per90: number;
  xa_per90: number;
  shots_per90: number;
  progressive_passes_per90: number;
  carries_per90: number;
  pressures_per90: number;
  tackles_per90: number;
  interceptions_per90: number;
};

type MetricKey =
  | 'goals_per90'
  | 'xg_per90'
  | 'assists_per90'
  | 'xa_per90'
  | 'progressive_passes_per90'
  | 'pressures_per90'
  | 'tackles_per90'
  | 'interceptions_per90';

type Mode = 'single' | 'compare';

// Player accent colors on the radar (dark-green panel background).
// White vs sky blue: maximum contrast against each other AND the bg.
const PLAYER_A_COLOR = '#FFFFFF';
const PLAYER_B_COLOR = '#38BDF8'; // tailwind sky-400

// Cap on dropdown results to keep the popover renderable.
const SEARCH_RESULT_CAP = 200;

const STAT_ROWS: Array<{ label: string; key: MetricKey }> = [
  { label: 'Goals per 90', key: 'goals_per90' },
  { label: 'xG per 90', key: 'xg_per90' },
  { label: 'Assists per 90', key: 'assists_per90' },
  { label: 'xA per 90', key: 'xa_per90' },
  { label: 'Progressive passes per 90', key: 'progressive_passes_per90' },
  { label: 'Pressures per 90', key: 'pressures_per90' },
  { label: 'Tackles per 90', key: 'tackles_per90' },
  { label: 'Interceptions per 90', key: 'interceptions_per90' },
];

const RADAR_METRICS: Array<{ label: string; key: MetricKey }> = [
  { label: 'Goals', key: 'goals_per90' },
  { label: 'xG', key: 'xg_per90' },
  { label: 'Assists', key: 'assists_per90' },
  { label: 'xA', key: 'xa_per90' },
  { label: 'Prog. Pass', key: 'progressive_passes_per90' },
  { label: 'Pressures', key: 'pressures_per90' },
  { label: 'Tackles', key: 'tackles_per90' },
  { label: 'Interceptions', key: 'interceptions_per90' },
];

const PERCENTILE_METRICS: Array<{ label: string; key: MetricKey }> = [
  { label: 'Goals', key: 'goals_per90' },
  { label: 'xG', key: 'xg_per90' },
  { label: 'Assists', key: 'assists_per90' },
  { label: 'xA', key: 'xa_per90' },
  { label: 'Progressive passes', key: 'progressive_passes_per90' },
  { label: 'Pressures', key: 'pressures_per90' },
  { label: 'Tackles', key: 'tackles_per90' },
  { label: 'Interceptions', key: 'interceptions_per90' },
];

const COHORT_MIN_MINUTES = 450; // five full matches

type RadarDatum = { metric: string; value: number; raw: number };
type CompareRadarDatum = {
  metric: string;
  valueA: number;
  valueB: number;
  rawA: number;
  rawB: number;
};
type PercentileDatum = { label: string; percentile: number; raw: number };

function cohortFor(player: Player, players: Player[]): Player[] {
  return (
    player.position_group
      ? players.filter((p) => p.position_group === player.position_group)
      : players
  ).filter((p) => p.minutes >= COHORT_MIN_MINUTES);
}

function buildRadarData(player: Player, players: Player[]): RadarDatum[] {
  const cohort = cohortFor(player, players);
  return RADAR_METRICS.map(({ label, key }) => {
    const vals = cohort.map((p) => p[key]);
    const lo = vals.length ? Math.min(...vals) : 0;
    const hi = vals.length ? Math.max(...vals) : 1;
    const span = hi - lo;
    const pct = span === 0 ? 50 : ((player[key] - lo) / span) * 100;
    return {
      metric: label,
      value: Math.max(0, Math.min(100, Math.round(pct))),
      raw: player[key],
    };
  });
}

function buildCompareRadarData(
  playerA: Player,
  playerB: Player,
  players: Player[],
): CompareRadarDatum[] {
  const a = buildRadarData(playerA, players);
  const b = buildRadarData(playerB, players);
  return a.map((da, i) => ({
    metric: da.metric,
    valueA: da.value,
    valueB: b[i].value,
    rawA: da.raw,
    rawB: b[i].raw,
  }));
}

function buildPercentileData(
  player: Player,
  players: Player[],
): PercentileDatum[] {
  const cohort = cohortFor(player, players);
  return PERCENTILE_METRICS.map(({ label, key }) => {
    const peers = cohort
      .filter((p) => p.player_id !== player.player_id)
      .map((p) => p[key]);
    const value = player[key];
    const below = peers.filter((v) => v < value).length;
    const percentile =
      peers.length > 0 ? Math.round((below / peers.length) * 100) : 50;
    return { label, percentile, raw: value };
  });
}

function percentileTone(p: number): { bg: string; text: string } {
  if (p <= 33) return { bg: 'bg-red-600', text: 'text-red-600' };
  if (p <= 66) return { bg: 'bg-amber-500', text: 'text-amber-500' };
  return { bg: 'bg-green-600', text: 'text-green-600' };
}

export default function ScoutingPage() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Sidebar filters (used only in single mode).
  const [search, setSearch] = useState('');
  const [teamFilter, setTeamFilter] = useState('');
  const [positionFilter, setPositionFilter] = useState('');

  const [mode, setMode] = useState<Mode>('single');
  const [playerAId, setPlayerAId] = useState<number | null>(null);
  const [playerBId, setPlayerBId] = useState<number | null>(null);

  const { setSelection, openAssistant } = useApp();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/players');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: Player[] = await res.json();
        if (!cancelled) {
          setPlayers(data);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load players');
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const teams = useMemo(
    () =>
      Array.from(
        new Set(players.map((p) => p.team).filter((t): t is string => !!t)),
      ).sort(),
    [players],
  );

  const positions = useMemo(
    () =>
      Array.from(
        new Set(
          players.map((p) => p.position_group).filter((p): p is string => !!p),
        ),
      ).sort(),
    [players],
  );

  // Sidebar-filtered list (single mode only).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return players.filter((p) => {
      if (teamFilter && p.team !== teamFilter) return false;
      if (positionFilter && p.position_group !== positionFilter) return false;
      if (q && !(p.player ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [players, search, teamFilter, positionFilter]);

  const playerA = useMemo(
    () => players.find((p) => p.player_id === playerAId) ?? null,
    [players, playerAId],
  );

  // Expose the current selection to the nav (for the breadcrumb) and
  // to the global Ask-AI button. Clear on unmount so navigating away
  // removes the breadcrumb.
  useEffect(() => {
    if (playerA) {
      setSelection({
        label: playerA.player ?? 'Unknown player',
        sub: `${playerA.team ?? '—'}${playerA.position ? ` · ${playerA.position}` : ''}`,
        context: playerA,
      });
    } else {
      setSelection(null);
    }
    return () => setSelection(null);
  }, [playerA, setSelection]);
  const playerB = useMemo(
    () => players.find((p) => p.player_id === playerBId) ?? null,
    [players, playerBId],
  );

  const radarDataA = useMemo(
    () => (playerA ? buildRadarData(playerA, players) : []),
    [playerA, players],
  );
  const compareRadarData = useMemo(
    () =>
      playerA && playerB
        ? buildCompareRadarData(playerA, playerB, players)
        : [],
    [playerA, playerB, players],
  );

  const percentileDataA = useMemo(
    () => (playerA ? buildPercentileData(playerA, players) : []),
    [playerA, players],
  );
  const percentileDataB = useMemo(
    () => (playerB ? buildPercentileData(playerB, players) : []),
    [playerB, players],
  );

  return (
    <div className="flex h-full bg-white text-[#1A3C2E]">
      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside className="flex w-80 flex-col bg-[#1A3C2E] text-white">
        <header className="border-b border-white/10 px-5 py-4">
          <ModeToggle mode={mode} onChange={setMode} />
        </header>

        {/* Shared filters are visible only in single mode.
            Compare mode uses per-player filters in the main pane. */}
        {mode === 'single' && (
          <div className="space-y-3 border-b border-white/10 px-5 py-4">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/50" />
              <input
                type="text"
                placeholder="Search players..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-md border border-white/10 bg-white/5 py-2 pl-9 pr-3 text-sm placeholder-white/40 outline-none transition-colors focus:border-white/40"
              />
            </div>

            <select
              value={teamFilter}
              onChange={(e) => setTeamFilter(e.target.value)}
              className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none transition-colors focus:border-white/40"
            >
              <option value="" className="bg-[#1A3C2E]">
                All teams
              </option>
              {teams.map((t) => (
                <option key={t} value={t} className="bg-[#1A3C2E]">
                  {t}
                </option>
              ))}
            </select>

            <select
              value={positionFilter}
              onChange={(e) => setPositionFilter(e.target.value)}
              className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none transition-colors focus:border-white/40"
            >
              <option value="" className="bg-[#1A3C2E]">
                All positions
              </option>
              {positions.map((p) => (
                <option key={p} value={p} className="bg-[#1A3C2E]">
                  {p}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {loading && (
            <ul aria-hidden className="space-y-1 px-5 py-3">
              {Array.from({ length: 10 }).map((_, i) => (
                <li key={i} className="py-2">
                  <Skeleton className="h-4 w-2/3" dark />
                  <Skeleton className="mt-2 h-3 w-1/2" dark />
                </li>
              ))}
            </ul>
          )}
          {error && (
            <div className="px-5 py-4 text-sm text-red-300">Error: {error}</div>
          )}
          {!loading && !error && mode === 'compare' && (
            <div className="px-5 py-6 text-sm text-white/60">
              <Users className="mb-3 h-5 w-5 text-white/40" />
              Each player has its own search and filters in the main pane.
              <span className="mt-2 block text-xs text-white/40">
                Switch back to{' '}
                <button
                  type="button"
                  onClick={() => setMode('single')}
                  className="underline underline-offset-2 hover:text-white"
                >
                  Single
                </button>{' '}
                mode to browse from this sidebar.
              </span>
            </div>
          )}
          {!loading && !error && mode === 'single' && filtered.length === 0 && (
            <div className="px-5 py-4 text-sm text-white/60">
              No players match these filters.
            </div>
          )}
          {!loading && !error && mode === 'single' && filtered.length > 0 && (
            <ul>
              {filtered.map((p) => {
                const isSelected = p.player_id === playerAId;
                return (
                  <li key={p.player_id}>
                    <button
                      type="button"
                      onClick={() => setPlayerAId(p.player_id)}
                      className={`flex w-full flex-col items-start gap-0.5 border-l-2 px-5 py-3 text-left text-sm transition-colors ${
                        isSelected
                          ? 'border-white bg-white/10'
                          : 'border-transparent hover:bg-white/5'
                      }`}
                    >
                      <span className="font-medium leading-tight">
                        {p.player ?? 'Unknown'}
                      </span>
                      <span className="text-xs text-white/60">
                        {p.team ?? '—'}
                        {p.position_group ? ` · ${p.position_group}` : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="border-t border-white/10 px-5 py-3 text-xs text-white/40">
          {loading
            ? '…'
            : mode === 'compare'
            ? `${players.length} players available`
            : `${filtered.length} of ${players.length} players`}
        </footer>
      </aside>

      {/* ── Main content ────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto">
        <div
          className={`mx-auto px-10 py-12 ${
            mode === 'compare' ? 'max-w-5xl' : 'max-w-2xl'
          }`}
        >
          {mode === 'single' ? (
            playerA ? (
              <PlayerCard
                player={playerA}
                radarData={radarDataA}
                percentileData={percentileDataA}
                onScout={() => {
                  openAssistant({
                    mode: 'scouting_report',
                    eyebrow: 'Scouting Report',
                    title: playerA.player ?? 'Unknown player',
                    subtitle: `${playerA.team ?? '—'}${playerA.position ? ` · ${playerA.position}` : ''}`,
                    context: playerA,
                  });
                }}
              />
            ) : (
              <EmptyState />
            )
          ) : (
            <CompareView
              playerA={playerA}
              playerB={playerB}
              playerAId={playerAId}
              playerBId={playerBId}
              onSelectA={setPlayerAId}
              onSelectB={setPlayerBId}
              players={players}
              teams={teams}
              positions={positions}
              compareRadarData={compareRadarData}
              percentileDataA={percentileDataA}
              percentileDataB={percentileDataB}
            />
          )}
        </div>
      </main>
    </div>
  );
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-white/10 bg-white/5 p-0.5">
      {(['single', 'compare'] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={`rounded px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
            mode === m
              ? 'bg-white text-[#1A3C2E]'
              : 'text-white/70 hover:text-white'
          }`}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

function PlayerCard({
  player,
  radarData,
  percentileData,
  onScout,
}: {
  player: Player;
  radarData: RadarDatum[];
  percentileData: PercentileDatum[];
  onScout: () => void;
}) {
  return (
    <article className="rounded-lg border border-[#1A3C2E]/10 bg-white p-8 shadow-sm">
      <header className="flex items-start gap-4 border-b border-[#1A3C2E]/10 pb-6">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[#1A3C2E] text-white">
          <User className="h-7 w-7" />
        </div>
        <div className="min-w-0">
          <h2 className="text-2xl font-semibold leading-tight text-[#1A3C2E]">
            {player.player ?? 'Unknown player'}
          </h2>
          <p className="mt-1 text-sm text-[#1A3C2E]/70">
            {player.team ?? '—'}
            {player.position ? ` · ${player.position}` : ''}
            {player.position_group && player.position_group !== player.position
              ? ` (${player.position_group})`
              : ''}
          </p>
          <p className="mt-1 text-xs text-[#1A3C2E]/50">
            {Math.round(player.minutes).toLocaleString()} minutes played
          </p>
        </div>
      </header>

      <PlayerRadar
        data={radarData}
        cohortLabel={player.position_group ?? 'all players'}
      />

      <section className="mb-6">
        <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-[#1A3C2E]/60">
          Percentile rank
        </h3>
        <PercentileBars data={percentileData} />
      </section>

      <dl className="divide-y divide-[#1A3C2E]/5">
        {STAT_ROWS.map(({ label, key }) => (
          <div
            key={key}
            className="flex items-baseline justify-between gap-4 py-3"
          >
            <dt className="text-sm text-[#1A3C2E]/70">{label}</dt>
            <dd className="font-mono text-lg font-semibold tabular-nums text-[#1A3C2E]">
              {player[key].toFixed(2)}
            </dd>
          </div>
        ))}
      </dl>

      <button
        type="button"
        onClick={onScout}
        className="mt-8 flex w-full items-center justify-center gap-2 rounded-md bg-[#1A3C2E] py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#1A3C2E]/90 focus:outline-none focus:ring-2 focus:ring-[#1A3C2E]/30"
      >
        <Sparkles className="h-4 w-4" />
        Scout This Player
      </button>
    </article>
  );
}

function PlayerRadar({
  data,
  cohortLabel,
}: {
  data: RadarDatum[];
  cohortLabel: string;
}) {
  return (
    <section className="my-6 rounded-lg bg-[#1A3C2E] p-6 text-white">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wider text-white/70">
          Profile vs {cohortLabel}
        </h3>
        <span className="text-xs text-white/40">0–100 normalized</span>
      </div>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={data} outerRadius="70%">
            <PolarGrid stroke="rgba(255,255,255,0.18)" />
            <PolarAngleAxis
              dataKey="metric"
              tick={{ fill: '#FFFFFF', fontSize: 11 }}
              stroke="rgba(255,255,255,0.4)"
            />
            <PolarRadiusAxis
              domain={[0, 100]}
              tick={false}
              axisLine={false}
              stroke="transparent"
            />
            <Radar
              name="player"
              dataKey="value"
              stroke="#FFFFFF"
              strokeWidth={2}
              fill="#FFFFFF"
              fillOpacity={0.25}
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function PercentileBars({ data }: { data: PercentileDatum[] }) {
  return (
    <ul className="space-y-2">
      {data.map(({ label, percentile }) => {
        const tone = percentileTone(percentile);
        return (
          <li key={label} className="flex items-center gap-3">
            <span className="w-36 shrink-0 text-sm text-[#1A3C2E]/80">
              {label}
            </span>
            <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-[#1A3C2E]/5">
              <div
                className={`h-full rounded-full transition-[width] duration-300 ${tone.bg}`}
                style={{ width: `${percentile}%` }}
              />
            </div>
            <span
              className={`w-8 shrink-0 text-right font-mono text-sm font-semibold tabular-nums ${tone.text}`}
            >
              {percentile}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function CompareView({
  playerA,
  playerB,
  playerAId,
  playerBId,
  onSelectA,
  onSelectB,
  players,
  teams,
  positions,
  compareRadarData,
  percentileDataA,
  percentileDataB,
}: {
  playerA: Player | null;
  playerB: Player | null;
  playerAId: number | null;
  playerBId: number | null;
  onSelectA: (id: number | null) => void;
  onSelectB: (id: number | null) => void;
  players: Player[];
  teams: string[];
  positions: string[];
  compareRadarData: CompareRadarDatum[];
  percentileDataA: PercentileDatum[];
  percentileDataB: PercentileDatum[];
}) {
  const bothSelected = playerA !== null && playerB !== null;
  const samePlayer =
    bothSelected && playerA!.player_id === playerB!.player_id;
  const { openAssistant } = useApp();

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-6">
        <PlayerSearchInput
          label="Player A"
          dotColor={PLAYER_A_COLOR}
          dotBorder
          value={playerAId}
          onSelect={onSelectA}
          players={players}
          teams={teams}
          positions={positions}
        />
        <PlayerSearchInput
          label="Player B"
          dotColor={PLAYER_B_COLOR}
          value={playerBId}
          onSelect={onSelectB}
          players={players}
          teams={teams}
          positions={positions}
        />
      </div>

      {bothSelected ? (
        <>
          <OverlayRadar
            data={compareRadarData}
            playerA={playerA!}
            playerB={playerB!}
          />

          <section>
            <h3 className="mb-4 text-xs font-medium uppercase tracking-wider text-[#1A3C2E]/60">
              Percentile rank
            </h3>
            <div className="grid grid-cols-2 gap-8">
              <div>
                <h4 className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#1A3C2E]">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full border border-[#1A3C2E]/30"
                    style={{ backgroundColor: PLAYER_A_COLOR }}
                  />
                  {playerA!.player ?? 'Player A'}
                  <span className="text-xs font-normal text-[#1A3C2E]/50">
                    {playerA!.position_group ? `vs ${playerA!.position_group}` : ''}
                  </span>
                </h4>
                <PercentileBars data={percentileDataA} />
              </div>
              <div>
                <h4 className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#1A3C2E]">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: PLAYER_B_COLOR }}
                  />
                  {playerB!.player ?? 'Player B'}
                  <span className="text-xs font-normal text-[#1A3C2E]/50">
                    {playerB!.position_group ? `vs ${playerB!.position_group}` : ''}
                  </span>
                </h4>
                <PercentileBars data={percentileDataB} />
              </div>
            </div>
          </section>

          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              disabled={samePlayer}
              onClick={() => {
                if (samePlayer) return;
                openAssistant({
                  mode: 'comparison_report',
                  eyebrow: 'Comparison Report',
                  title: `${playerA!.player ?? 'Player A'} vs ${playerB!.player ?? 'Player B'}`,
                  subtitle: `${playerA!.team ?? '—'} · ${playerB!.team ?? '—'}`,
                  context: { playerA, playerB },
                });
              }}
              className="flex items-center gap-2 rounded-md bg-[#1A3C2E] px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#1A3C2E]/90 focus:outline-none focus:ring-2 focus:ring-[#1A3C2E]/30 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-[#1A3C2E]"
            >
              <Sparkles className="h-4 w-4" />
              Compare Reports
            </button>
            {samePlayer && (
              <p className="text-xs text-[#1A3C2E]/60">
                Pick two different players to generate a comparison.
              </p>
            )}
          </div>
        </>
      ) : (
        <CompareEmptyState
          aSelected={playerA !== null}
          bSelected={playerB !== null}
        />
      )}
    </div>
  );
}

function PlayerSearchInput({
  label,
  dotColor,
  dotBorder,
  value,
  onSelect,
  players,
  teams,
  positions,
}: {
  label: string;
  dotColor: string;
  dotBorder?: boolean;
  value: number | null;
  onSelect: (id: number | null) => void;
  players: Player[];
  teams: string[];
  positions: string[];
}) {
  // Per-widget state: each Player A / B has independent filters + query.
  const [query, setQuery] = useState('');
  const [teamFilter, setTeamFilter] = useState('');
  const [positionFilter, setPositionFilter] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close the popover when the user clicks anywhere outside this widget.
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  const selected = useMemo(
    () => players.find((p) => p.player_id === value) ?? null,
    [players, value],
  );

  // Match logic: substring on player name (case-insensitive) plus the
  // widget's own team + position filters. Capped at SEARCH_RESULT_CAP so
  // the popover doesn't render 2000 nodes when filters are empty.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: Player[] = [];
    for (const p of players) {
      if (teamFilter && p.team !== teamFilter) continue;
      if (positionFilter && p.position_group !== positionFilter) continue;
      if (q && !(p.player ?? '').toLowerCase().includes(q)) continue;
      out.push(p);
      if (out.length >= SEARCH_RESULT_CAP) break;
    }
    return out;
  }, [players, query, teamFilter, positionFilter]);

  // What the user sees in the input field:
  // - if a player is chosen, show "Name — Team" (input is readOnly)
  // - otherwise show the typed query
  const inputDisplay = selected
    ? `${selected.player ?? 'Unknown'}${selected.team ? ` — ${selected.team}` : ''}`
    : query;

  function clear() {
    onSelect(null);
    setQuery('');
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative">
      <label className="mb-1.5 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-[#1A3C2E]/60">
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${
            dotBorder ? 'border border-[#1A3C2E]/30' : ''
          }`}
          style={{ backgroundColor: dotColor }}
        />
        {label}
      </label>

      {/* Per-player filters sit directly above the search input. */}
      <div className="mb-2 grid grid-cols-2 gap-2">
        <select
          value={teamFilter}
          onChange={(e) => setTeamFilter(e.target.value)}
          className="rounded-md border border-[#1A3C2E]/15 bg-white px-2 py-1.5 text-xs outline-none transition-colors focus:border-[#1A3C2E]/40"
        >
          <option value="">All teams</option>
          {teams.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          value={positionFilter}
          onChange={(e) => setPositionFilter(e.target.value)}
          className="rounded-md border border-[#1A3C2E]/15 bg-white px-2 py-1.5 text-xs outline-none transition-colors focus:border-[#1A3C2E]/40"
        >
          <option value="">All positions</option>
          {positions.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      {/* Search input. readOnly when a player is selected so typing over
          the chosen "Name — Team" string can't produce a garbled query. */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#1A3C2E]/40" />
        <input
          type="text"
          value={inputDisplay}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          readOnly={selected !== null}
          placeholder="Search players..."
          className={`w-full rounded-md border border-[#1A3C2E]/15 py-2 pl-9 pr-9 text-sm outline-none transition-colors focus:border-[#1A3C2E]/50 ${
            selected
              ? 'cursor-pointer bg-[#1A3C2E]/5 font-medium text-[#1A3C2E]'
              : 'bg-white text-[#1A3C2E]'
          }`}
        />
        {(selected || query) && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              clear();
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[#1A3C2E]/40 hover:bg-[#1A3C2E]/5 hover:text-[#1A3C2E]"
            aria-label="Clear selection"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Scrollable results dropdown. Absolute-positioned below the input;
          z-20 so it floats over the radar / percentile sections below. */}
      {open && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-md border border-[#1A3C2E]/15 bg-white shadow-lg">
          {matches.length === 0 ? (
            <div className="px-3 py-3 text-sm text-[#1A3C2E]/60">
              No players match these filters.
            </div>
          ) : (
            <>
              <ul>
                {matches.map((p) => {
                  const isCurrent = p.player_id === value;
                  return (
                    <li key={p.player_id}>
                      <button
                        type="button"
                        onClick={() => {
                          onSelect(p.player_id);
                          setQuery('');
                          setOpen(false);
                        }}
                        className={`flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm transition-colors hover:bg-[#1A3C2E]/5 ${
                          isCurrent ? 'bg-[#1A3C2E]/10' : ''
                        }`}
                      >
                        <span className="font-medium text-[#1A3C2E]">
                          {p.player ?? 'Unknown'}
                        </span>
                        <span className="text-xs text-[#1A3C2E]/60">
                          {p.team ?? '—'}
                          {p.position_group ? ` · ${p.position_group}` : ''}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {matches.length === SEARCH_RESULT_CAP && (
                <div className="border-t border-[#1A3C2E]/10 px-3 py-2 text-xs text-[#1A3C2E]/40">
                  Showing first {SEARCH_RESULT_CAP} — refine filters or search
                  to narrow.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function OverlayRadar({
  data,
  playerA,
  playerB,
}: {
  data: CompareRadarDatum[];
  playerA: Player;
  playerB: Player;
}) {
  const groupA = playerA.position_group ?? 'all players';
  const groupB = playerB.position_group ?? 'all players';
  const sameCohort = groupA === groupB;

  return (
    <section className="rounded-lg bg-[#1A3C2E] p-6 text-white">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wider text-white/70">
          Profile comparison
        </h3>
        <span className="text-xs text-white/40">
          0–100 normalized per position
        </span>
      </div>
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={data} outerRadius="68%">
            <PolarGrid stroke="rgba(255,255,255,0.18)" />
            <PolarAngleAxis
              dataKey="metric"
              tick={{ fill: '#FFFFFF', fontSize: 11 }}
              stroke="rgba(255,255,255,0.4)"
            />
            <PolarRadiusAxis
              domain={[0, 100]}
              tick={false}
              axisLine={false}
              stroke="transparent"
            />
            <Radar
              name={playerA.player ?? 'Player A'}
              dataKey="valueA"
              stroke={PLAYER_A_COLOR}
              strokeWidth={2}
              fill={PLAYER_A_COLOR}
              fillOpacity={0.22}
            />
            <Radar
              name={playerB.player ?? 'Player B'}
              dataKey="valueB"
              stroke={PLAYER_B_COLOR}
              strokeWidth={2}
              fill={PLAYER_B_COLOR}
              fillOpacity={0.22}
            />
            <Legend
              verticalAlign="bottom"
              iconType="circle"
              wrapperStyle={{
                paddingTop: 12,
                color: '#FFFFFF',
                fontSize: 12,
              }}
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>
      {!sameCohort && (
        <p className="mt-3 border-t border-white/10 pt-3 text-xs text-white/50">
          Each player is normalized within their own position cohort:{' '}
          <span className="text-white/80">{groupA}</span> for{' '}
          {playerA.player ?? 'Player A'} ·{' '}
          <span className="text-white/80">{groupB}</span> for{' '}
          {playerB.player ?? 'Player B'}.
        </p>
      )}
    </section>
  );
}

function CompareEmptyState({
  aSelected,
  bSelected,
}: {
  aSelected: boolean;
  bSelected: boolean;
}) {
  const remaining = [
    !aSelected ? 'Player A' : null,
    !bSelected ? 'Player B' : null,
  ].filter(Boolean);
  return (
    <div className="flex h-[40vh] items-center justify-center rounded-lg border border-dashed border-[#1A3C2E]/15">
      <div className="text-center">
        <Users className="mx-auto h-8 w-8 text-[#1A3C2E]/30" />
        <p className="mt-3 text-sm text-[#1A3C2E]/60">
          Pick {remaining.join(' and ')} to see the comparison.
        </p>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-[60vh] items-center justify-center">
      <div className="text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border-2 border-dashed border-[#1A3C2E]/20">
          <User className="h-8 w-8 text-[#1A3C2E]/30" />
        </div>
        <p className="mt-4 max-w-xs text-sm text-[#1A3C2E]/60">
          Select a player from the sidebar to view their per-90 metrics.
        </p>
      </div>
    </div>
  );
}

