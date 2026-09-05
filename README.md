<h1 align="center">claude-transplant</h1>

<h3 align="center">Move Claude Code history between accounts. Menubar or CLI.</h3>

<p align="center"><img src="https://raw.githubusercontent.com/vitaliyhayda/claude-transplant/main/menubar.gif" alt="Claude Transplant panel with source accounts converging on one destination" width="760"></p>

## What it does

Claude Desktop lists each Claude Code session under the account and organization that created it. Switch accounts and the history stays behind.

- Moves local Desktop session records to another account. Transcripts and sidecars stay on disk, sessions keep their ids, nothing is copied.
- Sessions owned by a running Desktop worker are held until you approve a restart, or skipped with Move only the rest.
- `--cloud` reconciles Remote Control for the signed-in source. No model runs, no artifact is recreated.
- `undo` reverses the whole move.
- macOS only. Unofficial, not affiliated with Anthropic.

## Install

Node 22 or newer. The menubar also needs the Xcode command line tools: `xcode-select --install`

```
npx claude-transplant menubar   # install the menubar app
npx claude-transplant           # CLI
```

From this repo instead of npm: `npx github:vitaliyhayda/claude-transplant` (append a tag or commit hash to pin).

## Menubar

- Two columns: FROM on the left, TO on the right. Uncheck accounts to leave behind.
- When the active account is known, TO defaults to the most recently used other account and every other account starts as a source. Otherwise pick TO yourself.
- Open local sessions offer Stop and restart. Finish move continues the same receipt. Keep completed cancels remaining work without reversing completed moves.
- Held local work retries when its workers stop. Pending cloud sources retry when that account signs in.
- Starts at login, shows progress in the icon, notifies when done.
- Bundles its own CLI, so rerun `menubar` after upgrading.
- `menubar --snapshot panel.png` renders the live panel, `menubar --remove` uninstalls, `--demo <dir>` renders the animation above.

## CLI

```
From  ↑↓ move · space select · enter next
  ❯ ◉ you@work.com · Acme Inc.    161 | 2h ago | acme-api | active
    ◉ you@work.com · Personal     157 | 1d ago | acme-api
    ○ you@home.com · Personal       3 | 5d ago | notes
    ○ you@work2.com · Northwind     12 | 4m ago | northwind

To    ↑↓ move · enter confirm
  ❯ ● you@home.com · Personal       3 | 5d ago | notes

  inventory   318 records | 3 already there | 307 to move
  move        308 ✓ | 307 zero-copy | 1 rescued
  verify      transcripts unchanged ✓ | sidecars unchanged ✓ | desktop ✓

  receipt     ~/Library/Application Support/claude-transplant/2026-09-02T16-04-11-208.json
  undo        npx claude-transplant undo
```

| Command | Effect |
|---|---|
| `claude-transplant` | pick From and To, move, print a receipt |
| `--dry-run` | plan only, write nothing |
| `undo` | quarantine the last move and restore source entries, refused if a target changed or a source cannot be restored |
| `finish` | finish held local records, check the active pending cloud source, or continue a staged cloud undo |
| `sweep` | verify placed records and retry eligible pending work, never requests a restart |
| `restart` | show the plan for the existing Desktop refresh action |
| `keep-local` | cancel held work and pending cloud checks without reversing completed moves |
| `accounts` | list accounts |
| `menubar` | install the menubar app (`--snapshot <png>`, `--remove`) |
| `--from <match> --to <match>` | skip the picker, repeat `--from`, match on email, org name, or uuid prefix |
| `--move-only` | move eligible records, leave Desktop-owned records held |
| `--restart-approved <token>` | approve the exact plan printed by the prior move, finish, or restart call |
| `--cloud` | reconcile the active source, queue inaccessible sources that still have unreadable or unarchived local records |
| `--json` | one event per line |
| `--version` | print the version |

## Reading the output

- without history: transcript no longer exists on disk
- unreadable: Desktop record is not valid JSON
- source rejected / target rejected: invalid identity or unsafe transcript history, left untouched
- compatible source versions: same history in several transcript files, blocked unless the target already holds every version
- grew apart: overlapping versions with different messages, all move
- already there: target already holds every message and sidecar file
- held: a Desktop worker owns a required record, restart approval is offered
- blocked: needs merging, has a collision or unresolved parent, or is owned by a scheduled task, notification route, or external CLI worker
- retired: source entries moved to quarantine after verification
- cloud mirrors: active or paused Remote Control rows under the signed-in source
- cloud rescue: one divergent remote branch materialized as a separate local session from exact message payloads
- cloud blocked: no unambiguous local anchor, unsupported payload, connected worker, changed history, or account mismatch
- cloud checks pending: inaccessible sources that still have unreadable or unarchived local records
- newer cloud sessions: rows created after Move, left for the next move

Accounts are labeled from `~/.claude.json`, its backups, `~/.claude*` profile directories, and Desktop's agent-mode records. Personal-plan organizations show as Personal. Accounts with no known email show a uuid prefix, session count, last activity, and most common project folder.

