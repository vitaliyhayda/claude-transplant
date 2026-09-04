<h1 align="center">claude-transplant</h1>

<h3 align="center">Move Claude Code history between accounts. Menubar or CLI.</h3>

<p align="center"><img src="https://raw.githubusercontent.com/vitaliyhayda/claude-transplant/main/menubar.gif" alt="Claude Transplant: pick from, pick to, move" width="760"></p>

## What it does

Claude Desktop lists each Claude Code session under the account and organization that created it. Switch accounts and the history stays behind. claude-transplant moves the Desktop record to the account you are switching to. The transcript and sidecars stay where they are, the session keeps its id, nothing is copied. When the active source also lists a Remote Control mirror, the menubar either verifies that history in one local target or materializes a divergent branch as a separate local session before archiving the source mirror. No model runs and no artifact is recreated. `undo` restores both layers. macOS only.

## Install

Node 22 or newer. The menubar also needs the Xcode command line tools once: `xcode-select --install`.

```
npx claude-transplant menubar
npx claude-transplant
```

To run from this repository instead of npm: `npx github:vitaliyhayda/claude-transplant`, with `#v2.1.0` or a commit hash to pin.

The menubar app asks From and To, starts at login, shows progress in the icon, and posts a notification when done. Sign Claude Desktop into From before moving so Remote Control mirrors can be reconciled. The active account is tagged. When one account is left unpicked it becomes the destination. The app bundles its own copy of the CLI, so run the menubar command again after upgrading. `menubar --remove` uninstalls. The animation above is rendered by the app itself with `--demo <dir>`.

```
From  ↑↓ move · space select · enter next
  ❯ ◉ you@work.com · Acme Inc.    161 | 2h ago | acme-api
    ◉ you@work.com · Personal     157 | 1d ago | acme-api
    ○ you@home.com · Personal       3 | 5d ago | notes | active

To    ↑↓ move · enter confirm
  ❯ ● you@home.com · Personal       3 | 5d ago | notes | active

  inventory   318 records | 6 without history | 2 blocked | 3 already there | 5 cloud mirrors | 1 cloud rescue | 307 to move
  move        308 ✓ | 73,902 events | 307 zero-copy | 1 rescued
  sidecars    890 files | unchanged ✓
  desktop     308 records | 251 archived | 57 active
  verify      transcripts unchanged ✓ | sidecars unchanged ✓ | desktop ✓ | 2s
  retired     310 source records → quarantine | transcripts untouched
  cloud       5 source mirrors archived

  receipt     ~/Library/Application Support/claude-transplant/2026-09-02T16-04-11-208.json
  undo        npx claude-transplant undo
  then        restart Claude Desktop to see them
```

## Commands

| Command | Effect |
|---|---|
| `claude-transplant` | pick From and To, move, print a receipt |
| `claude-transplant --dry-run` | plan only, write nothing, refused while an interrupted run awaits reconciliation |
| `claude-transplant undo` | quarantine the last move, restore the source entries, refused if a target changed or a source cannot be restored |
| `claude-transplant accounts` | list accounts |
| `claude-transplant menubar` | install the menubar app, `--remove` uninstalls |
| `--from <match> --to <match>` | skip the picker, repeat `--from`, match on email, org name, or uuid prefix |
| `--cloud` | reconcile active source Remote Control mirrors, source must be signed in |
| `--json` | one event per line |
| `--version` | print the version |

## Reading the output

- without history: the transcript no longer exists on disk
- unreadable: the Desktop record is not valid JSON, named, nonzero exit
- compatible source versions: the same history exists in several transcript files, blocked unless the target already holds every version, since moving it would mean merging
- grew apart: overlapping versions with different messages or state, all move
- already there: the target already holds every message and sidecar file
- blocked: needs merging, has a collision or malformed record, an unresolved parent, or is owned by a scheduled task, notification route, or running worker, named and left untouched
- retired: source entries moved to quarantine after verification, including already-there ones
- cloud mirrors: active or paused Remote Control rows found under the signed-in source
- cloud rescue: one divergent remote branch materialized as a separate local session from exact message payloads, with no model call
- cloud blocked: no unambiguous local anchor, an unsupported payload, a connected worker, changed history, or an account mismatch, left active and named

Accounts are labeled from `~/.claude.json`, its backups, `~/.claude*` profile directories, and Desktop's agent-mode records. Personal-plan organizations show as Personal. An account with no known email shows a uuid prefix, session count, last activity, and most common project folder.

