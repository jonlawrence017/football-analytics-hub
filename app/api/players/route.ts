import { promises as fs } from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';

type Player = {
  player_id: number;
  player: string | null;
  team: string | null;
  position?: string | null;
  position_group?: string | null;
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
  totals: Record<string, number>;
};

const DATA_PATH = path.join(process.cwd(), 'public', 'data', 'players.json');

export async function GET(request: NextRequest) {
  let players: Player[];

  try {
    const raw = await fs.readFile(DATA_PATH, 'utf-8');
    players = JSON.parse(raw);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return NextResponse.json(
        { error: 'players.json not found. Run scripts/load_data.py first.' },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: 'Failed to read or parse players.json.' },
      { status: 500 },
    );
  }

  if (!Array.isArray(players)) {
    return NextResponse.json(
      { error: 'players.json is malformed (expected an array).' },
      { status: 500 },
    );
  }

  const team = request.nextUrl.searchParams.get('team');
  const position = request.nextUrl.searchParams.get('position');

  let filtered = players;
  if (team) {
    const needle = team.toLowerCase();
    filtered = filtered.filter((p) => p.team?.toLowerCase() === needle);
  }
  if (position) {
    // Accept either a broad group ("Forward") or a granular StatsBomb
    // position ("Right Wing"). Match against position_group OR position.
    const needle = position.toLowerCase();
    filtered = filtered.filter(
      (p) =>
        p.position_group?.toLowerCase() === needle ||
        p.position?.toLowerCase() === needle,
    );
  }

  return NextResponse.json(filtered);
}
