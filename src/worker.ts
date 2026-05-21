/**
 * Worker thread entry point for isolated WebAssembly execution.
 *
 * This module is spawned as a dedicated Worker thread by {@link module:wasmRunner}
 * so the host can terminate it on wall-clock timeout without any cleanup burden.
 * The standard WebAssembly API has no fuel metering, so the timeout is the
 * only bound against non-terminating modules.
 *
 * Input is received via `workerData` (see {@link WorkerInput}).
 * Results are posted back via `parentPort` as a {@link WorkerOutput} message.
 */
import { parentPort, workerData } from "worker_threads";

/** Structured input passed to the worker via `workerData`. */
interface WorkerInput {
  /** Raw wasm module bytes as a plain number array (for structured clone compatibility). */
  wasmBytes: number[];
  /** Name of the exported function to invoke. */
  funcName: string;
  /** Call arguments (numeric, passed directly to the wasm function). */
  args: number[];
}

/** Discriminated-union message posted back to the parent thread. */
type WorkerOutput =
  | { ok: true; results: unknown[] }
  | { ok: false; error: string };

async function run(): Promise<void> {
  const { wasmBytes, funcName, args } = workerData as WorkerInput;

  try {
    const buffer = Buffer.from(wasmBytes);
    const wasmModule = new WebAssembly.Module(buffer);
    const instance = new WebAssembly.Instance(wasmModule, {});

    const fn = (instance.exports as Record<string, unknown>)[funcName];
    if (typeof fn !== "function") {
      parentPort!.postMessage({ ok: false, error: `No exported function named '${funcName}'` });
      return;
    }

    const raw = fn(...args) as unknown;
    const results = raw === undefined || raw === null ? [] : [raw];
    parentPort!.postMessage({ ok: true, results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    parentPort!.postMessage({ ok: false, error: `Execution trap: ${msg}` });
  }
}

run();
