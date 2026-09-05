<h1 align="center">claude-transplant</h1>

<h3 align="center">Move Claude Code history between accounts. Menubar or CLI.</h3>

<p align="center"><img src="https://raw.githubusercontent.com/vitaliyhayda/claude-transplant/main/menubar.gif" alt="Claude Transplant panel with source accounts converging on one destination" width="760"></p>

## What it does

Claude Desktop lists each Claude Code session under the account and organization that created it. Switch accounts and the history stays behind. claude-transplant moves every eligible local Desktop record immediately, regardless of which account is signed in. The transcript and sidecars stay where they are, the session keeps its id, nothing is copied. A session owned by a Desktop worker offers an explicit restart or Move only the rest. There is no idle detector or idle wait. Remote Control runs for the active source. An inactive source creates no pending check when every readable unarchived local conversation moved, while unreadable or unarchived records left behind remain pending. No model runs and no artifact is recreated. `undo` restores completed work and cancels unfinished cloud sources as one logical move. macOS only.

## Install

Node 22 or newer. The menubar also needs the Xcode command line tools once: `xcode-select --install`.

```
npx claude-transplant menubar
npx claude-transplant
```

To run from this repository instead of npm: `npx github:vitaliyhayda/claude-transplant`, append a published tag or commit hash to pin.

The menubar shows two columns of email over plan, with FROM on the left and TO on the right. When the active identity is known, TO starts on the most recently used account other than the signed-in one, while every other account starts selected as a source. When it is unknown, choose TO explicitly. An explicit destination choice is preserved across refreshes. Uncheck only the accounts to leave behind. Curves converge on TO, chevrons show direction, destination changes swap lane identity, and source changes fade only that lane. Long inventories scroll together. The active account is tagged, pending sources are tagged, and Finish move continues the same receipt, and an open local session offers Stop and restart. A held local source and its dependent forks can finish under any login. The app quietly retries held local work when its workers stop and source cleanup when the source account becomes active, with a 60-second retry backoff. A connected mirror is waiting work, and its known local worker can be stopped through the same explicit restart flow. A cheap process check skips repeated transcript inventories while held workers remain. Read-only account refreshes stop after 60 seconds if they fail to return. Mutating sweeps keep their journal and HTTP timeouts, and errors remain visible in the panel. Keep completed cancels the remaining work without reversing completed moves. Results stay in one sentence with Details collapsed by default. The selection clears after a completed operation. Waiting work keeps its original destination, and an unavailable source account shows which login is needed. A connected session without a local worker to stop stays waiting instead of offering a button that can only repeat the hold. It starts at login, shows progress in the icon, and posts a notification when done. The app bundles its own CLI, so run the menubar command again after upgrading. Use `menubar --snapshot panel.png` to render the live panel without installing it, or use `menubar --remove` to uninstall. The animation above is rendered from the same Swift panel and result handler. It follows one person rotating between their own work and home logins. The home Personal account is the destination, Acme is active, and Northwind is unchecked before moving the 318 selected records, matching the terminal example.

```
From  ↑↓ move · space select · enter next
  ❯ ◉ you@work.com · Acme Inc.    161 | 2h ago | acme-api | active
    ◉ you@work.com · Personal     157 | 1d ago | acme-api
    ○ you@home.com · Personal       3 | 5d ago | notes
    ○ you@work2.com · Northwind     12 | 4m ago | northwind

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
```

## Commands

