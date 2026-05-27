/**
 * coachingBriefSkill
 *
 * Builds the system + user prompt for producing a post-match coaching
 * brief from the HOME team's perspective. Intended for the AI panel on
 * the matches page.
 */

export type PromptPair = {
  system: string;
  user: string;
};

export type TeamKpi = {
  team: string;
  shots: number;
  xg: number;
  possession: number;        // 0–100
  pass_completion: number;   // 0–100
  ppda: number | null;       // null when there were 0 defensive actions
  progressive_passes: number;
};

/**
 * Minimal input shape — structurally compatible with the matches page's
 * `MatchKpiResponse`, so the page can pass that in directly.
 */
export type MatchKpiData = {
  match: {
    home_team: string;
    away_team: string;
    home_score: number | null;
    away_score: number | null;
    season: string;
    match_date: string;
  };
  kpis: {
    home: TeamKpi;
    away: TeamKpi;
  };
};

const SYSTEM_PROMPT = `You are a first-team performance analyst writing a post-match brief for the head coach. The brief lands in their inbox before the next session — it must be short, direct, and immediately actionable.

The brief is from the HOME team's perspective. "Our" team = home team. The opponent = away team.

Use this exact structure:

**What Worked**
2-3 bullets on what the home team did well. Each bullet must cite at least one specific KPI from the data.

**What Didn't**
2-3 bullets on what underperformed. Each bullet must cite at least one specific KPI from the data.

**Key Individual Performances**
1-2 sentences. Note that individual-level data isn't in this brief — flag which positions or roles to review on tape based on the team-level patterns visible.

**One Tactical Recommendation**
A single concrete adjustment to try in the next match — name a phase, a line, a numerical target. Vague advice ("press harder") is not acceptable. Justify with KPI evidence.

Style rules:
- Speak to the coach as a peer, not a junior.
- Compare home vs away KPIs explicitly (e.g., "PPDA of 9.2 vs their 14.5 — we pressed harder").
- Use the actual numbers from the data.
- No fluff, no narrative recap — just analysis.
- Be willing to flag failures bluntly.`;

function fmt(n: number): string {
  return n.toFixed(2);
}
function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}
function ppda(n: number | null): string {
  return n === null ? '—' : n.toFixed(2);
}

function formatMatch(d: MatchKpiData): string {
  const { match, kpis } = d;
  return [
    `Match: ${match.home_team} (home) vs ${match.away_team} (away)`,
    `Date: ${match.match_date}`,
    `Season: ${match.season}`,
    `Final score: ${match.home_score ?? '?'} - ${match.away_score ?? '?'}`,
    ``,
    `${match.home_team} (HOME — "our" team) KPIs:`,
    `- Shots: ${kpis.home.shots}`,
    `- xG: ${fmt(kpis.home.xg)}`,
    `- Possession: ${pct(kpis.home.possession)}`,
    `- Pass completion: ${pct(kpis.home.pass_completion)}`,
    `- PPDA: ${ppda(kpis.home.ppda)}`,
    `- Progressive passes: ${kpis.home.progressive_passes}`,
    ``,
    `${match.away_team} (AWAY — opponent) KPIs:`,
    `- Shots: ${kpis.away.shots}`,
    `- xG: ${fmt(kpis.away.xg)}`,
    `- Possession: ${pct(kpis.away.possession)}`,
    `- Pass completion: ${pct(kpis.away.pass_completion)}`,
    `- PPDA: ${ppda(kpis.away.ppda)}`,
    `- Progressive passes: ${kpis.away.progressive_passes}`,
  ].join('\n');
}

export function buildCoachingPrompt(matchKPIs: MatchKpiData): PromptPair {
  return {
    system: SYSTEM_PROMPT,
    user: `Produce a post-match brief from the home team's head coach's perspective.\n\n${formatMatch(matchKPIs)}`,
  };
}
