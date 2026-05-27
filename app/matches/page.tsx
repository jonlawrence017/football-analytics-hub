'use client';

import { useEffect, useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { KpiCardSkeleton, Skeleton } from '@/components/Skeleton';

type Match = {
  match_id: number;
  season: string;
  match_date: string;
  home_team: string;
  away_team: string;
  home_score: number | null;
  away_score: number | null;
};

type TeamKpi = {
  team: string;
  shots: number;
  xg: number;
  possession: number;
  pass_completion: number;
  ppda: number | null;
  progressive_passes: number;
};

type MatchKpiResponse = {
  match: Match;
  kpis: { home: TeamKpi; away: TeamKpi };
};

type Shot = {
  player: string | null;
  team: string | null;
  location: [number, number] | null;
  outcome: string | null;
  xg: number | null;
};

type Pass = {
  player: string | null;
  team: string | null;
  recipient: string | null;
  location: [number, number] | null;
  end_location: [number, number] | null;
  outcome: string | null;
};

type MatchPlayer = {
  player: string;
  team: string;
  is_starter: boolean;
  minutes: number;
};

type MatchEventsResponse = {
  matchId: number;
  shots: Shot[];
  passes: Pass[];
  players: MatchPlayer[];
};

const KPI_DEFS: Array<{ label: string; format: (k: TeamKpi) => string }> = [
  { label: 'Shots', format: (k) => String(k.shots) },
  { label: 'xG', format: (k) => k.xg.toFixed(2) },
  { label: 'Possession', format: (k) => `${k.possession.toFixed(0)}%` },
  { label: 'Pass %', format: (k) => `${k.pass_completion.toFixed(0)}%` },
  { label: 'PPDA', format: (k) => (k.ppda === null ? '—' : k.ppda.toFixed(1)) },
  { label: 'Prog. passes', format: (k) => String(k.progressive_passes) },
];

// Shot-marker radius bounds, in viewBox (pitch) units.
// The pitch SVG renders ~720px wide, so 1 viewBox unit ≈ 6px.
// → SHOT_R_MIN = 1.0 ≈ 6px (low-xG), SHOT_R_MAX = 3.3 ≈ 20px (top-xG).
const SHOT_R_MIN = 1.0;
const SHOT_R_MAX = 3.3;

function xgToRadius(xg: number | null): number {
  const x = Math.max(0, Math.min(1, xg ?? 0));
  return SHOT_R_MIN + x * (SHOT_R_MAX - SHOT_R_MIN);
}

// ── Pass-network helpers ────────────────────────────────────────────

type PassNetworkNode = {
  player: string;
  lastName: string;
  x: number;        // mean pass-start x
  y: number;        // mean pass-start y
  passCount: number;
};

type PassNetworkEdge = {
  playerA: string;
  playerB: string;
  count: number;
};

// Node + edge size scales (in pitch / viewBox units).
const NODE_R_MIN = 1.5;
const NODE_R_MAX = 4.0;
const NODE_SCALE_AT = 80;   // passes-made that maps to NODE_R_MAX
const EDGE_W_MIN = 0.3;
const EDGE_W_MAX = 1.8;
const EDGE_SCALE_AT = 25;   // pair pass-count that maps to EDGE_W_MAX

function nodeRadius(passes: number): number {
  const k = Math.min(passes, NODE_SCALE_AT) / NODE_SCALE_AT;
  return NODE_R_MIN + k * (NODE_R_MAX - NODE_R_MIN);
}

function edgeWidth(count: number): number {
  // Edges only exist for count >= 3, so the min anchor is count=3.
  const k =
    Math.min(Math.max(count - 3, 0), EDGE_SCALE_AT - 3) / (EDGE_SCALE_AT - 3);
  return EDGE_W_MIN + k * (EDGE_W_MAX - EDGE_W_MIN);
}

// Spanish/Portuguese surname extraction.
//   "Lionel Andrés Messi Cuccittini" → "Messi" (paternal surname)
//   "Sergio Busquets i Burgos"        → "Busquets"  (skips Catalan "i")
//   "Gerard Piqué Bernabéu"           → "Piqué"
// Heuristic: for 3+ word names, take second-to-last (paternal surname
// in Spanish convention), skipping particles like i / de / dos / del.
const NAME_PARTICLES = new Set([
  'i', 'de', 'da', 'do', 'dos', 'das', 'del', 'la', 'le', 'di',
]);

function getLastName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[1];
  let idx = parts.length - 2;
  while (idx > 0 && NAME_PARTICLES.has(parts[idx].toLowerCase())) {
    idx--;
  }
  return parts[idx];
}

