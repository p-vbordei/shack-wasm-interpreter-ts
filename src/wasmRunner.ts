/**
 * WebAssembly execution and validation logic.
 *
 * Execution runs in a Worker thread so the main event loop can enforce a
 * wall-clock timeout: when the worker does not respond in time it is
 * terminated, preventing non-terminating modules from hanging the server.
 *
 * WAT text is compiled to binary using the wabt library before instantiation.
 * The standard WebAssembly API has no fuel metering, so the wall-clock timeout
 * ({@link EXEC_TIMEOUT_MS}) is the only bound against non-terminating modules.
 *
 * @module wasmRunner
 */
import { Worker } from "worker_threads";
import { fileURLToPath } from "url";
import path from "path";
import WabtModule from "wabt";

/** Maximum instruction-budget units reported back to the caller (informational only). */
export const DEFAULT_FUEL_LIMIT = 10_000_000;

/** Wall-clock timeout in milliseconds before a Worker thread is forcibly terminated. */
export const EXEC_TIMEOUT_MS = 5_000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// When running via ts-jest the source files live under src/, but the compiled
// worker lives under dist/. Detect the layout and resolve accordingly.
function resolveWorkerPath(): string {
  const inSrc = __dirname.endsWith(path.sep + "src") || __dirname.endsWith("/src");
  if (inSrc) {
    return path.join(__dirname, "..", "dist", "worker.js");
  }
  return path.join(__dirname, "worker.js");
}
const WORKER_PATH = resolveWorkerPath();

let wabtReady: ReturnType<typeof WabtModule> | null = null;

async function getWabt() {
  if (!wabtReady) {
    wabtReady = WabtModule();
  }
  return wabtReady;
}

/**
 * Decode WebAssembly module bytes from the tool-call arguments.
 *
 * Looks for `wasm_base64` (base64-encoded `.wasm` bytes) first, then
 * `wat` (WebAssembly Text Format source compiled via wabt).
 *
 * @throws {Error} when neither key is present or the value is malformed.
 */
async function decodeModuleBytes(args: Record<string, unknown>): Promise<Buffer> {
  if (typeof args["wasm_base64"] === "string") {
    try {
      return Buffer.from(args["wasm_base64"].trim(), "base64");
    } catch (err) {
      throw new Error(`Invalid base64: ${err}`);
    }
  }
  if (typeof args["wat"] === "string") {
    try {
      const wabt = await getWabt();
      const parsed = wabt.parseWat("module.wat", args["wat"], {});
      const { buffer } = parsed.toBinary({});
      parsed.destroy();
      return Buffer.from(buffer);
    } catch (err) {
      throw new Error(`WAT parse error: ${err}`);
    }
  }
  throw new Error("Provide either wasm_base64 or wat");
}

/**
 * Normalise a `WebAssembly.ModuleExportDescriptor` kind string to one of
 * `"function"`, `"memory"`, `"table"`, `"global"`, or `"unknown"`.
 */
function getExportKind(kind: string): string {
  switch (kind) {
    case "function": return "function";
    case "memory": return "memory";
    case "table": return "table";
    case "global": return "global";
    default: return "unknown";
  }
}

/**
 * Spawn a Worker thread to execute the WebAssembly function in isolation.
 *
 * The worker is forcibly terminated if it does not respond within `timeoutMs`
 * milliseconds.  This is the primary defence against non-terminating modules
 * because the standard WebAssembly API provides no fuel metering.
 */
