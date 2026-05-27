/**
 * Skeleton — a pulsing placeholder block used while data loads.
 *
 * Two visual variants depending on the surrounding background:
 *   - default: dark-green tint, for white panels
 *   - `dark`: white tint, for the dark-green sidebar
 *
 * Sizing comes from `className` (e.g. `h-4 w-2/3`) so every skeleton
 * looks like the thing it stands in for.
 */
export function Skeleton({
  className = '',
  dark = false,
}: {
  className?: string;
  dark?: boolean;
}) {
  const bg = dark ? 'bg-white/10' : 'bg-[#1A3C2E]/10';
  return <div className={`animate-pulse rounded ${bg} ${className}`} />;
}

/**
 * KpiCardSkeleton — placeholder mirroring a single TeamKpiPanel cell.
 * Label on top (small bar), value below (larger bar).
 */
export function KpiCardSkeleton() {
  return (
    <div className="rounded-md bg-[#1A3C2E]/5 p-3">
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="mt-2 h-6 w-1/2" />
    </div>
  );
}
