#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, realpathSync } from 'node:fs'
import { copyFile, link as hardlink, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TYPES = new Set(['user', 'assistant', 'attachment', 'system', 'progress'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SEPARATORS = new RegExp(`[${String.fromCharCode(0x85, 0x2028, 0x2029)}]`, 'g')
const NOTE = 'restart Claude Code to see them'
const LABEL = 'io.github.vitaliyhayda.claude-transplant'
const HELP = `claude-transplant   move Claude Code history between accounts, sources untouched

  claude-transplant             pick from → to, move, print receipt
  claude-transplant --dry-run   plan only, write nothing
  claude-transplant undo        quarantine the last move
  claude-transplant accounts    list accounts
  claude-transplant menubar     install the menubar app, starts at login, --remove uninstalls

  --from <match> --to <match>   skip the picker, match on email, org name, or uuid prefix
  --json                        machine-readable output
  --version
`

const sha = (data) => createHash('sha256').update(data).digest('hex')
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v
const stable = (v) => JSON.stringify(sortKeys(v))
const short = (id) => id.slice(0, 8)
const count = (v) => v.toLocaleString('en-US')
const exists = (p) => stat(p).then(() => true, () => false)
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'))
const stamp = () => new Date().toISOString().slice(0, 23).replace(/[:.]/g, '-')
const jsonl = (entries) => entries.map((e) => JSON.stringify(e).replace(SEPARATORS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)).join('\n') + '\n'
const same = (a, b) => a.size === b.size && [...a].every((v) => b.has(v))

export function layout(home = os.homedir()) {
  const support = path.join(home, 'Library/Application Support')
  return {
    home,
    records: path.join(support, 'Claude/claude-code-sessions'),
    agentSessions: path.join(support, 'Claude/local-agent-mode-sessions'),
    desktop: path.join(support, 'Claude/config.json'),
    usage: path.join(support, 'Claude/plan-usage-history.json'),
    pool: path.join(home, '.claude/projects'),
    login: path.join(home, '.claude.json'),
    backups: path.join(home, '.claude/backups'),
    state: path.join(support, 'claude-transplant')
  }
}

async function dirs(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isDirectory() && UUID.test(e.name)).map((e) => e.name).sort()
}

async function tree(root) {
  const out = []
  const walk = async (dir) => {
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile()) out.push(p)
      else throw new Error(`unsupported entry ${p}`)
    }
  }
  if (await exists(root)) await walk(root)
  return out
}

async function digest(root) {
  const rows = []
  for (const file of await tree(root)) {
    const data = await readFile(file)
    rows.push({ rel: path.relative(root, file), bytes: data.length, sha: sha(data) })
  }
  return { count: rows.length, bytes: rows.reduce((s, r) => s + r.bytes, 0), sha: sha(stable(rows)) }
}

async function copyTree(from, to) {
  for (const file of await tree(from)) {
    const dest = path.join(to, path.relative(from, file))
    await mkdir(path.dirname(dest), { recursive: true })
    await copyFile(file, dest, constants.COPYFILE_EXCL)
  }
}

async function writeNew(file, text) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text, { flag: 'wx', mode: 0o600 })
}

async function quarantine(items, dest) {
  for (const p of items) {
    if (!(await exists(p))) continue
    await mkdir(dest, { recursive: true })
    await rename(p, path.join(dest, path.basename(p)))
  }
}

async function locked(paths, work) {
  await mkdir(paths.state, { recursive: true })
  const lockFile = path.join(paths.state, 'lock')
  const mine = path.join(paths.state, `lock.${process.pid}`)
  const holder = () => readFile(lockFile, 'utf8').catch(() => null)
  const alive = (pid) => { try { return pid > 0 && process.kill(pid, 0) } catch { return false } }
  const grab = () => hardlink(mine, lockFile).then(() => true, () => false)
  await writeFile(mine, String(process.pid), { mode: 0o600 })
  try {
    if (!(await grab())) {
      const stale = await holder()
      if (alive(Number(stale))) throw new Error(`another run holds the lock, pid ${Number(stale)}`)
      if ((await holder()) === stale) await unlink(lockFile).catch(() => {})
      if (!(await grab())) throw new Error('another run holds the lock')
    }
    try {
      return await work()
    } finally {
      if ((await holder()) === String(process.pid)) await unlink(lockFile).catch(() => {})
    }
  } finally {
    await unlink(mine).catch(() => {})
  }
}

async function records(root) {
  const out = []
  for (const account of await dirs(root)) {
    for (const org of await dirs(path.join(root, account))) {
      const dir = path.join(root, account, org)
      const names = (await readdir(dir).catch(() => [])).filter((f) => f.startsWith('local_') && f.endsWith('.json')).sort()
      out.push({ account, org, dir, files: names.map((f) => path.join(dir, f)) })
    }
  }
  return out
}

