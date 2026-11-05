// Workspace registry — the single place a new workspace is declared (see the DSS revamp spec §5:
// one folder under src/workspaces/<id>/ + one entry here; the shell handles switcher + routing).
import type { ComponentType } from "react";

export type WorkspaceId = "atlas" | "mis";

export interface WorkspaceDef {
  id: WorkspaceId;
  label: string;
  description: string;
  /** Lazy chunk loader. Absent for the Atlas — it is the inline default, never code-split out. */
  load?: () => Promise<{ default: ComponentType }>;
}

export const WORKSPACES: WorkspaceDef[] = [
  {
    id: "atlas",
    label: "Atlas",
    description: "The reference map and lookup tool for the AP-TRANSCO transmission network.",
  },
  {
    id: "mis",
    label: "Network MIS",
    description: "Asset inventory, line age, N-1 exposure and 33 kV downstream load — drill down by circle, zone, division, voltage and more.",
    load: () => import("./mis/MisWorkspace.tsx"),
  },
];

export function isWorkspaceId(v: unknown): v is WorkspaceId {
  return v === "atlas" || v === "mis";
}
