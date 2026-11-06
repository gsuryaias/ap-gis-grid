// App header: brand · lens tabs · search (map lenses) · Live badge · Copy link · ⋯ menu.
// On a phone: brand + Live + ⋯ on one row, the lens tabs full-width under it (search sits on the map).
import { CopyLinkButton } from "../components/CopyLink.tsx";
import { LiveStatusBadge } from "../components/LiveStatus.tsx";
import { SearchBar } from "../components/SearchBar.tsx";
import type { GridData } from "../data/types.ts";
import { LENS_BY_ID } from "../lenses/registry.ts";
import { formatInt } from "../lib/format.ts";
import { useAppStore } from "../state/store.ts";
import { LensTabs } from "./LensTabs.tsx";
import { MoreMenu } from "./MoreMenu.tsx";

function Brand({ data, compact }: { data: GridData; compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand text-white">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
        </svg>
      </span>
      <div className="min-w-0">
        <h1 className="truncate text-sm font-bold leading-none text-ink">{compact ? "Grid Atlas" : "AP-TRANSCO Grid Atlas"}</h1>
        {!compact && (
          <p className="mt-0.5 hidden truncate text-[10px] text-ink-2 xl:block">
            {formatInt(data.meta.counts.substations)} SS · {formatInt(data.meta.counts.lines)} lines · {formatInt(Math.round(data.meta.totalLengthKm))} km
          </p>
        )}
      </div>
    </div>
  );
}

export function Header({ data, isMobile }: { data: GridData; isMobile: boolean }) {
  const lens = useAppStore((s) => s.lens);
  const mapLens = LENS_BY_ID[lens].layout === "map";

  if (isMobile)
    return (
      <header className="relative z-40 shrink-0 border-b border-line bg-surface px-2.5 pb-2 pt-2">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <Brand data={data} compact />
          </div>
          <LiveStatusBadge />
          <MoreMenu data={data} withCopyLink />
        </div>
        <div className="mt-2">
          <LensTabs fill />
        </div>
      </header>
    );

  return (
    <header className="relative z-40 flex shrink-0 items-center gap-3 border-b border-line bg-surface px-3 py-2">
      <Brand data={data} />
      <LensTabs />
      <div className="min-w-0 max-w-[460px] flex-1">{mapLens && <SearchBar data={data} />}</div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <LiveStatusBadge />
        <CopyLinkButton />
        <MoreMenu data={data} />
      </div>
    </header>
  );
}