type PassNetworkFilters = {
  startersOnly: boolean;
  minMinutes: number;          // 0–90
  minPassConnections: number;  // edge threshold, e.g. 3
};

function buildPassNetwork(
  passes: Pass[],
  team: string,
  matchPlayers: MatchPlayer[],
  filters: PassNetworkFilters,
): { nodes: PassNetworkNode[]; edges: PassNetworkEdge[] } {
  // Eligibility = passes the starters/minutes filters.
  // Avg position is still computed from all the player's completed
  // passes (their actual on-field activity); edges only count pairs
  // where BOTH endpoints are eligible.
  const eligible = new Set<string>();
  for (const p of matchPlayers) {
    if (p.team !== team) continue;
    if (filters.startersOnly && !p.is_starter) continue;
    if (p.minutes < filters.minMinutes) continue;
    eligible.add(p.player);
  }

  // Completed passes only: incompletes have no recipient and add noise
  // to the avg-position aggregation (they're often hopeful long balls).
  const teamPasses = passes.filter(
    (p) =>
      p.team === team &&
      p.outcome === null &&
      p.recipient !== null &&
      p.location !== null,
  );

  // Mean of pass-start locations per ELIGIBLE player (using all their
  // own completed passes regardless of recipient — gives a faithful
  // position even when teammates are filtered out).
  const agg: Record<string, { sumX: number; sumY: number; count: number }> = {};
  for (const p of teamPasses) {
    if (!p.player || !p.location) continue;
    if (!eligible.has(p.player)) continue;
    const entry = (agg[p.player] ??= { sumX: 0, sumY: 0, count: 0 });
    entry.sumX += p.location[0];
    entry.sumY += p.location[1];
    entry.count += 1;
  }

  const nodes: PassNetworkNode[] = Object.entries(agg).map(([player, a]) => ({
    player,
    lastName: getLastName(player),
    x: a.sumX / a.count,
    y: a.sumY / a.count,
    passCount: a.count,
  }));

  // Undirected pair counts: A→B and B→A collapse to one edge.
  // Only count pairs where both endpoints are eligible.
  const pairCounts: Record<string, number> = {};
  for (const p of teamPasses) {
    if (!p.player || !p.recipient) continue;
    if (!eligible.has(p.player) || !eligible.has(p.recipient)) continue;
    const [a, b] = [p.player, p.recipient].sort();
    const key = `${a}||${b}`;
    pairCounts[key] = (pairCounts[key] ?? 0) + 1;
  }

  const edges: PassNetworkEdge[] = Object.entries(pairCounts)
    .filter(([, count]) => count >= filters.minPassConnections)
    .map(([key, count]) => {
      const [playerA, playerB] = key.split('||');
      return { playerA, playerB, count };
    });

  return { nodes, edges };
}

