<h1 align="center">claude-transplant</h1>

<h3 align="center">Move Claude Code history between accounts. Either via menubar or CLI.</h3>

<p align="center"><img src="https://raw.githubusercontent.com/vitaliyhayda/claude-transplant/main/menubar.gif" alt="Claude Transplant: pick from, pick to, move" width="760"></p>

## What it is

Claude Desktop keeps Claude Code sessions inside the account that created them. Switch accounts and your history stays behind. claude-transplant rebuilds it in the account you are switching to, then retires the old account's local entry so the live chat leaves its normal sidebar. Pick the accounts to take from, pick the one to land in, done. Every copied message records the message it came from, no transcript on disk is ever edited or deleted, and the last move undoes with one command. Run it twice and the second run finds nothing to move. macOS only, because it works on Claude Desktop's own files.

## Menubar or CLI

Same engine, two doors. Both need Node 22 or newer. The menubar also needs the Xcode command line tools once, `xcode-select --install`. Straight from this repository instead of the npm registry: `npx github:vitaliyhayda/claude-transplant`. Append `#v1.3.0` or a commit hash to pin one.

```
npx claude-transplant menubar
```

The menubar app asks the same two questions and nothing else. It starts at login, shows progress in the icon, posts a notification when done, and marks the account Claude Desktop is signed into as active. When one account is left unpicked it becomes the destination on its own. It is a single Swift file, compiled once, that keeps its own copy of the CLI inside the app bundle and reads its JSON, so after upgrading the package run the menubar command again. `menubar --remove` takes it out. The animation above is rendered by the app itself: the binary inside the bundle, run with `--demo <dir>`, writes the frames and their durations.

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

  inventory   318 records | 6 without history | 155 older versions skipped | 3 already there | 154 to move
  fork        154 ✓ | 73,783 events | 12 replay duplicates collapsed
  sidecars    890 files | sha256 ✓
  desktop     154 records | 126 archived | 28 active
  verify      provenance ✓ | lineage ✓ | sidecars ✓ | desktop ✓ | sources unchanged ✓ | 41s
  retired     312 source records → quarantine | transcripts untouched

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
- older versions skipped: the same history present in more than one source account, or in several compatible versions where one contains the others, moved once as the fullest version. Shared messages and state must agree. Distinct sidecar files are combined, while the same path with different bytes keeps both versions. An unparseable or conflicting version is never folded away
- grew apart: overlapping versions with different messages or meaningful state, or two branches that both continued after a copy. All of them move and the line says so
- already there: the target already holds every message and every sidecar file, followed through earlier copies whose transcripts are still on disk

The retired line counts source entries that left their account once the destination was verified to hold their whole history, including the ones skipped as older versions and the ones already there. Only the Desktop entry moves, into quarantine. The transcript and its sidecars stay exactly where they were, and `undo` puts the entries back. Sources and destinations are checked at the retirement boundary and again afterward. If anything changes after parking begins, the plan is restored before return. A changed source, missing destination, Desktop or transcript bridge, scheduled-task registry, notification route, or running worker keeps its entry and makes the run fail visibly.

Accounts are labeled from `~/.claude.json`, its backups, any `~/.claude*` profile directory, and Desktop's agent-mode records. Personal-plan organizations show as Personal. The active tag prefers a recent organization request in Desktop's local Sentry scope, then recent usage or focus evidence, and shows nothing when all signals are stale. An account with no known email shows a uuid prefix, then its session count, last activity, and most common project folder.

## How it works

A Claude Code session is three things that can disagree: the transcript in `~/.claude/projects`, the sidecar files beside it (subagent transcripts and tool results), and the account-scoped record under `~/Library/Application Support/Claude/claude-code-sessions/<account>/<organization>`. Anthropic exposes no way to reassign a session to another account, so a move is a reconstruction. Each source session gets a new id, a forked transcript in which every message carries `forkedFrom` with the id of its source message, byte-identical sidecar files from every compatible nested version, and a fresh Desktop record in the target account. The Desktop record keeps the source session's created, activity, and focus times. Once the destination is verified to hold a source's whole history, that source's Desktop record is retired into quarantine, which is what makes this a move rather than a copy: the account you left stops listing the chat while its transcript stays on disk as the baseline.

Before writing, the tool checks projected disk use and keeps 1 GiB free, then rechecks the planned transcript semantics and sidecar manifest. After writing, it re-reads provenance, sidecar hashes, and every target Desktop record byte for byte. Existing destinations and all source artifacts are checked again immediately before retirement. Undo first verifies every target artifact and every quarantined restore path, then records its plan before changing anything. Changed means the conversation, sidecars, or Desktop record changed. An unreadable Desktop record or scheduled-task registry stops the run instead of silently discarding ownership evidence. A failed check exits nonzero and prevents unsafe retirement.

A duplicate message id counts as a sync replay only when the copies differ in runtime metadata alone, parent pointer, folder, slug, prompt id, version, git branch, or tool output verbosity, and every parent exists. Anything else is a conflict and the session is refused. This rests on one assumption made deliberately: a message id names one event, so two compatible placements of the same id are one event, and the richer copy is kept.

Lineage comparison follows every copied message back to its root. A source version is skipped only when another compatible version contains every one of its root messages and sidecars. Versions with different shared content, replacements, suppression, or relocation state move separately. When a complete version lands beside an older version in the destination, that older version is retired into quarantine after verification and an unchanged check, whoever created it, so repeated moves converge to one compatible entry per history. A receipt journals copying, verification, retirement, and undo. An interrupted retirement restores every partially parked entry and leaves the verified copies for the next move to reconcile. An interrupted undo resumes from its recorded artifact state. Any earlier interruption rolls back its unchanged copies, while a copy that gained meaningful changes stays in place and remains identified in the receipt. `undo` stops after any other recovery and must be run again, so a corrupt newest receipt can never make it cross into the previous batch.

