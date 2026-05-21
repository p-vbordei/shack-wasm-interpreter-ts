import { describe, test, expect } from "@jest/globals";
import { runWasm, validateWasm } from "../src/wasmRunner.js";

const ADD_WAT = `
(module
  (func (export "add") (param i32 i32) (result i32)
    local.get 0
    local.get 1
    i32.add
  )
)
`;

const INFINITE_LOOP_WAT = `
(module
  (func (export "run")
    (loop $l
      br $l
    )
  )
)
`;

const CONST_WAT = `
(module
  (func (export "answer") (result i32)
    i32.const 42
  )
)
`;

function extractText(result: unknown): unknown {
  const r = result as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text);
}

describe("run_wasm", () => {
  test("adds two integers", async () => {
    const result = await runWasm({ wat: ADD_WAT, function: "add", args: [3, 7] });
    const parsed = extractText(result) as { results: number[] };
    expect(parsed.results[0]).toBe(10);
  }, 10000);

  test("infinite loop is terminated by wall-clock timeout", async () => {
    // The worker is killed after EXEC_TIMEOUT_MS; the test must not hang.
    await expect(
      runWasm({ wat: INFINITE_LOOP_WAT, function: "run", args: [] })
    ).rejects.toThrow(/timed out/i);
  }, 15000);

  test("returns a constant result", async () => {
    const result = await runWasm({ wat: CONST_WAT, function: "answer", args: [] });
    const parsed = extractText(result) as { results: number[] };
    expect(parsed.results[0]).toBe(42);
  }, 10000);

  test("argument count mismatch throws", async () => {
    await expect(
      runWasm({ wat: ADD_WAT, function: "add", args: [1] })
    ).rejects.toThrow(/expects/i);
  }, 10000);

  test("missing input throws", async () => {
    await expect(runWasm({})).rejects.toThrow();
  }, 10000);

  test("reports fuel_consumed field", async () => {
    const result = await runWasm({ wat: ADD_WAT, function: "add", args: [1, 2] });
    const parsed = extractText(result) as { fuel_consumed: number };
    expect(typeof parsed.fuel_consumed).toBe("number");
  }, 10000);
});

describe("validate_wasm", () => {
  test("valid module returns valid=true and lists exports", async () => {
    const result = await validateWasm({ wat: ADD_WAT });
    const parsed = extractText(result) as { valid: boolean; exports: Array<{ name: string; kind: string }> };
    expect(parsed.valid).toBe(true);
    expect(parsed.exports).toHaveLength(1);
    expect(parsed.exports[0].name).toBe("add");
    expect(parsed.exports[0].kind).toBe("function");
  }, 10000);

  test("invalid bytes throw validation error", async () => {
    await expect(
      validateWasm({ wasm_base64: "bm90d2FzbQ==" })
    ).rejects.toThrow(/validation failed/i);
  }, 10000);
});