function runInWorker(
  wasmBytes: Buffer,
  funcName: string,
  args: number[],
  timeoutMs: number
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: {
        wasmBytes: Array.from(wasmBytes),
        funcName,
        args,
      },
    });

    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("Execution timed out"));
    }, timeoutMs);

    worker.on("message", (msg: { ok: boolean; results?: unknown[]; error?: string }) => {
      clearTimeout(timer);
      worker.terminate();
      if (msg.ok) {
        resolve(msg.results ?? []);
      } else {
        reject(new Error(msg.error ?? "Unknown execution error"));
      }
    });

    worker.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Worker error: ${err.message}`));
    });
  });
}

/**
 * Instantiate a WebAssembly module and invoke an exported function.
 *
 * @param args - Tool-call arguments:
 *   - `wasm_base64` (string) – base64-encoded `.wasm` bytes
 *   - `wat` (string) – WebAssembly Text Format source (used when `wasm_base64` is absent)
 *   - `function` (string, optional) – exported function name; defaults to the first exported function
 *   - `args` (number[]) – integer call arguments
 * @returns MCP content object `{ content: [{ type: "text", text: "<json>" }] }` where
 *   the inner JSON has `function`, `results`, and `fuel_consumed` (always 0 in TypeScript).
 * @throws {Error} on bad module bytes, missing export, arity mismatch, or execution trap.
 */
export async function runWasm(args: Record<string, unknown>): Promise<unknown> {
  const wasmBytes = await decodeModuleBytes(args);

  let wasmModule: WebAssembly.Module;
  try {
    // Copy into a plain ArrayBuffer to satisfy the BufferSource constraint.
    const ab = new ArrayBuffer(wasmBytes.byteLength);
    new Uint8Array(ab).set(wasmBytes);
    wasmModule = new WebAssembly.Module(ab);
  } catch (err) {
    throw new Error(`Module compilation error: ${err}`);
  }

  const allExports = WebAssembly.Module.exports(wasmModule);
  const funcExports = allExports.filter((e) => e.kind === "function");

  let funcName: string;
  if (typeof args["function"] === "string") {
    funcName = args["function"];
  } else {
    if (funcExports.length === 0) {
      throw new Error("Module has no exported functions");
    }
    funcName = funcExports[0].name;
  }

  const found = funcExports.find((e) => e.name === funcName);
  if (!found) {
    throw new Error(`No exported function named '${funcName}'`);
  }

  // Instantiate without user code to inspect the function arity.
  let expectedArity = -1;
  try {
    const dummy = new WebAssembly.Instance(wasmModule, {});
    const fn = (dummy.exports as Record<string, unknown>)[funcName];
    if (typeof fn === "function") {
      expectedArity = fn.length;
    }
  } catch {
    // If instantiation requires imports we cannot pre-check arity.
  }

  const rawArgs: number[] = Array.isArray(args["args"])
    ? (args["args"] as unknown[]).map((v) => Number(v))
    : [];

  if (expectedArity >= 0 && rawArgs.length !== expectedArity) {
    throw new Error(
      `Function '${funcName}' expects ${expectedArity} argument(s), got ${rawArgs.length}`
    );
  }

  const results = await runInWorker(wasmBytes, funcName, rawArgs, EXEC_TIMEOUT_MS);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          function: funcName,
          results,
          // Without native fuel metering we report 0; the timeout is the bound.
          fuel_consumed: 0,
        }),
      },
    ],
  };
}

/**
 * Parse and validate a WebAssembly module without executing it.
 *
 * @param args - Tool-call arguments:
 *   - `wasm_base64` (string) – base64-encoded `.wasm` bytes
 *   - `wat` (string) – WebAssembly Text Format source
 * @returns MCP content object where the inner JSON has `valid: true` and an
 *   `exports` list, each item with `name` and `kind`.
 * @throws {Error} if the module cannot be parsed or validated.
 */
export async function validateWasm(args: Record<string, unknown>): Promise<unknown> {
  const wasmBytes = await decodeModuleBytes(args);

  let wasmModule: WebAssembly.Module;
  try {
    // Copy into a plain ArrayBuffer to satisfy the BufferSource constraint.
    const ab = new ArrayBuffer(wasmBytes.byteLength);
    new Uint8Array(ab).set(wasmBytes);
    wasmModule = new WebAssembly.Module(ab);
  } catch (err) {
    throw new Error(`Validation failed: ${err}`);
  }

  const exports = WebAssembly.Module.exports(wasmModule).map((exp) => ({
    name: exp.name,
    kind: getExportKind(exp.kind),
  }));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ valid: true, exports }),
      },
    ],
  };
}
