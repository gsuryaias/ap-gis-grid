// DC-flow web worker — runs the base-case solve + full N-1 screen OFF the main thread
// (DSS revamp spec §3 "graph worker"). Vite bundles this as its own module-worker chunk via
// the `new Worker(new URL("./flow.worker.ts", import.meta.url), { type: "module" })` pattern
// in useFlowEngine.ts — no config needed, and nothing here leaks into the Atlas entry chunk.
//
// Protocol (scenario.ts): one FlowWorkerRequest in → "phase" updates while computing, then
// exactly one "result" or "error" out, all keyed by reqId. Compute is synchronous, so
// requests queue naturally in the worker's message queue and answer in order.
import { runFlowCase, type FlowWorkerRequest, type FlowWorkerResponse } from "./scenario.ts";

const post = (msg: FlowWorkerResponse): void => self.postMessage(msg);

self.onmessage = (e: MessageEvent<FlowWorkerRequest>) => {
  const { reqId, spec } = e.data;
  try {
    const result = runFlowCase(spec, (phase) => post({ type: "phase", reqId, phase }));
    post({ type: "result", reqId, result });
  } catch (err) {
    post({ type: "error", reqId, message: err instanceof Error ? err.message : String(err) });
  }
};