| Command | Effect |
|---|---|
| `claude-transplant` | pick From and To, move, print a receipt |
| `claude-transplant --dry-run` | plan only and write nothing, refuses crash recovery or an open move, with `--cloud` it reads remote metadata and history |
| `claude-transplant undo` | quarantine the last move, restore the source entries, refused if a target changed or a source cannot be restored |
| `claude-transplant finish` | finish held local records, check the active pending cloud source, or continue a staged cloud Undo |
| `claude-transplant sweep` | verify placed metadata and quietly retry eligible pending work, never request a new restart |
| `claude-transplant restart` | display a plan for the existing Desktop refresh action |
| `--move-only` | move eligible records and leave Desktop-owned records held in the same receipt |
| `--restart-approved <token>` | approve the exact engine plan printed by the prior move, finish, or restart call |
| `claude-transplant keep-local` | cancel held work and pending cloud checks without reversing completed moves |
| `claude-transplant accounts` | list accounts |
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
- held: a Desktop worker owns a required source or destination record, restart approval is offered and declined work stays in the receipt
- blocked: needs merging, has a collision, an unresolved parent, or is owned by a scheduled task, notification route, or external CLI worker, named and left untouched
- retired: source entries moved to quarantine after verification, including already-there ones
- cloud mirrors: active or paused Remote Control rows found under the signed-in source
- cloud rescue: one divergent remote branch materialized as a separate local session from exact message payloads, with no model call
- cloud blocked: no unambiguous local anchor, an unsupported payload, a connected worker, changed history, or an account mismatch, left active and named
- cloud checks pending: inaccessible sources that still have unreadable or unarchived local records after the move
- newer cloud sessions: rows created after Move, named and left for the next move

Accounts are labeled from `~/.claude.json`, its backups, `~/.claude*` profile directories, and Desktop's agent-mode records. Known login pairs appear even before their Desktop record directory exists. Personal-plan organizations show as Personal. An account with no known email shows a uuid prefix, session count, last activity, and most common project folder.

Active identity comes from the newest complete account/org initialization entry in Claude Desktop's `main.log` and numbered rotations during the current Desktop process lifetime. A newer logout, unfinished switch, initialization failure, conflict with account configuration, or missing usable entry clears the answer. Startup timestamps in the same second are accepted. There is no inactivity expiry, Sentry or usage inference, focused-session fallback, Keychain access, or network request for the badge. One resolver supplies the badge, destination suggestion, and pending-source detection. The panel shows unknown or signed out when appropriate, while cloud mutations independently authenticate the account and organization before writing. Desktop must be running to resolve its active identity.

The extensions allowlist timestamp was rejected as an identity source and as a veto. Desktop writes it after an asynchronous network request without rechecking selection, so a failed refresh or delayed response can leave it pointing at another organization. Log wording remains private and fixtures cannot detect future vendor changes by themselves. Restricting accepted entries to the current launch prevents an older launch's recognized entry from silently surviving a changed startup format.

## How it works

A session is three files that can disagree: the transcript in `~/.claude/projects`, the sidecar directory beside it, and the record under `~/Library/Application Support/Claude/claude-code-sessions/<account>/<organization>`. The transcript pool is shared by every account on the Mac, so a move writes the same record into the target organization with the same `cliSessionId`, verifies the transcript, sidecars, and both records are unchanged, then parks the source record in quarantine. Ten round trips keep one transcript.

Remote Control adds a fourth, server-owned layer. With `--cloud`, claude-transplant reads whichever selected source is active through Claude Desktop's authenticated session and hashes durable user and assistant message shapes. An inaccessible source becomes pending only when unreadable or unarchived local records remain after the move. Sign into a pending source and the menubar retries it automatically. CLI users run `finish` or `sweep`. Each retry uses the original receipt and checks the active authenticated identity, history, persisted user/control input, pending-action fields, and connection state before changing a remote row. The installed Desktop worker code maintains pending actions separately from its idle status. The archive guard refuses nonempty or unreadable action metadata and re-reads one complete user/assistant/control-event digest immediately before archival. A failed source keeps its remote session active and remains retryable. If one local target contains the remote history, that record becomes the destination. A bridge id links the remote row to its local session when available. Otherwise, one same-title target must share eight consecutive exact remote messages before it can anchor a separate companion whose supported remote message payloads are copied exactly into a new local transcript. The anchor supplies local project metadata and a narrow allowlist of project, display, and model settings because the remote endpoint does not expose a local working directory. Anchor-only prompt, browser, permission, spawn, and runtime state is discarded, and permission mode resets to default. The tool checks that the remote worker is disconnected and unchanged before archiving its source mirror. Cookies are decrypted in memory through macOS Keychain, sent only to `claude.ai`, and never printed or stored.

