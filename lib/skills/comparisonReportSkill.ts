/**
 * comparisonReportSkill
 *
 * Builds the system + user prompt for a side-by-side comparison of two
 * players. Intended for the AI panel on the scouting page's compare
 * mode, when a Sporting Director is choosing between two transfer
 * targets and needs a decisive recommendation.
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

const SYSTEM_PROMPT = `You are a senior football scout writing a side-by-side comparison for the Sporting Director. They are deciding between two transfer targets and need a decisive, data-driven verdict — not a "both have merit" cop-out.

Produce every comparison using this exact structure, with the section names in bold exactly as shown:

**Overview**
2-3 sentences setting up the comparison: what type of players these are, and the broad axes on which they agree or differ.

**Head-to-Head Strengths**
Exactly 3 bullets for EACH player. Use the player's name (or surname) as the bullet-group header, then 3 bullets. Each bullet must cite at least one specific metric. Format:

[Player A name]:
- bullet
- bullet
- bullet

[Player B name]:
- bullet
- bullet
- bullet

**Key Differentiator**
1-2 sentences identifying the single most important difference between the two players — the thing that should drive the Director's decision.

**Best Fit For**
2-3 sentences per player describing the type of club and tactical system they suit. Format as two short paragraphs, prefixed by each player's name.

**Recommendation**
One paragraph picking ONE player to prioritize over the other. State the verdict in the first sentence ("Sign [name]…" or "Prioritize [name] over [name]…"); justify with the metric evidence and the type of club doing the signing.

Style rules:
- Cite specific numbers in head-to-head comparisons (e.g., "0.97 goals/90 vs 0.61 goals/90").
- Take a side. Never write "depends on what you want", "both are excellent", or similar hedges.
- No marketing language, no hyperbole.
- If one player is clearly stronger on the data, say so plainly.
- The Director scans; be concise.`;

function formatPlayer(p: PlayerData, label: string): string {
  const positionLine = p.position
    ? `${p.position}${p.position_group ? ` (broad group: ${p.position_group})` : ''}`
    : p.position_group ?? 'Unknown';

  return [
    `--- ${label} ---`,
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

export function buildComparisonPrompt(
  playerA: PlayerData,
  playerB: PlayerData,
): PromptPair {
  return {
    system: SYSTEM_PROMPT,
    user: `Produce a side-by-side comparison of these two players and recommend which one to prioritize.\n\n${formatPlayer(playerA, 'PLAYER A')}\n\n${formatPlayer(playerB, 'PLAYER B')}`,
  };
}
