import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

import {
  buildScoutingPrompt,
  type PlayerData,
} from '@/lib/skills/scoutingReportSkill';
import {
  buildCoachingPrompt,
  type MatchKpiData,
} from '@/lib/skills/coachingBriefSkill';
import { buildNLPrompt } from '@/lib/skills/naturalLanguageSkill';
import {
  buildComparisonPrompt,
  type PlayerData as ComparisonPlayerData,
} from '@/lib/skills/comparisonReportSkill';

// Note: claude-sonnet-4-20250514 is the May 2025 Sonnet 4 release.
// It is deprecated (retires 2026-06-15); plan to migrate to
// `claude-sonnet-4-6` before then.
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1000;

type AssistantMode =
  | 'scouting_report'
  | 'coaching_brief'
  | 'comparison_report'
  | 'natural_language';

const VALID_MODES: AssistantMode[] = [
  'scouting_report',
  'coaching_brief',
  'comparison_report',
  'natural_language',
];

type AssistantRequest = {
  mode: AssistantMode;
  data?: unknown;
  question?: string;
};

export async function POST(request: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY is not configured on the server.' },
      { status: 500 },
    );
  }

  // ── Parse and validate the request body ────────────────────────────
  let body: AssistantRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Request body must be valid JSON.' },
      { status: 400 },
    );
  }

  if (!VALID_MODES.includes(body.mode)) {
    return NextResponse.json(
      {
        error: `Invalid mode "${body.mode}". Expected one of: ${VALID_MODES.join(
          ', ',
        )}.`,
      },
      { status: 400 },
    );
  }

  // ── Dispatch to the right skill function ──────────────────────────
  // Each skill's input type is structurally minimal — the API receives
  // unknown JSON, so we cast at the boundary and let the prompt builder
  // throw if the shape is wrong (caught below as a 400).
  let prompt: { system: string; user: string };
  try {
    switch (body.mode) {
      case 'scouting_report':
        if (!body.data || typeof body.data !== 'object') {
          return NextResponse.json(
            { error: '`data` (a Player object) is required for scouting_report.' },
            { status: 400 },
          );
        }
        prompt = buildScoutingPrompt(body.data as PlayerData);
        break;

      case 'coaching_brief':
        if (!body.data || typeof body.data !== 'object') {
          return NextResponse.json(
            { error: '`data` (a MatchKpiResponse object) is required for coaching_brief.' },
            { status: 400 },
          );
        }
        prompt = buildCoachingPrompt(body.data as MatchKpiData);
        break;

      case 'comparison_report': {
        if (!body.data || typeof body.data !== 'object') {
          return NextResponse.json(
            { error: '`data` (an object with `playerA` and `playerB`) is required for comparison_report.' },
            { status: 400 },
          );
        }
        const pair = body.data as {
          playerA?: ComparisonPlayerData;
          playerB?: ComparisonPlayerData;
        };
        if (!pair.playerA || !pair.playerB) {
          return NextResponse.json(
            { error: '`data.playerA` and `data.playerB` are both required for comparison_report.' },
            { status: 400 },
          );
        }
        prompt = buildComparisonPrompt(pair.playerA, pair.playerB);
        break;
      }

      case 'natural_language':
        if (typeof body.question !== 'string' || !body.question.trim()) {
          return NextResponse.json(
            { error: '`question` is required for natural_language.' },
            { status: 400 },
          );
        }
        prompt = buildNLPrompt(body.question, body.data ?? null);
        break;
    }
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? `Failed to build prompt: ${err.message}`
            : 'Failed to build prompt.',
      },
      { status: 400 },
    );
  }

  // ── Open the streaming Anthropic call ─────────────────────────────
  // messages.stream() is the SDK's streaming equivalent of
  // messages.create({stream: true}). AbortController lets us cancel
  // the upstream request if the client disconnects, so we stop
  // burning tokens on a response no one will read.
  const client = new Anthropic({ apiKey });
  const abortController = new AbortController();

  const sdkStream = client.messages.stream(
    {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Wrap the system prompt as a content block with cache_control so
      // repeated calls reuse the prefix. Forward-compatible: the marker
      // is a no-op on Sonnet 4 today (system prompts here are ~250-300
      // tokens, below the 1024-token caching minimum) but kicks in
      // automatically if prompts grow past the threshold.
      system: [
        {
          type: 'text',
          text: prompt.system,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: prompt.user }],
    },
    { signal: abortController.signal },
  );

  // ── Pipe SDK events into a plain UTF-8 text stream ────────────────
  // We forward only text deltas. Once the HTTP response headers are
  // flushed we can't change the status, so mid-stream errors are
  // emitted as a tagged tail rather than swallowed.
  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of sdkStream) {
          if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta'
          ) {
            controller.enqueue(encoder.encode(event.delta.text));
          }
        }
        controller.close();
      } catch (err) {
        let message: string;
        if (err instanceof Anthropic.APIError) {
          message = `Anthropic API error ${err.status}: ${err.message}`;
        } else if (err instanceof Error) {
          message = err.message;
        } else {
          message = 'Unknown streaming error.';
        }
        controller.enqueue(encoder.encode(`\n\n[Error: ${message}]`));
        controller.close();
      }
    },
    cancel() {
      abortController.abort();
    },
  });

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