async function logins(paths) {
  const emails = new Map()
  const orgs = new Map()
  const take = async (file) => {
    const a = (await readJson(file).catch(() => ({}))).oauthAccount
    if (a?.accountUuid && a.emailAddress) emails.set(a.accountUuid, a.emailAddress)
    if (a?.organizationUuid && a.organizationName) orgs.set(a.organizationUuid, a.organizationType && !/team|enterprise/.test(a.organizationType) ? 'Personal' : a.organizationName)
  }
  for (const e of await readdir(paths.home, { withFileTypes: true }).catch(() => [])) if (e.name.startsWith('.claude')) await take(e.isDirectory() ? path.join(paths.home, e.name, '.claude.json') : path.join(paths.home, e.name))
  for (const f of await readdir(paths.backups).catch(() => [])) if (f.startsWith('.claude.json.backup')) await take(path.join(paths.backups, f))
  await take(paths.login)
  for (const { account, files } of await records(paths.agentSessions)) {
    for (const file of files) {
      if (emails.has(account)) break
      const r = await readJson(file).catch(() => ({}))
      if (r.emailAddress) emails.set(account, r.emailAddress)
    }
  }
  return { emails, orgs }
}

function ago(ms) {
  if (!ms) return '—'
  const s = Math.max(0, Date.now() - ms) / 1000
  const [n, unit] = s < 3600 ? [s / 60, 'm'] : s < 86400 ? [s / 3600, 'h'] : s < 86400 * 30 ? [s / 86400, 'd'] : [s / 86400 / 30, 'mo']
  return `${Math.max(1, Math.round(n))}${unit} ago`
}

function mode(values) {
  const tally = new Map()
  for (const v of values) if (v) tally.set(v, (tally.get(v) ?? 0) + 1)
  return [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—'
}

async function current(paths) {
  const desktop = await readJson(paths.desktop).catch(() => ({}))
  const samples = (await readJson(paths.usage).catch(() => ({}))).samples ?? []
  const latest = samples.reduce((best, s) => (s?.t > (best?.t ?? -1) ? s : best), null)
  return { account: desktop.lastKnownAccountUuid ?? null, org: latest?.org ?? null }
}

export async function accounts(paths) {
  const { emails, orgs } = await logins(paths)
  const cur = await current(paths)
  const out = []
  for (const { account, org, dir, files } of await records(paths.records)) {
    const sessions = []
    for (const file of files) {
      const r = await readJson(file).catch(() => null)
      if (!r) continue
      sessions.push({ file, id: UUID.test(r.cliSessionId ?? '') ? r.cliSessionId : null, cwd: r.cwd ?? '', title: r.title ?? '', archived: r.isArchived === true, createdAt: r.createdAt ?? 0, activeAt: r.lastActivityAt ?? 0, focusedAt: r.lastFocusedAt ?? 0, record: r })
    }
    const activeAt = Math.max(0, ...sessions.map((s) => s.activeAt))
    const email = emails.get(account) ?? null
    const orgName = orgs.get(org) ?? null
    const label = `${email ?? short(account)} · ${orgName ?? short(org)}`
    const stats = sessions.length ? `${sessions.length} | ${ago(activeAt)} | ${mode(sessions.map((s) => path.basename(s.cwd)))}` : '0 | —'
    out.push({ account, org, dir, email, orgName, sessions, activeAt, focusedAt: Math.max(0, ...sessions.map((s) => s.focusedAt)), label, stats, active: false })
  }
  const mine = out.filter((a) => a.account === cur.account)
  const chosen = mine.find((a) => a.org === cur.org) ?? mine.toSorted((a, b) => b.focusedAt - a.focusedAt)[0]
  if (chosen) Object.assign(chosen, { active: true, stats: `${chosen.stats} | active` })
  return out.sort((a, b) => b.activeAt - a.activeAt)
}

async function index(pool) {
  const map = new Map()
  for (const dir of await readdir(pool).catch(() => [])) {
    const full = path.join(pool, dir)
    for (const name of await readdir(full).catch(() => [])) {
      const id = name.slice(0, -6)
      if (name.endsWith('.jsonl') && UUID.test(id)) map.set(id, path.join(full, name))
    }
  }
  return map
}

export async function scan(file) {
  const raw = await readFile(file, 'utf8')
  const ids = []
  const forked = new Map()
  let invalid = 0
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text) continue
    let e
    try { e = JSON.parse(text) } catch { invalid++; continue }
    if (!e || typeof e !== 'object' || !TYPES.has(e.type) || typeof e.uuid !== 'string' || e.isSidechain || e.type === 'progress') continue
    ids.push(e.uuid)
    if (typeof e.forkedFrom?.messageUuid === 'string') forked.set(e.uuid, e.forkedFrom)
  }
  return { file, sha: sha(raw), ids, forked, invalid }
}

async function load(file) {
  const raw = await readFile(file, 'utf8')
  const entries = []
  let invalid = 0
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text) continue
    try {
      const e = JSON.parse(text)
      if (e && typeof e === 'object' && !Array.isArray(e)) entries.push(e)
    } catch { invalid++ }
  }
  return { sha: sha(raw), entries, invalid }
}

