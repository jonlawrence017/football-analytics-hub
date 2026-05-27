import { promises as fs } from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';

type Match = {
  match_id: number;
  season: string;
  match_date: string;
  home_team: string;
  away_team: string;
  home_score: number | null;
  away_score: number | null;
};

const DATA_PATH = path.join(process.cwd(), 'public', 'data', 'matches.json');

export async function GET(request: NextRequest) {
  let matches: Match[];

  try {
    const raw = await fs.readFile(DATA_PATH, 'utf-8');
    matches = JSON.parse(raw);
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

  if (!Array.isArray(matches)) {
    return NextResponse.json(
      { error: 'matches.json is malformed (expected an array).' },
      { status: 500 },
    );
  }

  // ?season=2019%2F2020 decodes to "2019/2020", matching the season field as written.
  const season = request.nextUrl.searchParams.get('season');
  const filtered = season ? matches.filter((m) => m.season === season) : matches;

  return NextResponse.json(filtered);
}
