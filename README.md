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
| `fug worker [install] [--server URL] [--workspace NAME] [--name MACHINE] [--parallel N] [--service PATH] [--token TOKEN]` | Serve the workspace's builds on this machine; `install` keeps it running as a systemd user service |
| `fug worker uninstall [--server URL] --workspace NAME` | Remove that service |
| `fug --help` | Show usage |

`push`, `status`, and `mcp` find the nearest binding in the current directory or
its parents. Tokens are selected in this order: `--token`, `FUGHETTA_TOKEN`, saved
token. Credentials live in `$XDG_CONFIG_HOME/fughetta/credentials.json`, or
`~/.config/fughetta/credentials.json` when XDG configuration is unset. Windows uses
`%APPDATA%\Fughetta\credentials.json`. Credential writes are serialized and use
mode 0600 on POSIX. Bindings and MCP registration contain no token.

## Explicit worldlines

`fug worldline list` lists the project's worldlines. `fug worldline fork NAME`
synchronizes the current copy and forks its resulting version. It retains the
request locally; retry the same command after a lost reply to recover the same
fork. The current directory stays on its original worldline.

Use `fug worldline checkout NAME NEW_DIRECTORY` to download a worldline into a
new directory outside the current checkout. Existing directories are refused.
Each copy has its own baseline and pending-operation records. After an interrupted
download, run `fug push` from the new directory to resume synchronization. Run
`fug mcp` there to use the branch's engineering tools.

`fug worldline diff SOURCE [--version VERSION] [--observed VERSION]` compares
that source version with the bound target worldline's observed version. Omitted
versions select current server heads. Output includes both versions and changed
file metadata; it does not synchronize the local directory.

`fug worldline promote SOURCE --operation-id ID [--version VERSION]
[--observed VERSION] [--intent TEXT]` copies the source changes since the common
history into one atomic target contribution. Unrelated target changes remain;
a file changed differently in both worldlines refuses the whole operation.
The command saves both selected versions before publishing. After a lost reply,
repeat the same operation ID and arguments to recover its receipt, even if heads
have advanced. Use a new ID for another promotion. Run `fug push` afterward to
synchronize the target checkout; local edits use the usual conflict recovery.

Worldline histories remain separate. Use `fug d-mail send --to RECIPIENT --file FILE`
to exchange conclusions between branches.

## Run builds on your own machine

A workspace owner can make a Linux, Windows, or macOS machine serve the workspace's builds:

```sh
fug worker --workspace my-team
```

On first use `fug` signs in, registers the machine (named after its host name,
or `--name MACHINE`), and saves its identity in
`$XDG_STATE_HOME/fughetta/workers/<host>-<workspace>/identity.json` (mode 0600 on Unix;
`~/.local/state` when unset, `%LOCALAPPDATA%\Fughetta\workers` with an owner-only ACL on Windows).
Later starts reuse it without a token. `fug` then downloads the latest
`fughetta-service` release from GitHub for this platform, checks its published
SHA-256 digest, and caches it under `$XDG_CACHE_HOME/fughetta/service/<tag>/`.
Without network access it uses the newest cached release. `--service PATH` or
`FUGHETTA_SERVICE` runs a binary you supply instead.

The Worker connects only outward. `fug` listens on a loopback port and relays
each Worker connection to the gateway over WebSocket, using the same origin and
`FUGHETTA_CA_FILE` as other commands. `fug` starts the Worker directly;
foreground execution requires no systemd user session. The deployment supplies
the execution environment and isolation. `fug` restarts a Worker that exits. When an owner revokes the
machine in the console, the Worker stops, `fug` exits with status 2 and removes
the saved identity; run `fug worker` again to register the machine anew.

```sh
fug worker install --workspace my-team     # start now and at every sign-in
loginctl enable-linger "$USER"             # keep it running while signed out
fug worker uninstall --workspace my-team
```

Workers default to 8 compute threads and build parallelism of 8. Use
`fug worker --parallel 4` to set both budgets to 4. The value must be a positive
integer; `fug worker install --parallel 4` saves it in the systemd unit.

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

Engineering tool results include a synchronization report with updated local
paths, deferred edits, source conflicts, and preserved content locations. The
blob cache retains current baselines and pending submissions; missing or corrupt
baseline blobs are restored from their saved remote versions. Captured files in
`state/recovered/` are checked on the next sync: unchanged copies are removed,
while copies changed through an editor's old file handle remain available.

## Tools available to the agent

