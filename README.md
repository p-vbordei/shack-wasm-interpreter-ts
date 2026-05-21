# shack-wasm-interpreter (TypeScript)

An MCP server that compiles and executes WebAssembly modules in a sandboxed, timeout-bounded environment.
Speaks JSON-RPC 2.0 over stdio (`STDOUT` carries only protocol messages; all diagnostic logs go to `STDERR`).

## What it does

- Accepts WebAssembly modules as WAT text (compiled via wabt) or base64-encoded `.wasm` binary.
- Each execution runs in a dedicated Worker thread.  A wall-clock timeout (5 s) forcibly terminates
  the worker if it does not respond in time, preventing non-terminating modules from hanging the server.
- The sandbox has no access to the host filesystem, network, or memory beyond the WebAssembly linear
  memory of the module itself — no host imports are satisfied.
- Exposes `run_wasm` (instantiate and call an exported function) and `validate_wasm` (parse, validate,
  and list exports without executing).

## MCP tools

| Tool | Arguments | Description |
|---|---|---|
| `run_wasm` | `wasm_base64` (string, base64 `.wasm`), `wat` (string, WAT source), `function` (string, export name; defaults to first), `args` (number[], integer values) | Instantiate a WebAssembly module and invoke an exported function. Execution runs in a Worker thread with a 5 s wall-clock timeout. |
| `validate_wasm` | `wasm_base64` (string, base64 `.wasm`), `wat` (string, WAT source) | Check that a module parses and validates without executing it, and return its exports. |

## Configuration

| Parameter | Default | Description |
|---|---|---|
| Timeout | `5000 ms` | Wall-clock timeout before the Worker thread is terminated; hardcoded in the binary. |

There are no CLI flags.  Launch the server and pipe JSON-RPC messages to its `STDIN`.

> **Note:** The TypeScript implementation does not have instruction-level fuel metering
> (the standard WebAssembly API does not expose this).  The `fuel_consumed` field in the
> response is always `0`; the wall-clock timeout is the only bound against non-terminating modules.

## Install and build

```sh
npm install
npm run build
```

## Run

```sh
node dist/server.js
```

## Tests

```sh
npm test
```

The test suite covers: success paths (add, constant result, round-trip from WAT to base64 wasm,
function name in response), error paths (bad base64, invalid WAT, missing export, no exports,
wrong arity, garbage bytes), timeout via wall-clock (infinite loop), and `validate_wasm`
success/error cases including multi-export modules.

## Usage example

Below is a concrete JSON-RPC interaction.  The client sends a `tools/call` request
for `run_wasm` with a WAT module that adds two integers.

**Request (sent to STDIN, one line):**

```json
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"run_wasm","arguments":{"wat":"(module (func (export \"add\") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))","function":"add","args":[17,25]}},"id":1}
```

**Response (read from STDOUT):**

```json
{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"{\"function\":\"add\",\"results\":[42],\"fuel_consumed\":0}"}]},"id":1}
```

The `results` array contains the return values of the called function.
`fuel_consumed` is always `0` in the TypeScript implementation.