const canonical = (e) => {
  const c = structuredClone(e)
  for (const k of ['slug', 'promptId', 'parentUuid', 'version', 'cwd']) delete c[k]
  if (c.toolUseResult && typeof c.toolUseResult === 'object' && !Array.isArray(c.toolUseResult)) {
    delete c.toolUseResult.stdout
    delete c.toolUseResult.stderr
  }
  return stable(c)
}

const richness = (e) => ['stdout', 'stderr'].reduce((n, k) => n + (typeof e.toolUseResult?.[k] === 'string' ? Buffer.byteLength(e.toolUseResult[k]) : 0), 0)

function survivor(rows, ids, parentOf) {
  if (new Set(rows.map((r) => canonical(r.entry))).size !== 1) return null
  const parents = [...new Set(rows.map((r) => r.entry.parentUuid ?? null))]
  if (parents.some((p) => p && !ids.has(p))) return null
  const above = (a, b) => {
    const seen = new Set()
    for (let cur = b; cur && !seen.has(cur); cur = parentOf.get(cur) ?? null) {
      if (cur === a) return true
      seen.add(cur)
    }
    return a === null
  }
  if (!parents.every((a) => parents.every((b) => a === b || above(a, b) || above(b, a)))) return null
  const depth = (p) => { const seen = new Set(); for (let cur = p; cur && !seen.has(cur); cur = parentOf.get(cur) ?? null) seen.add(cur); return seen.size }
  const depths = rows.toSorted((a, b) => a.line - b.line).map((r) => depth(r.entry.parentUuid ?? null))
  if (depths.some((d, i) => i && d > depths[i - 1])) return null
  const keep = {}
  for (const k of ['stdout', 'stderr']) {
    const values = new Set(rows.map((r) => r.entry.toolUseResult?.[k]).filter((v) => typeof v === 'string' && v.length))
    if (values.size > 1) return null
    keep[k] = [...values][0] ?? ''
  }
  const ranked = rows.toSorted((a, b) => richness(b.entry) - richness(a.entry) || a.line - b.line)
  return ranked.find((r) => ['stdout', 'stderr'].every((k) => !keep[k] || r.entry.toolUseResult?.[k] === keep[k]))?.line ?? null
}

export function normalize(entries) {
  const rows = entries.map((entry, line) => ({ entry, line })).filter(({ entry }) => TYPES.has(entry.type) && typeof entry.uuid === 'string' && !entry.isSidechain)
  const groups = Map.groupBy(rows, (r) => r.entry.uuid)
  const ids = new Set(groups.keys())
  const parentOf = new Map(rows.map((r) => [r.entry.uuid, r.entry.parentUuid ?? null]))
  const drop = new Set()
  let replays = 0
  let conflicts = 0
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const line = survivor(group, ids, parentOf)
    if (line === null) { conflicts++; continue }
    replays++
    for (const r of group) if (r.line !== line) drop.add(r.line)
  }
  return { entries: entries.filter((_, line) => !drop.has(line)), replays, conflicts }
}

function derive(entries) {
  let custom, ai, first
  for (const e of entries) {
    if (e.type === 'custom-title' && e.customTitle) custom = e.customTitle
    else if (e.type === 'ai-title' && e.aiTitle) ai = e.aiTitle
    else if (!first && e.type === 'user' && !e.isMeta && !e.isCompactSummary) {
      const c = e.message?.content
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((b) => b?.type === 'text')?.text : null
      if (text) first = text.split('\n')[0].slice(0, 60)
    }
  }
  return custom || ai || first || ''
}

