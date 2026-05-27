'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Sparkles } from 'lucide-react';

import AiPanel, { type AssistantMode } from './AiPanel';

// ── Types ──────────────────────────────────────────────────────────

/**
 * What the currently-active page has loaded. Used by the nav for the
 * breadcrumb display and by the floating Ask-AI button for context.
 * Pages call setSelection() in a useEffect when their selection
 * changes, and clear it in the effect's cleanup (so navigating away
 * removes the breadcrumb).
 */
export type Selection = {
  label: string;
  sub?: string;
  context: unknown;
} | null;

/** Config passed to openAssistant() to open the panel from anywhere. */
export type AssistantConfig = {
  mode: AssistantMode;
  eyebrow: string;
  title: string | null;
  subtitle?: string | null;
  context: unknown;
};

type AppContextValue = {
  selection: Selection;
  setSelection: (s: Selection) => void;
  openAssistant: (c: AssistantConfig) => void;
  closeAssistant: () => void;
};

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useApp must be used within <AppShell>.');
  }
  return ctx;
}

// ── Nav links ──────────────────────────────────────────────────────

const NAV_LINKS = [
  { href: '/scouting', label: 'Scouting' },
  { href: '/matches', label: 'Matches' },
];

// ── Shell ──────────────────────────────────────────────────────────

export default function AppShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const [selection, setSelectionInner] = useState<Selection>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantConfig, setAssistantConfig] =
    useState<AssistantConfig | null>(null);

  // Stable callbacks so consumers (pages) don't see referential churn
  // and re-fire their useEffects on every parent render.
  const setSelection = useCallback((s: Selection) => {
    setSelectionInner(s);
  }, []);

  const openAssistant = useCallback((c: AssistantConfig) => {
    setAssistantConfig(c);
    setAssistantOpen(true);
  }, []);

  const closeAssistant = useCallback(() => {
    setAssistantOpen(false);
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({ selection, setSelection, openAssistant, closeAssistant }),
    [selection, setSelection, openAssistant, closeAssistant],
  );

  return (
    <AppContext.Provider value={value}>
      <div className="flex h-screen flex-col">
        <NavBar />
        <main className="flex-1 overflow-y-auto bg-white">{children}</main>
      </div>

      {/*
        AiPanel is always mounted so the slide-in transition runs on
        the FIRST open (not just subsequent opens). When closed it
        sits off-screen via translate-x-full inside AiPanel itself.
        Props fall back to safe defaults until openAssistant() fills
        them in.
      */}
      <AiPanel
        open={assistantOpen}
        onClose={closeAssistant}
        eyebrow={assistantConfig?.eyebrow ?? 'Assistant'}
        title={assistantConfig?.title ?? null}
        subtitle={assistantConfig?.subtitle ?? null}
        mode={assistantConfig?.mode ?? 'natural_language'}
        context={assistantConfig?.context ?? null}
      />
    </AppContext.Provider>
  );
}

// ── NavBar ─────────────────────────────────────────────────────────

function NavBar() {
  const { selection, openAssistant } = useApp();
  const pathname = usePathname();

  function handleAskAi() {
    openAssistant({
      mode: 'natural_language',
      eyebrow: 'Ask Assistant',
      title: selection?.label ?? 'Ask anything',
      subtitle:
        selection?.sub ??
        'Pick a player or match first to ground answers in real data.',
      context: selection?.context ?? null,
    });
  }

  return (
    <header className="shrink-0 border-b border-white/10 bg-[#1A3C2E] text-white">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-6">
        <Link
          href="/"
          className="whitespace-nowrap text-sm font-semibold tracking-tight"
        >
          Football Analytics Hub
        </Link>

        <nav className="flex items-center gap-1">
          {NAV_LINKS.map((link) => {
            const active =
              pathname === link.href ||
              pathname?.startsWith(link.href + '/') ||
              false;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? 'bg-white/10 text-white'
                    : 'text-white/70 hover:bg-white/5 hover:text-white'
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        {selection && (
          <div className="hidden min-w-0 items-center gap-2 text-sm md:flex">
            <span className="text-white/30">/</span>
            <span className="truncate font-medium text-white">
              {selection.label}
            </span>
            {selection.sub && (
              <span className="truncate text-xs text-white/50">
                · {selection.sub}
              </span>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={handleAskAi}
          className="ml-auto flex shrink-0 items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-white/30"
        >
          <Sparkles className="h-4 w-4" />
          Ask AI
        </button>
      </div>
    </header>
  );
}