Active identity comes from the newest complete initialization entry in Claude Desktop's `main.log` for the current Desktop process. A logout, unfinished switch, initialization failure, or config conflict clears it and the panel shows unknown. No Keychain access or network request is used for the badge. Desktop must be running.

## How it works

A session is three files: the transcript in `~/.claude/projects`, the sidecar directory beside it, and the record under `~/Library/Application Support/Claude/claude-code-sessions/<account>/<organization>`. The transcript pool is shared across accounts, so a move writes the same record into the target organization with the same `cliSessionId`, verifies that transcript, sidecars, and both records are unchanged, then parks the source record in quarantine.

Eligibility:

- history is a single comparable version
- record filename and identity are valid
- no scheduled task, notification route, or running worker owns it
- parent record is already in the target or moves first in the same batch
- no id collision in the target

Worker identity uses the Desktop record id, CLI session id, PID, process start time, and ancestry, plus `~/.claude/sessions/<pid>.json` for workers that omit the session id. External CLI workers are always refused because restarting Desktop does not stop them.

Restarts:

- When an operation needs Desktop to close, the engine emits a plan first. The menubar warns which Code workers, windows, Chat, Cowork, and background commands will close.
- Stop and restart approves that exact process inventory. A changed inventory invalidates approval. Cold moves show no dialog.
- An approved restart sends a graceful quit, waits for Desktop and its descendants to exit, moves the held records, and reopens Desktop. 30 second budget, no force kill, no cloud work in that window. A veto or missed deadline leaves held records untouched.
- Background retries never start a new shutdown.

Remote Control (`--cloud`):

- Reads the active selected source through Claude Desktop's authenticated `claude.ai` session. Cookies are decrypted in memory via Keychain, sent only to `claude.ai`, never stored.
- If one local target contains the remote history, that record becomes the destination. Otherwise a same-title target must share eight consecutive exact remote messages to anchor a separate companion whose supported payloads are copied exactly into a new local transcript.
- The source mirror is archived only after the remote worker is disconnected and unchanged and the local target verifies.
- Inaccessible sources become pending only when unreadable or unarchived local records remain. Retries check identity, history, and connection state before touching a remote row. A failed source stays active and retryable.

Safety:

- One receipt owns the move, held records, cloud checks, failures, and retries. Another move cannot start until it is complete, kept local, or undone.
- Records are written to a private temp inode, journaled, then exposed by an atomic no-clobber hard link. A record is either absent or complete.
- Interrupted retirement or undo resumes from the receipt. A corrupt newest receipt stops undo.
- Later moves and sweeps compare placed records with their snapshots. Durable differences (title, archive, pin) are saved under `drift/<receipt>` and reported, not overwritten.
- Lineage follows `forkedFrom` pointers to their roots. Duplicate message ids that differ only in runtime metadata count as sync replays, anything else is refused.
- A disposable planning cache lives at `~/Library/Application Support/claude-transplant/cache.json`. Every write decision uses live files. Delete it any time.

## Rules

- Rehome local history or refuse. Never duplicate a local transcript, never merge histories.
- No transcript or sidecar is renamed, edited, or deleted. The quarantined record is the rollback.
- Cold moves need no confirmation. Desktop restarts require exact plan approval or the saved warning preference.
- Remote rescue copies payloads exactly. No model reconstructs history.
- Remote Control is touched only with `--cloud`, with no credential persistence.
- Automatic retries cover the receipt's named work only. They never start a restart, store credentials, or create destination bridges.
- One JavaScript file, no dependencies, Node 22. The menubar is one Swift file.

## Not done, and why

| Tried | Result |
|---|---|
| Change ownership on the server | No API reassigns a session |
| `claude --fork-session` | Copies only the compacted chain and grows disk use |
| Copy an existing local transcript | The pool is already shared, a duplicate is only disk |
| Delete the source | Removes the rollback |
| Merge sidecars across versions | Requires writing a new generation |
| Move a record while its Desktop worker runs | Desktop rewrites the record from cache, title and turn count roll back |
| Infer a restart-safe moment from activity logs | Cold records need no restart, held records get an explicit graceful shutdown |
| Repair changed records from old snapshots | Would overwrite legitimate title, archive, and pin edits |
| Read the active org from Desktop's extensions allowlist timestamp | Can point at the wrong org after a failed refresh |

## Limits

- macOS 13 or newer with Claude Desktop. Sign Desktop into the target account to see moved history.
- Remote Control ownership does not transfer. Re-enable it per session under the destination account.
- Artifact ownership, versions, comments, and share links stay with the original account.
- Embedded base64, text, and HTTP(S) images and documents can be rescued. Account-owned file ids and unknown shapes are refused.
- Remote Control uses private Claude endpoints and fails closed if their shape or auth changes.
- File layouts, log wording, and endpoints are undocumented and may change. Verified with Claude Desktop 1.46388.4 and Claude Code 2.1.260.
- Moving history out of a Team organization is your organization's decision.

Receipts, quarantine, drift evidence, cache, and the menubar app live in `~/Library/Application Support/claude-transplant`. Delete `quarantine` once its receipts are no longer wanted. A kernel lock prevents overlapping runs. MIT.