export function fork(entries, sourceId, targetId, title, now = new Date().toISOString(), uuid = randomUUID) {
  const transcript = []
  const replacements = []
  let suppressed = false
  let atis
  let relocated
  for (const e of entries) {
    if (TYPES.has(e.type) && typeof e.uuid === 'string') transcript.push(e)
    else if (e.type === 'history-suppression') suppressed = true
    else if (e.type === 'atis-latch' && e.sessionId === sourceId && typeof e.atis === 'string' && /^[\x21-\x7e]*$/.test(e.atis)) atis = e.atis
    else if (e.type === 'content-replacement' && e.sessionId === sourceId && Array.isArray(e.replacements)) replacements.push(...e.replacements)
    else if (e.type === 'relocated' && e.sessionId === sourceId && typeof e.relocatedCwd === 'string' && e.relocatedCwd !== '') relocated = e.relocatedCwd
  }
  const kept = transcript.filter((e) => !e.isSidechain)
  const fresh = new Map(kept.map((e) => [e.uuid, uuid()]))
  const byId = new Map(kept.map((e) => [e.uuid, e]))
  const messages = kept.filter((e) => e.type !== 'progress')
  if (!messages.length) throw new Error('no messages to fork')
  const out = []
  if (suppressed) out.push({ type: 'history-suppression', sessionId: targetId, cause: 'fork_inherit', ts: now })
  messages.forEach((m, i) => {
    let parent = null
    let cursor = m.parentUuid
    while (cursor) {
      const p = byId.get(cursor)
      if (!p) break
      if (p.type !== 'progress') { parent = fresh.get(cursor) ?? null; break }
      cursor = p.parentUuid
    }
    out.push({
      ...m,
      ...(m.type === 'system' && m.subtype === 'model_refusal_fallback' ? { neutralizedByFork: true } : {}),
      uuid: fresh.get(m.uuid),
      parentUuid: parent,
      logicalParentUuid: m.logicalParentUuid == null ? m.logicalParentUuid : fresh.get(m.logicalParentUuid) ?? null,
      sessionId: targetId,
      timestamp: i === messages.length - 1 ? now : m.timestamp,
      isSidechain: false,
      teamName: undefined,
      agentName: undefined,
      sessionKind: undefined,
      slug: undefined,
      sourceToolAssistantUUID: undefined,
      forkedFrom: { sessionId: sourceId, messageUuid: m.uuid }
    })
  })
  if (replacements.length) out.push({ type: 'content-replacement', sessionId: targetId, replacements, uuid: uuid(), timestamp: now })
  if (atis !== undefined) out.push({ type: 'atis-latch', sessionId: targetId, atis })
  if (relocated) out.push({ type: 'relocated', sessionId: targetId, relocatedCwd: relocated })
  out.push({ type: 'custom-title', sessionId: targetId, customTitle: title, uuid: uuid(), timestamp: now })
  return out
}

function clone(source, targetId, title, now) {
  const r = structuredClone(source)
  for (const k of ['forkedFromSessionId', 'writtenBranch', 'writtenBranches', 'scheduledTaskId', 'notifySessionId']) delete r[k]
  return { ...r, sessionId: `local_${targetId}`, cliSessionId: targetId, createdAt: now, lastActivityAt: now, lastFocusedAt: now, title, titleSource: 'user', bridgeSessionIds: [], sessionPermissionUpdates: [], spawnSeed: {} }
}

async function scanned(id, ctx) {
  if (!ctx.scans.has(id)) ctx.scans.set(id, ctx.index.has(id) ? await scan(ctx.index.get(id)) : null)
  return ctx.scans.get(id)
}

async function roots(id, ctx) {
  const out = new Set()
  const own = await scanned(id, ctx)
  for (const uuid of own?.ids ?? []) {
    let cursor = uuid
    let session = own
    const seen = new Set()
    while (session && !seen.has(cursor)) {
      seen.add(cursor)
      const from = session.forked.get(cursor)
      if (!from) break
      cursor = from.messageUuid
      session = await scanned(from.sessionId, ctx)
    }
    out.add(cursor)
  }
  return out
}

export async function inventory(from, to, paths) {
  const ctx = { index: await index(paths.pool), scans: new Map() }
  const seen = new Set()
  const missing = []
  const found = []
  let total = 0
  for (const account of from) {
    for (const s of account.sessions) {
      total++
      if (!s.id) { missing.push(s); continue }
      if (seen.has(s.id)) continue
      seen.add(s.id)
      const rootSet = await roots(s.id, ctx)
      const invalid = ctx.scans.get(s.id)?.invalid ?? 0
      if (!rootSet.size && !invalid) { missing.push(s); continue }
      found.push({ ...s, account, transcript: ctx.index.get(s.id), roots: rootSet, invalid, forks: ctx.scans.get(s.id).forked.size })
    }
  }
  const groups = [...Map.groupBy(found, (s) => sha(s.roots.size && !s.invalid ? [...s.roots].sort().join('\n') : s.id)).values()]
  const repOf = new Map()
  for (const g of groups) {
    const rep = g.toSorted((a, b) => a.forks - b.forks || a.createdAt - b.createdAt)[0]
    for (const s of g) repOf.set(s.record.sessionId, rep)
  }
  const reps = [...new Set(repOf.values())]
  const targets = []
  for (const s of to.sessions) {
    if (!s.id) continue
    const r = await roots(s.id, ctx)
    if (r.size) targets.push({ record: s.record.sessionId, roots: r })
  }
  const covering = (rootSet) => (rootSet.size ? targets.find((t) => [...rootSet].every((id) => t.roots.has(id)))?.record ?? null : null)
  const there = []
  const move = []
  for (const s of reps) (!s.invalid && covering(s.roots) ? there : move).push(s)
  const parent = (recordId) => {
    const rep = repOf.get(recordId)
    return rep ? { record: rep.record.sessionId, target: covering(rep.roots) } : null
  }
  return { total, missing, twice: found.length - reps.length, there, move, parent, from: from.map((a) => a.label) }
}

