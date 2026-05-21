# shack-wasm-interpreter (TypeScript)

An MCP server that compiles and executes WebAssembly modules in a sandboxed, timeout-bounded environment. Speaks JSON-RPC 2.0 over stdio (STDOUT carries only protocol messages; all diagnostic logs go to STDERR).

## MCP tools

| Tool | Description |
|---|---|
| `run_wasm` | Instantiate a WebAssembly module and invoke an exported function with integer arguments. Execution is timeout-bounded using a Worker thread. |
| `validate_wasm` | Check that a WebAssembly module parses and validates without executing it, and report its exports. |

## Install

```sh
npm install
npm run build
```

## Run

```sh
node dist/server.js
```

The server reads newline-delimited JSON-RPC 2.0 requests from stdin and writes responses to stdout.

## Tests

```sh
npm test
```
