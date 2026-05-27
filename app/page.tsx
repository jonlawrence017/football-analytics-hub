import Link from 'next/link';
import { ArrowUpRight, Target, Trophy } from 'lucide-react';

export default function HomePage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-16 sm:px-10 sm:py-20">
      <header className="mb-12">
        <h1 className="text-3xl font-bold tracking-tight text-[#1A3C2E] sm:text-4xl">
          Football Analytics Hub
        </h1>
        <p className="mt-3 max-w-2xl text-base text-[#1A3C2E]/70 sm:text-lg">
          La Liga player and match analytics built on StatsBomb open data — with
          an AI assistant grounded in the numbers you&apos;re looking at.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6">
        <HomeCard
          href="/scouting"
          icon={<Target className="h-5 w-5" />}
          title="Scouting"
          description="Per-90 player profiles with radar charts, position-aware percentile ranks, and AI-written scouting reports."
        />
        <HomeCard
          href="/matches"
          icon={<Trophy className="h-5 w-5" />}
          title="Matches"
          description="Match KPIs, shot maps, pass networks, and AI-generated post-match coaching briefs."
        />
      </div>
    </div>
  );
}

function HomeCard({
  href,
  icon,
  title,
  description,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="group block rounded-lg border border-[#1A3C2E]/10 bg-white p-6 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-[#1A3C2E]/25 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-[#1A3C2E]/30"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[#1A3C2E] text-white">
          {icon}
        </div>
        <ArrowUpRight className="h-5 w-5 text-[#1A3C2E]/30 transition-colors group-hover:text-[#1A3C2E]/70" />
      </div>
      <h2 className="mt-4 text-xl font-semibold text-[#1A3C2E]">{title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-[#1A3C2E]/70">
        {description}
      </p>
    </Link>
  );
}
