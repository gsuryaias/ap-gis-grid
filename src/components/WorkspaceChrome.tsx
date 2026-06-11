import { useAppStore } from "../state/store.ts";
import { WORKSPACES, type WorkspaceId } from "../workspaces/registry.ts";
import { MapIcon } from "./icons.tsx";

const MAP_WIDTH: Record<Exclude<WorkspaceId, "atlas">, string> = {
  risk: "min(44%, 520px)",
  planning: "min(46%, 540px)",
  mis: "min(34%, 380px)",
};

export function workspaceMapWidth(workspace: WorkspaceId): string | undefined {
  if (workspace === "atlas") return undefined;
  return MAP_WIDTH[workspace];
}

/** Slim strip above analysis content — workspace identity + map pane control. */
export function WorkspaceChrome() {
  const workspace = useAppStore((s) => s.workspace);
  const mapLayout = useAppStore((s) => s.mapLayout);
  const setMapLayout = useAppStore((s) => s.setMapLayout);

  if (workspace === "atlas") return null;

  const def = WORKSPACES.find((w) => w.id === workspace)!;
  const mapOpen = mapLayout === "open";

  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-line bg-surface/90 px-4 py-2 backdrop-blur">
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-semibold text-ink">{def.label}</h2>
        <p className="truncate text-[11px] text-ink-2">{def.description}</p>
      </div>
      <button
        type="button"
        onClick={() => setMapLayout(mapOpen ? "collapsed" : "open")}
        aria-pressed={mapOpen}
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
          mapOpen
            ? "border-accent/40 bg-accent/10 text-accent"
            : "border-line text-ink-2 hover:bg-surface-2 hover:text-ink"
        }`}
      >
        <MapIcon width={13} height={13} />
        {mapOpen ? "Hide map" : "Show map"}
      </button>
    </header>
  );
}