One receipt owns the local move, held records, completed cloud checks, failures, retries, and unfinished sources. A later local phase appends to that receipt only if it is still current under the lock, so Undo cannot be followed by a stale retry that starts another move. Only the new phase is verified against placement bytes, so older sessions may continue normally. A crash during an append rolls back only that phase. A delayed check includes only Remote Control sessions created no later than that original Move, so it never sweeps later work into an older instruction. Rows created later are named and left for the next move. Another move cannot start until that receipt is complete, kept local, or undone. Keep local cancels held records and pending or failed cloud checks without reversing completed local movement. Undo cancels unfinished cloud sources and reverses the whole move. If several source accounts already archived cloud mirrors, Undo restores the mirrors available under the current login and asks for each remaining source login before reversing the local records. No completed layer is silently abandoned.

A move is eligible when the history is a single comparable version, the record filename and identity are valid, no scheduled task, notification route, or running worker owns it, the parent record is already in the target or moves first in the same batch, and the target has no id collision. Worker identity includes the Desktop record id, CLI session id, PID, process start time, and ancestry. New CLI workers can omit the session id from argv, so the tool also reads `~/.claude/sessions/<pid>.json`. It accepts the registered session id only when the filename, PID, Darwin process domain, and UTC process-start value match the live process. Companion key files are never read. Helper and child processes appear as one session in the restart warning. An external CLI worker stays a separate refusal because restarting Desktop does not stop it. Unrelated validation failures do not trigger a restart. Everything else is refused with a named reason.

When a selected operation needs Desktop to close, the engine emits a plan before moving records. The menubar shows a native warning listing known Code workers and stating that all Desktop windows, Chat, Cowork, and background commands will close. Stop and restart approves that exact process inventory, Move only the rest keeps held records pending, and Cancel starts no additional work. Don't show again suppresses future warnings only for user-initiated actions, and Show restart warnings restores them. A changed process inventory invalidates approval. The ordinary cold path has no dialog. While held local work remains, Finish pending is the only restart action shown. Keep local leaves that held work at its source and allows a new move. The existing refresh link uses this same explicit restart flow.

History analysis is prepared while Desktop is running. Local and remote phases share the same cached history representation, so the post-quit pass validates fingerprints and reparses changed history instead of invalidating the archive cache. Inventory checks the remaining budget between records. An approved restart begins immediately, budgets 30 seconds from the approved CLI invocation, and reserves the last eight seconds for reopening. The engine sends a graceful quit, waits for the recorded Desktop process and descendants to exit, re-inventories only the original selection, moves through the existing rehome and retirement paths, and sends the reopen request before any fallible final journal write, even if earlier I/O exhausted its deadline. No force kill and no cloud API work run in this interval. If Claude asks for native quit confirmation, the tool does not answer it. A veto or deadline leaves the held records untouched and reports the failure. An OS stall can exceed the cooperative deadline, and a failed launch can prevent reopening. Both are reported with the recovery receipt. A later invocation may finish reopening a previously approved interrupted restart, but a background retry never starts a new shutdown.

The next Move and menubar sweep compare the latest receipt's placed records with their snapshots. Focus timestamps, turn counters, and new bridge registrations are expected runtime changes. Durable differences such as title, archive state, or pin state save both versions under `drift/<receipt>` and appear in the panel. A legitimate user edit is indistinguishable from some cache rewrites, so the tool reports the difference without overwriting it or pretending it proves corruption.

