import { NextRequest, NextResponse } from 'next/server';

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
  // null = completed pass. StatsBomb only sets pass.outcome on
  // incompletes ("Incomplete", "Out", "Pass Offside", "Unknown", ...).
  outcome: string | null;
};

// One row per player who appeared in the match. Used by the pass
// network filters: `is_starter` powers the "Starters only" toggle,
// `minutes` powers the minimum-minutes slider.
type MatchPlayer = {
  player: string;
  team: string;
  is_starter: boolean;
  minutes: number;
};

const SB_EVENTS_BASE =
  'https://raw.githubusercontent.com/statsbomb/open-data/master/data/events';

export async function GET(request: NextRequest) {
  const param = request.nextUrl.searchParams.get('matchId');
  const matchId = Number(param);
  if (!param || !Number.isFinite(matchId)) {
    return NextResponse.json(
      { error: 'Missing or invalid `matchId` query parameter.' },
      { status: 400 },
    );
  }

  // Pull the event feed from StatsBomb's open-data CDN.
  // force-cache means Next's fetch cache stores the response across
  // requests, so repeat selections of the same matchId never re-fetch.
  let events: unknown;
  try {
    const res = await fetch(`${SB_EVENTS_BASE}/${matchId}.json`, {
      cache: 'force-cache',
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `StatsBomb CDN returned ${res.status} for match ${matchId}.` },
        { status: 502 },
      );
    }
    events = await res.json();
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? `Failed to fetch event data: ${err.message}`
            : 'Failed to fetch event data.',
      },
      { status: 502 },
    );
  }

  if (!Array.isArray(events)) {
    return NextResponse.json(
      { error: 'Unexpected event payload shape from StatsBomb.' },
      { status: 502 },
    );
  }

  // Single pass over the event feed, partitioning into shots and passes
  // and projecting each to the slim shape the frontend needs.
  const shots: Shot[] = [];
  const passes: Pass[] = [];

  for (const ev of events as Array<Record<string, any>>) {
    const type = ev.type?.name;
    if (type === 'Shot') {
      shots.push({
        player: ev.player?.name ?? null,
        team: ev.team?.name ?? null,
        location: toXY(ev.location),
        outcome: ev.shot?.outcome?.name ?? null,
        xg:
          typeof ev.shot?.statsbomb_xg === 'number'
            ? ev.shot.statsbomb_xg
            : null,
      });
    } else if (type === 'Pass') {
      passes.push({
        player: ev.player?.name ?? null,
        team: ev.team?.name ?? null,
        recipient: ev.pass?.recipient?.name ?? null,
        location: toXY(ev.location),
        end_location: toXY(ev.pass?.end_location),
        outcome: ev.pass?.outcome?.name ?? null,
      });
    }
  }

  const players = computeLineups(events as Array<Record<string, any>>);

  return NextResponse.json({ matchId, shots, passes, players });
}

// StatsBomb locations come as [x, y] arrays with numeric entries.
// Guard against missing / malformed entries.
function toXY(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  if (typeof v[0] !== 'number' || typeof v[1] !== 'number') return null;
  return [v[0], v[1]];
}

// Estimate per-player minutes + starter status from the event feed.
// Mirrors the Python logic in scripts/load_data.py:
//   - Starting XI players are credited the full match length to begin.
//   - On substitution, the player going off has their exit time fixed
//     and the player coming on is credited entry → match_end.
//   - A red card caps the offender's exit time at the dismissal.
function computeLineups(
  events: Array<Record<string, any>>,
): MatchPlayer[] {
  if (events.length === 0) return [];

  // Approximate full-time = highest minute timestamp in the event log.
  let maxMin = 0;
  for (const ev of events) {
    if (typeof ev.minute === 'number' && ev.minute > maxMin) {
      maxMin = ev.minute;
    }
  }
  const matchEnd = maxMin + 1;

  const entry = new Map<string, number>();
  const exit = new Map<string, number>();
  const teamOf = new Map<string, string>();
  const starters = new Set<string>();

  // Pass 1: Starting XI events carry a `tactics.lineup` array per team.
  for (const ev of events) {
    if (ev.type?.name !== 'Starting XI') continue;
    const teamName = ev.team?.name;
    if (typeof teamName !== 'string') continue;
    const lineup = ev.tactics?.lineup;
    if (!Array.isArray(lineup)) continue;
    for (const item of lineup) {
      const playerName = item?.player?.name;
      if (typeof playerName !== 'string') continue;
      entry.set(playerName, 0);
      exit.set(playerName, matchEnd);
      teamOf.set(playerName, teamName);
      starters.add(playerName);
    }
  }

  // Pass 2: Substitutions. The player going off gets a fixed exit; the
  // player coming on gets a fresh entry and the default match-end exit.
  for (const ev of events) {
    if (ev.type?.name !== 'Substitution') continue;
    const teamName = ev.team?.name;
    const offName = ev.player?.name;
    const onName = ev.substitution?.replacement?.name;
    const t =
      (typeof ev.minute === 'number' ? ev.minute : 0) +
      (typeof ev.second === 'number' ? ev.second / 60 : 0);
    if (typeof offName === 'string') {
      exit.set(offName, t);
    }
    if (typeof onName === 'string') {
      entry.set(onName, t);
      exit.set(onName, matchEnd);
      if (typeof teamName === 'string') {
        teamOf.set(onName, teamName);
      }
    }
  }

  // Pass 3: Red cards cap the offender's exit at the dismissal time.
  for (const ev of events) {
    if (ev.type?.name !== 'Bad Behaviour') continue;
    const cardName = ev.bad_behaviour?.card?.name;
    if (typeof cardName !== 'string' || !cardName.includes('Red')) continue;
    const playerName = ev.player?.name;
    if (typeof playerName !== 'string') continue;
    const t =
      (typeof ev.minute === 'number' ? ev.minute : 0) +
      (typeof ev.second === 'number' ? ev.second / 60 : 0);
    if (exit.has(playerName)) {
      exit.set(playerName, Math.min(exit.get(playerName)!, t));
    }
  }

  // Materialise to MatchPlayer rows.
  return Array.from(exit.entries()).map(([name, exitT]) => {
    const entryT = entry.get(name) ?? 0;
    const minutes = Math.max(0, exitT - entryT);
    return {
      player: name,
      team: teamOf.get(name) ?? '',
      is_starter: starters.has(name),
      minutes: Math.round(minutes * 10) / 10,
    };
  });
}