## How it works

A session is three files that can disagree: the transcript in `~/.claude/projects`, the sidecar directory beside it, and the record under `~/Library/Application Support/Claude/claude-code-sessions/<account>/<organization>`. The transcript pool is shared by every account on the Mac, so a move writes the same record into the target organization with the same `cliSessionId`, verifies the transcript, sidecars, and both records are unchanged, then parks the source record in quarantine. Ten round trips keep one transcript.

Remote Control adds a fourth, server-owned layer. With `--cloud`, claude-transplant reads the active source account through Claude Desktop's authenticated session and hashes durable user and assistant message shapes. If one local target contains them, that record becomes the destination. If exactly one same-title local target exists but the histories diverged, it anchors a separate companion whose supported remote message payloads are copied exactly into a new local transcript. The tool checks that the remote worker is disconnected and unchanged before archiving its source mirror. Cookies are decrypted in memory through macOS Keychain, sent only to `claude.ai`, and never printed or stored. A receipt journals the remote id, local companion, target activation, and prior state so interrupted archival reconciles from server state and Undo can unarchive the source.

A move is eligible when the history is a single comparable version, the record filename and identity are valid, no scheduled task, notification route, or running worker owns it, the parent record is already in the target or moves first in the same batch, and the target has no id collision. Everything else is refused with a named reason.

Before writing, the transcript is hashed against its analyzed bytes and both records are reread. Sources and destinations are checked again before retirement, and a change after parking begins restores the plan. Undo verifies the target record and every restore path before recording its plan, then moves only Desktop records. A receipt journals every phase, interrupted retirement or undo resumes from it, and a corrupt newest receipt stops undo before it can reach the previous batch.

Planning reuses a disposable cache at `~/Library/Application Support/claude-transplant/cache.json`, keyed by path, device, inode, size, and nanosecond mtime and ctime. Dry runs read it, real moves refresh it, and every decision that writes is made from live files. Delete the cache at any time.

Lineage follows existing `forkedFrom` pointers to their roots, so copies made by earlier versions or other tools are recognized. A contained older destination record retires after the arriving record verifies. A duplicate message id counts as a sync replay only when the copies differ in runtime metadata alone and every parent exists, anything else is a conflict and the session is refused.

## Rules

- Rehome local history or refuse. Never duplicate an existing local transcript and never merge histories. A divergent remote-only branch may become one separate verified companion.
- No transcript or sidecar is renamed, edited, or deleted. The quarantined record is the rollback.
- No confirmation prompt. Runs are idempotent, writes are journaled, undo refuses before changing anything it cannot restore.
- Remote rescue copies supported payloads exactly. It does not ask a model to reconstruct history.
- Local transcripts stay local. Remote Control reconciliation uses Claude Desktop's current `claude.ai` session only when `--cloud` is present, with no credential persistence.
- One JavaScript file, no dependencies, Node 22. The menubar is one Swift file.

## Not done, and why

| Tried | Result |
|---|---|
| Change ownership on the server | No API reassigns a session, so a verified local target replaces it and the source mirror is archived |
| `claude --fork-session` | Copies only the compacted chain and grows disk use |
| Copy the transcript | The pool is already shared, so a copy is only disk |
| Delete the source | Removes the rollback |
| Merge sidecars across versions | Requires writing a new generation |
| Trust one `forkedFrom` hop | Misses second-generation copies |

## Limits

- macOS 13 or newer with Claude Desktop. Sign Desktop into the target account to see moved history.
- Remote Control ownership does not transfer. The menubar archives a disconnected source mirror only after one complete local target verifies. A new target bridge starts lazily when that local session is resumed there.
- Artifact ownership, versions, comments, and share links stay with the original account. Artifacts are neither copied nor recreated.
- Sign Claude Desktop into From for Remote Control reconciliation. CLI moves without `--cloud` change local records only.
- Remote Control uses private Claude endpoints and fails closed if their response shape, organization, history, status, or authentication changes.
- Receipts from before 1.2.0 use byte-exact undo checks.
- File layouts are undocumented. Verified with Claude Code 2.1.257 and Desktop transcript 2.1.258.
- Moving history out of a Team organization is your organization's decision.
- Unofficial. Not affiliated with Anthropic.

Receipts, quarantine, the cache, and the menubar app live in `~/Library/Application Support/claude-transplant`. The `quarantine` folder can be deleted once its receipts are no longer wanted. A kernel lock prevents overlapping runs. MIT.