Legacy partial receipts can adopt their named worker refusals as held records and append completion to the original receipt. Cancelled work remains cancelled unless explicitly resumed. A resumed cancelled source check retains its recorded remote session ids, so it cannot sweep unrelated older sessions into the retry. One Undo then covers the earlier and later phases.

Before writing, the transcript is hashed against its analyzed bytes and both records are reread. A private temporary inode is fully written and journaled before an atomic no-clobber hard link exposes the completed record. Failed placement and interrupted v4 recovery leave independently arrived records alone, even when their bytes match the intended copy. Sources and destinations are checked again before retirement, and a change after parking begins restores the plan. Undo verifies the target record and every restore path before recording its plan, then moves only Desktop records. A receipt journals every phase, interrupted retirement or undo resumes from it, and a corrupt newest receipt stops undo before it can reach the previous batch.

Planning reuses a disposable cache at `~/Library/Application Support/claude-transplant/cache.json`, keyed by path, device, inode, size, and nanosecond mtime and ctime. Dry runs read it, real moves refresh it, and every decision that writes is made from live files. Delete the cache at any time.

Lineage follows existing `forkedFrom` pointers to their roots, so copies made by earlier versions or other tools are recognized. A contained older destination record retires after the arriving record verifies. A duplicate message id counts as a sync replay only when the copies differ in runtime metadata alone and every parent exists, anything else is a conflict and the session is refused.

## Rules

- Rehome local history or refuse. Never duplicate an existing local transcript and never merge histories. A divergent remote-only branch may become one separate verified companion.
- No transcript or sidecar is renamed, edited, or deleted. The quarantined record is the rollback.
- Cold moves need no confirmation. Desktop restarts require an exact plan approval or the saved warning preference. Writes are journaled, and Undo refuses before changing anything it cannot restore.
- Remote rescue copies supported payloads exactly. It does not ask a model to reconstruct history.
- Local transcripts stay local. Remote Control reconciliation uses Claude Desktop's current `claude.ai` session only when `--cloud` is present, with no credential persistence.
- Automatic retries cover the receipt's named work only. They never initiate a new Desktop restart, store account credentials, or create destination Remote Control bridges.
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
| Move verbatim records while a Desktop worker runs | September 4 probe retained the transcript but observed stale title and turn metadata after switching and opening. That probe retained a historical bridge id, so it did not isolate the production rehome transform or the cause of the rewrite |
| Treat sidebar Idle as an interruption inventory | An organization switch stopped two unrelated workers during the probe. The restart warning uses process ancestry and identities, and explicitly covers all Desktop windows |
| Infer a restart-safe moment from private activity logs | Not required by this version. Cold records move normally and held records require an explicit graceful shutdown |
| Repair every changed record from its old snapshot | Would overwrite legitimate titles, archive changes, and pins. Save evidence and report meaningful differences instead |
| Multiline argv in macOS `ps` | The local canary escaped its newline as `\012`, and strict parsing passed |

## Limits

- macOS 13 or newer with Claude Desktop. Sign Desktop into the target account to see moved history.
- Remote Control ownership does not transfer. The menubar archives a disconnected source mirror only after an existing or newly materialized local target verifies. Enable Remote Control per session under the destination account yourself.
- Artifact ownership, versions, comments, and share links stay with the original account. Artifacts are neither copied nor recreated.
- Embedded base64, text, and HTTP or HTTPS images and documents can be rescued. Account-owned file ids and unknown source shapes are refused.
- Sign Claude Desktop into a named pending source to finish its Remote Control check or cloud Undo. Local movement never waits for that login.
- Remote Control uses private Claude endpoints and fails closed if their response shape, organization, history, status, or authentication changes.
- File layouts and Remote Control endpoints are undocumented. Original reconciliation coverage used Desktop 1.46388.1 and bundled Claude Code 2.1.260. The cold control passed on Desktop 1.46388.3. The hot canary reopened on 1.46388.4 after Desktop updated during shutdown.
- Moving history out of a Team organization is your organization's decision.
- Unofficial. Not affiliated with Anthropic.