function planned(s, to, targetId) {
  const dir = path.dirname(s.transcript)
  return [path.join(dir, `${targetId}.jsonl`), path.join(dir, targetId), path.join(to.dir, `local_${targetId}.json`)]
}

async function one(s, to, targetId, now) {
  const source = await load(s.transcript)
  if (source.invalid) throw new Error(`${source.invalid} unparseable lines`)
  const { entries, replays, conflicts } = normalize(source.entries)
  if (conflicts) throw new Error(`${conflicts} conflicting duplicate uuids`)
  const title = s.title.trim() || derive(entries) || 'Untitled'
  const text = jsonl(fork(entries, s.id, targetId, title))
  const [targetTranscript, targetDir, record] = planned(s, to, targetId)
  await writeNew(targetTranscript, text)
  const sourceDir = path.join(path.dirname(s.transcript), s.id)
  let sidecars = { count: 0, bytes: 0, sha: null }
  if (await exists(sourceDir)) {
    await copyTree(sourceDir, targetDir)
    sidecars = await digest(targetDir)
    if (sidecars.sha !== (await digest(sourceDir)).sha) throw new Error('sidecar copy mismatch')
  }
  const want = new Set(entries.filter((e) => TYPES.has(e.type) && typeof e.uuid === 'string' && !e.isSidechain && e.type !== 'progress').map((e) => e.uuid))
  const got = new Set([...(await scan(targetTranscript)).forked.values()].map((f) => f.messageUuid))
  if (!same(want, got)) throw new Error('provenance mismatch')
  const recordText = `${JSON.stringify(clone(s.record, targetId, title, now), null, 2)}\n`
  await writeNew(record, recordText)
  if (sha(await readFile(s.transcript)) !== source.sha) throw new Error('source changed during move')
  return { id: s.id, targetId, title, archived: s.archived, transcript: s.transcript, sourceSha: source.sha, targetTranscript, targetSha: sha(text), targetDir: sidecars.sha ? targetDir : null, record, recordSha: sha(recordText), sidecars, events: want.size, replays, forkedFromSessionId: s.record.forkedFromSessionId ?? null, sourceRecordId: s.record.sessionId ?? null }
}

async function link(rows, inv) {
  const byRecord = new Map(rows.map((r) => [r.sourceRecordId, r]))
  for (const r of rows) {
    if (!r.forkedFromSessionId) continue
    const p = inv.parent(r.forkedFromSessionId)
    const inBatch = p && byRecord.get(p.record)
    const target = inBatch ? `local_${inBatch.targetId}` : p?.target
    if (!target) continue
    const record = await readJson(r.record)
    record.forkedFromSessionId = target
    const text = `${JSON.stringify(record, null, 2)}\n`
    await writeFile(`${r.record}.tmp`, text, { mode: 0o600 })
    await rename(`${r.record}.tmp`, r.record)
    r.linkedTo = target
    r.recordSha = sha(text)
  }
}

async function verify(rows) {
  const bad = { provenance: 0, lineage: 0, sidecars: 0, desktop: 0, sources: 0 }
  const problems = []
  const flag = (check, r) => { bad[check]++; problems.push({ title: r.title, check }) }
  for (const r of rows) {
    if (!(await exists(r.targetTranscript)) || sha(await readFile(r.targetTranscript)) !== r.targetSha) flag('provenance', r)
    const raw = await readFile(r.record, 'utf8').catch(() => null)
    if (r.linkedTo && (raw ? JSON.parse(raw) : {}).forkedFromSessionId !== r.linkedTo) flag('lineage', r)
    const sourceDir = path.join(path.dirname(r.transcript), r.id)
    if (r.targetDir ? (await digest(r.targetDir)).sha !== r.sidecars.sha || (await digest(sourceDir)).sha !== r.sidecars.sha : await exists(sourceDir)) flag('sidecars', r)
    if (!raw || sha(raw) !== r.recordSha) flag('desktop', r)
    if (!(await exists(r.transcript)) || sha(await readFile(r.transcript)) !== r.sourceSha) flag('sources', r)
  }
  const mark = (v) => (v ? `✗ ${v}` : '✓')
  return { ok: problems.length === 0, problems, lines: [`provenance ${mark(bad.provenance)}`, `lineage ${mark(bad.lineage)}`, `sidecars ${mark(bad.sidecars)}`, `desktop ${mark(bad.desktop)}`, `sources unchanged ${mark(bad.sources)}`] }
}

const receipts = async (paths) => (await readdir(paths.state).catch(() => [])).filter((f) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}\.json$/.test(f)).sort()

async function reconcile(paths) {
  const name = (await receipts(paths)).at(-1)
  if (!name) return
  const file = path.join(paths.state, name)
  const receipt = await readJson(file)
  if (!receipt.pending) return
  await quarantine(receipt.pending.made, path.join(paths.state, 'quarantine', receipt.at, 'failed'))
  receipt.failed.push({ id: receipt.pending.id, title: receipt.pending.title, error: 'interrupted' })
  receipt.pending = null
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
}

