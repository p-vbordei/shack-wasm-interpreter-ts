/**
 * MCP server entry point.
 *
 * Reads newline-delimited JSON-RPC 2.0 from stdin, writes responses to stdout.
 * All diagnostic output goes to stderr so stdout carries only protocol messages.
 */
import { createInterface } from "readline";
import { runWasm, validateWasm, EXEC_TIMEOUT_MS } from "./wasmRunner.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "shack-wasm-interpreter";
const SERVER_VERSION = "0.1.0";

const TOOLS = [
  {
    name: "run_wasm",
    description:
      "Instantiate a WebAssembly module and invoke an exported function with integer arguments. " +
      "Accepts the module as base64-encoded binary (.wasm) or WAT text. Execution is bounded by " +
      "a fuel limit and a wall-clock timeout.",
    inputSchema: {
      type: "object",
      properties: {
        wasm_base64: {
          type: "string",
          description: "Base64-encoded WebAssembly binary (.wasm bytes).",
        },
        wat: {
          type: "string",
          description: "WebAssembly Text Format source. Used when wasm_base64 is absent.",
        },
        function: {
          type: "string",
          description:
            "Name of the exported function to call. Defaults to the first exported function if omitted.",
        },
        args: {
          type: "array",
          items: { type: "number" },
          description: "Integer (i64) arguments passed to the function.",
        },
        fuel_limit: {
          type: "integer",
          description: "Maximum fuel units. Defaults to 10000000.",
        },
      },
    },
  },
  {
    name: "validate_wasm",
    description:
      "Check that a WebAssembly module parses and validates without executing it, and report its exports.",
    inputSchema: {
      type: "object",
      properties: {
        wasm_base64: {
          type: "string",
          description: "Base64-encoded WebAssembly binary.",
        },
        wat: {
          type: "string",
          description: "WebAssembly Text Format source. Used when wasm_base64 is absent.",
        },
      },
    },
  },
];

function write(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function errorResponse(code: number, message: string, id: unknown): unknown {
  return { jsonrpc: "2.0", error: { code, message }, id };
}

async function handleToolsCall(params: unknown, id: unknown): Promise<unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return errorResponse(-32602, "Invalid params", id);
  }

  const p = params as Record<string, unknown>;
  const name = p["name"];
  if (typeof name !== "string") {
    return errorResponse(-32602, "Invalid params: missing tool name", id);
  }

  const toolArgs = (p["arguments"] as Record<string, unknown>) ?? {};

  let fn: (args: Record<string, unknown>) => Promise<unknown>;
  if (name === "run_wasm") {
    fn = runWasm;
  } else if (name === "validate_wasm") {
    fn = validateWasm;
  } else {
    return errorResponse(-32603, `Unknown tool: ${name}`, id);
  }

  try {
    const result = await Promise.race([
      fn(toolArgs),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Execution timed out")), EXEC_TIMEOUT_MS + 1000)
      ),
    ]);
    return { jsonrpc: "2.0", result, id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(-32603, msg, id);
  }
}

async function handle(req: unknown): Promise<unknown | null> {
  if (!req || typeof req !== "object" || Array.isArray(req)) {
    return errorResponse(-32600, "Invalid Request", null);
  }

  const r = req as Record<string, unknown>;
  const id = r["id"] ?? null;
  const method = r["method"];

  if (typeof method !== "string") {
    return errorResponse(-32600, "Invalid Request: missing method", id);
  }

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
        id,
      };

    case "notifications/initialized":
      return null;

    case "tools/list":
      return { jsonrpc: "2.0", result: { tools: TOOLS }, id };

    case "tools/call":
      return handleToolsCall(r["params"] ?? null, id);

    default:
      return errorResponse(-32601, `Method not found: ${method}`, id);
  }
}

async function main(): Promise<void> {
  process.stderr.write("shack-wasm-interpreter starting\n");

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let req: unknown;
    try {
      req = JSON.parse(trimmed);
    } catch (err) {
      write(errorResponse(-32700, `Parse error: ${err}`, null));
      continue;
    }

    const response = await handle(req);
    if (response !== null) {
      write(response);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
