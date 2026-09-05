<h1 align="center">claude-transplant</h1>

<h3 align="center">Move Claude Code history between accounts. Menubar or CLI.</h3>

<p align="center"><img src="https://raw.githubusercontent.com/vitaliyhayda/claude-transplant/main/menubar.gif" alt="Claude Transplant panel with source accounts converging on one destination" width="760"></p>

## What it does

Claude Desktop lists each Claude Code session under the account and organization that created it. Switch accounts and the history stays behind. claude-transplant moves every eligible local Desktop record immediately, regardless of which account is signed in. The transcript and sidecars stay where they are, the session keeps its id, nothing is copied. Remote Control runs for the active source. An inactive source creates no pending check when every readable unarchived local conversation moved, while unreadable or unarchived records left behind remain pending. No model runs and no artifact is recreated. `undo` restores completed work and cancels unfinished cloud sources as one logical move. macOS only.

## Install

Node 22 or newer. The menubar also needs the Xcode command line tools once: `xcode-select --install`.

```
npx claude-transplant menubar
npx claude-transplant
```

To run from this repository instead of npm: `npx github:vitaliyhayda/claude-transplant`, with `#v3.1.0` or a commit hash to pin.

The menubar shows two columns of email over plan, with FROM on the left and TO on the right. TO starts on the most recently used account other than the signed-in one, while every other account starts selected as a source. Uncheck only the accounts to leave behind. Curves converge on TO, chevrons show direction, destination changes swap lane identity, and source changes fade only that lane. Long inventories scroll together. The active account is tagged, pending sources are tagged, and Finish pending becomes available when one is active. Keep local abandons pending cloud work without reversing successful local movement. It starts at login, shows progress in the icon, and posts a notification when done. The app bundles its own CLI, so run the menubar command again after upgrading. Use `menubar --snapshot panel.png` to render the live panel without installing it, or use `menubar --remove` to uninstall. The animation above is rendered from the same Swift panel.

```
From  ↑↓ move · space select · enter next
  ❯ ◉ you@work.com · Acme Inc.    161 | 2h ago | acme-api | active
    ◉ you@work.com · Personal     157 | 1d ago | acme-api
    ○ you@home.com · Personal       3 | 5d ago | notes

To    ↑↓ move · enter confirm
  ❯ ● you@home.com · Personal       3 | 5d ago | notes

  inventory   318 records | 6 without history | 2 blocked | 3 already there | 5 cloud mirrors | 1 cloud rescue | 1 cloud check pending | 307 to move
  move        308 ✓ | 73,902 events | 307 zero-copy | 1 rescued
  sidecars    890 files | unchanged ✓
  desktop     308 records | 251 archived | 57 active
  verify      transcripts unchanged ✓ | sidecars unchanged ✓ | desktop ✓ | 2s
  retired     310 source records → quarantine | transcripts untouched
  cloud       5 source mirrors archived
  pending     1 source cloud check

  receipt     ~/Library/Application Support/claude-transplant/2026-09-02T16-04-11-208.json
  undo        npx claude-transplant undo
  then        restart Claude Desktop to see them
```

## Commands

| Command | Effect |
|---|---|
| `claude-transplant` | pick From and To, move, print a receipt |
| `claude-transplant --dry-run` | plan only and write nothing, refuses crash recovery or an open move, with `--cloud` it reads remote metadata and history |
| `claude-transplant undo` | quarantine the last move, restore the source entries, refused if a target changed or a source cannot be restored |
| `claude-transplant finish` | check the active pending source, retry its failures, or continue a staged cloud Undo |
| `claude-transplant keep-local` | cancel pending or failed cloud sources without reversing completed local movement |
| `claude-transplant accounts` | list accounts |
| `claude-transplant restart` | explicitly reload idle Desktop, including when it has no workers, never force quit |
| `claude-transplant menubar` | install the menubar app, `--snapshot <png>` renders live accounts, `--remove` uninstalls |
| `--from <match> --to <match>` | skip the picker, repeat `--from`, match on email, org name, or uuid prefix |
| `--cloud` | reconcile the active source and queue only inaccessible sources that still have unreadable or unarchived local records |
| `--json` | one event per line |
| `--version` | print the version |

## Reading the output

