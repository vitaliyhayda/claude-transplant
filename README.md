<h1 align="center">claude-transplant</h1>

<h3 align="center">Move Claude Code history between accounts. Either via menubar or CLI.</h3>

<p align="center"><img src="https://raw.githubusercontent.com/vitaliyhayda/claude-transplant/main/menubar.gif" alt="Claude Transplant: pick from, pick to, move" width="760"></p>

## What it is

Claude Desktop keeps Claude Code sessions inside the account and organization that listed them. Switch accounts or organizations and your history stays behind. claude-transplant moves each small Desktop record to the context you are switching to while keeping the same global transcript, sidecars, and session id. The source entry retires only after the destination verifies, no transcript is copied or edited, and the last move undoes with one command. Ambiguous histories are named and left untouched instead of being reconstructed. Run it twice and the second run finds nothing to move. macOS only, because it works on Claude Desktop's own files.

## Menubar or CLI

Same engine, two doors. Both need Node 22 or newer. The menubar also needs the Xcode command line tools once, `xcode-select --install`. Straight from this repository instead of the npm registry: `npx github:vitaliyhayda/claude-transplant`. Append `#v2.0.0` or a commit hash to pin one.

```
npx claude-transplant menubar
```

The menubar app asks the same two questions and nothing else. It starts at login, animates immediately after Move, shows real per-phase counts when totals are known, posts a notification when done, and marks the account Claude Desktop is signed into as active. When one account is left unpicked it becomes the destination on its own. It is a single Swift file, compiled once, that keeps its own copy of the CLI inside the app bundle and reads its JSON, so after upgrading the package run the menubar command again. `menubar --remove` takes it out. The animation above is rendered by the app itself: the binary inside the bundle, run with `--demo <dir>`, writes the frames and their durations.

```
npx claude-transplant
```

```
From  ↑↓ move · space select · enter next
  ❯ ◉ you@work.com · Acme Inc.    161 | 2h ago | acme-api
    ◉ you@work.com · Personal     157 | 1d ago | acme-api
    ○ you@home.com · Personal       3 | 5d ago | notes | active

To    ↑↓ move · enter confirm
  ❯ ● you@home.com · Personal       3 | 5d ago | notes | active

  inventory   318 records | 6 without history | 2 blocked | 3 already there | 307 to move
  move        307 ✓ | 73,783 events | 307 zero-copy
  sidecars    890 files | unchanged ✓
  desktop     307 records | 251 archived | 56 active
  verify      transcripts unchanged ✓ | sidecars unchanged ✓ | desktop ✓ | 2s
  retired     310 source records → quarantine | transcripts untouched

  receipt     ~/Library/Application Support/claude-transplant/2026-09-02T16-04-11-208.json
  undo        npx claude-transplant undo
  then        restart Claude Desktop to see them
```

## Options

| Command | What it does |
|---|---|
| `claude-transplant` | pick From and To, move, print a receipt |
| `claude-transplant --dry-run` | plan only, write nothing, refuses to predict until an interrupted run is reconciled |
| `claude-transplant undo` | quarantine the last move and put the source entries back, refused if a target changed or a source cannot be restored |
| `claude-transplant accounts` | list accounts |
| `claude-transplant menubar` | install the menubar app, `--remove` uninstalls |
| `--from <match> --to <match>` | skip the picker, repeat `--from`, match on email, org name, or uuid prefix |
| `--json` | machine-readable output, one event per line |
| `--version` | print the version |

The inventory line, decoded:

- without history: a Desktop record whose transcript no longer exists on disk
- unreadable: a Desktop record that is not valid JSON. It is named, the command exits nonzero, and no assumption is made about its history
- compatible source versions: the same history exists in separate transcript generations. If the target does not already contain every version, the group is blocked because moving it would require merging. Exact account records that point to one physical transcript move once and every verified source owner retires
- grew apart: overlapping versions with different messages or meaningful state, or two branches that both continued after a copy. All of them move and the line says so
- already there: the target already holds every message and every sidecar file, followed through earlier copies whose transcripts are still on disk
- blocked: the history needs merging, has a collision or malformed record, has an unresolved parent, or is owned by a task, notification route, or running worker. Every blocked history is named and left untouched

The retired line counts source entries that left their organization once the destination was verified. The target record points to the same transcript and sidecars. Only the old Desktop entry moves into quarantine, and `undo` puts it back. Sources and destinations are checked at the retirement boundary and again afterward. If anything changes after parking begins, the plan is restored before return. A changed record, missing destination, scheduled-task registry, notification route, or running worker keeps its entry and makes the run fail visibly.

