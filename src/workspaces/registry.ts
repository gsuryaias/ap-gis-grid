// Workspace registry — the single place a new workspace is declared (see the DSS revamp spec §5:
// one folder under src/workspaces/<id>/ + one entry here; the shell handles switcher + routing).
import type { ComponentType } from "react";

export type WorkspaceId = "atlas" | "risk";

export interface WorkspaceDef {
  id: WorkspaceId;
  label: string;
  description: string;
  /** Lazy chunk loader. Absent for the Atlas — it is the inline default, never code-split out. */
  load?: () => Promise<{ default: ComponentType }>;
  /** Dataset manifests (by id) this workspace depends on; the shell can gate/badge on them. */
  requiredManifests: string[];
}

export const WORKSPACES: WorkspaceDef[] = [
  {
    id: "atlas",
    label: "Atlas",
    description: "The reference map and lookup tool for the AP-TRANSCO transmission network.",
    requiredManifests: [],
  },
  {
    id: "risk",
    label: "Risk Room",
    description: "Hazard layers, scenario-ranked at-risk asset registers and briefing-pack exports.",
    load: () => import("./risk/RiskRoom.tsx"),
    requiredManifests: [],
  },
];

export function isWorkspaceId(v: unknown): v is WorkspaceId {
  return v === "atlas" || v === "risk";
}