| Endpoint | Tools |
| --- | --- |
| Core | `configurations`, `build`, `test`, `run`, `language` |
| Project configuration | `project`, `save_project`, `effective`, `schema` |

The proxy injects the bound project and removes it from tool schemas. `build`,
`test`, `run`, and `language` work on the version the preceding send produced, so
results always describe the files on disk. The agent edits local files using its
own editor tools. Before `configurations`, `build`,
`test`, `run`, and `language`, the proxy sends local changes.
If sending fails, the tool returns an error without running the remote call.
Sync summaries and skipped or kept files go to stderr; stdout contains only MCP
messages. Calls run concurrently, use separate remote request IDs, and forward
cancellation to the correct endpoint. Cancellation also interrupts source sync.
Long calls stream progress and return the final result in the original call; no
polling is needed. Language queries prepare missing or stale analysis automatically.

## License

Mozilla Public License 2.0. See [LICENSE](LICENSE).

## Sync recovery files

The baseline stores file metadata and observed versions; immutable file bytes are
kept by digest in `.fughetta/state/blobs/`. Unchanged files are not downloaded
again. Small writeback records in `state/pulls/` let the next sync finish an
interrupted installation without treating later local edits as the old baseline.

Before replacing or removing an existing file, sync moves it into
`state/recovered/`. It installs new content only if no editor has recreated the
target. The saved file and its JSON record retain the original path and versions;
they are recovery data, not build output. Sync reports saved paths on stderr.
Concurrent path creation also preserves the remote original under
`state/collisions/` before rebasing the local change. CRDT conflict projections
preserve differing local bytes under `state/conflicts/`.

Changing an existing copy's project or worldline binding is refused. Use a new
worldline checkout, which keeps pending operations separate. Older `sent.json`
ledgers are preserved and refused; sync does not guess their source baselines.

## D-mail

Send a text record from the bound worldline to a named recipient without merging
source between worldlines:

```sh
fug d-mail send --to branch-b --file findings.txt
fug d-mail read --to branch-b --after 0 --output inbox.json
```

Messages retain the authenticated sender, source worldline, recipient, timestamp,
and body. Recipients are labels within the project, not private mailboxes; project
members can read them. The default read recipient is the bound worldline name.
Reads return a cursor and `more` flag. Sending saves a local draft first; after a
lost response, reuse the printed `--operation-id` with the same file to retrieve
the existing message without sending it twice. Drafts remain under
`.fughetta/state/d-mail/`.

### Local execution logs

When a build, test, or run returns more than 8 KiB of step output, `fug` saves
that captured output in private files under `.fughetta/state/reports/execution-*/`.
Each step returns `output_file` (an absolute local path), `output_bytes`, and
`output_shortened`, alongside a short tail in `output`. Diagnostics, test results,
and exit status remain in the result. The existing `truncated` field describes the inline worker summary. A step
with a `log` reference also downloads the separately captured process output,
including bytes omitted from that summary, and exposes it as `output_file` when
capture is complete. `log_truncated` indicates that the 64 MiB per-configuration
log storage budget was exhausted. In that case `log.local_path` holds the captured
prefix, while the inline tail is kept separately; if shortened, its complete copy
is saved as `output_file`. `log_error` reports worker log storage failures. If local storage fails, the complete received result remains
available and a `delivery_error` describes the failure. Each call uses a separate
report directory. Delivery directories are temporary and excluded from source sync.
Copy logs or artifacts outside `.fughetta/state` if they need permanent retention.

### Downloaded artifacts

Build, test, and run results can include `exports`. `fug` downloads each file to
`.fughetta/state/artifacts/execution-*/`, checks its SHA-256 digest and size, and
adds an absolute `local_path` to the result. Executable files retain execution
permission. Later calls reuse a delivered file after checking its digest, size,
and execution permission. Reuse is scoped to the bound service, workspace, and
project. Modified files are kept; a replacement download gets a new path.
Downloads use project-authorized URLs from the bound gateway;
remote filenames cannot select paths outside this new artifact directory.
A failed download adds `delivery_error` to that file and removes its partial
local copy while preserving the build result and any other completed downloads.

On delivery calls, `fug` collects historical artifact and report directories at
most once a minute. Each category has a seven-day retention period and soft
limits of 20 GiB and 256 execution directories. Oldest eligible directories are
removed first. Active writers and directories used or modified in the last ten
minutes are protected, so temporary usage can exceed these limits. Successful
reuse refreshes a directory's retention time. Stale download-index entries are
removed with their missing files. Collection errors do not discard tool results.
