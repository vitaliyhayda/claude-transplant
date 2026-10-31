<h1 align="center">claude-transplant</h1>

<h3 align="center">Move Claude Code history between accounts in Claude Desktop. Menubar or CLI.</h3>

<p align="center"><a href="https://www.npmjs.com/package/claude-transplant"><img src="https://img.shields.io/npm/v/claude-transplant" alt="npm version"></a> <a href="https://github.com/vitaliyhayda/claude-transplant/actions/workflows/ci.yml"><img src="https://github.com/vitaliyhayda/claude-transplant/actions/workflows/ci.yml/badge.svg" alt="CI"></a> <a href="https://github.com/vitaliyhayda/claude-transplant/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/claude-transplant" alt="MIT license"></a></p>

<p align="center"><img src="https://raw.githubusercontent.com/vitaliyhayda/claude-transplant/main/menubar.gif" alt="claude-transplant menubar panel moving Claude Code sessions from a Team account and a personal account into one destination in Claude Desktop" width="760"></p>

Different accounts, the same conversations

<table>
<tr>
<td width="50%" align="center"><a href="https://raw.githubusercontent.com/vitaliyhayda/claude-transplant/46897ffeb11a8fb14e175f023e2ee64c99c52e73/code-sidebar-work.png"><img src="https://raw.githubusercontent.com/vitaliyhayda/claude-transplant/46897ffeb11a8fb14e175f023e2ee64c99c52e73/code-sidebar-work.png" width="370" alt="Claude Desktop Code sidebar with three conversations under you@work.com, with Acme Inc. selected before Move"></a><br><strong>Work account before Move</strong><br>you@work.com · Acme Inc.</td>
<td width="50%" align="center"><a href="https://raw.githubusercontent.com/vitaliyhayda/claude-transplant/46897ffeb11a8fb14e175f023e2ee64c99c52e73/code-sidebar-personal.png"><img src="https://raw.githubusercontent.com/vitaliyhayda/claude-transplant/46897ffeb11a8fb14e175f023e2ee64c99c52e73/code-sidebar-personal.png" width="370" alt="The same three conversations under you@home.com, with Personal selected after moving Claude Desktop Code history between accounts"></a><br><strong>Personal account after Move</strong><br>you@home.com · Personal</td>
</tr>
</table>

## Quick start

```
npx claude-transplant menubar
```

Open the panel from the menu bar, check the accounts to take from, pick the one to land in, click Move. Sign Claude Desktop into that account and the sessions are listed there.

## What it does

Switch accounts in Claude Desktop and the Code sidebar goes empty. The session history is not lost. Desktop lists each Claude Code session under the account and organization that created it, so a personal plan, a Team seat, or a second Max subscription each sees only its own. This tool moves that history to the account you are using.

- Moves local Desktop session records to another account. Transcripts and sidecars stay on disk, sessions keep their ids, nothing is copied, and `undo` reverses the whole move.
- Sessions with a running Desktop worker wait until you approve a restart, or stay behind with Move only the rest.
- `--cloud` also archives the source account's Remote Control copies once the local session verifies.
- macOS only. Unofficial, not affiliated with Anthropic.

Where it fits next to the other tools people find for this problem:

| Tool | Layer | Effect on the Desktop Code sidebar |
|---|---|---|
| claude-swap, claude-acc, CCSwitcher, clauth, `CLAUDE_CONFIG_DIR` | swap the CLI login or config directory | none, Desktop keeps its own login and its own sidebar |
| restore-desktop-sessions | copies record files into the active account | sessions appear under both accounts and the copies drift apart |
| claude-code-session-restorer | rebuilds record files from transcripts on Windows | recovers a sidebar whose records were deleted |
| claude-transplant | moves record files between accounts, verified, with undo | history follows you, one account lists each session |

## Install

Node 22 or newer. The menubar also needs the Xcode command line tools: `xcode-select --install`

```
npx claude-transplant menubar   # install the menubar app
npx claude-transplant           # CLI
npm i -g claude-transplant      # global install, then claude-transplant
```

From this repo instead of npm: `npx github:vitaliyhayda/claude-transplant` (append a tag or commit hash to pin).

