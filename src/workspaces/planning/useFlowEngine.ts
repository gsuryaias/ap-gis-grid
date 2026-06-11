// Typed main-thread wrapper around the flow worker + the React hooks that drive it.
// The engine owns one lazily-created worker; requests are keyed by reqId and resolve to
// promises, with "phase" updates surfaced for the computing state. Compute inside the
// worker is synchronous, so concurrent runs simply queue in its message queue.
import { useEffect, useRef, useState } from "react";
import type { FlowCaseResult, FlowCaseSpec, FlowWorkerRequest, FlowWorkerResponse } from "./scenario.ts";

interface Pending {
  resolve: (r: FlowCaseResult) => void;
  reject: (e: Error) => void;
  onPhase?: (phase: string) => void;
}

export class FlowEngine {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  private ensureWorker(): Worker {
    if (!this.worker) {
      // Vite-native module-worker pattern — bundled as a separate chunk, no config needed.
      this.worker = new Worker(new URL("./flow.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent<FlowWorkerResponse>) => {
        const msg = e.data;
        const p = this.pending.get(msg.reqId);
        if (!p) return; // superseded request — drop silently
        if (msg.type === "phase") {
          p.onPhase?.(msg.phase);
        } else if (msg.type === "result") {
          this.pending.delete(msg.reqId);
          p.resolve(msg.result);
        } else {
          this.pending.delete(msg.reqId);
          p.reject(new Error(msg.message));
        }
      };
      this.worker.onerror = (e: ErrorEvent) => {
        const err = new Error(e.message || "Flow worker failed");
        for (const [id, p] of this.pending) {
          this.pending.delete(id);
          p.reject(err);
        }
      };
    }
    return this.worker;
  }

  run(spec: FlowCaseSpec, onPhase?: (phase: string) => void): Promise<FlowCaseResult> {
    const reqId = this.nextId++;
    return new Promise<FlowCaseResult>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject, onPhase });
      const req: FlowWorkerRequest = { reqId, spec };
      this.ensureWorker().postMessage(req);
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}

/** One engine per mounted studio; the worker is created on first run and torn down on unmount. */
export function useFlowEngine(): FlowEngine {
  const ref = useRef<FlowEngine | null>(null);
  if (!ref.current) ref.current = new FlowEngine();
  useEffect(() => {
    const engine = ref.current!;
    return () => engine.dispose();
  }, []);
  return ref.current;
}

export interface FlowRunState {
  status: "idle" | "computing" | "ready" | "error";
  phase: string | null;
  /** Last completed result — kept on screen while a recompute is in flight. */
  result: FlowCaseResult | null;
  error: string | null;
}

const IDLE: FlowRunState = { status: "idle", phase: null, result: null, error: null };

/**
 * Run a flow case in the worker whenever `spec` changes (pass null to idle the slot).
 * The previous result stays available during a recompute so tables don't blank out;
 * superseded responses are ignored via the cancellation flag.
 */
export function useFlowCase(engine: FlowEngine, spec: FlowCaseSpec | null): FlowRunState {
  const [state, setState] = useState<FlowRunState>(IDLE);
  useEffect(() => {
    if (!spec) {
      setState(IDLE);
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, status: "computing", phase: "Queued", error: null }));
    engine
      .run(spec, (phase) => {
        if (!cancelled) setState((s) => ({ ...s, phase }));
      })
      .then((result) => {
        if (!cancelled) setState({ status: "ready", phase: null, result, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState((s) => ({
            ...s,
            status: "error",
            phase: null,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [engine, spec]);
  return state;
}

/** Debounce a value (slider drags etc.) so worker runs only fire once input settles. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
