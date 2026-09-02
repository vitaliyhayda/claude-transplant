<h1 align="center">claude-transplant</h1>

<h3 align="center">Move Claude Code history between accounts. Either via menubar or CLI.</h3>

<p align="center"><img src="https://raw.githubusercontent.com/vitaliyhayda/claude-transplant/main/menubar.gif" alt="Claude Transplant: pick from, pick to, move" width="760"></p>

## What it is

Claude Desktop keeps Claude Code sessions inside the account that created them. Switch accounts and your history stays behind. claude-transplant rebuilds it in the account you are switching to. Pick the accounts to take from, pick the one to land in, done. Every copied message records the message it came from, the sources are never touched, and the last move undoes with one command. Run it twice and the second run finds nothing to move. macOS only, because it works on Claude Desktop's own files.

## Menubar or CLI

Same engine, two doors. Both need Node 22 or newer. The menubar also needs the Xcode command line tools once, `xcode-select --install`. Straight from this repository instead of the npm registry: `npx github:vitaliyhayda/claude-transplant`, append a hash and a release tag to pin one.

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

  inventory   318 records | 6 without history | 155 same lineage twice | 3 already there | 154 to move
  fork        154 ✓ | 73,783 events | 12 replay duplicates collapsed
  sidecars    890 files | sha256 ✓
  desktop     154 records | 126 archived | 28 active
  verify      provenance ✓ | lineage ✓ | sidecars ✓ | desktop ✓ | sources unchanged ✓ | 41s

  receipt     ~/Library/Application Support/claude-transplant/2026-09-02T16-04-11-208.json
  undo        npx claude-transplant undo
  then        restart Claude Code to see them
```

## Options

| Command | What it does |
|---|---|
| `claude-transplant` | pick From and To, move, print a receipt |
| `claude-transplant --dry-run` | plan only, write nothing |
| `claude-transplant undo` | quarantine the last move, refused if a moved session changed since |
| `claude-transplant accounts` | list accounts |
| `claude-transplant menubar` | install the menubar app, `--remove` uninstalls |
| `--from <match> --to <match>` | skip the picker, repeat `--from`, match on email, org name, or uuid prefix |
| `--json` | machine-readable output, one event per line |
| `--version` | print the version |

The inventory line, decoded:

- without history: a Desktop record whose transcript no longer exists on disk
- same lineage twice: the same history present in more than one source account, or in several versions where one contains the others, moved once as the fullest version
- already there: the target already holds every message, followed through earlier copies whose transcripts are still on disk

Accounts are labeled from `~/.claude.json`, its backups, any `~/.claude*` profile directory, and Desktop's agent-mode records. Personal-plan organizations show as Personal. An account with no known email shows a uuid prefix, then its session count, last activity, and most common project folder.

## How it works

A Claude Code session is three things that can disagree: the transcript in `~/.claude/projects`, the sidecar files beside it (subagent transcripts and tool results), and the account-scoped record under `~/Library/Application Support/Claude/claude-code-sessions/<account>/<organization>`. Anthropic exposes no way to reassign a session to another account, so a move is a reconstruction. Each source session gets a new id, a forked transcript in which every message carries `forkedFrom` with the id of its source message, a byte-identical copy of its sidecar tree, and a fresh Desktop record in the target account. After writing, the tool re-reads what it wrote and checks provenance, sidecar hashes on both sides, every target Desktop record byte for byte, and that the source transcripts and sidecars did not change underneath it. Source records are re-read at copy time. A session whose transcript has an unparseable line, conflicting duplicate ids, or changes while it is being copied is skipped and named in the output, and the command exits nonzero so nothing partial passes as success. A duplicate message id counts as a sync replay only when the copies differ in runtime metadata alone, parent pointer, folder, slug, prompt id, version, git branch, tool output verbosity, and every parent exists. Anything else is a conflict and the session is refused. Run again once the session is quiet. A receipt records every path and hash, and that receipt is what `undo` reads.

## Why it is built this way

- Reconstruction, not reassignment. No supported operation changes a session's owner, so new ids with per-message provenance are the honest equivalent.
- The source is the rollback. Nothing in a source account is renamed, archived, or rewritten. A bad copy is disposable, a changed source would destroy the only trustworthy baseline.
- No confirmation prompt. Safety lives in properties, not dialogs: runs are idempotent, copies get fresh ids, and undo refuses only when a copy changed after the move.
- Lineage over bookkeeping. "Already there" follows `forkedFrom` pointers to the root, so copies made through earlier hops, or by other tools, are recognized without a shared database.
- The official fork, ported. The TypeScript Agent SDK's `forkSession` is the reference implementation. Both official SDKs bundle the entire CLI for what is one screen of logic, so the routine is ported, pinned by a golden fixture, and checked in CI against the real SDK on every push.
- One file, no dependencies. Plain JavaScript on Node 22, no build step, nothing to audit but a file you can read in one sitting. The menubar is one Swift file for the same reason.
- Local only. No tokens, cookies, or network. The tool never reads Desktop's credential caches.

## The long view

Every green light in this system proves one layer. A transcript that parses says nothing about the sidebar. A record in the sidebar says nothing about whether its transcript still exists. An active remote bridge says nothing about whether a local process is alive to serve it. Most history-loss stories start with trusting one layer's signal for another layer's claim.

Tools that share one transcript store across accounts solve a different problem: who pays for the next turn. They do not make history belong to an account, and they cannot make it appear in Claude Desktop under that account. If you live in a terminal and rotate logins for rate limits, use one of those. If Claude Desktop is your home and you switch accounts deliberately, move the history, sign in on your phone to the same account, and accept a few minutes of login tax for behavior that is supported end to end.

The cost of this design is a copy that lives beside its source rather than replacing it, and an occasional second copy when a source kept growing after it was moved. The benefit is that nothing can be lost, and every number on screen has a witness on disk.

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
| Skip lines that fail to parse | The copy looks complete and is not | Sessions with unparseable lines are refused and named |

## Boundaries

- macOS with Claude Desktop. Everything is local.
- Remote Control bridges, scheduled tasks, and cloud ownership do not move. They belong to the account that created them.
- The transcript and record layouts are undocumented and may change. Verified with Claude Code 2.1.257 and Agent SDK 0.3.258.
- Moving history out of a Team organization is your organization's call, not this tool's.
- Unofficial. Not affiliated with Anthropic.

Receipts, quarantine, and the menubar app live in `~/Library/Application Support/claude-transplant`. Quarantine holds undone and failed copies, sources are intact, so recovery is a rerun, and the `quarantine` folder inside can be deleted once its receipts are no longer wanted. A run interrupted mid-copy is reconciled by the next run or undo, which quarantines the half-written copy and names it. A lock file names the running process and is cleared automatically once that process is gone. MIT.