## Why it is built this way

- Reconstruction, not reassignment. No supported operation changes a session's owner, so new ids with per-message provenance are the honest equivalent.
- The source transcript is the rollback. No source transcript or sidecar is renamed, edited, or deleted. A contained older destination can move into quarantine, and undo restores it together with the source entry.
- No confirmation prompt. Safety lives in properties, not dialogs: runs are idempotent, copies get fresh ids, and undo refuses before changing anything when a target changed or a source cannot be restored.
- Lineage over bookkeeping. "Already there" follows `forkedFrom` pointers to the root, so copies made through earlier hops, or by other tools, are recognized without a shared database.
- The official fork, ported. The TypeScript Agent SDK's `forkSession` is the reference implementation. Both official SDKs bundle the entire CLI for what is one screen of logic, so the routine is ported, pinned by a golden fixture, and checked in CI against the real SDK on every push.
- One file, no dependencies. Plain JavaScript on Node 22, no build step, and one source file to audit. The menubar is one Swift file for the same reason.
- Local only. No tokens, cookies, or network. The tool never reads Desktop's credential caches.

## The long view

Every green light in this system proves one layer. A transcript that parses says nothing about the sidebar. A record in the sidebar says nothing about whether its transcript still exists. An active remote bridge says nothing about whether a local process is alive to serve it. Most history-loss stories start with trusting one layer's signal for another layer's claim.

Tools that share one transcript store across accounts solve a different problem: who pays for the next turn. They do not make history belong to an account, and they cannot make it appear in Claude Desktop under that account. If you live in a terminal and rotate logins for rate limits, use one of those. If Claude Desktop is your home and you switch accounts deliberately, move the history, sign in on your phone to the same account, and accept a few minutes of login tax for behavior that is supported end to end.

The cost of this design is a new transcript generation on every move, the old generation staying on disk, and an occasional second entry when histories genuinely grew apart. The tool refuses a move that would leave less than 1 GiB free. It never prunes transcripts. The benefit is that the untouched source remains the recovery baseline.

## Dead ends

Each of these was tried. Each looked like it worked until the layer below was checked.

| Tempting | Why it fails | Here |
|---|---|---|
| Change the account on a session | No API reassigns ownership | New target id, source preserved |
| `claude --fork-session` | Copies only the active compacted chain | Full transcript fork with per-message provenance |
| Fork through the Python SDK | `splitlines()` splits inside JSON at U+2028 and drops the event | Split on newline only, separators escaped on write |
| Copy the transcript alone | Subagent sidecars stay behind | Sidecar tree copied and hashed |
| Trust one `forkedFrom` hop | A second-generation copy looks missing | Provenance followed to the root |
| Pass repeated message UUIDs through | Every occurrence is written again | Sync replays collapsed, conflicts refused |
| Edit `cwd` on a record | Relabels metadata without moving history | Records keep their folder, transcripts keep their project |
| Undo by deleting | New messages in the copy would vanish | Undo refuses when a copy changed, otherwise quarantines |
| Leave the source entry in place | Rotating between accounts ends with a stale copy listed in every account you passed through | The verified source entry is retired into quarantine, undo puts it back |
| Delete the source to make it a move | The only trustworthy baseline goes with it | Only the account-scoped entry moves, the transcript stays |
| Treat different sidecar sets as different chats | Rotations can split non-conflicting subagent files across nested snapshots | Merge those files into the fullest transcript, keep path conflicts apart |
| Trust the newest usage sample for the active tag | Desktop polls more than one organization in the background | Prefer the latest organization-scoped request, then fall back to usage and focus |
| Refresh the active tag only in `onAppear` | MenuBarExtra keeps its view mounted between openings | Refresh when the panel becomes visible again |
| Skip lines that fail to parse | The copy looks complete and is not | Sessions with unparseable lines are refused and named |
| Copy the fuller version beside the older one | The sidebar fills with stale copies over repeated switches | A contained older version is superseded into quarantine, undo restores it |

## Boundaries

- macOS 13 or newer with Claude Desktop. Everything is local.
- Remote Control bridges, scheduled tasks, and cloud ownership do not move. They belong to the account that created them.
- Records tied to a Desktop or transcript bridge, scheduled task, notification route, or running worker are never retired or superseded automatically.
- Inline sidechain events in the main transcript do not move, matching the official `forkSession` behavior. Sidecar subagent transcripts and tool results do move.
- A retired source entry disappears from the normal local sidebar. Claude's separate archived Remote Control history can still appear under Show all sessions because cloud ownership does not move. The tool does not call private network APIs or delete that archive. The transcript stays on disk and quarantine holds the local entry, so `undo` or moving it back restores it.
- Receipts from before 1.2.0 fall back to byte-exact undo checks. Opening one of those copies in Desktop may make undo refuse rather than guess that its changes were harmless.
- The transcript and record layouts are undocumented and may change. Verified with Claude Code 2.1.257, Desktop transcript 2.1.258, and Agent SDK 0.3.259.
- Moving history out of a Team organization is your organization's call, not this tool's.
- Unofficial. Not affiliated with Anthropic.

Receipts, quarantine, and the menubar app live in `~/Library/Application Support/claude-transplant`. Quarantine holds undone copies, failed copies, superseded versions, and retired source entries, transcripts are intact, so recovery is a rerun or an `undo`, and the `quarantine` folder inside can be deleted once its receipts are no longer wanted. Dry-run never performs recovery and reports that no reliable plan is available until the next real move reconciles an interruption. A kernel lock prevents overlapping runs and releases automatically when its holder exits. MIT.