export function move(inv, to, paths, report = () => {}) {
  return locked(paths, async () => {
    await reconcile(paths)
    const started = Date.now()
    const at = stamp()
    const receipt = { at, from: inv.from, to: to.label, sessions: [], failed: [] }
    const file = path.join(paths.state, `${at}.json`)
    const save = () => writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
    let events = 0
    let replays = 0
    for (const [i, s] of inv.move.entries()) {
      report('fork', `${i + 1}/${inv.move.length}`, { live: true })
      const targetId = randomUUID()
      const made = planned(s, to, targetId)
      receipt.pending = { id: s.id, title: s.title, made }
      await save()
      try {
        const row = await one(s, to, targetId, started)
        receipt.sessions.push(row)
        events += row.events
        replays += row.replays
      } catch (error) {
        await quarantine(made, path.join(paths.state, 'quarantine', at, 'failed'))
        receipt.failed.push({ id: s.id, title: s.title, error: error.message })
      }
      receipt.pending = null
      await save()
    }
    await link(receipt.sessions, inv)
    await save()
    const done = receipt.sessions.length
    report('fork', [`${count(done)} ✓`, `${count(events)} events`, replays ? `${count(replays)} replay duplicates collapsed` : null, receipt.failed.length ? `${receipt.failed.length} failed` : null].filter(Boolean).join(' | '))
    report('sidecars', `${count(receipt.sessions.reduce((n, r) => n + r.sidecars.count, 0))} files | sha256 ✓`)
    const archived = receipt.sessions.filter((r) => r.archived).length
    report('desktop', `${count(done)} records | ${count(archived)} archived | ${count(done - archived)} active`)
    const { ok, lines, problems } = await verify(receipt.sessions)
    receipt.verification = { ok, problems }
    await save()
    report('verify', [...lines, `${Math.round((Date.now() - started) / 1000)}s`].join(' | '))
    return { file, receipt, checks: lines, problems, ok: ok && receipt.failed.length === 0 }
  })
}

export function undo(paths) {
  return locked(paths, async () => {
    await reconcile(paths)
    const name = (await receipts(paths)).at(-1)
    if (!name) return { nothing: true }
    const receipt = await readJson(path.join(paths.state, name))
    const changed = []
    for (const r of receipt.sessions) if ((await exists(r.targetTranscript)) && sha(await readFile(r.targetTranscript)) !== r.targetSha) changed.push(r.title)
    if (changed.length) return { receipt, changed }
    const dest = path.join(paths.state, 'quarantine', receipt.at)
    await mkdir(dest, { recursive: true })
    for (const r of receipt.sessions) await quarantine([r.targetTranscript, r.targetDir, r.record].filter(Boolean), dest)
    await rename(path.join(paths.state, name), path.join(dest, 'receipt.json'))
    return { receipt, dest }
  })
}

function describe(list) {
  const emails = new Set(list.map((a) => a.email ?? short(a.account)))
  return emails.size === 1 ? `${[...emails][0]} · ${list.map((a) => a.orgName ?? short(a.org)).join(' + ')}` : list.map((a) => a.label).join(', ')
}

function find(all, sel) {
  const hay = (a) => `${a.email ?? ''} ${a.account} ${a.orgName ?? ''} ${a.org}`.toLowerCase()
  const hits = all.filter((a) => sel.toLowerCase().split(/\s+/).every((t) => hay(a).includes(t)))
  if (hits.length === 1) return hits[0]
  throw new Error(hits.length ? `"${sel}" matches ${hits.map((a) => a.label).join(', ')}` : `"${sel}" matches no account`)
}

export function step(state, key) {
  const { cursor, chosen, size, multi } = state
  if (key === 'up') return { ...state, cursor: (cursor + size - 1) % size }
  if (key === 'down') return { ...state, cursor: (cursor + 1) % size }
  if (key === 'space' && multi) {
    const next = new Set(chosen)
    next.has(cursor) ? next.delete(cursor) : next.add(cursor)
    return { ...state, chosen: next }
  }
  if (key === 'return') return multi ? (chosen.size ? { ...state, done: true } : state) : { ...state, chosen: new Set([cursor]), done: true }
  return state
}