Accounts are labeled from `~/.claude.json`, its backups, any `~/.claude*` profile directory, and Desktop's agent-mode records. Personal-plan organizations show as Personal. The active tag prefers a recent organization request in Desktop's local Sentry scope, then recent usage or focus evidence, and shows nothing when all signals are stale. An account with no known email shows a uuid prefix, then its session count, last activity, and most common project folder.

## How it works

A Claude Code session is three things that can disagree: the transcript in `~/.claude/projects`, the sidecar files beside it, and the account-scoped record under `~/Library/Application Support/Claude/claude-code-sessions/<account>/<organization>`. The transcript pool is global on the Mac. An ordinary move therefore writes the same Desktop record into the target account and organization with the same `cliSessionId`, verifies the unchanged transcript, sidecars, and both records, then parks the source record. Ten round trips keep one transcript.

The zero-copy path is deliberately narrow. It requires a different account or organization context, one comparable history, a valid record filename and identity, no scheduled task or notification route, no running worker, no unresolved parent record, and no target id collision. A parent link is allowed when its parent is already in the target or moves first in the same batch. Exact account records that share one transcript move once. Compatible histories in separate transcript files are blocked because combining them would require writing a new transcript. Anything outside these conditions fails with a named reason and remains where it is.

Before writing, rehome hashes each live transcript against its analyzed bytes, checks sidecar paths and file metadata, and rereads both Desktop records. Fresh metadata fingerprints guard verification and retirement because transcripts and sidecars are never written. Existing destinations and all source records are checked again immediately before retirement. Undo verifies the target record and every quarantined restore path before recording its plan. An unreadable Desktop record or selected scheduled-task registry stops the run instead of silently discarding ownership evidence. A bad registry in an unrelated account remains visible in the picker but does not block other accounts. A failed check exits nonzero and prevents unsafe retirement.

Successful real moves refresh a disposable analysis cache at `~/Library/Application Support/claude-transplant/cache.json`. It stores derived lineage, transcript hashes, and sidecar manifests keyed by path, device, inode, size, and nanosecond mtime and ctime. Dry-run can read that cache but never writes it. A real move reads and hashes the live transcript before placing a record, and any fingerprint change blocks the move or retirement. Deleting or corrupting the cache makes the next real move rebuild its analysis from live files.

A duplicate message id counts as a sync replay only when the copies differ in runtime metadata alone, parent pointer, folder, slug, prompt id, version, git branch, or tool output verbosity, and every parent exists. Anything else is a conflict and the session is refused. This rests on one assumption made deliberately: a message id names one event, so two compatible placements of the same id are one event, and the richer copy is kept.

Lineage comparison follows existing `forkedFrom` pointers back to their roots so old copies are recognized without creating new ones. Versions with different shared content, replacements, suppression, relocation state, or conflicting sidecars remain separate. A contained older destination record retires after the arriving record verifies, while its transcript and sidecars stay in the global pool for Undo. A receipt journals record creation, verification, retirement, and undo. Interrupted retirement restores every partially parked entry, and interrupted undo resumes from its recorded state. Undo and crash rollback move only Desktop records. Shared transcript or sidecar growth stays in place, while a missing transcript or expected sidecar tree stops recovery.

## Why it is built this way

- Rehome or refuse. An ordinary account or organization switch needs only a Desktop record move. Ambiguous histories stay untouched with a named reason.
- The quarantined source record is the rollback. No source transcript or sidecar is renamed, edited, or deleted. Undo restores the original record after checking every path.
- No confirmation prompt. Safety lives in properties, not dialogs: runs are idempotent, record writes are journaled, and undo refuses before changing anything when a target changed or a source cannot be restored.
- Cache is acceleration with live validation. Planning reuses unchanged analysis, then zero-copy rehome hashes the current transcript and checks fresh file fingerprints before any source entry retires.
- Lineage over bookkeeping. "Already there" follows `forkedFrom` pointers to the root, so copies made through earlier hops, or by other tools, are recognized without a shared database.
- One file, no dependencies. Plain JavaScript on Node 22, no build step, and one source file to audit. The menubar is one Swift file for the same reason.
- Local only. No tokens, cookies, or network. The tool never reads Desktop's credential caches.

## The long view

Every green light in this system proves one layer. A transcript that parses says nothing about the sidebar. A record in the sidebar says nothing about whether its transcript still exists. An active remote bridge says nothing about whether a local process is alive to serve it. Most history-loss stories start with trusting one layer's signal for another layer's claim.

