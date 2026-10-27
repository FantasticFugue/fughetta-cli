# Repository guide

Use American English in source comments and documentation. Keep runtime
dependencies small. Work on the current implementation. Do not publish, initialize
Git, or commit unless the user requests it. Read the user's repository rules and
`~/.githooks/pre-commit` before editing; its word checks apply to source and docs.

## Layout

- `src/cli.ts`: command parsing, project creation, status, MCP registration.
- `src/login.ts`: OAuth discovery, loopback PKCE sign-in, workspace selection.
- `src/remote.ts`: origin parsing, authenticated HTTP, MCP calls.
- `src/credentials.ts`, `src/files.ts`: private token storage, JSON writes, locks.
- `src/proxy.ts`: stdio MCP, tool routing, project injection, source sync.
- `src/checkout/`: binding, ignore rules, scanning, hash index, push state.
- `src/worker.ts`: build-machine registration, release download, Worker supervision, systemd user unit.
- `src/tunnel.ts`: loopback listener relaying Worker TCP connections over the gateway's WebSocket tunnel.
- `tests/client.test.mjs`, `tests/cli.test.mjs`: client units and real-core workflow.
- `tests/checkout.test.mjs`: sync tests when supplied by the sync author.
- `tests/worker.test.mjs`: unit, release download, and a real Worker behind a stand-in gateway (needs `systemd-run --user`).
- `tests/service.mjs`: real-core test process and scratch directory helpers.

## Build and test

Use Node.js 22 or later and bun. `fug` runs on Node.js; bun manages packages and
runs the scripts.

```sh
bun install --concurrent-scripts=4
bun run build
bun run test
```

TypeScript outputs to the repository's `build/` directory. Use that directory for
build output; do not choose another location or create nested substitute build
roots. The test command is `node --test --test-concurrency=1 tests/*.test.mjs` and
runs against built JavaScript. Limit execution to at most four CPU cores. On Linux,
use `taskset` with four CPUs allowed by the current process. Child cores inherit
that affinity. Test scratch directories contain fixtures and core state and must
be removed after use. Do not leave logs behind.

`FUGHETTA_SERVICE` selects the real service binary; its default is
`../fughetta-service/build/debug/fughetta-service`. Do not modify the service
repository. `FUGHETTA_RELEASES` replaces the GitHub release API URL that
`fug worker` downloads from. OAuth tests use an in-process HTTP server and do not require a hosted
gateway. Sync-dependent end-to-end assertions require the completed `push`
implementation in `src/checkout/`.

Complete a batch before validating. Select local checks or cloud CI for a batch;
use existing successful evidence when inputs have not changed. Check running
processes before starting validation. Rerun only the scope affected by a changed
input, a failure, an interruption, or a concrete coverage gap. Keep operational
instructions here and user-facing behavior in README.md. Report incomplete work
and validation limits in the handoff.