A September 5 canary exercised the final atomic writer into the active organization while an unrelated Desktop worker stayed running. The watcher saw a complete JSON record on its first observation, metadata stayed correct for 60 seconds, and Undo restored the source exactly. Desktop and the unrelated worker kept their original PID and start identities.

The September 4 cold control used the real rehome transform from the active organization with no worker. Its target bytes stayed identical for 60 seconds, then title and archive state survived switching and opening, with only the focus timestamp changing. The hot canary used the production Swift Model, Panel, warning, and engine in an isolated window harness. Cancel preserved both files and left warning suppression off. Approval completed in 6.7 seconds, preserved title, archive state, and pin, and continued under the target account with a correct recall of the original seed. Undo refused while that target worker ran, then restored the source while retaining the new transcript turn after the worker stopped. The status-item popup itself was not exercised by that harness. Native quit vetoes and failure recovery use deterministic fixture coverage. These are observed results on those builds, not a guarantee about every future Desktop cache implementation.

The September 5 identity check resolved the running Desktop's Personal organization after hours without an identity event, and the rendered live panel displayed its active badge. All 149 Node tests passed, including launch boundaries, rotations, incomplete transitions, logout, account conflicts, and a simulated offline switch with a stale allowlist timestamp. Twelve retained real switch sequences were replayed through the resolver. Swift checks confirmed that unknown identity leaves the suggested destination empty while preserving an explicit choice. New live account switches and logout were not performed because three unrelated Desktop workers were running. The offline check is a fixture, not evidence of a newly performed offline Desktop switch.

A later installed-popup test exposed a real timeout and two UI gaps. The cloud/local cache-key split forced a post-quit reparse of the 177-record archive, connected mirrors were repeated as failures, and helper processes appeared as duplicate unidentified sessions. The corrected cache reused all 167 analyzed histories in a 121 ms second pass after a 29.9-second cold preparation with Desktop still open. Regression coverage checks cross-phase reuse, changed-history reanalysis, scan deadlines, process-registry identity, grouped warnings, normal connected-session waiting, receipt-bound completion, and one Undo across a legacy partial move.

The repaired build then completed the real installed-menubar flow through mouse clicks. The native restart took 11.7 seconds and appended the remaining record to the existing 165-session receipt. All 166 destination records were present, the original 165 receipt entries and quarantine entries were unchanged, the source record was retired, and verification passed with no held sessions, failures, or pending source checks. The three original mirrors were independently confirmed archived, they were already archived before this final run and were not claimed as new archival work. Switching Desktop to the destination showed all three named conversations, and opening them produced three correctly named worker groups. The popup displayed one completed summary with the selection cleared, and its actual Details control expanded correctly. The combined Undo path was exercised against a legacy-receipt fixture, not by reversing the owner's completed live move. The full Node suite has 156 passing tests, with Swift typechecking and model-state checks also passing.

Native automation did not expose the windowless status popup reliably. The live test used direct mouse clicks and screenshots on the external display, whose macOS coordinates have a negative Y origin. SwiftUI ImageRenderer did not capture the native scroll content inside expanded Details, so that control was verified in the installed popup instead of relying on its synthetic image.

To regenerate the demo, compile `swiftc -O -parse-as-library -o /tmp/claude-transplant-demo menubar.swift`, then run `/tmp/claude-transplant-demo --demo /tmp/claude-transplant-frames`. Encode its PNGs using one shared 256-color palette and the durations in `durations.json`. The September 5 animation has ten frames at 1084 by 642 pixels, including the final result height in every frame. The account data matches the terminal example, and decoded GIF frames were checked for retained blue controls and green active tags.

Receipts, quarantine, the cache, and the menubar app live in `~/Library/Application Support/claude-transplant`. The `quarantine` folder can be deleted once its receipts are no longer wanted. A kernel lock prevents overlapping runs. MIT.