- without history: the transcript no longer exists on disk
- unreadable: the Desktop record is not valid JSON, named, nonzero exit
- source rejected or target rejected: a readable record has invalid identity or unsafe transcript history, named and left untouched
- compatible source versions: the same history exists in several transcript files, blocked unless the target already holds every version, since moving it would mean merging
- grew apart: overlapping versions with different messages or state, all move
- already there: the target already holds every message and sidecar file
- blocked: needs merging, has a collision, an unresolved parent, or is owned by a scheduled task, notification route, or running worker, named and left untouched
- retired: source entries moved to quarantine after verification, including already-there ones
- cloud mirrors: active or paused Remote Control rows found under the signed-in source
- cloud rescue: one divergent remote branch materialized as a separate local session from exact message payloads, with no model call
- cloud blocked: no unambiguous local anchor, an unsupported payload, a connected worker, changed history, or an account mismatch, left active and named
- cloud checks pending: inaccessible sources that still have unreadable or unarchived local records after the move
- newer cloud sessions: rows created after Move, named and left for the next move

Accounts are labeled from `~/.claude.json`, its backups, `~/.claude*` profile directories, and Desktop's agent-mode records. Known login pairs appear even before their Desktop record directory exists. Personal-plan organizations show as Personal. An account with no known email shows a uuid prefix, session count, last activity, and most common project folder.

## How it works

A session is three files that can disagree: the transcript in `~/.claude/projects`, the sidecar directory beside it, and the record under `~/Library/Application Support/Claude/claude-code-sessions/<account>/<organization>`. The transcript pool is shared by every account on the Mac, so a move writes the same record into the target organization with the same `cliSessionId`, verifies the transcript, sidecars, and both records are unchanged, then parks the source record in quarantine. Ten round trips keep one transcript.

Remote Control adds a fourth, server-owned layer. With `--cloud`, claude-transplant reads whichever selected source is active through Claude Desktop's authenticated session and hashes durable user and assistant message shapes. An inaccessible source becomes pending only when unreadable or unarchived local records remain after the move. Sign into a pending source and run `finish`, or click Finish pending, to inspect it without repeating the local move. A failed source keeps its remote session active and remains retryable. If one local target contains the remote history, that record becomes the destination. A bridge id links the remote row to its local session when available. Otherwise, one same-title target must share eight consecutive exact remote messages before it can anchor a separate companion whose supported remote message payloads are copied exactly into a new local transcript. The anchor supplies local project metadata and a narrow allowlist of project, display, and model settings because the remote endpoint does not expose a local working directory. Anchor-only prompt, browser, permission, spawn, and runtime state is discarded, and permission mode resets to default. The tool checks that the remote worker is disconnected and unchanged before archiving its source mirror. Cookies are decrypted in memory through macOS Keychain, sent only to `claude.ai`, and never printed or stored.

One receipt owns the local move, completed cloud checks, failures, retries, and unfinished sources. A delayed check includes only Remote Control sessions created no later than that original Move, so it never sweeps later work into an older instruction. Rows created later are named and left for the next move. Another move cannot start until that receipt is complete, kept local, or undone. Keep local cancels pending or failed cloud work without reversing completed local movement. Undo cancels unfinished cloud sources and reverses the whole move. If several source accounts already archived cloud mirrors, Undo restores the mirrors available under the current login and asks for each remaining source login before reversing the local records. No completed layer is silently abandoned.

A move is eligible when the history is a single comparable version, the record filename and identity are valid, no scheduled task, notification route, or running worker owns it, the parent record is already in the target or moves first in the same batch, and the target has no id collision. Everything else is refused with a named reason.

Remote Control can keep an idle Desktop worker alive, so process presence is not the same as an active response. An automatic restart is considered only when a selected record is worker-blocked. Every Desktop-owned Claude worker must map to a valid, unowned record and a completed turn (`end_turn`, `stop_sequence`, or `refusal`), followed by Desktop's global idle acknowledgement, unchanged across two checks. Unknown workers, unreadable activity, newer prompts, or active work mean wait, while eligible records still move. If cloud work is pending, finish it or choose Keep local before the next Move. No Remote Control default is changed.

After a graceful quit, the tool waits for Desktop and its tracked children, rebuilds the inventory with the original cloud-history cutoff, then moves. It attempts to reopen Desktop even if the move fails and verifies a new app process, not just an `open` exit code. A slow or failed shutdown is never force-killed or mistaken for a successful restart. The result asks you to reopen manually if it cannot confirm that state. The explicit restart link uses the same idle check, but can reload a workerless app when the log covers its lifetime without newer activity. It preserves the move summary and account choices.

