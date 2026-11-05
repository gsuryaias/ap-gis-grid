import type { CtxSlice, SliceCreator, WorkspaceContext } from "../types.ts";

export const createCtxSlice: SliceCreator<CtxSlice> = (set) => ({
  workspaceContext: {},

  setWorkspaceContext: (ctx) =>
    set((s) => {
      const changed = (Object.keys(ctx) as (keyof WorkspaceContext)[]).some((k) => s.workspaceContext[k] !== ctx[k]);
      return changed ? { workspaceContext: { ...s.workspaceContext, ...ctx } } : s;
    }),
});