async function pick(title, rows, multi) {
  if (!rows.length) throw new Error('no accounts to choose from')
  const hint = multi ? '↑↓ move · space select · enter next' : '↑↓ move · enter confirm'
  const width = Math.max(...rows.map((r) => r.label.length))
  const { stdin: input, stdout: output } = process
  let state = { cursor: 0, chosen: new Set(), size: rows.length, multi }
  const lines = () => [`${title}  ${hint}`, ...rows.map((r, i) => `  ${i === state.cursor ? '❯' : ' '} ${multi ? (state.chosen.has(i) ? '◉' : '○') : i === state.cursor ? '●' : '○'} ${r.label.padEnd(width)}  ${r.stats}`)]
  const erase = `\x1b[${rows.length + 1}A\x1b[J`
  readline.emitKeypressEvents(input)
  input.setRawMode(true)
  input.resume()
  output.write(`\x1b[?25l${lines().join('\n')}\n`)
  try {
    await new Promise((resolve, reject) => {
      const onKey = (_, key) => {
        if (!key) return
        if ((key.ctrl && key.name === 'c') || key.name === 'escape' || key.name === 'q') {
          input.off('keypress', onKey)
          reject(Object.assign(new Error('aborted'), { code: 130 }))
          return
        }
        state = step(state, key.name)
        if (state.done) { input.off('keypress', onKey); resolve(); return }
        output.write(`${erase}${lines().join('\n')}\n`)
      }
      input.on('keypress', onKey)
    })
  } finally {
    input.setRawMode(false)
    input.pause()
    output.write(`${erase}\x1b[?25h`)
  }
  return [...state.chosen].sort((a, b) => a - b).map((i) => rows[i])
}

function reporter(json) {
  if (json) return (stage, text, extra = {}) => process.stdout.write(`${JSON.stringify({ stage, text, ...(extra.live ? { live: true } : {}) })}\n`)
  return (stage, text, extra = {}) => {
    if (extra.live && !process.stdout.isTTY) return
    process.stdout.write(`${process.stdout.isTTY ? '\r\x1b[K' : ''}  ${stage.padEnd(11)} ${text}${extra.live ? '' : '\n'}`)
  }
}

