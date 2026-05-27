/**
 * naturalLanguageSkill
 *
 * Builds the system + user prompt for a free-form natural-language Q&A
 * grounded in whatever player / match data the app currently has loaded.
 */

export type PromptPair = {
  system: string;
  user: string;
};

const SYSTEM_PROMPT = `You are a football data assistant. Answer the user's question using ONLY the data provided in the context below — do not rely on general knowledge about the player, team, or match.

Rules:
1. Cite specific numbers from the data in your answer (e.g., "0.97 goals per 90", "PPDA of 9.2").
2. If the data doesn't contain enough information to answer, say so explicitly — never speculate or fall back on outside knowledge.
3. Stay under 200 words.
4. Plain prose; use bullets only when listing 3+ discrete items.
5. No hedging ("might", "perhaps", "possibly") unless the data is genuinely ambiguous.`;

/**
 * @param question  The user's free-text question.
 * @param context   Whatever the app currently has loaded — a Player on
 *                  the scouting page, a MatchKpiResponse on the matches
 *                  page, etc. Pre-formatted strings are passed through;
 *                  objects are JSON-stringified so Claude sees the full
 *                  shape.
 */
export function buildNLPrompt(question: string, context: unknown): PromptPair {
  const contextStr =
    typeof context === 'string'
      ? context
      : context == null
        ? '(no context provided)'
        : JSON.stringify(context, null, 2);

  return {
    system: SYSTEM_PROMPT,
    user: `Context data:\n\`\`\`json\n${contextStr}\n\`\`\`\n\nQuestion: ${question}`,
  };
}