export default function MatchesPage() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [loadingMatches, setLoadingMatches] = useState(true);
  const [matchesError, setMatchesError] = useState<string | null>(null);

  const [season, setSeason] = useState('');
  const [matchId, setMatchId] = useState<number | null>(null);

  const [kpiData, setKpiData] = useState<MatchKpiResponse | null>(null);
  const [loadingKpis, setLoadingKpis] = useState(false);
  const [kpiError, setKpiError] = useState<string | null>(null);

  const [eventsData, setEventsData] = useState<MatchEventsResponse | null>(null);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);

  const { setSelection, openAssistant } = useApp();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/matches');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: Match[] = await res.json();
        if (!cancelled) {
          setMatches(data);
          setLoadingMatches(false);
        }
      } catch (err) {
        if (!cancelled) {
          setMatchesError(
            err instanceof Error ? err.message : 'Failed to load matches',
          );
          setLoadingMatches(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const seasons = useMemo(
    () =>
      Array.from(new Set(matches.map((m) => m.season)))
        .sort()
        .reverse(),
    [matches],
  );

  const seasonMatches = useMemo(() => {
    if (!season) return [];
    return matches
      .filter((m) => m.season === season)
      .sort((a, b) => a.match_date.localeCompare(b.match_date));
  }, [matches, season]);

  // Wipe match + per-match data when the season changes.
  useEffect(() => {
    setMatchId(null);
    setKpiData(null);
    setKpiError(null);
    setEventsData(null);
    setEventsError(null);
  }, [season]);

  // Fetch KPIs in parallel with the event feed.
  useEffect(() => {
    if (matchId === null) {
      setKpiData(null);
      return;
    }
    let cancelled = false;
    setLoadingKpis(true);
    setKpiError(null);
    (async () => {
      try {
        const res = await fetch(`/api/matches/${matchId}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const data: MatchKpiResponse = await res.json();
        if (!cancelled) {
          setKpiData(data);
          setLoadingKpis(false);
        }
      } catch (err) {
        if (!cancelled) {
          setKpiError(
            err instanceof Error ? err.message : 'Failed to load match data',
          );
          setLoadingKpis(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [matchId]);

  // Raw events for the shot map. Independent of the KPI fetch so the
  // map can render as soon as its own request completes.
  useEffect(() => {
    if (matchId === null) {
      setEventsData(null);
      return;
    }
    let cancelled = false;
    setLoadingEvents(true);
    setEventsError(null);
    (async () => {
      try {
        const res = await fetch(`/api/match-events?matchId=${matchId}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const data: MatchEventsResponse = await res.json();
        if (!cancelled) {
          setEventsData(data);
          setLoadingEvents(false);
        }
      } catch (err) {
        if (!cancelled) {
          setEventsError(
            err instanceof Error ? err.message : 'Failed to load event data',
          );
          setLoadingEvents(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [matchId]);

  const selectedMatch = useMemo(
    () => matches.find((m) => m.match_id === matchId) ?? null,
    [matches, matchId],
  );

  // Expose the current match selection to the nav (breadcrumb) and to
  // the global Ask-AI button. Prefer the loaded KPI payload as the AI
  // context; fall back to bare match metadata while KPIs are fetching.
  useEffect(() => {
    if (selectedMatch) {
      setSelection({
        label: `${selectedMatch.home_team} vs ${selectedMatch.away_team}`,
        sub: `${selectedMatch.season} · ${selectedMatch.match_date} · ${formatScore(selectedMatch)}`,
        context: kpiData ?? { match: selectedMatch },
      });
    } else {
      setSelection(null);
    }
    return () => setSelection(null);
  }, [selectedMatch, kpiData, setSelection]);

  return (
    <div className="min-h-full bg-white text-[#1A3C2E]">
      <div className="mx-auto max-w-6xl px-10 py-8">
        {/* ── Two-step selector ────────────────────────────────────── */}
        <section className="mb-8 rounded-lg border border-[#1A3C2E]/10 bg-white p-6 shadow-sm">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_2fr]">
            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-[#1A3C2E]/60">
                Season
              </label>
              <select
                value={season}
                onChange={(e) => setSeason(e.target.value)}
                disabled={loadingMatches || !!matchesError}
                className="w-full rounded-md border border-[#1A3C2E]/15 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-[#1A3C2E]/50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="">
                  {loadingMatches ? 'Loading…' : 'Select a season…'}
                </option>
                {seasons.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-[#1A3C2E]/60">
                Match
              </label>
              <select
                value={matchId ?? ''}
                onChange={(e) =>
                  setMatchId(e.target.value ? Number(e.target.value) : null)
                }
                disabled={!season}
                className="w-full rounded-md border border-[#1A3C2E]/15 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-[#1A3C2E]/50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="">
                  {season ? 'Select a match…' : 'Pick a season first'}
                </option>
                {seasonMatches.map((m) => (
                  <option key={m.match_id} value={m.match_id}>
                    {m.home_team} vs {m.away_team} · {m.match_date} ·{' '}
                    {formatScore(m)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {matchesError && (
            <p className="mt-3 text-sm text-red-700">
              Couldn’t load matches: {matchesError}
            </p>
          )}
        </section>

        {/* ── Match header (shown the moment a match is picked) ────── */}
        {selectedMatch && (
          <section className="mb-6 rounded-lg border border-[#1A3C2E]/10 bg-white p-6 shadow-sm">
            <div className="flex items-baseline justify-between gap-6">
              <div className="min-w-0">
                <h2 className="truncate text-2xl font-semibold text-[#1A3C2E]">
                  {selectedMatch.home_team}{' '}
                  <span className="text-[#1A3C2E]/40">vs</span>{' '}
                  {selectedMatch.away_team}
                </h2>
                <p className="mt-1 text-sm text-[#1A3C2E]/60">
                  {selectedMatch.season} · {selectedMatch.match_date}
                </p>
              </div>
              <div className="shrink-0 font-mono text-3xl font-bold tabular-nums text-[#1A3C2E]">
                {formatScore(selectedMatch)}
              </div>
            </div>
          </section>
        )}

        {/* ── KPI section ──────────────────────────────────────────── */}
        {matchId !== null && (
          <div className="mb-6">
            {loadingKpis && (
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <KpiPanelSkeleton />
                <KpiPanelSkeleton />
              </div>
            )}
            {kpiError && !loadingKpis && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                Couldn’t load match analysis: {kpiError}
              </div>
            )}
            {!loadingKpis && !kpiError && kpiData && selectedMatch && (
              <>
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                  <TeamKpiPanel
                    team={selectedMatch.home_team}
                    kpi={kpiData.kpis.home}
                  />
                  <TeamKpiPanel
                    team={selectedMatch.away_team}
                    kpi={kpiData.kpis.away}
                  />
                </div>
                <div className="mt-6 flex justify-center">
                  <button
                    type="button"
                    onClick={() => {
                      if (!selectedMatch) return;
                      openAssistant({
                        mode: 'coaching_brief',
                        eyebrow: 'Coaching Brief',
                        title: `${selectedMatch.home_team} vs ${selectedMatch.away_team}`,
                        subtitle: `${selectedMatch.season} · ${selectedMatch.match_date} · ${formatScore(selectedMatch)}`,
                        context: kpiData,
                      });
                    }}
                    className="flex items-center gap-2 rounded-md bg-[#1A3C2E] px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#1A3C2E]/90 focus:outline-none focus:ring-2 focus:ring-[#1A3C2E]/30"
                  >
                    <Sparkles className="h-4 w-4" />
                    Generate Coaching Brief
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Shot map ─────────────────────────────────────────────── */}
        {matchId !== null && selectedMatch && (
          <ShotMapSection
            shots={eventsData?.shots ?? []}
            homeTeam={selectedMatch.home_team}
            awayTeam={selectedMatch.away_team}
            loading={loadingEvents}
            error={eventsError}
          />
        )}

        {/* ── Pass network ─────────────────────────────────────────── */}
        {matchId !== null && selectedMatch && (
          <div className="mt-6">
            <PassNetworkSection
              passes={eventsData?.passes ?? []}
              players={eventsData?.players ?? []}
              homeTeam={selectedMatch.home_team}
              awayTeam={selectedMatch.away_team}
              loading={loadingEvents}
              error={eventsError}
            />
          </div>
        )}

        {/* ── Empty state (no match selected yet) ──────────────────── */}
        {matchId === null && (
          <div className="flex h-[40vh] items-center justify-center rounded-lg border border-dashed border-[#1A3C2E]/15">
            <p className="text-sm text-[#1A3C2E]/60">
              Pick a season and a match to see the analysis.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function TeamKpiPanel({ team, kpi }: { team: string; kpi: TeamKpi }) {
  return (
    <section className="rounded-lg border border-[#1A3C2E]/10 bg-white p-6 shadow-sm">
      <h3 className="mb-4 border-b border-[#1A3C2E]/10 pb-3 text-sm font-semibold uppercase tracking-wider text-[#1A3C2E]">
        {team}
      </h3>
      <div className="grid grid-cols-3 gap-3">
        {KPI_DEFS.map(({ label, format }) => (
          <KpiCard key={label} label={label} value={format(kpi)} />
        ))}
      </div>
    </section>
  );
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-[#1A3C2E]/5 p-3">
      <p className="text-xs uppercase tracking-wider text-[#1A3C2E]/60">
        {label}
      </p>
      <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-[#1A3C2E]">
        {value}
      </p>
    </div>
  );
}

// Placeholder for one team's KPI panel while the API call is in flight.
// 3 × 2 grid of skeleton cards — same shape as a real TeamKpiPanel.
function KpiPanelSkeleton() {
  return (
    <section className="rounded-lg border border-[#1A3C2E]/10 bg-white p-6 shadow-sm">
      <Skeleton className="mb-4 h-4 w-1/3" />
      <div className="grid grid-cols-3 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <KpiCardSkeleton key={i} />
        ))}
      </div>
    </section>
  );
}

// Placeholder for the shot map / pass network pitch while events load.
// Same aspect ratio and pitch background as the real SVG, with a
// gentle pulse to signal "loading" without showing a spinner.
function PitchSkeleton() {
  return (
    <div className="mx-auto max-w-3xl">
      <div
        className="block w-full animate-pulse rounded-md bg-[#2D5A3D]"
        style={{ aspectRatio: '3 / 2' }}
        aria-label="Loading pitch data"
      />
    </div>
  );
}

function formatScore(m: Match): string {
  if (m.home_score === null || m.away_score === null) return '—';
  return `${m.home_score} - ${m.away_score}`;
}

// ── Shot map ────────────────────────────────────────────────────────

function ShotMapSection({
  shots,
  homeTeam,
  awayTeam,
  loading,
  error,
}: {
  shots: Shot[];
  homeTeam: string;
  awayTeam: string;
  loading: boolean;
  error: string | null;
}) {
  // Visibility toggles persist across match changes (the user's view
  // preference shouldn't reset every time they pick a different match).
  const [showHome, setShowHome] = useState(true);
  const [showAway, setShowAway] = useState(true);

  const visibleShots = useMemo(
    () =>
      shots.filter((s) => {
        if (s.team === homeTeam) return showHome;
        if (s.team === awayTeam) return showAway;
        return false;
      }),
    [shots, homeTeam, awayTeam, showHome, showAway],
  );

  return (
    <section className="rounded-lg border border-[#1A3C2E]/10 bg-white p-6 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-[#1A3C2E]/10 pb-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-[#1A3C2E]">
          Shot map
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <TeamToggle
            fill="#1A3C2E"
            border="rgba(255,255,255,0.5)"
            label={homeTeam}
            active={showHome}
            onClick={() => setShowHome((v) => !v)}
          />
          <TeamToggle
            fill="#FFFFFF"
            border="#1A3C2E"
            label={awayTeam}
            active={showAway}
            onClick={() => setShowAway((v) => !v)}
          />
        </div>
      </div>

      {loading && <PitchSkeleton />}

      {error && !loading && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          Couldn’t load shot data: {error}
        </div>
      )}

      {!loading && !error && (
        <>
          <div className="mx-auto max-w-3xl">
            <svg
              viewBox="0 0 120 80"
              preserveAspectRatio="xMidYMid meet"
              className="block w-full rounded-md bg-[#2D5A3D]"
            >
              <PitchLines />
              {visibleShots.map((shot, i) => (
                <ShotMarker
                  key={i}
                  shot={shot}
                  isHome={shot.team === homeTeam}
                />
              ))}
            </svg>
          </div>
          <ShotLegend />
          <p className="mt-2 text-center text-xs text-[#1A3C2E]/40">
            Home attacks → · ← Away attacks · marker size scales with xG
          </p>
        </>
      )}
    </section>
  );
}

function TeamToggle({
  fill,
  border,
  label,
  active,
  onClick,
}: {
  fill: string;
  border: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-2 rounded-full border border-[#1A3C2E]/15 px-3 py-1.5 text-xs font-medium transition-opacity ${
        active ? 'opacity-100' : 'opacity-40'
      }`}
    >
      <span
        className="inline-block h-3 w-3 rounded-full"
        style={{ backgroundColor: fill, border: `1px solid ${border}` }}
      />
      <span className="text-[#1A3C2E]">{label}</span>
      <span className="text-[#1A3C2E]/40">
        {active ? 'shown' : 'hidden'}
      </span>
    </button>
  );
}

function PitchLines() {
  // All pitch geometry uses StatsBomb's 120 × 80 frame so coordinates
  // are pitch-natural. strokeWidth ≈ 0.3 viewBox units (~2px rendered).
  return (
    <g fill="none" stroke="white" strokeWidth="0.3">
      {/* Outer boundary (inset slightly so stroke isn't clipped). */}
      <rect x="0.15" y="0.15" width="119.7" height="79.7" />

      {/* Halfway line + centre circle + centre spot. */}
      <line x1="60" y1="0" x2="60" y2="80" />
      <circle cx="60" cy="40" r="10" />
      <circle cx="60" cy="40" r="0.5" fill="white" stroke="none" />

      {/* Left penalty area + 6-yard box + penalty spot. */}
      <rect x="0.15" y="18" width="17.85" height="44" />
      <rect x="0.15" y="30" width="5.85" height="20" />
      <circle cx="12" cy="40" r="0.5" fill="white" stroke="none" />

      {/* Right penalty area + 6-yard box + penalty spot. */}
      <rect x="102" y="18" width="17.85" height="44" />
      <rect x="114" y="30" width="5.85" height="20" />
      <circle cx="108" cy="40" r="0.5" fill="white" stroke="none" />
    </g>
  );
}

function ShotMarker({ shot, isHome }: { shot: Shot; isHome: boolean }) {
  if (!shot.location) return null;

  // Mirror the away team's x so home attacks → and away attacks ←
  // on a single shared pitch.
  const x = isHome ? shot.location[0] : 120 - shot.location[0];
  const y = shot.location[1];
  const r = xgToRadius(shot.xg);
  const isGoal = shot.outcome === 'Goal';

  const fill = isHome ? '#1A3C2E' : '#FFFFFF';
  // Home markers need a thin light outline to read against the same-
  // colour pitch background; away markers carry a dark outline.
  const stroke = isHome ? 'rgba(255,255,255,0.55)' : '#1A3C2E';

  if (isGoal) {
    // Goals get a star, sized 1.2× the circle's radius so the visual
    // weight is comparable (a 5-point star at r covers less area than a
    // circle at r).
    return (
      <Star
        cx={x}
        cy={y}
        r={r * 1.2}
        fill={fill}
        stroke={stroke}
        strokeWidth={0.3}
      />
    );
  }

  return (
    <circle
      cx={x}
      cy={y}
      r={r}
      fill={fill}
      stroke={stroke}
      strokeWidth={0.3}
    />
  );
}

function Star({
  cx,
  cy,
  r,
  fill,
  stroke,
  strokeWidth,
}: {
  cx: number;
  cy: number;
  r: number;
  fill: string;
  stroke?: string;
  strokeWidth?: number;
}) {
  // 5-point star: alternate outer / inner radii every 36°. Inner
  // radius = outer × 0.382 (the classic "pretty star" ratio).
  const points: string[] = [];
  for (let i = 0; i < 10; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const radius = i % 2 === 0 ? r : r * 0.382;
    points.push(
      `${cx + radius * Math.cos(angle)},${cy + radius * Math.sin(angle)}`,
    );
  }
  return (
    <polygon
      points={points.join(' ')}
      fill={fill}
      stroke={stroke}
      strokeWidth={strokeWidth}
    />
  );
}

function ShotLegend() {
  // Sample xG values for the size scale.
  const sizes = [0.05, 0.25, 0.7];
  return (
    <div className="mt-4 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-[#1A3C2E]/70">
      <div className="flex items-center gap-1.5">
        <svg width="14" height="14" viewBox="-7 -7 14 14">
          <Star cx={0} cy={0} r={6} fill="#1A3C2E" />
        </svg>
        <span>Goal</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[#1A3C2E]/60">xG:</span>
        {sizes.map((xg) => (
          <span key={xg} className="flex items-center gap-1">
            <svg width="20" height="20" viewBox="-10 -10 20 20">
              <circle
                cx={0}
                cy={0}
                r={xgToRadius(xg) * (10 / SHOT_R_MAX)}
                fill="#1A3C2E"
              />
            </svg>
            <span className="tabular-nums">{xg.toFixed(2)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Pass network ────────────────────────────────────────────────────

function PassNetworkSection({
  passes,
  players,
  homeTeam,
  awayTeam,
  loading,
  error,
}: {
  passes: Pass[];
  players: MatchPlayer[];
  homeTeam: string;
  awayTeam: string;
  loading: boolean;
  error: string | null;
}) {
  // Which side to render — toggle is mutually exclusive (radio-style)
  // since a pass network plots one team at a time.
  const [side, setSide] = useState<'home' | 'away'>('home');
  // Filter state lives here so updates are instant — the network
  // re-renders via the useMemo below without any network call.
  const [startersOnly, setStartersOnly] = useState(true);
  const [minMinutes, setMinMinutes] = useState(20);
  const [minPassConnections, setMinPassConnections] = useState(3);

  const teamName = side === 'home' ? homeTeam : awayTeam;

  const { nodes, edges } = useMemo(
    () =>
      buildPassNetwork(passes, teamName, players, {
        startersOnly,
        minMinutes,
        minPassConnections,
      }),
    [passes, teamName, players, startersOnly, minMinutes, minPassConnections],
  );

  // Map player → node so edges can resolve to coordinates in one lookup.
  const nodesByPlayer = useMemo(() => {
    const m = new Map<string, PassNetworkNode>();
    for (const n of nodes) m.set(n.player, n);
    return m;
  }, [nodes]);

  return (
    <section className="rounded-lg border border-[#1A3C2E]/10 bg-white p-6 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-[#1A3C2E]/10 pb-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-[#1A3C2E]">
          Pass network
        </h3>
        <div className="inline-flex rounded-md border border-[#1A3C2E]/15 p-0.5">
          {(['home', 'away'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSide(s)}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                side === s
                  ? 'bg-[#1A3C2E] text-white'
                  : 'text-[#1A3C2E]/70 hover:text-[#1A3C2E]'
              }`}
            >
              {s === 'home' ? homeTeam : awayTeam}
            </button>
          ))}
        </div>
      </div>

      {/* Filter controls. All three update state locally; the network
          recomputes via useMemo with no re-fetch. */}
      <div className="mb-4 grid grid-cols-1 gap-4 border-b border-[#1A3C2E]/10 pb-4 md:grid-cols-3">
        <label className="flex cursor-pointer items-center justify-between gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-[#1A3C2E]/60">
            Starters only
          </span>
          <input
            type="checkbox"
            checked={startersOnly}
            onChange={(e) => setStartersOnly(e.target.checked)}
            className="h-4 w-4 cursor-pointer accent-[#1A3C2E]"
          />
        </label>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-[#1A3C2E]/60">
              Min minutes
            </span>
            <span className="font-mono text-sm font-semibold tabular-nums text-[#1A3C2E]">
              {minMinutes}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={90}
            value={minMinutes}
            onChange={(e) => setMinMinutes(Number(e.target.value))}
            aria-label="Minimum minutes played"
            className="block w-full cursor-pointer accent-[#1A3C2E]"
          />
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-[#1A3C2E]/60">
              Min connections
            </span>
            <span className="font-mono text-sm font-semibold tabular-nums text-[#1A3C2E]">
              {minPassConnections}
            </span>
          </div>
          <input
            type="range"
            min={1}
            max={10}
            value={minPassConnections}
            onChange={(e) => setMinPassConnections(Number(e.target.value))}
            aria-label="Minimum pass connections"
            className="block w-full cursor-pointer accent-[#1A3C2E]"
          />
        </div>
      </div>

      {loading && <PitchSkeleton />}

      {error && !loading && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          Couldn’t load pass data: {error}
        </div>
      )}

      {!loading && !error && nodes.length === 0 && (
        <div className="flex h-64 items-center justify-center text-sm text-[#1A3C2E]/60">
          No pass data for {teamName} in this match.
        </div>
      )}

      {!loading && !error && nodes.length > 0 && (
        <>
          <div className="mx-auto max-w-3xl">
            <svg
              viewBox="0 0 120 80"
              preserveAspectRatio="xMidYMid meet"
              className="block w-full rounded-md bg-[#2D5A3D]"
            >
              <PitchLines />

              {/* Edges first so nodes sit on top. */}
              <g stroke="rgba(255,255,255,0.45)" strokeLinecap="round">
                {edges.map((edge, i) => {
                  const a = nodesByPlayer.get(edge.playerA);
                  const b = nodesByPlayer.get(edge.playerB);
                  if (!a || !b) return null;
                  return (
                    <line
                      key={i}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      strokeWidth={edgeWidth(edge.count)}
                    />
                  );
                })}
              </g>

              {/* Nodes + labels. */}
              {nodes.map((node) => {
                const r = nodeRadius(node.passCount);
                const labelBelow = node.y < 40;
                const labelY = labelBelow ? node.y + r + 2.8 : node.y - r - 1.4;
                return (
                  <g key={node.player}>
                    <circle
                      cx={node.x}
                      cy={node.y}
                      r={r}
                      fill={side === 'home' ? '#1A3C2E' : '#FFFFFF'}
                      stroke={
                        side === 'home' ? 'rgba(255,255,255,0.55)' : '#1A3C2E'
                      }
                      strokeWidth="0.3"
                    />
                    <text
                      x={node.x}
                      y={labelY}
                      textAnchor="middle"
                      fontSize="2.4"
                      fontWeight="600"
                      fill="#FFFFFF"
                      stroke="rgba(0,0,0,0.55)"
                      strokeWidth="0.5"
                      style={{ paintOrder: 'stroke' }}
                    >
                      {node.lastName}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
          <p className="mt-2 text-center text-xs text-[#1A3C2E]/40">
            Nodes at each player’s average pass-start location · edges drawn
            for pairs with ≥ {minPassConnections} completed{' '}
            {minPassConnections === 1 ? 'pass' : 'passes'} · line thickness ∝
            pass count
          </p>
        </>
      )}
    </section>
  );
}
