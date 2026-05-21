/**
 * Unit tests for the wasmRunner module.
 *
 * Covers success paths and error paths for both runWasm and validateWasm,
 * including malformed input, wrong arity, missing exports, timeout, and
 * WAT-to-binary round-trips.
 */
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

// ── additional error-path and boundary tests ──────────────────────────────────

describe("run_wasm error paths", () => {
  test("invalid base64 string throws", async () => {
    await expect(
      runWasm({ wasm_base64: "not-valid-base64!!!" })
    ).rejects.toThrow();
  }, 10000);

  test("invalid WAT syntax throws", async () => {
    await expect(
      runWasm({ wat: "(module (func (export \"bad\") i99.const 0))" })
    ).rejects.toThrow(/wat parse error/i);
  }, 10000);

  test("missing export name throws", async () => {
    await expect(
      runWasm({ wat: ADD_WAT, function: "nonexistent_fn", args: [] })
    ).rejects.toThrow(/nonexistent_fn/);
  }, 10000);

  test("module with no exports throws", async () => {
    const noExportWat = `(module (func))`;
    await expect(
      runWasm({ wat: noExportWat, args: [] })
    ).rejects.toThrow(/no exported/i);
  }, 10000);

  test("too many arguments throws", async () => {
    await expect(
      runWasm({ wat: ADD_WAT, function: "add", args: [1, 2, 3] })
    ).rejects.toThrow(/expects/i);
  }, 10000);

  test("garbage wasm bytes throw compilation error", async () => {
    // Valid base64 of 0x00 0x01 0x02 0x03 — not a wasm module.
    await expect(
      runWasm({ wasm_base64: "AAQEBA==" })
    ).rejects.toThrow();
  }, 10000);

  test("no input fields throws", async () => {
    await expect(runWasm({})).rejects.toThrow();
  }, 10000);
});

describe("run_wasm success paths", () => {
  test("wasm_base64 round-trip works", async () => {
    // Compile ADD_WAT to bytes and feed them back as base64.
    const WabtModule = (await import("wabt")).default;
    const wabt = await WabtModule();
    const parsed = wabt.parseWat("t.wat", ADD_WAT, {});
    const { buffer } = parsed.toBinary({});
    parsed.destroy();
    const b64 = Buffer.from(buffer).toString("base64");

    const result = await runWasm({ wasm_base64: b64, function: "add", args: [10, 32] });
    const inner = extractText(result) as { results: number[] };
    expect(inner.results[0]).toBe(42);
  }, 10000);

  test("function name is reported in result", async () => {
    const result = await runWasm({ wat: ADD_WAT, function: "add", args: [0, 0] });
    const inner = extractText(result) as { function: string };
    expect(inner.function).toBe("add");
  }, 10000);

  test("i32 add with different values returns correct sum", async () => {
    // Use a pure i32 function to avoid BigInt complications with i64 in JS.
    const mulWat = `
(module
  (func (export "mul") (param i32 i32) (result i32)
    local.get 0
    local.get 1
    i32.mul
  )
)`;
    const result = await runWasm({ wat: mulWat, function: "mul", args: [6, 7] });
    const inner = extractText(result) as { results: number[] };
    expect(inner.results[0]).toBe(42);
  }, 10000);
});

describe("validate_wasm additional", () => {
  test("module with memory and multiple functions lists all exports", async () => {
    const multiWat = `
(module
  (memory (export "mem") 1)
  (func (export "fn_a") (result i32) i32.const 1)
  (func (export "fn_b") (result i32) i32.const 2)
)`;
    const result = await validateWasm({ wat: multiWat });
    const parsed = extractText(result) as { valid: boolean; exports: Array<{ name: string; kind: string }> };
    expect(parsed.valid).toBe(true);
    expect(parsed.exports).toHaveLength(3);
    const kinds = parsed.exports.map((e) => e.kind);
    expect(kinds).toContain("function");
    expect(kinds).toContain("memory");
  }, 10000);

  test("invalid base64 in validate_wasm throws", async () => {
    await expect(
      validateWasm({ wasm_base64: "not-valid-base64!!!" })
    ).rejects.toThrow();
  }, 10000);

  test("garbage wasm bytes in validate_wasm throw", async () => {
    await expect(
      validateWasm({ wasm_base64: "AAQEBA==" })
    ).rejects.toThrow(/validation failed/i);
  }, 10000);
});