Tools that share one transcript store across accounts solve a different problem: who pays for the next turn. They do not make history belong to an account, and they cannot make it appear in Claude Desktop under that account. If you live in a terminal and rotate logins for rate limits, use one of those. If Claude Desktop is your home and you switch accounts deliberately, move the history, sign in on your phone to the same account, and accept a few minutes of login tax for behavior that is supported end to end.

Earlier releases paid for every rotation with another full transcript generation. Version 2 removes transcript generation entirely. The ten-round-trip test keeps one transcript and less than 1 MB of receipts and recoverable record backups. On the 162-session test Mac, a warmed move fell from 40-41 seconds to 1-2 seconds. Cross-login tests continued one session under both emails and across Team and Personal, with restarts between moves and no transcript fork. Ineligible histories are refused, the tool never prunes transcripts, and the quarantined source record remains the rollback.

## Dead ends

Each of these was tried. Each looked like it worked until the layer below was checked.

| Tempting | Why it fails | Here |
|---|---|---|
| Change cloud ownership on a session | No API reassigns ownership | Rehome the eligible local record, leave cloud features with their owner |
| `claude --fork-session` | Copies only the active compacted chain and grows disk use | Refuse histories that cannot be rehomed exactly |
| Copy the transcript | The pool is already global and another copy wastes disk | Move only the Desktop record |
| Trust one `forkedFrom` hop | A second-generation copy looks missing | Provenance followed to the root |
| Pass repeated message UUIDs through | Every occurrence is written again | Sync replays collapsed, conflicts refused |
| Edit `cwd` on a record | Relabels metadata without moving history | Records keep their folder, transcripts keep their project |
| Undo by deleting | Recovery becomes irreversible | Move the target record into quarantine and restore the source record |
| Leave the source entry in place | Rotating between accounts ends with a stale copy listed in every account you passed through | The verified source entry is retired into quarantine, undo puts it back |
| Delete the source to make it a move | The only trustworthy baseline goes with it | Only the account-scoped entry moves, the transcript stays |
| Merge sidecars from several source versions | Requires manufacturing another session generation | Name the versions and leave them untouched |
| Trust the newest usage sample for the active tag | Desktop polls more than one organization in the background | Prefer the latest organization-scoped request, then fall back to usage and focus |
| Refresh the active tag only in `onAppear` | MenuBarExtra keeps its view mounted between openings | Refresh when the panel becomes visible again |
| Skip lines that fail to parse | The copy looks complete and is not | Sessions with unparseable lines are refused and named |
| Copy the fuller version beside the older one | The sidebar fills with stale copies over repeated switches | A contained older version is superseded into quarantine, undo restores it |

## Boundaries

- macOS 13 or newer with Claude Desktop. Everything is local.
- Zero-copy rehome works between eligible accounts and organizations on the same Mac. The target login still has to be selected in Claude Desktop to see the moved history.
- Remote Control cloud ownership does not move. A rehomed record arrives with an empty bridge list, so Remote Control starts fresh under the destination when you turn it on there. The transcript keeps its `bridge-session` lines as history, and undo restores the original record with its bridge ids intact.
- Artifact references stay in the conversation, but server-side artifact ownership, versions, comments, share links, and comment monitors do not move. The tool never recreates artifacts automatically.
- Records tied to a scheduled task, notification route, running worker, malformed filename identity, merged history, unresolved parent record, or target id collision are named and left untouched.
- The transcript stays byte-identical, including inline sidechain events. Sidecar subagent transcripts and tool results remain in their existing global directory.
- A retired source entry disappears from the normal local sidebar. Claude's separate archived Remote Control history can still appear under Show all sessions because cloud ownership does not move. The tool does not call private network APIs or delete that archive. The transcript stays on disk and quarantine holds the local entry, so `undo` or moving it back restores it.
- Receipts from before 1.2.0 fall back to byte-exact undo checks. Opening one of those copies in Desktop may make undo refuse rather than guess that its changes were harmless.
- The transcript and record layouts are undocumented and may change. Verified with Claude Code 2.1.257 and Desktop transcript 2.1.258.
- Moving history out of a Team organization is your organization's call, not this tool's.
- Unofficial. Not affiliated with Anthropic.

Receipts, quarantine, the disposable cache, and the menubar app live in `~/Library/Application Support/claude-transplant`. Quarantine holds undone copies, failed copies, superseded versions, and retired source entries. Transcripts remain intact, so recovery is a rerun or an `undo`. The cache can be deleted at any time. The `quarantine` folder can be deleted once its receipts are no longer wanted. Dry-run never writes or performs recovery and reports that no reliable plan is available until the next real move reconciles an interruption. A kernel lock prevents overlapping runs and releases automatically when its holder exits. MIT.
