/**
 * scoutingReportSkill
 *
 * Builds the system + user prompt for producing a structured scouting
 * report on a single player. Intended to be consumed by the AI panel
 * on the scouting page.
 */

export type PromptPair = {
  system: string;
  user: string;
};

/**
 * Minimal input shape — structurally compatible with the app's `Player`
 * type, so the page can pass that in directly.
 */
export type PlayerData = {
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
  totals: {
    goals: number;
    xg: number;
    assists: number;
    xa: number;
    shots: number;
    progressive_passes: number;
    carries: number;
    pressures: number;
    tackles: number;
    interceptions: number;
  };
};

const SYSTEM_PROMPT = `You are a senior football scout writing for the Sporting Director. They make signing decisions worth tens of millions and need decisive, data-driven analysis — not marketing copy.

Produce every report using this exact structure:

**Overview**
A short paragraph (2-3 sentences) summarising the player's profile, role, and current level.

**Key Strengths** (exactly 3 bullets)
Each bullet must cite at least one specific metric from the data provided.

**Areas of Concern** (exactly 2 bullets)
Each bullet must cite at least one specific metric or a quantitative gap from the data.

**Positional Fit**
2-3 sentences on which tactical systems and roles suit the player, grounded in the metrics.

**Transfer Recommendation**
A direct verdict — one of: Strong Buy / Buy at Right Price / Watchlist / Pass — with one sentence of reasoning.

Style rules:
- Reference numbers explicitly when making claims (e.g., "0.97 goals/90", "9.4 pressures/90").
- No hyperbole, no marketing language.
- Be willing to give negative verdicts when the data warrants.
- Do not invent metrics beyond what is provided.
- Be concise — the Director scans, doesn't read.`;

function formatPlayer(p: PlayerData): string {
  const positionLine = p.position
    ? `${p.position}${p.position_group ? ` (broad group: ${p.position_group})` : ''}`
    : p.position_group ?? 'Unknown';

  return [
    `Player: ${p.player ?? 'Unknown'}`,
    `Team: ${p.team ?? 'Unknown'}`,
    `Position: ${positionLine}`,
    `Minutes in sample: ${Math.round(p.minutes).toLocaleString()}`,
    ``,
    `Per-90 metrics:`,
    `- Goals: ${p.goals_per90.toFixed(2)}`,
    `- xG: ${p.xg_per90.toFixed(2)}`,
    `- Assists: ${p.assists_per90.toFixed(2)}`,
    `- xA: ${p.xa_per90.toFixed(2)}`,
    `- Shots: ${p.shots_per90.toFixed(2)}`,
    `- Progressive passes: ${p.progressive_passes_per90.toFixed(2)}`,
    `- Carries: ${p.carries_per90.toFixed(2)}`,
    `- Pressures: ${p.pressures_per90.toFixed(2)}`,
    `- Tackles: ${p.tackles_per90.toFixed(2)}`,
    `- Interceptions: ${p.interceptions_per90.toFixed(2)}`,
    ``,
    `Totals across the sample:`,
    `- Goals: ${p.totals.goals}`,
    `- xG: ${p.totals.xg.toFixed(2)}`,
    `- Assists: ${p.totals.assists}`,
    `- xA: ${p.totals.xa.toFixed(2)}`,
    `- Shots: ${p.totals.shots}`,
    `- Progressive passes: ${p.totals.progressive_passes}`,
    `- Pressures: ${p.totals.pressures}`,
    `- Tackles: ${p.totals.tackles}`,
    `- Interceptions: ${p.totals.interceptions}`,
  ].join('\n');
}

export function buildScoutingPrompt(playerData: PlayerData): PromptPair {
  return {
    system: SYSTEM_PROMPT,
    user: `Produce a scouting report on the following player.\n\n${formatPlayer(playerData)}`,
  };
}