const plist = (dict) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${Object.entries(dict).map(([k, v]) => `<key>${k}</key>${v === true ? '<true/>' : Array.isArray(v) ? `<array>${v.map((s) => `<string>${s}</string>`).join('')}</array>` : `<string>${v}</string>`}`).join('')}</dict></plist>\n`

async function menubar(paths, remove) {
  const app = path.join(paths.state, 'Claude Transplant.app')
  const binary = path.join(app, 'Contents/MacOS/Claude Transplant')
  const agent = path.join(paths.home, 'Library/LaunchAgents', `${LABEL}.plist`)
  const domain = `gui/${process.getuid()}`
  const stop = () => {
    spawnSync('launchctl', ['bootout', `${domain}/${LABEL}`])
    spawnSync('pkill', ['-x', 'Claude Transplant'])
  }
  if (remove) {
    stop()
    await rm(app, { recursive: true, force: true })
    await rm(agent, { force: true })
    return 'menubar removed'
  }
  const source = path.join(HERE, 'menubar.swift')
  const key = sha((await readFile(source, 'utf8')) + (await readJson(path.join(HERE, 'package.json'))).version)
  const built = path.join(app, 'Contents/Resources/build.sha256')
  if ((await readFile(built, 'utf8').catch(() => '')) !== key) {
    const fresh = `${app}.building`
    await rm(fresh, { recursive: true, force: true })
    await mkdir(path.join(fresh, 'Contents/MacOS'), { recursive: true })
    await mkdir(path.join(fresh, 'Contents/Resources'), { recursive: true })
    const { version } = await readJson(path.join(HERE, 'package.json'))
    await writeFile(path.join(fresh, 'Contents/Info.plist'), plist({ CFBundleIdentifier: LABEL, CFBundleName: 'Claude Transplant', CFBundleExecutable: 'Claude Transplant', CFBundlePackageType: 'APPL', CFBundleShortVersionString: version, LSMinimumSystemVersion: '13.0', LSUIElement: true, NSHighResolutionCapable: true }))
    const build = spawnSync('swiftc', ['-O', '-parse-as-library', '-o', path.join(fresh, 'Contents/MacOS/Claude Transplant'), source], { encoding: 'utf8' })
    if (build.error) throw new Error('swiftc not found, run xcode-select --install')
    if (build.status !== 0) throw new Error(`swiftc failed\n${build.stderr.trim()}`)
    await writeFile(path.join(fresh, 'Contents/Resources/build.sha256'), key)
    stop()
    await rm(app, { recursive: true, force: true })
    await rename(fresh, app)
  } else stop()
  const script = path.join(app, 'Contents/Resources/transplant.js')
  await copyFile(path.join(HERE, 'transplant.js'), script)
  await writeFile(path.join(paths.state, 'menubar.json'), `${JSON.stringify({ node: process.execPath, script })}\n`)
  await mkdir(path.dirname(agent), { recursive: true })
  await writeFile(agent, plist({ Label: LABEL, ProgramArguments: [binary], RunAtLoad: true }))
  const load = spawnSync('launchctl', ['bootstrap', domain, agent], { encoding: 'utf8' })
  if (load.status !== 0) throw new Error(`launchctl failed: ${(load.stderr || '').trim()}`)
  return `menubar installed | starts at login | ${app}`
}

function parse(argv) {
  const args = { from: [], to: null, cmd: null, dry: false, json: false, help: false, version: false, remove: false }
  const value = (i) => { if (argv[i] === undefined || argv[i].startsWith('-')) throw new Error(`${argv[i - 1]} needs a value`); return argv[i] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--from') args.from.push(value(++i))
    else if (a === '--to') args.to = value(++i)
    else if (a === '--dry-run') args.dry = true
    else if (a === '--json') args.json = true
    else if (a === '--remove') args.remove = true
    else if (a === '--version' || a === '-v') args.version = true
    else if (a === '--help' || a === '-h') args.help = true
    else if (!a.startsWith('-') && !args.cmd) args.cmd = a
    else throw new Error(`unknown argument ${a}`)
  }
  if ((args.from.length > 0) !== Boolean(args.to)) throw new Error('--from and --to go together')
  return args
}

async function main(argv) {
  const args = parse(argv)
  if (args.help) return process.stdout.write(HELP)
  if (args.version) return process.stdout.write(`${(await readJson(path.join(HERE, 'package.json'))).version}\n`)
  const paths = layout()
  const out = process.stdout
  const emit = (o) => out.write(`${JSON.stringify(o)}\n`)
  const all = await accounts(paths)
  if (args.cmd === 'accounts') {
    if (args.json) return emit(all.map(({ account, org, email, orgName, label, stats, active, sessions, activeAt }) => ({ account, org, email, orgName, label, stats, active, sessions: sessions.length, activeAt })))
    if (!all.length) return out.write('no accounts found\n')
    const width = Math.max(...all.map((a) => a.label.length))
    return out.write(`${all.map((a) => `  ${a.label.padEnd(width)}  ${a.stats}`).join('\n')}\n`)
  }
  if (args.cmd === 'menubar') return out.write(`${await menubar(paths, args.remove)}\n`)
  if (args.cmd === 'undo') {
    const result = await undo(paths)
    if (result.changed) process.exitCode = 1
    if (args.json) return emit(result.nothing ? { nothing: true } : result.changed ? { refused: result.changed, at: result.receipt.at } : { undone: result.receipt.at, quarantine: result.dest, sessions: result.receipt.sessions.length, note: NOTE })
    if (result.nothing) return out.write('nothing to undo\n')
    const { receipt } = result
    out.write(`Undo  ${receipt.at} | ${receipt.from.join(' + ')} → ${receipt.to}\n`)
    if (result.changed) {
      return out.write(`  refused | ${result.changed.length} sessions changed since the move | nothing changed\n${result.changed.map((t) => `    ${t}`).join('\n')}\n`)
    }
    const files = receipt.sessions.reduce((n, r) => n + r.sidecars.count, 0)
    return out.write(`  ${count(receipt.sessions.length)} transcripts | ${count(files)} sidecar files | ${count(receipt.sessions.length)} desktop records → quarantine\n  sources unchanged ✓\n  quarantine  ${result.dest}\n  then        ${NOTE}\n`)
  }
  if (args.cmd) throw new Error(`unknown command ${args.cmd}`)
  let from
  let to
  if (args.to) {
    from = args.from.map((sel) => find(all, sel))
    to = find(all, args.to)
  } else {
    if (!process.stdin.isTTY) throw new Error('no terminal, pass --from and --to')
    from = await pick('From', all, true)
    to = (await pick('To', all.filter((a) => !from.includes(a)), false))[0]
  }
  if (from.includes(to)) throw new Error('to must differ from from')
  const report = reporter(args.json)
  if (!args.json) out.write(`From  ${describe(from)}\nTo    ${to.label}\n\n`)
  const inv = await inventory(from, to, paths)
  report('inventory', [`${count(inv.total)} records`, inv.missing.length ? `${count(inv.missing.length)} without history` : null, inv.twice ? `${count(inv.twice)} same lineage twice` : null, inv.there.length ? `${count(inv.there.length)} already there` : null, `${count(inv.move.length)} to move`].filter(Boolean).join(' | '))
  if (!inv.move.length) return args.json ? emit({ done: true, ok: true, moved: 0 }) : out.write('  nothing to move\n')
  if (args.dry) return args.json ? emit({ done: true, ok: true, dry: true, moved: 0 }) : out.write('  dry run     nothing written\n')
  const { file, receipt, checks, problems, ok } = await move(inv, to, paths, report)
  if (!ok) process.exitCode = 1
  const note = receipt.sessions.length ? NOTE : null
  if (args.json) return emit({ done: true, ok, receipt: file, moved: receipt.sessions.length, failed: receipt.failed, problems, checks, note })
  const trouble = [...receipt.failed.map((f) => `${f.title || f.id} | ${f.error}`), ...problems.map((p) => `${p.title} | ${p.check} check failed`)]
  if (trouble.length) out.write(`  failed      ${trouble.join('\n              ')}\n`)
  out.write(`\n  receipt     ${file}\n  undo        npx claude-transplant undo\n${note ? `  then        ${note}\n` : ''}`)
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`claude-transplant: ${error.message}\n`)
    process.exitCode = error.code === 130 ? 130 : 1
  })
}
