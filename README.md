# claude-transplant

Move Claude Code history between Claude accounts on a Mac. Sources stay untouched, every copy is verified, and one command undoes the last move.

```
npx claude-transplant
```

```
From  ↑↓ move · space select · enter next
  ❯ ◉ you@work.com · Acme Inc.    161 | 2h ago | acme-api
    ◉ you@work.com · Personal     157 | 1d ago | acme-api
    ○ you@home.com · Personal       3 | 5d ago | notes

To    ↑↓ move · enter confirm
  ❯ ● you@home.com · Personal       3 | 5d ago | notes

From  you@work.com · Acme Inc. + Personal
To    you@home.com · Personal

  inventory   318 records | 6 without history | 155 same lineage twice | 3 already there | 154 to move
  fork        154 ✓ | 73,783 events | 12 replay duplicates collapsed
  sidecars    890 files | sha256 ✓
  desktop     154 records | 126 archived | 28 active
  verify      provenance ✓ | lineage ✓ | sidecars ✓ | sources unchanged ✓ | 41s

  receipt     ~/Library/Application Support/claude-transplant/2026-09-02T16-04-11.json
  undo        npx claude-transplant undo
```

Two questions, nothing else. Run it again and it finds nothing to move.

## Commands

| | |
|---|---|
| `claude-transplant` | pick from and to, move, print a receipt |
| `claude-transplant --dry-run` | plan only, write nothing |
| `claude-transplant undo` | quarantine the last move, refused if a moved session gained messages |
| `claude-transplant accounts` | list accounts |
| `--from <match> --to <match>` | skip the picker, repeat `--from`; match on email, org name, or uuid prefix |
| `--json` | machine-readable output |

Accounts are labeled from `~/.claude.json`, its backups, any `~/.claude*` profile directory, and Desktop's agent-mode records. Personal-plan organizations show as Personal. An account with no known email shows a uuid prefix, then its session count, last activity, and most common project folder.

## How it works

A Claude Code session is several records that can disagree: the transcript in `~/.claude/projects`, the sidecar files beside it, and the account-scoped Desktop record under `~/Library/Application Support/Claude/claude-code-sessions/<account>/<organization>`. Anthropic exposes no way to reassign a session to another account, so a move is a reconstruction: a new session id, a forked transcript in which every message records the source message it came from, a byte-identical copy of the sidecar tree, and a fresh Desktop record in the target account. The source is never modified. It is the rollback.

The fork is a port of the official Agent SDK's `forkSession`. A golden fixture pins its output, and CI runs the real SDK against the same input to keep the port honest.

The inventory line, decoded:

- **without history**: a Desktop record whose transcript no longer exists on disk
- **same lineage twice**: the same history present in more than one source account, moved once
- **already there**: the target already holds every message, through any number of earlier copies

## Dead ends

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

## Boundaries

- macOS with Claude Desktop. Everything is local: no tokens, no cookies, no network.
- Remote Control bridges, scheduled tasks, and cloud ownership do not move. They belong to the account that created them.
- The transcript and record layouts are undocumented and may change. Verified with Claude Code 2.1.257 and Agent SDK 0.3.258.
- Moving history out of a Team organization is your organization's call, not this tool's.
- Unofficial. Not affiliated with Anthropic.

Receipts and quarantine live in `~/Library/Application Support/claude-transplant`. MIT.