Before writing, the transcript is hashed against its analyzed bytes and both records are reread. Sources and destinations are checked again before retirement, and a change after parking begins restores the plan. Undo verifies the target record and every restore path before recording its plan, then moves only Desktop records. A receipt journals every phase, interrupted retirement or undo resumes from it, and a corrupt newest receipt stops undo before it can reach the previous batch.

Planning reuses a disposable cache at `~/Library/Application Support/claude-transplant/cache.json`, keyed by path, device, inode, size, and nanosecond mtime and ctime. Dry runs read it, real moves refresh it, and every decision that writes is made from live files. Delete the cache at any time.

Lineage follows existing `forkedFrom` pointers to their roots, so copies made by earlier versions or other tools are recognized. A contained older destination record retires after the arriving record verifies. A duplicate message id counts as a sync replay only when the copies differ in runtime metadata alone and every parent exists, anything else is a conflict and the session is refused.

## Rules

- Rehome local history or refuse. Never duplicate an existing local transcript and never merge histories. A divergent remote-only branch may become one separate verified companion.
- No transcript or sidecar is renamed, edited, or deleted. The quarantined record is the rollback.
- No confirmation prompt. Runs are idempotent, writes are journaled, undo refuses before changing anything it cannot restore.
- Remote rescue copies supported payloads exactly. It does not ask a model to reconstruct history.
- Local transcripts stay local. Remote Control reconciliation uses Claude Desktop's current `claude.ai` session only when `--cloud` is present, with no credential persistence.
- Pending cloud checks never run automatically. The user signs into the named source and clicks Finish pending.
- Keep local cancels pending or failed checks only after completed local targets still verify.
- One JavaScript file, no dependencies, Node 22. The menubar is one Swift file.

## Not done, and why

| Tried | Result |
|---|---|
| Change ownership on the server | No API reassigns a session, so a verified local target replaces it and the source mirror is archived |
| `claude --fork-session` | Copies only the compacted chain and grows disk use |
| Copy an existing local transcript | The pool is already shared, so a duplicate is only disk |
| Delete the source | Removes the rollback |
| Merge sidecars across versions | Requires writing a new generation |
| Trust one `forkedFrom` hop | Misses second-generation copies |
| Atomic external idle-and-quit API | None exposed. Use two fresh checks and an ordinary guarded quit, never override Desktop's busy dialog |

## Limits

- macOS 13 or newer with Claude Desktop. Sign Desktop into the target account to see moved history.
- Remote Control ownership does not transfer. The menubar archives a disconnected source mirror only after an existing or newly materialized local target verifies. A new target bridge starts lazily when that local session is resumed there.
- Artifact ownership, versions, comments, and share links stay with the original account. Artifacts are neither copied nor recreated.
- Embedded base64, text, and HTTP or HTTPS images and documents can be rescued. Account-owned file ids and unknown source shapes are refused.
- Sign Claude Desktop into a named pending source to finish its Remote Control check or cloud Undo. Local movement never waits for that login.
- Remote Control uses private Claude endpoints and fails closed if their response shape, organization, history, status, or authentication changes.
- File layouts and Remote Control endpoints are undocumented. Verified with Claude Desktop 1.46388.1, bundled Claude Code 2.1.260, and transcript 2.1.258.
- Automatic restart also depends on Desktop's private activity log. Missing, rotated, changed, or inconclusive activity evidence means wait, never assume idle. Desktop's idle acknowledgement can arrive about 30 seconds after a response ends.
- Opening the embedded terminal logs `startShellPty`, not a model turn. That event does not invalidate an idle acknowledgement by itself.
- On the tested Desktop version, its installed quit guard checks both Code and Cowork activity before accepting a normal quit. New work can therefore veto the quit after our snapshot. The tool never accepts its Quit anyway option. Resumed workers without a completed turn from their current process remain unverified, so they may need a manual quit once idle.
- Moving history out of a Team organization is your organization's decision.
- Unofficial. Not affiliated with Anthropic.

Receipts, quarantine, the cache, and the menubar app live in `~/Library/Application Support/claude-transplant`. The `quarantine` folder can be deleted once its receipts are no longer wanted. A kernel lock prevents overlapping runs. MIT.
