'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Sparkles, X } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';

// Tailwind-styled element overrides for the streamed AI markdown.
// The AI prompts mainly emit paragraphs, **strong** section markers,
// and bullet lists; the rest are belt-and-suspenders.
const markdownComponents: Components = {
  p: ({ children }) => (
    <p className="mb-3 text-sm leading-relaxed text-white/90 last:mb-0">
      {children}
    </p>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-white">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 pl-5 text-sm text-white/90">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5 text-sm text-white/90">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }) => (
    <h1 className="mb-2 mt-4 text-base font-semibold text-white first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-4 text-base font-semibold text-white first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 mt-3 text-sm font-semibold text-white first:mt-0">
      {children}
    </h3>
  ),
  code: ({ children }) => (
    <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-xs">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded bg-black/30 p-3 text-xs">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-white/30 pl-3 italic text-white/70">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-white/20" />,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2 hover:text-white"
    >
      {children}
    </a>
  ),
};

export type AssistantMode =
  | 'scouting_report'
  | 'coaching_brief'
  | 'comparison_report'
  | 'natural_language';

export type AiPanelProps = {
  open: boolean;
  onClose: () => void;
  /** Small uppercase label above the title, e.g. "Scouting Report". */
  eyebrow: string;
  /** Primary heading — a player name, a matchup, etc. */
  title: string | null;
  /** Optional second line under the title. */
  subtitle?: string | null;
  /**
   * Drives the initial POST body's `mode` field. `natural_language`
   * skips the initial fetch — the panel opens empty and waits for the
   * user to submit a question via the input box.
   */
  mode: AssistantMode;
  /** Sent as `data` on both the initial request and any NL follow-ups. */
  context: unknown;
};

// One exchange = one chunk of AI output, with an optional preceding
// user question for follow-ups. The initial report has no question.
type Exchange =
  | { kind: 'report'; text: string }
  | { kind: 'qa'; question: string; answer: string };

export default function AiPanel({
  open,
  onClose,
  eyebrow,
  title,
  subtitle,
  mode,
  context,
}: AiPanelProps) {
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [question, setQuestion] = useState('');

  const abortRef = useRef<AbortController | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Escape closes the panel.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // Lifecycle: when the panel opens, kick off the initial report.
  // When it closes, abort any in-flight request and clear all state
  // so the next open starts fresh.
  //
  // `mode` and `context` are intentionally NOT in the deps — once a
  // panel is open we don't want a context change in the parent to
  // silently re-trigger the stream. Close + reopen to refresh.
  useEffect(() => {
    if (!open) return;
    // Report modes auto-start a stream on open. NL mode opens empty and
    // waits for the user to submit a question via the input.
    if (
      mode === 'scouting_report' ||
      mode === 'coaching_brief' ||
      mode === 'comparison_report'
    ) {
      runReportStream();
    }
    return () => {
      abortRef.current?.abort();
      setExchanges([]);
      setQuestion('');
      setStreaming(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Snap-scroll to bottom as content streams in.
  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [exchanges]);

  async function runReportStream() {
    setExchanges([{ kind: 'report', text: '' }]);
    await streamInto({ mode, data: context }, (chunk) =>
      setExchanges((prev) => {
        const last = prev[prev.length - 1];
        if (!last || last.kind !== 'report') return prev;
        return [...prev.slice(0, -1), { ...last, text: last.text + chunk }];
      }),
    );
  }

  async function runQuestionStream(q: string) {
    setExchanges((prev) => [...prev, { kind: 'qa', question: q, answer: '' }]);
    await streamInto(
      { mode: 'natural_language', data: context, question: q },
      (chunk) =>
        setExchanges((prev) => {
          const last = prev[prev.length - 1];
          if (!last || last.kind !== 'qa') return prev;
          return [
            ...prev.slice(0, -1),
            { ...last, answer: last.answer + chunk },
          ];
        }),
    );
  }

  // Shared streaming worker. POSTs to /api/assistant and pumps text
  // chunks through `onChunk` until the response ends or errors out.
  // Errors (both pre-stream HTTP failures and mid-stream issues) are
  // surfaced as a "[Error: ...]" tail in the output, matching the
  // route's own convention for in-band errors.
  async function streamInto(
    body: object,
    onChunk: (chunk: string) => void,
  ): Promise<void> {
    const abort = new AbortController();
    abortRef.current = abort;
    setStreaming(true);

    try {
      const res = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abort.signal,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }

      if (!res.body) {
        throw new Error('Response has no body.');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        onChunk(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      // User-initiated abort (panel closed mid-stream) — just bail.
      if (err instanceof Error && err.name === 'AbortError') return;
      const msg = err instanceof Error ? err.message : 'Unknown error';
      onChunk(`\n\n[Error: ${msg}]`);
    } finally {
      setStreaming(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || streaming) return;
    setQuestion('');
    runQuestionStream(q);
  }

  return (
    <aside
      aria-hidden={!open}
      className={`fixed inset-y-0 right-0 z-50 flex w-[480px] flex-col bg-[#1A3C2E] text-white shadow-2xl transition-transform duration-300 ease-out ${
        open ? 'translate-x-0' : 'translate-x-full'
      }`}
    >
      <header className="flex items-start justify-between border-b border-white/10 px-6 py-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-white/60">
            {eyebrow}
          </p>
          {title && (
            <h2 className="mt-0.5 truncate text-lg font-semibold leading-tight">
              {title}
            </h2>
          )}
          {subtitle && (
            <p className="mt-0.5 truncate text-xs text-white/60">{subtitle}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          className="-mr-1 shrink-0 rounded p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/30"
        >
          <X className="h-5 w-5" />
        </button>
      </header>

      <div ref={bodyRef} className="flex-1 overflow-y-auto px-6 py-6">
        {exchanges.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center text-white/60">
            {mode === 'natural_language' ? (
              <>
                <Sparkles className="h-8 w-8 text-white/40" />
                <p className="mt-4 max-w-xs text-sm">
                  Ask a question about the data on this page.
                </p>
              </>
            ) : (
              <>
                <Loader2 className="h-8 w-8 animate-spin text-white/40" />
                <p className="mt-4 text-sm">Connecting…</p>
              </>
            )}
          </div>
        )}

        {exchanges.map((exch, i) => {
          const isLast = i === exchanges.length - 1;
          const showCursor = streaming && isLast;
          const text = exch.kind === 'report' ? exch.text : exch.answer;
          return (
            <div
              key={i}
              className={i > 0 ? 'mt-6 border-t border-white/10 pt-6' : ''}
            >
              {exch.kind === 'qa' && (
                <div className="mb-3">
                  <p className="text-xs font-medium uppercase tracking-wider text-white/40">
                    Question
                  </p>
                  <p className="mt-1 text-sm text-white/80">{exch.question}</p>
                </div>
              )}
              <div className="text-white/90">
                <ReactMarkdown components={markdownComponents}>
                  {text}
                </ReactMarkdown>
                {showCursor && (
                  <span
                    aria-hidden
                    className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-white/70 align-middle"
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      <form
        onSubmit={handleSubmit}
        className="border-t border-white/10 px-6 py-4"
      >
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={
            streaming ? 'Waiting for response…' : 'Ask a follow-up question…'
          }
          disabled={streaming}
          aria-label="Ask a follow-up question"
          className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm placeholder-white/40 outline-none transition-colors focus:border-white/40 disabled:cursor-not-allowed disabled:opacity-60"
        />
      </form>
    </aside>
  );
}
