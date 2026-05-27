import { promises as fs } from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';

type MatchMeta = {
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

const MATCHES_PATH = path.join(process.cwd(), 'public', 'data', 'matches.json');
const SB_EVENTS_BASE =
  'https://raw.githubusercontent.com/statsbomb/open-data/master/data/events';

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  const matchId = Number(params.id);
  if (!Number.isFinite(matchId)) {
    return NextResponse.json({ error: 'Invalid match id.' }, { status: 400 });
  }

  // Look up the match in our pre-computed metadata.
  let matches: MatchMeta[];
  try {
    matches = JSON.parse(await fs.readFile(MATCHES_PATH, 'utf-8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return NextResponse.json(
        { error: 'matches.json not found. Run scripts/load_data.py first.' },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: 'Failed to read or parse matches.json.' },
      { status: 500 },
    );
  }

  const match = matches.find((m) => m.match_id === matchId);
  if (!match) {
    return NextResponse.json({ error: 'Match not found.' }, { status: 404 });
  }

  // Fetch the event feed from StatsBomb's open-data CDN.
  // force-cache + GET means Next's fetch cache stores the response across
  // requests, so repeat selections of the same match are instant.
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
      { error: 'Unexpected event payload shape.' },
      { status: 502 },
    );
  }

  const kpis = {
    home: computeTeamKpis(events, match.home_team, match.away_team),
    away: computeTeamKpis(events, match.away_team, match.home_team),
  };

  return NextResponse.json({ match, kpis });
}

// Loose typing on event rows — StatsBomb's schema is large and we only
// read a handful of fields. Using `any` here avoids replicating their
// entire type tree just to read 5 leaf properties.
type SBEvent = Record<string, any>;

function computeTeamKpis(
  events: SBEvent[],
  team: string,
  opponent: string,
): TeamKpi {
  const teamEvents = events.filter((e) => e.team?.name === team);
  const oppEvents = events.filter((e) => e.team?.name === opponent);

  // Total shots.
  const shots = teamEvents.filter((e) => e.type?.name === 'Shot').length;

  // xG: sum of statsbomb_xg over our shots.
  const xg = teamEvents
    .filter((e) => e.type?.name === 'Shot')
    .reduce<number>((sum, e) => sum + (e.shot?.statsbomb_xg ?? 0), 0);

  // Possession %: pass-count share. Less precise than time-based
  // possession but the standard quick proxy.
  const teamPasses = teamEvents.filter((e) => e.type?.name === 'Pass');
  const oppPasses = oppEvents.filter((e) => e.type?.name === 'Pass');
  const totalPasses = teamPasses.length + oppPasses.length;
  const possession =
    totalPasses > 0 ? (teamPasses.length / totalPasses) * 100 : 50;

  // Pass completion %: a pass is complete iff pass.outcome is not set.
  const completedPasses = teamPasses.filter((e) => !e.pass?.outcome).length;
  const passCompletion =
    teamPasses.length > 0 ? (completedPasses / teamPasses.length) * 100 : 0;

  // PPDA = opponent passes attempted in opponent's own 60% of the pitch
  //        ÷ our defensive actions in that same physical zone.
  //
  // StatsBomb pitch is 120 long; events are recorded in the actor's
  // POV (their team always attacks "right"). The same physical zone
  // therefore has different coordinate bounds in each team's frame:
  //   - opponent's own 60% in opp's POV  → opp.x ≤ 72
  //   - opponent's own 60% in our POV    → our.x ≥ 48
  const oppPassesInZone = oppPasses.filter((e) => {
    const x = e.location?.[0];
    return typeof x === 'number' && x <= 72;
  }).length;

  const ourDefActions = teamEvents.filter((e) => {
    const x = e.location?.[0];
    if (typeof x !== 'number' || x < 48) return false;
    const type = e.type?.name;
    if (type === 'Interception') return true;
    if (type === 'Foul Committed') return true;
    if (type === 'Duel' && e.duel?.type?.name === 'Tackle') return true;
    return false;
  }).length;

  const ppda =
    ourDefActions > 0 ? oppPassesInZone / ourDefActions : null;

  // Progressive passes: forward pass that advances ≥ 10 units in x
  // (same threshold used in scripts/load_data.py).
  const progressivePasses = teamPasses.filter((e) => {
    const start = e.location;
    const end = e.pass?.end_location;
    return (
      Array.isArray(start) &&
      Array.isArray(end) &&
      typeof start[0] === 'number' &&
      typeof end[0] === 'number' &&
      end[0] - start[0] >= 10
    );
  }).length;

  return {
    team,
    shots,
    xg: Number(xg.toFixed(2)),
    possession: Number(possession.toFixed(1)),
    pass_completion: Number(passCompletion.toFixed(1)),
    ppda: ppda !== null ? Number(ppda.toFixed(2)) : null,
    progressive_passes: progressivePasses,
  };
}
