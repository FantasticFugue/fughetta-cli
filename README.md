# Fughetta CLI

`fug` connects a local repository to Fughetta so a coding agent can build, test,
run, and analyze its files on a core. Requires Node.js 22 or later.

## Install

```sh
bun add --global @fantasticfugue/fughetta-cli
```

For source builds, see the [repository guide](AGENTS.md#build-and-test).

## Connect a repository

For Fughetta hosting, run this in the repository you want to send:

```sh
fug init
```

The default origin is `https://fughetta.dev`. With no usable token, `fug` opens
sign-in in your browser and also prints the URL. Sign-in uses authorization code
with PKCE and a temporary listener on `127.0.0.1`; it expires after five minutes.
The token is saved for that origin. A single workspace is selected automatically.
For several workspaces, select one at the terminal prompt or supply its name:

```sh
fug init --server https://fughetta.dev --workspace my-team --name my-project
```

Noninteractive sessions must supply `--workspace` when several choices exist.
If your account has none, create a workspace in the console first.

For a self-hosted core, use its origin and a token issued by its owner:

```sh
fug init --server http://127.0.0.1:8080 --token '<core-token>'
```

A core has no workspace prefix or browser sign-in. Hosted requests use
`/w/{workspace}`. Origins can use IPv6, for example `http://[::1]:8080`.
`FUGHETTA_CA_FILE` selects a PEM certificate authority file for HTTPS.

`init` uses an existing project or creates one. The project name defaults to the
directory name. A new project starts without build configurations: `fug` does not
inspect toolchains. The agent reads the repository and sets up builds, tests, and
analysis with `schema`, `project`, and `save_project`.

`init` saves the binding in `.fughetta/project.json`, sends files, and registers
Fughetta in `.mcp.json`. It also updates `.cursor/mcp.json` when `.cursor` exists.
Other JSON entries are preserved; malformed JSON is left for manual editing.
Start your coding agent in the repository after initialization. The registration
uses `fug` when available on PATH; a source checkout otherwise records absolute
Node and CLI paths. Install `fug` on PATH and rerun `init` before sharing that file.

## Commands

| Command | Purpose |
| --- | --- |
| `fug init [--server URL] [--workspace NAME] [--name PROJECT] [--token TOKEN]` | Bind, configure, send files, and register MCP |
| `fug login [--server URL] [--workspace NAME] [--token TOKEN]` | Sign in and save a token for an origin |
| `fug push` | Send local changes to the bound project |
| `fug status` | Show the binding, check access, and list build configurations |
| `fug mcp` | Serve newline-delimited MCP JSON on stdin/stdout |
| `fug worker [install] [--server URL] [--workspace NAME] [--name MACHINE] [--service PATH] [--token TOKEN]` | Serve the workspace's builds on this machine; `install` keeps it running as a systemd user service |
| `fug worker uninstall [--server URL] --workspace NAME` | Remove that service |
| `fug --help` | Show usage |

`push`, `status`, and `mcp` find the nearest binding in the current directory or
its parents. Tokens are selected in this order: `--token`, `FUGHETTA_TOKEN`, saved
token. Credentials live in `$XDG_CONFIG_HOME/fughetta/credentials.json`, or
`~/.config/fughetta/credentials.json` when XDG configuration is unset. Windows uses
`%APPDATA%\Fughetta\credentials.json`. Credential writes are serialized and use
mode 0600 on POSIX. Bindings and MCP registration contain no token.

## Run builds on your own machine

A workspace owner can make any Linux machine serve the workspace's builds:

```sh
fug worker --workspace my-team
```

On first use `fug` signs in, registers the machine (named after its host name,
or `--name MACHINE`), and saves its identity in
`$XDG_STATE_HOME/fughetta/workers/<host>-<workspace>/identity.json` (mode 0600;
`~/.local/state` when unset, `%LOCALAPPDATA%\Fughetta\workers` on Windows).
Later starts reuse it without a token. `fug` then downloads the latest
`fughetta-service` release from GitHub for this platform, checks its published
SHA-256 digest, and caches it under `$XDG_CACHE_HOME/fughetta/service/<tag>/`.
Without network access it uses the newest cached release. `--service PATH` or
`FUGHETTA_SERVICE` runs a binary you supply instead.

The Worker connects only outward. `fug` listens on a loopback port and relays
each Worker connection to the gateway over WebSocket, using the same origin and
`FUGHETTA_CA_FILE` as other commands. On Linux, `fug` starts the Worker in its
own delegated cgroup with `systemd-run --user --scope -p Delegate=yes`, so builds
get CPU and memory isolation without root. The Worker uses every CPU this
machine reports. `fug` restarts a Worker that exits. When an owner revokes the
machine in the console, the Worker stops, `fug` exits with status 2 and removes
the saved identity; run `fug worker` again to register the machine anew.

```sh
fug worker install --workspace my-team     # start now and at every sign-in
loginctl enable-linger "$USER"             # keep it running while signed out
fug worker uninstall --workspace my-team
```

`install` registers the machine and downloads the release if needed, then writes
the systemd user unit `fughetta-worker-<host>-<workspace>.service`, which runs
`fug worker` with absolute paths, restarts it after failures, and does not
restart it after a revocation. Follow it with `journalctl --user -u <unit> -f`.
`uninstall` stops and removes the unit; the machine stays registered until an
owner revokes it.

## Files sent to the core

Fughetta receives file paths, contents, and executable bits. Text and binary
files are sent; each file must fit the core's configured size limit. Nested
`.gitignore` and `.fughettaignore` rules control selection. Version control data,
`node_modules/`, and the root `.fughetta/` directory are excluded. Links, special
files, oversized files, and names refused by the core are skipped and reported.
Use ignore rules to exclude secrets before initialization.

`.fughetta/state/` holds local scan and push state and is ignored by Git. A push
tracks files this checkout sent; remote files it never had remain in place and
are reported as kept. See the sync implementation and its tests for conflict and
interrupted-push behavior.

## Tools available to the agent

| Endpoint | Tools |
| --- | --- |
| Core | `configurations`, `build`, `test`, `run`, `language`, `jobs` |
| Project configuration | `project`, `save_project`, `effective`, `schema`, `preview`, `analysis` |

The proxy injects the bound project and removes it from tool schemas. `build`,
`test`, `run`, and `language` work on the version the preceding send produced, so
results always describe the files on disk. The agent edits local files using its
own editor tools. Before `configurations`, `build`,
`test`, `run`, `language`, `preview`, and `analysis`, the proxy sends local changes.
If sending fails, the tool returns an error without running the remote call.
Sync summaries and skipped or kept files go to stderr; stdout contains only MCP
messages. Calls run concurrently, use separate remote request IDs, and forward
cancellation to the correct endpoint. Long-running builds can be followed through
`jobs`.

## License

Mozilla Public License 2.0. See [LICENSE](LICENSE).