## Menubar

- When the active account is known, TO defaults to the most recently used other account and every other account starts as a source. Accounts with no sessions and no email stay hidden. Uncheck accounts to leave behind, Reset clears both columns.
- The last move's result stays until the next move or Reset, even after a restart.
- Open chats offer Restart Claude and move, and Finish the move continues pending work. Small links offer Undo last move, Keep moved sessions while work remains, and Show restart warnings when they are off. When the remaining work can't move, Keep and Undo are buttons.
- Held sessions move once their workers stop. Cloud cleanup retries under the signed-in login, and cleanup for another login waits for that sign-in unless Leave old copies and move skips it. While Claude starts, the panel says Waiting for Claude instead of asking you to sign in.
- Starts at login, shows percent and sessions left while moving, and notifies when done.
- Bundles its own CLI, so rerun `menubar` after upgrading.
- The app binary's `--demo <dir>` renders the frames of the animation above.

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
  move        307 ✓ | 307 zero-copy
  verify      chat messages unchanged ✓ | sidecars unchanged ✓ | desktop ✓

  receipt     ~/Library/Application Support/claude-transplant/2026-09-02T16-04-11-208.json
  undo        npx claude-transplant undo
```

| Command | Effect |
|---|---|
| `claude-transplant` | pick From and To, move, print a receipt |
| `--dry-run` | plan only, write nothing |
| `undo` | restore the last move, refused if a moved session changed or is still open, a new fork needs its parent, or a source can't be restored |
| `accounts` | list accounts |
| `menubar` | install the menubar app, `--snapshot <png>` renders the live panel, `--remove` uninstalls |
| `--from <match> --to <match>` | skip the picker, repeat `--from`, match on email, org name, or uuid prefix |
| `--cloud` | reconcile the active source's Remote Control copies, queue the rest |
| `--json` | one event per line |

`finish`, `sweep`, `restart`, `keep-local`, `--move-only` and `--restart-approved` handle held work, cloud checks and restarts. `claude-transplant --help` describes each.

## What each command touches

Every command may write the tool's own folder, `~/Library/Application Support/claude-transplant`: cache, lock, restart plan and diagnostics, receipts, quarantine and drift evidence. A move, `finish`, `sweep`, `undo` and `restart` first finish interrupted work, which can move records, rewrite the receipt and reopen Claude Desktop. `--dry-run` and `keep-local` refuse during recovery.

| Command | Beyond the tool's own folder |
|---|---|
| `accounts`, `--dry-run`, `--version`, `keep-local` | nothing, `--dry-run --cloud` also reads Remote Control metadata over the network |
| `restart` without a token | nothing beyond the recovery above |
| move, `finish`, `sweep`, `undo` | Desktop session records and scheduled task registries under `claude-code-sessions`, local Remote Control bridge metadata in shared transcripts |
| `--restart-approved <token>` | quits and reopens Claude Desktop around the operation |
| a move with `--cloud`, and `finish`, `sweep`, `undo`, or `restart` while the receipt has pending or staged cloud work | Desktop's claude.ai session read from Keychain in memory, network to `claude.ai` only, Remote Control copies archived or restored there |
| `menubar`, `menubar --remove` | the app bundle in the tool's folder and a LaunchAgent under `~/Library/LaunchAgents` |
| Move in the menubar | the same as a move with `--cloud` |
| `menubar --snapshot <png>` | that image file |

Command and flag names are stable. Renames get a deprecation release first.

## FAQ

### Why is the Code sidebar empty after switching accounts?

Desktop keeps one record per session under `~/Library/Application Support/Claude/claude-code-sessions/<account>/<organization>` and lists only the signed-in folder. The transcripts in `~/.claude/projects` are shared by every account.

### My sessions disappeared after signing out, an update, or a reset. Is this the fix?

Only when the records still exist under another account or organization. If a reset or update deleted them, there is nothing to move. The transcripts survive, `claude --resume` in the terminal still lists them, and the sidebar needs its records rebuilt.

### Do I have to move history back when I return to the first account?

Yes, it is a move, not a copy. Moving back is the same one click.

### Can I continue the same session under the other account?

Yes. It keeps its id, and the next message goes through the account you are signed into with the whole conversation as context. Personal history moved into a Team or Enterprise organization becomes that organization's data.

### Can a Team or Enterprise admin see moved history?

Team owners get usage analytics only. Enterprise compliance tooling can retrieve Claude Code session transcripts, and the next message in a moved session sends its whole conversation to that organization.

### Does it work on Windows or Linux?

Not yet. Desktop uses the same per-account folder layout there, so the CLI needs only the platform paths and process checks, and the menubar stays macOS. PRs welcome, and claude-code-session-restorer covers Windows rebuilds meanwhile.

Shorter answers:

- Does a move use tokens or talk to a model? No. Continuing a moved session costs the same as resuming any session after a break, because the prompt cache is per organization and a switch misses it either way.
- Which plans and accounts work? Any plan that runs Claude Code in Claude Desktop, Pro, Max, Team, or Enterprise. Two organizations on one email, a Team seat next to a personal plan, are two sidebars and both are supported.
- Is anything uploaded or read from Keychain? Only with `--cloud`, which the menubar's Move always passes. Desktop's claude.ai session is then read from Keychain in memory, sent only to claude.ai to reconcile Remote Control copies, and never stored.
- Does the CLI or the VS Code extension have this problem? The CLI does not, `claude --resume` reads the shared transcripts regardless of login. The VS Code extension keeps its own session index, untested and not handled here.
- What about Claude chats and Projects? Those live on claude.ai per organization and are not touched.
- Can I do it by hand? For task-free sessions, quit Desktop, move the record file into the other account's organization folder, then reopen Desktop. Do it only while Desktop is closed, it rewrites records it has open from memory.

Anthropic issues about the same problem:

- per-account scoping: [74662](https://github.com/anthropics/claude-code/issues/74662)
- root cause: [85294](https://github.com/anthropics/claude-code/issues/85294)
- disappearing sessions: [26452](https://github.com/anthropics/claude-code/issues/26452)
- account profiles: [18435](https://github.com/anthropics/claude-code/issues/18435)

Discussed on [Hacker News](https://news.ycombinator.com/item?id=49583423)

Manual walkthrough: [recovering missing Claude Desktop history](https://dev.to/vitaliyhayda/claude-desktop-history-missing-after-switching-accounts-and-how-to-get-it-back-4a26)

## How it works

A session is three files: the transcript in `~/.claude/projects`, the sidecar directory beside it, and the record under `~/Library/Application Support/Claude/claude-code-sessions/<account>/<organization>`. A move leaves the transcript and sidecars in place, writes and verifies the destination record with the same `cliSessionId`, then parks the source record in quarantine.

Eligibility:

- a sole session, the only Desktop record for its transcript with no fork, parent or rewind link, moves by identity and transcript fingerprint, even when its transcript fails to parse
- any other session's history is a single comparable version
- record filename and identity are valid
- no running worker owns it, and its task registrations, runs, notification routes, parents and forks form a complete movable family
- its parent is already in the target or moves first, and a parent stays wherever surviving forks refer to it, including archived forks without history
- no id collision in the target

Workers are identified by record id, CLI session id, PID, start time and ancestry. External CLI workers are always refused, because restarting Desktop does not stop them.

Restarts:

- When a move needs Desktop closed, the engine prints a plan first, and the menubar names the Code workers, windows, Chat, Cowork and background commands that will close. Approval covers that exact process list, or the saved choice to skip the warning. Task registry changes need Desktop stopped or both account and organization pairs known to be inactive. Other cold moves show no dialog.
- An approved restart moves what it can first, quits Desktop gracefully, waits for it and its child processes to exit, moves the held records with their routine families, and reopens Desktop. Desktop gets up to 30s to quit and 8s to reopen, and the move itself has no deadline. Nothing is force-killed and no cloud work runs while Claude is closed.
- A unit is a session, its fork family, or a whole routine family. When a unit fails, or a minute passes at a safe point with no progress, only unfinished units are unwound, and each is retried once on fresh data. A unit that fails again stays in its source with its dependents while the rest move on, and failures are listed with titles and reasons. A copy that changed after placement stays where it is, with its failure.
- Background retries never start a shutdown. Restart attempts are logged to a private, bounded `restart-events.jsonl` without prompts or raw errors.

Remote Control (`--cloud`):

- Reads the selected source organizations under the signed-in login through Desktop's own claude.ai session. Cookies are decrypted in memory via Keychain, sent only to `claude.ai`, and never stored.
- A copy is matched to its local session by bridge link or title and proven against the local conversation, subagent messages and delivered queued prompts, matched by id, role, payload and order. It is archived only after its remote worker is disconnected and unchanged and the proof holds again on fresh files.
- A copy that can't be proven to be on this Mac stays unarchived in its account, is named once in Details, and is never retried. The move still completes.
- Each retry checks identity, history and connection state before touching a remote row, and a failed source stays active and retryable.

Safety:

- One receipt owns the move, held records, cloud checks, failures and retries. Another move can't start until it is complete, kept local, or undone.
- Records are written to a private temp file, journaled, then exposed by an atomic no-clobber hard link, so a record is either absent or complete.
- Recovery unwinds only unfinished units and saves after every step. A crash during retirement restores the sources and unwinds their placed copies, so every session keeps exactly one live record. Interrupted undo resumes from the receipt, Undo restores the whole move, and a corrupt newest receipt stops undo. Unresolved ownership or history blocks further writes and keeps the recovery journal.
- A move interrupted under a version before 4.1.6 is left alone, and the CLI and panel say to finish it with `npx claude-transplant@4.1.6 finish`.
- Routine families keep reminders, run history, prompts and unrelated settings. A disabled twin in the destination is replaced only when it matches and nothing depends on it, and the receipt keeps it for undo.
- Later moves and sweeps report title, archive and starred changes under `drift/<receipt>`. Missing or unreadable records keep a warning.
- Sidecar symbolic links are accepted only as leaves inside real session folders, and only their target text and identity are read. Session folder links and special files are refused.
- Fork lineage follows `forkedFrom` pointers to their roots. A repeated message id counts as a replay only when one existing copy holds every filled tool-result value and producer marker, ignoring runtime metadata and token usage. Different filled values and complementary partial copies are refused.
- A disposable planning cache lives in `cache.json` in the tool's folder. Every write decision reads live files, so it can be deleted any time.

## Reading the output

- without history: transcript no longer exists on disk
- unreadable: Desktop record is not valid JSON, and retirement or undo can't touch its folder until it is fixed or removed
- source rejected / target rejected: invalid identity or unsafe transcript history, left untouched
- compatible source versions: same history in several transcripts without a Desktop fork, blocked unless the target holds every version
- overlapping versions: shared lineage kept separate, including Desktop forks
- already there: a Desktop record in the target holds every message and sidecar file
- held: a Desktop worker or scheduler owns required records, restart approval is offered
- blocked: needs merging, has a collision or unresolved parent, has an incomplete task family, or is owned by an external CLI worker
- retired: source records moved to quarantine after verification
- cloud mirrors: active or paused Remote Control copies under the signed-in source
- cloud blocked: not proven to be on this Mac, connected worker, changed history, or account mismatch
- kept: Remote Control copies left unarchived in their account, not proven to be on this Mac or left by Leave old copies and move
- source cloud checks: sources whose cloud cleanup still waits, usually for another login
- newer cloud sessions: created after Move, left for the next move

Accounts are labeled from `~/.claude.json` and its backups, `~/.claude*` profile directories, `~/.claude-switch/accounts/*` and Desktop's agent-mode records. Personal-plan organizations show as Personal, and an account with no known email shows a uuid prefix.

The active badge comes from Desktop's own `main.log`, with no Keychain read or network request, and shows unknown after a logout or an unfinished switch.

<details>
<summary>Rules</summary>

- Rehome local history or refuse. Never duplicate a local transcript, never merge histories.
- Chat messages and sidecars stay intact. The one transcript write appends Claude Code's own empty Remote Control pointer, so a stale pointer from the old account can't hide the session's title. A destination-owned pointer stays, SSH mirrors are left alone, recovery only appends, and Undo leaves later transcript edits and newer pointers alone. It needs no `--cloud`.
- A move to another account or organization drops the source account's saved error (`error`, `errorAt`, `priorErrorMark`) from the placed record. The quarantined original keeps it for Undo.
- Automatic retries cover the receipt's named work only. They never start a restart, store credentials, or create destination bridges.
- One JavaScript file, no dependencies, Node 22. The menubar is one Swift file.

</details>

<details>
<summary>Not done, and why</summary>

| Tried | Result |
|---|---|
| Change ownership on the server | No API reassigns a session |
| `claude --fork-session` | Copies only the compacted chain and grows disk use |
| Copy an existing local transcript | The pool is already shared, a copy only costs disk |
| Delete the source | Removes the rollback |
| Merge sidecars across versions | Requires writing a new generation |
| Extend per-field replay omission lists | Claude Code changes which fields it blanks, so a complete existing copy must cover every filled tool-result value instead |
| Treat replay bookkeeping as changed content | Claude Code 2.1.286 replayed identical content with zeroed token usage and no producer markers, which blocked a whole task family |
| Rely only on cached conversation hashes | They miss subagent files and queued-prompt delivery, so supplemental checks read the session's artifacts |
| Move a record while its Desktop worker runs | Desktop rewrites it from cache, rolling back the title and turn count |
| Leave a matching `.json.tmp` beside a retired record | Desktop restores the source from it on restart, so both are quarantined and restored together |
| Infer a restart-safe moment from activity logs | Cold records need no restart, held records get an explicit graceful shutdown |
| Repair changed records from old snapshots | Would overwrite real title, archive, and pin edits |
| Read the active org from Desktop's extensions allowlist timestamp | Can point at the wrong org after a failed refresh |
| Trust the `lastActiveOrg` cookie for the active organization | Stale after an in-Desktop switch, so it is only a fallback to the log |
| Require `/usr/bin/lockf` on every macOS version | macOS 14.5 lacks it, so bundled Perl takes the same kernel lock |
| Require a deleted routine's registration to move its archived runs | Runs of a routine in no registry, without notification routes, forks or scheduler state, move cold like any archived chat |
| Raise each history's memory limit independently | Concurrent reads multiply memory use, so one process budget is shared and concurrency drops under pressure |
| Append the bridge clear to an SSH session's local transcript | Desktop extends that mirror past the local size, so the next remote write leaves an unparseable fragment |
| Rescue copies of unproven Remote Control mirrors | Four of four rescue decisions were false positives that only made duplicates |

</details>

## Limits

- macOS 13 or newer with Claude Desktop. Sign Desktop into the target account to see moved history.
- Live Sonoma runs are unverified. The missing-`lockf` fallback is covered by synthetic checks.
- Remote Control ownership does not transfer. Re-enable it per session under the destination account.
- Artifact ownership, versions, comments, and share links stay with the original account.
- Remote Control uses private Claude endpoints and fails closed if their shape or auth changes.
- Remote history reads stop at 1m events, and one operation aims to stay under 20% of RAM, a target the OS does not enforce. A history over a limit pauses until something changes or you retry, and an incomplete check never authorizes cleanup.
- A filesystem call that never returns is not detected, so it can stall a move.
- Subagent coverage from retained histories after a CLI identity change is unsupported.
- Moving history out of a Team organization is your organization's decision.
- File layouts, log wording, and endpoints are undocumented and may change. Tested combinations are in the table below.

| claude-transplant | macOS | Claude Desktop | Claude Code | Tested |
|---|---|---|---|---|
| 4.1.6 | 27.0.1 | 3.6556.2 | 2.1.308 | 2026-10-29 |
| 4.1.5 | 27.0.1 | 3.6556.2 | 2.1.308 | 2026-10-26 |
| 4.1.4 | 27.0.1 | 3.6556.2 | 2.1.308 | 2026-10-26 |

4.1.5 and 4.1.6 were validated with synthetic fixtures and read-only code inspection, without a new live move.

Delete `quarantine` once its receipts are no longer wanted. A kernel lock prevents overlapping runs. MIT.
