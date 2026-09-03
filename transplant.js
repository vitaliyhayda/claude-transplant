#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TYPES = new Set(['user', 'assistant', 'attachment', 'system', 'progress'])
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const UUID = new RegExp(`^${UUID_PATTERN}$`, 'i')
const UUIDS = new RegExp(UUID_PATTERN, 'gi')
const LOCAL_RECORD = new RegExp(`^local_${UUID_PATTERN}$`, 'i')
const ORG_URL = new RegExp(`/(?:organizations|bootstrap)/(${UUID_PATTERN})(?:[/?#]|$)`, 'i')
const NOTE = 'restart Claude Desktop to see them'
const LABEL = 'io.github.vitaliyhayda.claude-transplant'
const SEMANTIC_VERSION = 3
const CACHE_VERSION = 2
const ACTIVE_WINDOW = 10 * 60 * 1000
const RUNTIME_KEYS = ['slug', 'promptId', 'parentUuid', 'version', 'cwd', 'gitBranch']
const HELP = `claude-transplant   move Claude Code history between accounts, transcripts untouched

  claude-transplant             pick from → to, move, retire the source entries, print receipt
  claude-transplant --dry-run   plan only, write nothing, refuses while recovery is pending
  claude-transplant undo        quarantine the last move, put the source entries back
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
const typed = (e) => e && typeof e === 'object' && TYPES.has(e.type) && typeof e.uuid === 'string' && !e.isSidechain
const message = (e) => typed(e) && e.type !== 'progress'
const recent = (time) => Date.now() - time >= 0 && Date.now() - time <= ACTIVE_WINDOW

function workers() {
  const options = { encoding: 'utf8' }
  const processes = spawnSync('/bin/ps', ['-axo', 'pid=,comm='], options)
  const commands = spawnSync('/bin/ps', ['-axo', 'pid=,command='], options)
  if ([processes, commands].some((result) => result.error || result.status !== 0)) throw new Error('cannot inspect running workers')
  const claude = new Set(processes.stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/)
    if (!match) return []
    const executable = match[2].trim()
    return path.basename(executable).toLowerCase() === 'claude' || executable.includes('/Claude.app/Contents/Helpers/disclaimer') ? [match[1]] : []
  }))
  const ids = commands.stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/)
    return match && claude.has(match[1]) ? match[2].match(UUIDS) ?? [] : []
  })
  return new Set(ids.map((id) => id.toLowerCase()))
}

export function layout(home = os.homedir()) {
  const support = path.join(home, 'Library/Application Support')
  return {
    home,
    records: path.join(support, 'Claude/claude-code-sessions'),
    agentSessions: path.join(support, 'Claude/local-agent-mode-sessions'),
    desktop: path.join(support, 'Claude/config.json'),
    usage: path.join(support, 'Claude/plan-usage-history.json'),
    scope: path.join(support, 'Claude/sentry/scope_v3.json'),
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

async function treeFingerprint(root, cache = null) {
  const files = await tree(root)
  const dependencies = await Promise.all(files.map(async (file) => ({ rel: path.relative(root, file), fingerprint: await fingerprint(file, cache) })))
  return { files, fingerprint: sha(stable(dependencies)) }
}

async function manifest(root, cache = null) {
  const before = await treeFingerprint(root, cache)
  const { files } = before
  const prior = cache ? cacheLookup(cache, 'manifests', root, before.fingerprint) : null
  if (prior) return manifestOf(prior.rows, before.fingerprint)
  const rows = []
  for (const file of files) {
    const data = await readFile(file)
    rows.push({ rel: path.relative(root, file), bytes: data.length, sha: sha(data) })
  }
  if (cache) cacheStore(cache, 'manifests', root, before.fingerprint, { rows })
  else if ((await treeFingerprint(root)).fingerprint !== before.fingerprint) throw new Error('sidecars changed while reading')
  return manifestOf(rows, before.fingerprint)
}

function manifestOf(rows, fingerprint = null) {
  return {
    set: new Set(rows.map((row) => `${row.rel}:${row.sha}`)),
    rows,
    count: rows.length,
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    sha: sha(stable(rows)),
    fingerprint
  }
}

const emptyCache = () => ({ version: CACHE_VERSION, semanticVersion: SEMANTIC_VERSION, histories: {}, manifests: {} })

async function openAnalysisCache(paths, writable) {
  const file = path.join(paths.state, 'cache.json')
  const stored = await readJson(file).catch(() => null)
  const valid = stored?.version === CACHE_VERSION && stored?.semanticVersion === SEMANTIC_VERSION &&
    ['histories', 'manifests'].every((key) => stored[key] && typeof stored[key] === 'object' && !Array.isArray(stored[key]))
  return {
    file,
    writable,
    data: valid ? stored : emptyCache(),
    used: { histories: new Set(), manifests: new Set() },
    fingerprints: new Map(),
    stats: { historyHits: 0, historyMisses: 0, manifestHits: 0, manifestMisses: 0 }
  }
}

async function fingerprint(file, cache = null) {
  if (cache?.fingerprints.has(file)) return cache.fingerprints.get(file)
  const detail = await stat(file, { bigint: true })
  const value = [detail.dev, detail.ino, detail.size, detail.mtimeNs, detail.ctimeNs].join(':')
  cache?.fingerprints.set(file, value)
  return value
}

const cacheNames = {
  histories: ['historyHits', 'historyMisses'],
  manifests: ['manifestHits', 'manifestMisses']
}

function cacheLookup(cache, bucket, key, signature) {
  cache.used[bucket].add(key)
  const item = cache.data[bucket][key]
  if (item?.signature === signature) {
    cache.stats[cacheNames[bucket][0]]++
    return item.value
  }
  cache.stats[cacheNames[bucket][1]]++
  return null
}

function cacheStore(cache, bucket, key, signature, value) {
  cache.used[bucket].add(key)
  cache.data[bucket][key] = { signature, value }
}

async function saveAnalysisCache(cache) {
  if (!cache.writable) return
  const kept = (bucket) => Object.fromEntries([...cache.used[bucket]].flatMap((key) => cache.data[bucket][key] ? [[key, cache.data[bucket][key]]] : []))
  await mkdir(path.dirname(cache.file), { recursive: true })
  await saveJson(cache.file, {
    version: CACHE_VERSION,
    semanticVersion: SEMANTIC_VERSION,
    histories: kept('histories'),
    manifests: kept('manifests')
  }, 0)
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
  const guard = spawn('/usr/bin/lockf', ['-k', '-s', '-w', '-t', '0', lockFile, '/bin/sh', '-c', 'printf ready; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] })
  await new Promise((resolve, reject) => {
    let ready = false
    guard.stdout.once('data', () => { ready = true; resolve() })
    guard.once('error', reject)
    guard.once('exit', (code) => {
      if (!ready) reject(new Error(code === 75 ? 'another run holds the lock' : `lockf failed, exit ${code ?? 'unknown'}`))
    })
  })
  try {
    return await work()
  } finally {
    guard.stdin.end()
    if (guard.exitCode === null) await new Promise((resolve) => guard.once('exit', resolve))
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

async function taskSessions(file) {
  let data
  try {
    data = await readJson(file)
  } catch (error) {
    if (error.code === 'ENOENT') return new Set()
    throw new Error(`unreadable scheduled task registry ${file}`)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`invalid scheduled task registry ${file}`)
  if (data.scheduledTasks !== undefined && !Array.isArray(data.scheduledTasks)) throw new Error(`invalid scheduled task registry ${file}`)
  if (data.scheduledTasks?.some((task) => !task || typeof task !== 'object' || (task.notifySessionId !== undefined && typeof task.notifySessionId !== 'string'))) throw new Error(`invalid scheduled task registry ${file}`)
  return new Set((data.scheduledTasks ?? []).map((task) => task?.notifySessionId).filter(Boolean))
}

async function logins(paths) {
  const emails = new Map()
  const orgs = new Map()
  const take = async (file) => {
    const a = (await readJson(file).catch(() => ({}))).oauthAccount
    if (a?.accountUuid && a.emailAddress) emails.set(a.accountUuid, a.emailAddress)
    if (a?.organizationUuid && a.organizationName) orgs.set(a.organizationUuid, a.organizationType && !/team|enterprise/.test(a.organizationType) ? 'Personal' : a.organizationName)
  }
  for (const e of await readdir(paths.home, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith('.claude')) await take(e.isDirectory() ? path.join(paths.home, e.name, '.claude.json') : path.join(paths.home, e.name))
  }
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
  if (!ms) return '-'
  const s = Math.max(0, Date.now() - ms) / 1000
  const [n, unit] = s < 3600 ? [s / 60, 'm'] : s < 86400 ? [s / 3600, 'h'] : s < 86400 * 30 ? [s / 86400, 'd'] : [s / 86400 / 30, 'mo']
  return `${Math.max(1, Math.round(n))}${unit} ago`
}

function mode(values) {
  const tally = new Map()
  for (const v of values) if (v) tally.set(v, (tally.get(v) ?? 0) + 1)
  return [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '-'
}

async function current(paths) {
  const desktop = await readJson(paths.desktop).catch(() => ({}))
  const samples = (await readJson(paths.usage).catch(() => ({}))).samples ?? []
  const clock = (value) => {
    const raw = typeof value === 'number' ? value : Date.parse(value ?? '')
    return Number.isFinite(raw) ? (raw < 1e12 ? raw * 1000 : raw) : -1
  }
  const latest = samples.reduce((best, sample) => clock(sample?.t) > best.time ? { org: sample.org, time: clock(sample.t) } : best, { org: null, time: -1 })
  const breadcrumbs = (await readJson(paths.scope).catch(() => ({}))).scope?.breadcrumbs ?? []
  const seen = breadcrumbs.reduce((best, crumb) => {
    const url = crumb?.data?.url
    const match = typeof url === 'string' ? url.match(ORG_URL) : null
    const time = clock(crumb?.timestamp)
    return match && Number.isFinite(time) && time > best.time ? { org: match[1], time } : best
  }, { org: null, time: -1 })
  return { account: desktop.lastKnownAccountUuid ?? null, org: recent(seen.time) ? seen.org : recent(latest.time) ? latest.org : null }
}

export async function accounts(paths) {
  const { emails, orgs } = await logins(paths)
  const cur = await current(paths)
  const out = []
  for (const { account, org, dir, files } of await records(paths.records)) {
    const sessions = []
    const unreadable = []
    for (const file of files) {
      const r = await readJson(file).catch(() => null)
      if (!r) { unreadable.push(file); continue }
      sessions.push({
        file,
        id: UUID.test(r.cliSessionId ?? '') ? r.cliSessionId : null,
        cwd: r.cwd ?? '',
        title: r.title ?? '',
        archived: r.isArchived === true,
        createdAt: r.createdAt ?? 0,
        activeAt: r.lastActivityAt ?? 0,
        focusedAt: r.lastFocusedAt ?? 0,
        record: r
      })
    }
    const activeAt = Math.max(0, ...sessions.map((s) => s.activeAt))
    const email = emails.get(account) ?? null
    const orgName = orgs.get(org) ?? null
    const taskFile = path.join(dir, 'scheduled-tasks.json')
    let scheduled = new Set()
    let taskError = null
    try { scheduled = await taskSessions(taskFile) } catch (error) { taskError = error.message }
    const label = `${email ?? short(account)} · ${orgName ?? short(org)}`
    const base = sessions.length ? `${sessions.length} | ${ago(activeAt)} | ${mode(sessions.map((s) => path.basename(s.cwd)))}` : '0 | -'
    const stats = `${base}${unreadable.length ? ` | ${unreadable.length} unreadable` : ''}${taskError ? ' | task registry unreadable' : ''}`
    out.push({ account, org, dir, email, orgName, sessions, unreadable, taskFile, taskSessions: scheduled, taskError, activeAt, focusedAt: Math.max(0, ...sessions.map((s) => s.focusedAt)), label, stats, active: false })
  }
  const mine = out.filter((a) => a.account === cur.account)
  const focused = mine.toSorted((a, b) => b.focusedAt - a.focusedAt)[0]
  const chosen = mine.find((a) => a.org === cur.org) ?? (focused && recent(focused.focusedAt) ? focused : null)
  if (chosen) Object.assign(chosen, { active: true, stats: `${chosen.stats} | active` })
  return out.sort((a, b) => b.activeAt - a.activeAt)
}

async function index(pool) {
  const map = new Map()
  for (const dir of await readdir(pool).catch(() => [])) {
    const full = path.join(pool, dir)
    for (const name of await readdir(full).catch(() => [])) {
      const id = name.slice(0, -6)
      if (name.endsWith('.jsonl') && UUID.test(id)) map.set(id, [...(map.get(id) ?? []), path.join(full, name)])
    }
  }
  return map
}

const locate = (index, id, cwd = '') => {
  const paths = index.get(id) ?? []
  return paths.length === 1 ? paths[0] : paths.find((p) => path.basename(path.dirname(p)) === cwd.replace(/[^A-Za-z0-9]/g, '-')) ?? null
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
    if (!message(e)) continue
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

const without = (entry, keys) => {
  const copy = structuredClone(entry)
  for (const key of keys) delete copy[key]
  return copy
}

const recordSemantic = (record) => sha(stable(without(record, [
  'lastActivityAt', 'lastFocusedAt', 'completedTurns', 'error', 'errorAt', 'priorErrorMark',
  'lastSpawnRootDetected', 'reportFindingsCard', 'scratchPromptRecents'
])))

const semanticShape = (entry) => stable(without(entry, RUNTIME_KEYS))

const replayShape = (entry) => {
  const c = without(entry, RUNTIME_KEYS)
  if (c.toolUseResult && typeof c.toolUseResult === 'object' && !Array.isArray(c.toolUseResult)) {
    delete c.toolUseResult.stdout
    delete c.toolUseResult.stderr
  }
  return stable(c)
}

const richness = (e) => ['stdout', 'stderr'].reduce((n, k) => n + (typeof e.toolUseResult?.[k] === 'string' ? Buffer.byteLength(e.toolUseResult[k]) : 0), 0)

function survivor(rows, ids) {
  if (new Set(rows.map((r) => replayShape(r.entry))).size !== 1) return null
  if (rows.some((r) => r.entry.parentUuid && !ids.has(r.entry.parentUuid))) return null
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
  const rows = entries.map((entry, line) => ({ entry, line })).filter(({ entry }) => typed(entry))
  const groups = Map.groupBy(rows, (r) => r.entry.uuid)
  const ids = new Set(groups.keys())
  const drop = new Set()
  let replays = 0
  let conflicts = 0
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const line = survivor(group, ids)
    if (line === null) { conflicts++; continue }
    replays++
    for (const r of group) if (r.line !== line) drop.add(r.line)
  }
  return { entries: entries.filter((_, line) => !drop.has(line)), replays, conflicts }
}

function sessionState(entries, sessionId, origin = new Map()) {
  const replacements = []
  let relocated = null
  for (const e of entries) {
    if (e.type === 'content-replacement' && e.sessionId === sessionId && Array.isArray(e.replacements)) {
      for (const replacement of e.replacements) {
        const copy = structuredClone(replacement)
        if (typeof copy.uuid === 'string') copy.uuid = origin.get(copy.uuid) ?? copy.uuid
        replacements.push(copy)
      }
    } else if (e.type === 'relocated' && e.sessionId === sessionId && typeof e.relocatedCwd === 'string' && e.relocatedCwd) relocated = e.relocatedCwd
  }
  return { replacements, suppressed: entries.some((e) => e.type === 'history-suppression'), relocated }
}

export function semantic(entries, sessionId, invalid = 0) {
  const normalized = normalize(entries)
  const rows = normalized.entries.filter(message).map((e) => sha(semanticShape(e)))
  return sha(stable({ rows, state: sessionState(entries, sessionId), invalid, conflicts: normalized.conflicts }))
}

async function scanned(id, ctx, cwd = '', dependencies = null) {
  const file = locate(ctx.index, id, cwd)
  if (!file) return null
  dependencies?.add(file)
  if (!ctx.scans.has(file)) ctx.scans.set(file, await scan(file))
  return ctx.scans.get(file)
}

async function sidecars(transcript, id, cache = null) {
  const root = path.join(path.dirname(transcript), id)
  return manifest(root, cache)
}

const sidecarsAgree = (a, b) => {
  const files = new Map(a.rows.map((row) => [row.rel, row.sha]))
  return b.rows.every((row) => !files.has(row.rel) || files.get(row.rel) === row.sha)
}

async function origins(id, ctx, cwd = '') {
  const out = new Map()
  const dependencies = new Set()
  const own = await scanned(id, ctx, cwd, dependencies)
  for (const uuid of new Set(own?.ids ?? [])) {
    let cursor = uuid
    let session = own
    const seen = new Set()
    while (session && !seen.has(cursor)) {
      seen.add(cursor)
      const from = session.forked.get(cursor)
      if (!from) break
      cursor = from.messageUuid
      session = await scanned(from.sessionId, ctx, '', dependencies)
    }
    out.set(uuid, cursor)
  }
  return { origin: out, dependencies }
}

const lineageEvent = (entry) => {
  const c = without(entry, RUNTIME_KEYS)
  const output = { stdout: null, stderr: null }
  const ignored = [
    'uuid', 'logicalParentUuid', 'sessionId', 'timestamp',
    'forkedFrom', 'teamName', 'agentName', 'sessionKind', 'sourceToolAssistantUUID', 'neutralizedByFork'
  ]
  for (const k of ignored) delete c[k]
  if (c.toolUseResult && typeof c.toolUseResult === 'object' && !Array.isArray(c.toolUseResult)) {
    for (const k of ['stdout', 'stderr']) {
      if (typeof c.toolUseResult[k] === 'string' && c.toolUseResult[k]) output[k] = sha(c.toolUseResult[k])
      delete c.toolUseResult[k]
    }
    if (!Object.keys(c.toolUseResult).length) delete c.toolUseResult
  }
  return { base: sha(stable(c)), ...output }
}

const eventIncluded = (a, b) => Boolean(b) && a.base === b.base && ['stdout', 'stderr'].every((k) => !a[k] || a[k] === b[k])

async function priorHistory(cache, key, transcript) {
  cache.used.histories.add(key)
  const item = cache.data.histories[key]
  const dependencies = item?.value?.dependencies
  const encoded = item?.value?.result
  if (Array.isArray(dependencies) && encoded && Array.isArray(encoded.events)) {
    try {
      const current = await Promise.all(dependencies.map(async ([file]) => [file, await fingerprint(file, cache)]))
      if (sha(stable(current)) === item.signature) {
        encoded.contentSha ??= sha(await readFile(transcript))
        cache.stats.historyHits++
        const events = new Map(encoded.events)
        return { ...encoded, events, roots: new Set(events.keys()) }
      }
    } catch {}
  }
  cache.stats.historyMisses++
  return null
}

async function history(id, transcript, ctx, cwd = '') {
  const cacheKey = ctx.cache ? sha(stable({ version: CACHE_VERSION, semanticVersion: SEMANTIC_VERSION, id, transcript, cwd })) : null
  if (ctx.cache) {
    const prior = await priorHistory(ctx.cache, cacheKey, transcript)
    if (prior) return prior
  }
  const lineage = await origins(id, ctx, cwd)
  const dependencyRows = ctx.cache
    ? await Promise.all([...lineage.dependencies].sort().map(async (file) => [file, await fingerprint(file, ctx.cache)]))
    : []
  const data = await load(transcript)
  const normalized = normalize(data.entries)
  const origin = lineage.origin
  const events = new Map()
  let conflicts = normalized.conflicts
  for (const e of normalized.entries.filter(message)) {
    const root = origin.get(e.uuid) ?? e.uuid
    const shape = lineageEvent(e)
    const prior = events.get(root)
    if (!prior || eventIncluded(prior, shape)) events.set(root, shape)
    else if (!eventIncluded(shape, prior)) conflicts++
  }
  const roots = new Set(events.keys())
  const state = sha(stable(sessionState(data.entries, id, origin)))
  const comparable = data.invalid === 0 && conflicts === 0 && roots.size > 0
  const result = { roots, events, forks: ctx.scans.get(transcript)?.forked.size ?? 0, state, bridge: data.entries.some((entry) => entry.type === 'bridge-session'), invalid: data.invalid, conflicts, comparable, snapshot: semantic(data.entries, id, data.invalid), contentSha: data.sha }
  if (ctx.cache) {
    const encoded = { ...result, roots: undefined, events: [...events] }
    cacheStore(ctx.cache, 'histories', cacheKey, sha(stable(dependencyRows)), { dependencies: dependencyRows, result: encoded })
  }
  return result
}

const sameEvents = (a, b) => {
  for (const [id, event] of a.events) if (!eventIncluded(event, b.events.get(id))) return false
  return true
}
const historyIncluded = (a, b) => a.comparable && b.comparable && a.roots.isSubsetOf(b.roots) && a.state === b.state && sameEvents(a, b)
const carries = (a, b) => Boolean(a.sidecar && b.sidecar && a.sidecar.set.isSubsetOf(b.sidecar.set))
const included = (a, b) => historyIncluded(a, b) && carries(a, b)
const overlaps = (a, b) => !a.roots.isDisjointFrom(b.roots)
const progress = (report, stage, completed, total) => report(stage, `${completed}/${total}`, { live: true, completed, total })

const rehomeReason = (source, to, targetIds, targetNames) => {
  if (new Set(source.members?.map((member) => member.transcript)).size > 1) return 'multiple compatible source versions require merging'
  if (source.account.account === to.account && source.account.org === to.org) return 'source and destination are the same'
  if (source.invalid) return `${source.invalid} unparseable lines`
  if (source.conflicts) return `${source.conflicts} conflicting duplicate uuids`
  if (!source.comparable) return 'history cannot be compared safely'
  if (!LOCAL_RECORD.test(source.record.sessionId ?? '')) return 'Desktop record id is not a local UUID'
  if (path.basename(source.file) !== `${source.record.sessionId}.json`) return 'Desktop record filename does not match its id'
  if (source.record.scheduledTaskId) return 'scheduled task owns the Desktop record'
  if (source.record.notifySessionId) return 'notification route owns the Desktop record'
  if (source.taskOwned) return 'scheduled task registry owns the Desktop record'
  if (source.worker) return 'running worker owns the session'
  if (targetIds.has(source.id)) return 'target session id collision'
  if (targetNames.has(path.basename(source.file))) return 'target Desktop filename collision'
  return null
}

export async function inventory(from, to, paths, report = () => {}, options = {}) {
  const brokenTasks = [...from, to].find((account) => account.taskError)
  if (brokenTasks) throw new Error(`${brokenTasks.label}: ${brokenTasks.taskError}`)
  const workTotal = from.reduce((sum, account) => sum + account.sessions.length, 0) + to.sessions.length
  let completed = 0
  progress(report, 'scan', completed, workTotal)
  const cache = await openAnalysisCache(paths, options.writeCache === true)
  const ctx = { index: await index(paths.pool), scans: new Map(), workers: workers(), cache }
  const analyzed = new Map()
  const missing = []
  const unreadable = []
  const rejected = []
  const found = []
  let total = 0
  for (const account of from) {
    total += account.unreadable?.length ?? 0
    unreadable.push(...(account.unreadable ?? []).map((file) => ({ file, account })))
    for (const s of account.sessions) {
      total++
      try {
        if (!s.id) { missing.push(s); continue }
        const transcript = locate(ctx.index, s.id, s.cwd)
        if (!transcript) { missing.push(s); continue }
        try {
          let detail = analyzed.get(transcript)
          if (!detail) {
            const historyDetail = await history(s.id, transcript, ctx, s.cwd)
            detail = { ...historyDetail, transcriptFingerprint: await fingerprint(transcript, cache), sidecar: await sidecars(transcript, s.id, cache) }
            analyzed.set(transcript, detail)
          }
          if (!detail.roots.size && !detail.invalid) { missing.push(s); continue }
          found.push({ ...s, account, transcript, ...detail, taskOwned: account.taskSessions.has(s.record.sessionId), worker: ctx.workers.has(s.id.toLowerCase()), recordSha: sha(await readFile(s.file)), recordSemantic: recordSemantic(s.record) })
        } catch (error) {
          rejected.push({ id: s.id, title: s.title, account, error: error.message })
        }
      } finally {
        progress(report, 'scan', ++completed, workTotal)
      }
    }
  }
  unreadable.push(...(to.unreadable ?? []).map((file) => ({ file, account: to, target: true })))
  const ranked = found.toSorted((a, b) => b.roots.size - a.roots.size || b.activeAt - a.activeAt || a.forks - b.forks || a.createdAt - b.createdAt)
  const reps = []
  for (const source of ranked) {
    const at = reps.findIndex((candidate) => {
      if (!historyIncluded(source, candidate) && !historyIncluded(candidate, source)) return false
      return candidate.members.every((member) => sidecarsAgree(member.sidecar, source.sidecar))
    })
    if (at >= 0) {
      const prior = reps[at]
      const members = [...prior.members, source]
      const fullest = historyIncluded(prior, source) && !historyIncluded(source, prior) ? source : prior
      reps[at] = { ...fullest, members }
    } else {
      reps.push({ ...source, members: [source] })
    }
  }
  const targets = []
  for (const s of to.sessions) {
    try {
      if (!s.id) continue
      const transcript = locate(ctx.index, s.id, s.cwd)
      try {
        const detail = transcript ? await history(s.id, transcript, ctx, s.cwd) : null
        if (detail?.roots.size) targets.push({ record: s.record.sessionId, id: s.id, ...detail, session: s, account: to, taskOwned: to.taskSessions.has(s.record.sessionId), worker: ctx.workers.has(s.id.toLowerCase()), transcript, transcriptFingerprint: await fingerprint(transcript, cache), sidecar: await sidecars(transcript, s.id, cache), recordSha: sha(await readFile(s.file)), recordSemantic: recordSemantic(s.record) })
      } catch (error) {
        rejected.push({ id: s.id, title: s.title, account: to, target: true, error: error.message })
      }
    } finally {
      progress(report, 'scan', ++completed, workTotal)
    }
  }
  const covering = (s) => targets.find((target) => s.members.every((member) => included(member, target)))?.record ?? null
  const there = []
  const pending = []
  for (const s of reps) (covering(s) && !s.invalid ? there : pending).push(s)
  const targetIds = new Set(to.sessions.map((session) => session.id).filter(Boolean))
  const targetNames = new Set([...to.sessions.map((session) => path.basename(session.file)), ...to.unreadable.map((file) => path.basename(file))])
  const reasons = new Map(pending.map((source) => [source, rehomeReason(source, to, targetIds, targetNames)]))
  const availableParents = new Set(to.sessions.map((session) => session.record.sessionId).filter(Boolean))
  let added = true
  while (added) {
    added = false
    for (const source of pending) {
      if (reasons.get(source) || availableParents.has(source.record.sessionId)) continue
      if (!source.record.forkedFromSessionId || availableParents.has(source.record.forkedFromSessionId)) {
        availableParents.add(source.record.sessionId)
        added = true
      }
    }
  }
  const blocked = []
  const move = []
  for (const source of pending) {
    const reason = reasons.get(source) || (!availableParents.has(source.record.sessionId) ? 'parent Desktop record is absent from the target and move' : null)
    if (reason) blocked.push({ ...source, error: reason })
    else {
      source.strategy = 'rehome'
      move.push(source)
    }
  }
  const ordered = []
  const pendingMove = [...move]
  const landedRecords = new Set(to.sessions.map((session) => session.record.sessionId).filter(Boolean))
  while (pendingMove.length) {
    const at = pendingMove.findIndex((source) => !source.record.forkedFromSessionId || landedRecords.has(source.record.forkedFromSessionId))
    if (at < 0) throw new Error('parent ordering invariant failed')
    const next = pendingMove.splice(at, 1)[0]
    ordered.push(next)
    landedRecords.add(next.record.sessionId)
  }
  move.splice(0, move.length, ...ordered)
  const apart = reps.filter((a) => reps.some((b) => a !== b && overlaps(a, b))).length
  await saveAnalysisCache(cache)
  return { total, missing, unreadable, rejected, blocked, twice: found.length - reps.length, apart, there, move, targets, sources: found, from: from.map((a) => a.label), cacheStats: cache.stats }
}

async function rehomeOne(s, to, journal, guard) {
  const transcriptBefore = await fingerprint(s.transcript)
  if (s.transcriptFingerprint && transcriptBefore !== s.transcriptFingerprint) throw new Error('source changed since inventory')
  const sourceSha = sha(await readFile(s.transcript))
  const transcriptFingerprint = await fingerprint(s.transcript)
  if (transcriptFingerprint !== transcriptBefore) throw new Error('source changed while reading')
  if (!s.contentSha || sourceSha !== s.contentSha) throw new Error('source changed since inventory')
  if (!s.snapshot) throw new Error('source analysis unavailable')
  const sidecarRoot = path.join(path.dirname(s.transcript), s.id)
  const sidecarFingerprint = (await treeFingerprint(sidecarRoot)).fingerprint
  if (!s.sidecar.fingerprint || sidecarFingerprint !== s.sidecar.fingerprint) throw new Error('source sidecars changed since inventory')
  const sourceSidecars = { ...s.sidecar, fingerprint: sidecarFingerprint }
  const sourceRecord = await readFile(s.file, 'utf8')
  const current = JSON.parse(sourceRecord)
  if (current.cliSessionId !== s.id || !LOCAL_RECORD.test(current.sessionId ?? '') || path.basename(s.file) !== `${current.sessionId}.json`) throw new Error('source Desktop record changed identity')
  if (recordSemantic(current) !== s.recordSemantic) throw new Error('source Desktop record changed since inventory')
  if (current.forkedFromSessionId !== s.record.forkedFromSessionId) throw new Error('source Desktop lineage changed since inventory')
  if (current.scheduledTaskId || current.notifySessionId) throw new Error('source Desktop ownership changed since inventory')
  if (guard.taskSessions.get(s.account.taskFile).has(current.sessionId)) throw new Error('source scheduled task ownership changed since inventory')
  if (guard.taskSessions.get(to.taskFile).has(current.sessionId)) throw new Error('target scheduled task collision')
  if (guard.workers.has(s.id.toLowerCase())) throw new Error('running worker')
  const title = (current.title ?? '').trim() || s.title || 'Untitled'
  const record = path.join(to.dir, path.basename(s.file))
  const sourceRecordSha = sha(sourceRecord)
  const placed = { ...current, bridgeSessionIds: [] }
  const recordText = `${JSON.stringify(placed, null, 2)}\n`
  const recordSha = sha(recordText)
  await journal({ strategy: 'rehome', recordSha })
  await writeNew(record, recordText)
  const [afterTranscriptFingerprint, afterRecord, afterSidecars] = await Promise.all([
    fingerprint(s.transcript),
    readFile(s.file, 'utf8'),
    treeFingerprint(sidecarRoot)
  ])
  if (afterTranscriptFingerprint !== transcriptFingerprint) throw new Error('source changed during move')
  if (sha(afterRecord) !== sourceRecordSha) throw new Error('source Desktop record changed during move')
  if (afterSidecars.fingerprint !== sourceSidecars.fingerprint) throw new Error('source sidecars changed during move')
  for (const member of s.members ?? [s]) {
    member.strategy = 'rehome'
    member.transcriptFingerprint = transcriptFingerprint
    member.sidecar = { ...member.sidecar, fingerprint: sourceSidecars.fingerprint }
  }
  return {
    strategy: 'rehome',
    id: s.id,
    targetId: s.id,
    title,
    archived: current.isArchived === true,
    transcript: s.transcript,
    targetTranscript: s.transcript,
    targetDir: sourceSidecars.count ? path.join(path.dirname(s.transcript), s.id) : null,
    record,
    recordSha,
    recordSemantic: recordSemantic(placed),
    targetRecordId: current.sessionId,
    taskFile: to.taskFile,
    taskOwned: false,
    transcriptFingerprint,
    sidecars: { count: sourceSidecars.count, bytes: sourceSidecars.bytes, fingerprint: sourceSidecars.fingerprint },
    events: s.roots.size
  }
}

const gained = (c) => [...new Set(c.ids)].some((u) => !c.forked.has(u))
const knownOf = (row) => ({
  semantic: row.targetSemantic ?? row.semantic,
  semanticVersion: row.targetSemanticVersion ?? row.semanticVersion,
  bridge: row.targetBridge ?? row.bridge,
  sha: row.targetSha ?? row.sha
})
const artifacts = (row) => row.strategy === 'rehome' ? [row.record] : [row.targetTranscript, row.targetDir, row.record].filter(Boolean)
const retiredCount = (receipt) => (receipt.superseded ?? []).filter((p) => p.source).length
const ownership = (row, liveWorkers, bridges = true) => {
  const record = row.session?.record ?? row.record ?? {}
  return [
    bridges && record.bridgeSessionIds?.length ? 'Remote Control bridge' : null,
    bridges && row.bridge ? 'transcript bridge' : null,
    record.scheduledTaskId ? 'scheduled task' : null,
    record.notifySessionId ? 'notification route' : null,
    row.taskOwned ? 'scheduled task registry' : null,
    row.worker || liveWorkers?.has(row.id.toLowerCase()) ? 'running worker' : null
  ].filter(Boolean).join(', ')
}
const rehomeOwnership = (row, liveWorkers) => ownership(row, liveWorkers, false)
const inventoryFailure = (item) => ({
  id: item.id ?? null,
  title: item.members?.length > 1
    ? item.members.map((member) => `${member.account.label} | ${member.title || path.basename(member.file)}`).join(' + ')
    : `${item.account.label} | ${item.title || path.basename(item.file)}`,
  error: item.error ?? 'unreadable Desktop record'
})
const inventoryFailures = (inv) => [...inv.unreadable, ...inv.rejected, ...(inv.blocked ?? [])].map(inventoryFailure)

async function changed(file, sessionId, known) {
  if (!(await exists(file))) return false
  if (known?.semantic && known.semanticVersion === SEMANTIC_VERSION) {
    const data = await load(file)
    return semantic(data.entries, sessionId, data.invalid) !== known.semantic || (known.bridge !== undefined && data.entries.some((entry) => entry.type === 'bridge-session') !== known.bridge)
  }
  if (known?.sha) return sha(await readFile(file)) !== known.sha
  return gained(await scan(file))
}

async function targetChanges(row, liveWorkers, checkShared = true) {
  const changes = []
  if (row.strategy === 'rehome') {
    const currentFingerprint = await fingerprint(row.targetTranscript).catch(() => null)
    if (!currentFingerprint) changes.push('transcript missing')
    else if (checkShared && row.transcriptFingerprint && currentFingerprint !== row.transcriptFingerprint) changes.push('transcript')
    const targetDir = row.targetDir ?? path.join(path.dirname(row.targetTranscript), row.targetId)
    const sidecarsExist = !row.sidecars?.count || await exists(targetDir)
    if (!sidecarsExist) changes.push('sidecars missing')
    else if (checkShared && row.sidecars?.fingerprint && (await treeFingerprint(targetDir).catch(() => null))?.fingerprint !== row.sidecars.fingerprint) {
      changes.push('sidecars')
    }
  } else {
    if (!(await exists(row.targetTranscript)) || await changed(row.targetTranscript, row.targetId, knownOf(row))) changes.push('transcript')
    const targetDir = row.targetDir ?? path.join(path.dirname(row.targetTranscript), row.targetId)
    const currentSidecars = await manifest(targetDir).catch(() => null)
    if (!currentSidecars || currentSidecars.sha !== row.sidecars.sha) changes.push('sidecars')
  }
  const currentRecord = await readFile(row.record).catch(() => null)
  let recordChanged = !currentRecord
  if (currentRecord) {
    try {
      recordChanged = row.recordSemantic ? recordSemantic(JSON.parse(currentRecord)) !== row.recordSemantic : sha(currentRecord) !== row.recordSha
    } catch { recordChanged = true }
  }
  if (recordChanged) changes.push('desktop record')
  if (row.taskFile && (await taskSessions(row.taskFile)).has(row.targetRecordId ?? `local_${row.targetId}`) !== row.taskOwned) changes.push('scheduled tasks')
  if (liveWorkers?.has(row.targetId.toLowerCase())) changes.push('running worker')
  return changes
}

async function restoreProblems(plan, root, parkedOnly = false) {
  const problems = []
  for (const item of plan) {
    const hashes = new Map(item.hashes ?? [])
    const trees = new Map(item.trees ?? [])
    const semantics = new Map(item.semantics ?? [])
    for (const [original, parked] of item.moved) {
      const relative = path.relative(root, parked)
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        problems.push(`${item.title || item.id} | recovery path outside quarantine | ${path.basename(parked)}`)
        continue
      }
      const [hasOriginal, hasParked] = await Promise.all([exists(original), exists(parked)])
      const optionalLegacyDir = !item.required && UUID.test(path.basename(original)) && !path.extname(original)
      if (parkedOnly && !hasParked) {
        if (!hasOriginal && !optionalLegacyDir) problems.push(`${item.title || item.id} | recovery artifact missing | ${path.basename(parked)}`)
        continue
      }
      if (hasOriginal && hasParked) problems.push(`${item.title || item.id} | restore path occupied | ${path.basename(original)}`)
      else if (!hasOriginal && !hasParked) {
        if (!optionalLegacyDir) problems.push(`${item.title || item.id} | recovery artifact missing | ${path.basename(parked)}`)
      } else {
        const available = hasOriginal ? original : parked
        const expectedHash = hashes.get(original)
        const expectedTree = trees.get(original)
        const expectedSemantic = semantics.get(original)
        if (expectedHash && sha(await readFile(available).catch(() => Buffer.alloc(0))) !== expectedHash) problems.push(`${item.title || item.id} | recovery artifact changed | ${path.basename(available)}`)
        else if (expectedTree && (await manifest(available).catch(() => null))?.sha !== expectedTree) problems.push(`${item.title || item.id} | recovery artifact changed | ${path.basename(available)}`)
        else if (expectedSemantic && recordSemantic(await readJson(available).catch(() => ({}))) !== expectedSemantic) problems.push(`${item.title || item.id} | recovery artifact changed | ${path.basename(available)}`)
        else if (item.source && !expectedHash && path.basename(original).startsWith('local_')) {
          const record = await readJson(available).catch(() => null)
          if (record?.cliSessionId !== item.id) problems.push(`${item.title || item.id} | recovery record invalid | ${path.basename(available)}`)
        }
      }
    }
  }
  return problems
}

async function snapshotPlan(item) {
  return {
    ...item,
    hashes: await Promise.all((item.hashes ?? []).map(async ([file]) => [file, sha(await readFile(file))])),
    trees: await Promise.all((item.trees ?? []).map(async ([file]) => [file, (await manifest(file)).sha])),
    semantics: await Promise.all((item.semantics ?? []).map(async ([file]) => [file, recordSemantic(await readJson(file))]))
  }
}

async function verify(rows, report = () => {}) {
  const bad = { transcript: 0, sidecars: 0, desktop: 0 }
  const problems = []
  const flag = (key, r) => { bad[key]++; problems.push({ id: r.targetId, title: r.title, check: key }) }
  progress(report, 'verify', 0, rows.length)
  for (const [i, r] of rows.entries()) {
    try {
      const targetDir = r.targetDir ?? path.join(path.dirname(r.targetTranscript), r.targetId)
      const currentFingerprint = await fingerprint(r.targetTranscript).catch(() => null)
      if (!currentFingerprint || currentFingerprint !== r.transcriptFingerprint) flag('transcript', r)
      if ((await treeFingerprint(targetDir).catch(() => null))?.fingerprint !== r.sidecars.fingerprint) flag('sidecars', r)
      const raw = await readFile(r.record, 'utf8').catch(() => null)
      if (!raw || sha(raw) !== r.recordSha) flag('desktop', r)
    } finally {
      progress(report, 'verify', i + 1, rows.length)
    }
  }
  const mark = (v) => (v ? `✗ ${v}` : '✓')
  const lines = [
    `transcripts unchanged ${mark(bad.transcript)}`,
    `sidecars unchanged ${mark(bad.sidecars)}`,
    `desktop ${mark(bad.desktop)}`
  ]
  return { ok: problems.length === 0, problems, lines }
}

const receipts = async (paths) => (await readdir(paths.state).catch(() => [])).filter((f) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}\.json$/.test(f)).sort()

const saveJson = async (file, value, spacing = 2) => {
  const text = `${JSON.stringify(value, null, spacing || undefined)}\n`
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, text, { flag: 'wx', mode: 0o600 })
    await rename(temp, file)
    return text
  } finally {
    await unlink(temp).catch(() => {})
  }
}

async function pending(paths) {
  const name = (await receipts(paths)).at(-1)
  if (!name) return null
  const file = path.join(paths.state, name)
  const receipt = await readJson(file).catch(() => null)
  if (!receipt) return { name, file, corrupt: true }
  return receipt.pending || receipt.retiring || receipt.finalizing || receipt.undoing ? { name, file, receipt } : null
}

async function park(plan, before = async () => {}) {
  for (const item of plan) {
    await before(item)
    const hashes = new Map(item.hashes ?? [])
    const trees = new Map(item.trees ?? [])
    const semantics = new Map(item.semantics ?? [])
    for (const [original, parked] of item.moved) {
      const [hasOriginal, hasParked] = await Promise.all([exists(original), exists(parked)])
      if (hasOriginal && hasParked) throw new Error(`retirement path occupied: ${path.basename(parked)}`)
      if (hasParked) continue
      if (!hasOriginal) {
        const optionalLegacyDir = !item.required && UUID.test(path.basename(original)) && !path.extname(original)
        if (!optionalLegacyDir) throw new Error(`retirement artifact missing: ${path.basename(original)}`)
        continue
      }
      if (hashes.has(original) && sha(await readFile(original)) !== hashes.get(original)) throw new Error(`retirement artifact changed: ${path.basename(original)}`)
      if (trees.has(original) && (await manifest(original)).sha !== trees.get(original)) throw new Error(`retirement artifact changed: ${path.basename(original)}`)
      if (semantics.has(original) && recordSemantic(await readJson(original)) !== semantics.get(original)) throw new Error(`retirement artifact changed: ${path.basename(original)}`)
      await mkdir(path.dirname(parked), { recursive: true })
      await rename(original, parked)
    }
  }
}

async function restore(plan, root) {
  for (const p of [...plan].reverse()) {
    for (const [original, parked] of [...p.moved].reverse()) {
      if ((await exists(parked)) && !(await exists(original))) await rename(parked, original)
    }
  }
  for (const p of plan) {
    for (const [, parked] of p.moved) {
      let dir = path.dirname(parked)
      while (dir !== root && !path.relative(root, dir).startsWith('..') && (await rmdir(dir).then(() => true, () => false))) dir = path.dirname(dir)
    }
  }
}

async function prepareUndo(receipt, paths) {
  const dest = path.join(paths.state, 'quarantine', receipt.at)
  const plan = []
  for (const row of receipt.sessions) {
    const files = row.strategy === 'rehome' ? [] : [row.targetTranscript].filter(Boolean)
    const trees = row.strategy === 'rehome' ? [] : [row.targetDir].filter(Boolean)
    const items = artifacts(row)
    plan.push(await snapshotPlan({
      id: row.targetId,
      title: row.title,
      required: items,
      hashes: files.map((file) => [file, null]),
      trees: trees.map((file) => [file, null]),
      semantics: [[row.record, null]],
      moved: items.map((file) => [file, path.join(dest, path.basename(file))])
    }))
  }
  return plan
}

async function finishUndo(receipt, file, paths) {
  const root = path.join(paths.state, 'quarantine')
  const dest = path.join(root, receipt.at)
  const problems = [
    ...await restoreProblems(receipt.superseded ?? [], root),
    ...await restoreProblems(receipt.undoing ?? [], root)
  ]
  if (await exists(path.join(dest, 'receipt.json'))) problems.push('undo receipt path occupied')
  const liveWorkers = workers()
  for (const row of receipt.sessions) {
    if (liveWorkers.has(row.targetId.toLowerCase())) problems.push(`${row.title} | running worker kept in destination`)
    if (row.taskFile && (await taskSessions(row.taskFile)).has(row.targetRecordId ?? `local_${row.targetId}`) !== row.taskOwned) problems.push(`${row.title} | scheduled tasks changed`)
  }
  if (problems.length) return { receipt, restoreProblems: problems }
  await restore(receipt.superseded ?? [], root)
  await park(receipt.undoing ?? [])
  await mkdir(dest, { recursive: true })
  await rename(file, path.join(dest, 'receipt.json'))
  return { receipt, dest }
}

async function rollbackTarget(row, dest, liveWorkers = workers()) {
  const locateArtifact = async (original) => {
    const parked = path.join(dest, path.basename(original))
    const [hasOriginal, hasParked] = await Promise.all([exists(original), exists(parked)])
    if (hasOriginal === hasParked) return { error: `${path.basename(original)} ${hasOriginal ? 'exists in both locations' : 'is missing'}` }
    return { original, parked, file: hasOriginal ? original : parked, move: hasOriginal }
  }
  const transcript = await locateArtifact(row.targetTranscript)
  const record = await locateArtifact(row.record)
  const sidecars = row.targetDir ? await locateArtifact(row.targetDir) : null
  if (row.strategy === 'rehome') {
    const changes = [
      transcript.error,
      !transcript.error && !transcript.move ? 'transcript missing' : null,
      sidecars?.error,
      sidecars && !sidecars.error && !sidecars.move ? 'sidecars missing' : null,
      record.error
    ].filter(Boolean)
    if (!record.error) {
      const raw = await readFile(record.file).catch(() => null)
      let sameRecord = Boolean(raw)
      try { if (raw) sameRecord = row.recordSemantic ? recordSemantic(JSON.parse(raw)) === row.recordSemantic : sha(raw) === row.recordSha } catch { sameRecord = false }
      if (!sameRecord) changes.push('desktop record changed')
    }
    if (row.taskFile && (await taskSessions(row.taskFile)).has(row.targetRecordId ?? `local_${row.targetId}`) !== row.taskOwned) changes.push('scheduled tasks changed')
    if (liveWorkers.has(row.targetId.toLowerCase())) changes.push('running worker')
    if (!changes.length && record.move) {
      await mkdir(dest, { recursive: true })
      await rename(record.original, record.parked)
    }
    return changes
  }
  const changes = [transcript.error, record.error, sidecars?.error].filter(Boolean)
  if (!sidecars?.error && (await manifest(sidecars?.file ?? path.join(path.dirname(row.targetTranscript), row.targetId))).sha !== row.sidecars.sha) changes.push('sidecars changed')
  if (!record.error) {
    const raw = await readFile(record.file).catch(() => null)
    let sameRecord = Boolean(raw)
    try { if (raw) sameRecord = row.recordSemantic ? recordSemantic(JSON.parse(raw)) === row.recordSemantic : sha(raw) === row.recordSha } catch { sameRecord = false }
    if (!sameRecord) changes.push('desktop record changed')
  }
  if (row.taskFile && (await taskSessions(row.taskFile)).has(row.targetRecordId ?? `local_${row.targetId}`) !== row.taskOwned) changes.push('scheduled tasks changed')
  if (liveWorkers.has(row.targetId.toLowerCase())) changes.push('running worker')
  if (!transcript.error && await changed(transcript.file, row.targetId, knownOf(row))) changes.push('transcript changed')
  if (changes.length) {
    for (const artifact of [transcript, sidecars, record].filter(Boolean)) {
      if (artifact.error || artifact.move || await exists(artifact.original) || !(await exists(artifact.parked))) continue
      await mkdir(path.dirname(artifact.original), { recursive: true })
      await rename(artifact.parked, artifact.original)
    }
    return changes
  }
  for (const artifact of [transcript, sidecars, record].filter(Boolean)) {
    if (!artifact.move) continue
    await mkdir(dest, { recursive: true })
    await rename(artifact.original, artifact.parked)
  }
  return []
}

async function reconcile(paths) {
  const p = await pending(paths)
  if (!p) return null
  if (p.corrupt) {
    await rename(p.file, `${p.file}.corrupt`)
    return { title: p.name, error: 'corrupt receipt set aside' }
  }
  const { receipt } = p
  receipt.failed ??= []
  receipt.superseded ??= []
  if (receipt.undoing) {
    const result = await finishUndo(receipt, p.file, paths)
    if (result.restoreProblems) return { title: 'undo recovery blocked', error: result.restoreProblems.join(', '), problems: result.restoreProblems }
    return { title: `${receipt.sessions.length} sessions`, error: 'interrupted undo completed', undo: result }
  }
  if (receipt.retiring) {
    const plan = receipt.retiring
    const root = path.join(paths.state, 'quarantine')
    const blocked = await restoreProblems(plan, root, true)
    if (blocked.length) return { title: 'retirement recovery blocked', error: blocked.join(', '), problems: blocked }
    await restore(plan, root)
    receipt.retiring = null
    receipt.finalizing = false
    await saveJson(p.file, receipt)
    return { title: `${plan.length} retirement entries`, error: 'interrupted retirement rolled back' }
  }
  const recovered = []
  if (receipt.pending) {
    const { id, title, targetId, made, strategy } = receipt.pending
    const used = strategy === 'rehome'
      ? await readFile(made[0]).then((raw) => Boolean(receipt.pending.recordSha && sha(raw) !== receipt.pending.recordSha), () => false)
      : await changed(made[0], targetId, knownOf(receipt.pending))
    if (!used) await quarantine(made, path.join(paths.state, 'quarantine', receipt.at, 'failed'))
    const error = used
      ? strategy === 'rehome'
        ? 'interrupted, target record changed since, left in place'
        : 'interrupted, legacy copy changed since, left in place'
      : 'interrupted'
    receipt.failed.push({ id, title, targetId, artifacts: made, retained: used, error })
    if (used) receipt.retained = [...(receipt.retained ?? []), { id, title, targetId, artifacts: made }]
    receipt.pending = null
    recovered.push({ title, error })
  }
  if (receipt.finalizing) {
    const root = path.join(paths.state, 'quarantine')
    const blocked = await restoreProblems(receipt.superseded, root)
    if (blocked.length) return { title: 'recovery blocked', error: blocked.join(', '), problems: blocked }
    await restore(receipt.superseded, root)
    const kept = []
    let rolledBack = 0
    const dest = path.join(paths.state, 'quarantine', receipt.at, 'failed')
    const liveWorkers = workers()
    for (const row of receipt.sessions ?? []) {
      const changes = await rollbackTarget(row, dest, liveWorkers)
      if (changes.length) {
        kept.push(row)
        receipt.failed.push({ id: row.id, title: row.title, error: `interrupted finalization, ${changes.join(', ')} changed since, left in place` })
      } else {
        receipt.failed.push({ id: row.id, title: row.title, error: 'interrupted finalization' })
        rolledBack++
      }
    }
    receipt.sessions = kept
    receipt.superseded = []
    receipt.finalizing = false
    receipt.verification = {
      ok: false,
      problems: kept.map((row) => ({ id: row.targetId, title: row.title, check: 'interrupted finalization' }))
    }
    recovered.push({
      title: `${rolledBack} unfinished copies`,
      error: kept.length ? `${kept.length} changed copies left in place` : 'interrupted finalization rolled back'
    })
  }
  await saveJson(p.file, receipt)
  return recovered.length === 1 ? recovered[0] : {
    title: recovered.map((item) => item.title).join(' + '),
    error: recovered.map((item) => item.error).join(', ')
  }
}

async function witnessed(row, liveWorkers, checkShared = true) {
  const expectedSidecars = row.sidecar ?? row.sidecars
  if (row.strategy === 'rehome' && row.transcriptFingerprint && expectedSidecars?.fingerprint) {
    const sidecarRoot = path.join(path.dirname(row.transcript), row.id)
    const [currentTranscript, currentSidecars] = await Promise.all([
      fingerprint(row.transcript).catch(() => null),
      treeFingerprint(sidecarRoot).catch(() => null)
    ])
    const sameTask = !row.account?.taskFile || (await taskSessions(row.account.taskFile)).has((row.session?.record ?? row.record).sessionId) === row.taskOwned
    const shared = Boolean(currentTranscript) && (!expectedSidecars.count || await exists(sidecarRoot)) && (!checkShared || (currentTranscript === row.transcriptFingerprint && currentSidecars?.fingerprint === expectedSidecars.fingerprint))
    return shared && sameTask && !liveWorkers?.has(row.id.toLowerCase())
  }
  const now = await sidecars(row.transcript, row.id).catch(() => null)
  const sameTask = !row.account?.taskFile || (await taskSessions(row.account.taskFile)).has((row.session?.record ?? row.record).sessionId) === row.taskOwned
  if (!now || now.sha !== row.sidecar.sha || !sameTask || liveWorkers?.has(row.id.toLowerCase())) return false
  return await exists(row.transcript) && !(await changed(row.transcript, row.id, { semantic: row.snapshot, semanticVersion: SEMANTIC_VERSION, bridge: row.bridge }))
}

async function untouched(row, liveWorkers, checkShared = true) {
  const record = row.session?.file ?? row.file
  const raw = record ? await readFile(record).catch(() => null) : null
  let sameRecord = Boolean(raw)
  if (raw) {
    try { sameRecord = row.recordSemantic ? recordSemantic(JSON.parse(raw)) === row.recordSemantic : !row.recordSha || sha(raw) === row.recordSha } catch { sameRecord = false }
  }
  return sameRecord && await witnessed(row, liveWorkers, checkShared)
}

const carrying = (inv, landed, gone = new Set()) => [
  ...landed,
  ...inv.targets.filter((t) => t.transcript && !gone.has(t)).map((t) => ({ by: t.id, history: t }))
]
const owners = (sources, carried) => sources.map((s) => ({ s, owner: carried.find((c) => included(s, c.history)) })).filter((row) => row.owner)

async function retire(inv, receipt, paths, at, problems, save, report = () => {}) {
  report('retire', 'checking', { live: true })
  const bad = new Set(problems.map((p) => p.id))
  const dest = path.join(paths.state, 'quarantine', at)
  let plan = []
  const landed = []
  for (const row of receipt.sessions) {
    const history = bad.has(row.targetId) ? null : inv.move.find((m) => m.id === row.id)
    if (history) landed.push({ by: row.targetId, history })
  }
  const gone = new Set()
  const blocked = new Set()
  const sourceRows = new Map()
  const targetRows = new Map()
  let liveWorkers = workers()
  const settled = new Map()
  const targetStable = async (target) => {
    if (!settled.has(target)) settled.set(target, await untouched(target, liveWorkers))
    return settled.get(target)
  }
  for (const { by, history } of landed) {
    for (const t of inv.targets) {
      if (gone.has(t) || !t.transcript || !included(t, history)) continue
      const claim = ownership(t, liveWorkers)
      if (claim) {
        if (!blocked.has(t.session.file)) receipt.failed.push({ id: t.id, title: t.session.title, error: `${claim} kept in destination` })
        blocked.add(t.session.file)
        continue
      }
      if (!(await targetStable(t))) continue
      gone.add(t)
      const items = [t.session.file]
      plan.push({
        id: t.id,
        title: t.session.title,
        by,
        required: items,
        hashes: [[t.session.file, null]],
        trees: [],
        moved: items.map((p) => [p, path.join(dest, 'superseded', path.basename(p))])
      })
      targetRows.set(t.session.file, t)
    }
  }
  const stableTargets = []
  for (const target of inv.targets) if (!gone.has(target) && target.transcript && await targetStable(target)) stableTargets.push(target)
  const carried = [...landed, ...stableTargets.map((history) => ({ by: history.id, history }))]
  const ready = new Map(owners(inv.sources, carried).map((row) => [row.s, row.owner]))
  const expected = new Set(owners(inv.sources, carrying(inv, landed, gone)).map((row) => row.s))
  let checkedSources = 0
  progress(report, 'retire', checkedSources, inv.sources.length)
  for (const s of inv.sources) {
    try {
      const owner = ready.get(s)
      if (!owner) {
        if (expected.has(s)) receipt.failed.push({ id: s.id, title: s.title, error: 'destination changed since inventory, source kept' })
        continue
      }
      const claim = owner.history.strategy === 'rehome' ? rehomeOwnership(s, liveWorkers) : ownership(s, liveWorkers)
      if (claim) {
        receipt.failed.push({ id: s.id, title: s.title, error: `${claim} kept in source` })
        continue
      }
      plan.push({ id: s.id, title: s.title, by: owner.by, source: true, required: [s.file], hashes: [[s.file, null]], moved: [[s.file, path.join(dest, 'sources', path.relative(paths.records, s.file))]] })
      sourceRows.set(s.file, s)
    } finally {
      progress(report, 'retire', ++checkedSources, inv.sources.length)
    }
  }
  report('finalize', 'preparing', { live: true })
  const carriers = new Map(receipt.sessions.map((row) => [row.targetId, row]))
  for (const target of stableTargets) if (!carriers.has(target.id)) carriers.set(target.id, target)
  liveWorkers = workers()
  settled.clear()
  const invalid = new Set()
  const carrierChecks = new Map()
  for (const item of plan) {
    if (invalid.has(item.by)) continue
    const carrier = carriers.get(item.by)
    if (!carrierChecks.has(item.by)) carrierChecks.set(item.by, carrier?.targetId ? !(await targetChanges(carrier, liveWorkers, carrier.strategy !== 'rehome')).length : carrier ? await targetStable(carrier) : false)
    const valid = carrierChecks.get(item.by)
    if (!valid) invalid.add(item.by)
  }
  if (invalid.size) {
    for (const id of invalid) receipt.failed.push({ id, title: 'destination', error: 'destination changed before retirement, source kept' })
    plan = plan.filter((item) => !invalid.has(item.by))
  }
  const readyPlan = []
  for (const item of plan) {
    const row = item.source ? sourceRows.get(item.moved[0][0]) : targetRows.get(item.moved.at(-1)[0])
    const unchanged = row && await untouched(row, liveWorkers, row.strategy !== 'rehome')
    if (!row || !unchanged) {
      receipt.failed.push({ id: item.id, title: item.title, error: `${item.source ? 'source' : 'destination'} changed before retirement, kept` })
    } else readyPlan.push(await snapshotPlan(item))
  }
  plan = readyPlan
  if (!plan.length) return
  receipt.retiring = plan
  await save()
  try {
    const parkWorkers = workers()
    await park(plan, async (item) => {
      const carrier = carriers.get(item.by)
      const carrierSafe = carrier?.targetId ? !(await targetChanges(carrier, parkWorkers, carrier.strategy !== 'rehome')).length : carrier ? await untouched(carrier, parkWorkers, carrier.strategy !== 'rehome') : false
      if (!carrierSafe) throw new Error(`destination changed during retirement: ${item.by}`)
      const carrierId = carrier?.targetId ?? carrier?.id
      if (carrierId && parkWorkers.has(carrierId.toLowerCase())) throw new Error(`running worker changed during retirement: ${item.id}`)
      const row = item.source ? sourceRows.get(item.moved[0][0]) : targetRows.get(item.moved.at(-1)[0])
      if (!row || !(await untouched(row, parkWorkers, row.strategy !== 'rehome'))) throw new Error(`${item.source ? 'source' : 'destination'} changed during retirement: ${item.id}`)
    })
    const postWorkers = workers()
    for (const id of new Set(plan.map((item) => item.by))) {
      const carrier = carriers.get(id)
      const carrierSafe = carrier?.targetId ? !(await targetChanges(carrier, postWorkers, carrier.strategy !== 'rehome')).length : carrier ? await untouched(carrier, postWorkers, carrier.strategy !== 'rehome') : false
      if (!carrierSafe) throw new Error(`destination changed after retirement: ${id}`)
    }
    for (const item of plan.filter((entry) => entry.source)) {
      const row = sourceRows.get(item.moved[0][0])
      if (!row || !(await witnessed(row, postWorkers, row.strategy !== 'rehome'))) throw new Error(`source changed after retirement: ${item.id}`)
    }
  } catch (error) {
    const root = path.dirname(dest)
    const blocked = await restoreProblems(plan, root, true)
    if (blocked.length) throw new Error(`${error.message}; retirement rollback blocked: ${blocked.join(', ')}`)
    await restore(plan, root)
    receipt.retiring = null
    receipt.failed.push({ id: null, title: 'retirement', error: error.message })
    await save()
    return
  }
  receipt.superseded = [...receipt.superseded, ...plan]
  receipt.retiring = null
  await save()
}

async function transfer(inv, to, paths, report) {
  const started = Date.now()
  const at = stamp()
  const initialFailures = inventoryFailures(inv)
  const receipt = { at, from: inv.from, to: to.label, sessions: [], failed: initialFailures, superseded: [], finalizing: true }
  const file = path.join(paths.state, `${at}.json`)
  const save = () => saveJson(file, receipt)
  let events = 0
  const rehomeGuard = { workers: workers(), taskSessions: new Map() }
  for (const file of new Set([...inv.move.map((row) => row.account.taskFile), to.taskFile])) {
    rehomeGuard.taskSessions.set(file, await taskSessions(file))
  }
  const landedRecordIds = new Set(to.sessions.map((session) => session.record.sessionId).filter(Boolean))
  progress(report, 'move', 0, inv.move.length)
  for (const [i, s] of inv.move.entries()) {
    const targetId = s.id
    const made = [path.join(to.dir, path.basename(s.file))]
    receipt.pending = { strategy: 'rehome', id: s.id, title: s.title, targetId, made, recordSha: null }
    await save()
    try {
      if (s.record.forkedFromSessionId && !landedRecordIds.has(s.record.forkedFromSessionId)) throw new Error('parent Desktop record did not move')
      const row = await rehomeOne(s, to, async (journal) => { Object.assign(receipt.pending, journal); await save() }, rehomeGuard)
      receipt.sessions.push(row)
      if (row.targetRecordId) landedRecordIds.add(row.targetRecordId)
      events += row.events
    } catch (error) {
      await quarantine(made, path.join(paths.state, 'quarantine', at, 'failed'))
      receipt.failed.push({ id: s.id, title: s.title, error: error.message })
    }
    receipt.pending = null
    await save()
    progress(report, 'move', i + 1, inv.move.length)
  }
  const done = receipt.sessions.length
  if (inv.move.length) {
    await save()
    report('move', [
      `${count(done)} ✓`,
      `${count(events)} events`,
      done ? `${count(done)} zero-copy` : null,
      receipt.failed.length ? `${receipt.failed.length} failed` : null
    ].filter(Boolean).join(' | '))
    report('sidecars', `${count(receipt.sessions.reduce((n, r) => n + r.sidecars.count, 0))} files | unchanged ✓`)
  }
  const { ok, lines, problems } = await verify(receipt.sessions, report)
  receipt.verification = { ok, problems }
  await save()
  await retire(inv, receipt, paths, at, problems, save, report)
  receipt.finalizing = false
  const retired = retiredCount(receipt)
  const superseded = receipt.superseded.length - retired
  if (!done && !receipt.superseded.length) {
    await rm(file, { force: true })
    return receipt.failed.length ? { file: null, receipt, checks: [], problems, ok: false, validationOnly: true } : null
  }
  await save()
  if (inv.move.length) {
    const archived = receipt.sessions.filter((r) => r.archived).length
    report('desktop', [
      `${count(done)} records`,
      `${count(archived)} archived`,
      `${count(done - archived)} active`,
      superseded ? `${count(superseded)} superseded` : null
    ].filter(Boolean).join(' | '))
    report('verify', [...lines, `${Math.round((Date.now() - started) / 1000)}s`].join(' | '))
  }
  if (retired) report('retired', `${count(retired)} source records → quarantine | transcripts untouched`)
  return { file, receipt, checks: lines, problems, ok: ok && receipt.failed.length === 0 }
}

export const move = (inv, to, paths, report = () => {}) => locked(paths, async () => {
  const reconciled = await reconcile(paths)
  return reconciled ? { reconciled, recoveryRequired: true, ok: false } : transfer(inv, to, paths, report)
})

export function undo(paths) {
  return locked(paths, async () => {
    const reconciled = await reconcile(paths)
    if (reconciled?.undo) return reconciled.undo
    if (reconciled) return { reconciled }
    const name = (await receipts(paths)).at(-1)
    if (!name) return { nothing: true }
    const file = path.join(paths.state, name)
    const receipt = await readJson(file)
    if (receipt.retained?.length) return { receipt, retained: receipt.retained }
    const kept = []
    const liveWorkers = workers()
    for (const r of receipt.sessions) {
      const changes = await targetChanges(r, liveWorkers, r.strategy !== 'rehome')
      if (changes.length) kept.push(`${r.title} | ${short(r.targetId)} | ${changes.join(', ')} changed`)
    }
    if (kept.length) return { receipt, changed: kept }
    const root = path.join(paths.state, 'quarantine')
    const blocked = await restoreProblems(receipt.superseded ?? [], root)
    if (blocked.length) return { receipt, restoreProblems: blocked }
    const plan = await prepareUndo(receipt, paths)
    const changedAfterSnapshot = []
    const finalWorkers = workers()
    for (const r of receipt.sessions) {
      const changes = await targetChanges(r, finalWorkers, r.strategy !== 'rehome')
      if (changes.length) changedAfterSnapshot.push(`${r.title} | ${short(r.targetId)} | ${changes.join(', ')} changed`)
    }
    if (changedAfterSnapshot.length) return { receipt, changed: changedAfterSnapshot }
    receipt.undoing = plan
    await saveJson(file, receipt)
    return finishUndo(receipt, file, paths)
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

function fresh(all, selected) {
  const account = all.find((candidate) => candidate.account === selected.account && candidate.org === selected.org)
  if (!account) throw new Error(`${selected.label} is no longer available`)
  return account
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
  const lines = () => [
    `${title}  ${hint}`,
    ...rows.map((r, i) => {
      const cursor = i === state.cursor ? '❯' : ' '
      const choice = multi ? (state.chosen.has(i) ? '◉' : '○') : i === state.cursor ? '●' : '○'
      return `  ${cursor} ${choice} ${r.label.padEnd(width)}  ${r.stats}`
    })
  ]
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
  let lastLive = 0
  return (stage, text, extra = {}) => {
    const now = Date.now()
    const edge = extra.completed === 0 || extra.completed === extra.total
    if (extra.live && !edge && now - lastLive < 100) return
    if (extra.live) lastLive = now
    const fields = {
      stage,
      text,
      ...(extra.live ? { live: true } : {}),
      ...(Number.isInteger(extra.completed) ? { completed: extra.completed } : {}),
      ...(Number.isInteger(extra.total) ? { total: extra.total } : {})
    }
    if (json) return process.stdout.write(`${JSON.stringify(fields)}\n`)
    if (extra.live && !process.stdout.isTTY) return
    process.stdout.write(`${process.stdout.isTTY ? '\r\x1b[K' : ''}  ${stage.padEnd(11)} ${text}${extra.live ? '' : '\n'}`)
  }
}

const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
const plist = (dict) => {
  const entry = ([key, value]) => {
    const body = value === true
      ? '<true/>'
      : Array.isArray(value)
        ? `<array>${value.map((s) => `<string>${xml(s)}</string>`).join('')}</array>`
        : `<string>${xml(value)}</string>`
    return `<key>${xml(key)}</key>${body}`
  }
  const body = Object.entries(dict).map(entry).join('')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<plist version="1.0"><dict>${body}</dict></plist>`,
    ''
  ].join('\n')
}

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
    const info = {
      CFBundleIdentifier: LABEL,
      CFBundleName: 'Claude Transplant',
      CFBundleExecutable: 'Claude Transplant',
      CFBundlePackageType: 'APPL',
      CFBundleShortVersionString: version,
      LSMinimumSystemVersion: '13.0',
      LSUIElement: true,
      NSHighResolutionCapable: true
    }
    await writeFile(path.join(fresh, 'Contents/Info.plist'), plist(info))
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
  if ((args.help || args.version) && argv.length > 1) throw new Error(`${args.help ? '--help' : '--version'} goes alone`)
  if (args.cmd === 'accounts' && (args.from.length || args.to || args.dry || args.remove)) throw new Error('accounts accepts only --json')
  if (args.cmd === 'undo' && (args.from.length || args.to || args.dry || args.remove)) throw new Error('undo accepts only --json')
  if (args.cmd === 'menubar' && (args.from.length || args.to || args.dry || args.json)) throw new Error('menubar accepts only --remove')
  if (args.cmd !== 'menubar' && args.remove) throw new Error('--remove requires menubar')
  return args
}

async function main(argv) {
  const args = parse(argv)
  if (args.help) return process.stdout.write(HELP)
  if (args.version) return process.stdout.write(`${(await readJson(path.join(HERE, 'package.json'))).version}\n`)
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node 22 or newer is required')
  const paths = layout()
  const out = process.stdout
  const emit = (o) => out.write(`${JSON.stringify(o)}\n`)
  if (args.cmd === 'menubar') return out.write(`${await locked(paths, () => menubar(paths, args.remove))}\n`)
  if (args.cmd === 'undo') {
    const result = await undo(paths)
    if (result.changed || result.retained || result.restoreProblems || result.reconciled) process.exitCode = 1
    if (args.json) {
      if (result.nothing) return emit({ nothing: true })
      if (result.reconciled) return emit({ reconciled: result.reconciled, retry: true })
      if (result.retained) return emit({ refused: result.retained.map((r) => `${r.title || r.id} | ${short(r.targetId)}`), retained: true, at: result.receipt.at })
      if (result.changed) return emit({ refused: result.changed, at: result.receipt.at })
      if (result.restoreProblems) return emit({ refused: result.restoreProblems, reason: 'Undo refused, recovery artifacts are missing or blocked', at: result.receipt.at })
      return emit({
        undone: result.receipt.at,
        quarantine: result.dest,
        sessions: result.receipt.sessions.length,
        restored: retiredCount(result.receipt),
        note: NOTE,
        restart: true
      })
    }
    if (result.nothing) return out.write('nothing to undo\n')
    if (result.reconciled) return out.write(`reconciled  ${result.reconciled.title} | ${result.reconciled.error}\n  undo        not run, run it again if still wanted\n`)
    const { receipt } = result
    out.write(`Undo  ${receipt.at} | ${receipt.from.join(' + ')} → ${receipt.to}\n`)
    if (result.retained) {
      const rows = result.retained.map((r) => `    ${r.title || r.id} | ${short(r.targetId)}`).join('\n')
      return out.write(`  refused | ${result.retained.length} interrupted copies changed and remain in place\n${rows}\n`)
    }
    if (result.changed) {
      return out.write(`  refused | ${result.changed.length} sessions changed since the move | nothing changed\n${result.changed.map((t) => `    ${t}`).join('\n')}\n`)
    }
    if (result.restoreProblems) {
      return out.write(`  refused | source recovery is incomplete | nothing changed\n${result.restoreProblems.map((t) => `    ${t}`).join('\n')}\n`)
    }
    const legacy = receipt.sessions.filter((row) => row.strategy !== 'rehome')
    const files = legacy.reduce((n, row) => n + row.sidecars.count, 0)
    const back = retiredCount(receipt)
    return out.write([
      receipt.sessions.length - legacy.length ? `  ${count(receipt.sessions.length - legacy.length)} desktop records → quarantine` : null,
      legacy.length ? `  ${count(legacy.length)} legacy transcripts | ${count(files)} sidecar files | ${count(legacy.length)} desktop records → quarantine` : null,
      back ? `  ${count(back)} source records put back` : null,
      '  shared transcripts unchanged ✓',
      `  quarantine  ${result.dest}`,
      `  then        ${NOTE}`,
      ''
    ].filter((line) => line !== null).join('\n'))
  }
  const all = await accounts(paths)
  if (args.cmd === 'accounts') {
    if (args.json) {
      return emit(all.map(({ account, org, email, orgName, label, stats, active, sessions, unreadable, activeAt }) => ({
        account, org, email, orgName, label, stats, active, sessions: sessions.length, unreadable: unreadable.length, activeAt
      })))
    }
    if (!all.length) return out.write('no accounts found\n')
    const width = Math.max(...all.map((a) => a.label.length))
    return out.write(`${all.map((a) => `  ${a.label.padEnd(width)}  ${a.stats}`).join('\n')}\n`)
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
  const summary = (inv) => {
    const tally = (items, target) => items.filter((item) => Boolean(item.target) === target).length
    const sourceUnreadable = tally(inv.unreadable, false)
    const targetUnreadable = tally(inv.unreadable, true)
    const sourceRejected = tally(inv.rejected, false)
    const targetRejected = tally(inv.rejected, true)
    report('inventory', [
      `${count(inv.total)} records`,
      inv.missing.length ? `${count(inv.missing.length)} without history` : null,
      sourceUnreadable ? `${count(sourceUnreadable)} source unreadable` : null,
      targetUnreadable ? `${count(targetUnreadable)} target unreadable` : null,
      sourceRejected ? `${count(sourceRejected)} source rejected` : null,
      targetRejected ? `${count(targetRejected)} target rejected` : null,
      inv.twice ? `${count(inv.twice)} compatible source versions` : null,
      inv.apart ? `${count(inv.apart)} grew apart, all kept` : null,
      inv.there.length ? `${count(inv.there.length)} already there` : null,
      inv.blocked.length ? `${count(inv.blocked.length)} blocked` : null,
      `${count(inv.move.length)} to move`
    ].filter(Boolean).join(' | '))
  }
  if (args.dry) {
    const p = await pending(paths)
    if (p) {
      let text = `${p.receipt?.sessions?.length ?? 0} sessions | interrupted finalization, reconciled on the next move`
      if (p.corrupt) text = `${p.name} | corrupt receipt, set aside on the next move`
      else if (p.receipt.pending) text = `${p.receipt.pending.title} | interrupted ${p.receipt.pending.strategy === 'rehome' ? 'record placement' : 'legacy copy'}, reconciled on the next move`
      else if (p.receipt.retiring) text = `${p.receipt.retiring.length} entries | interrupted retirement, reconciled on the next move`
      else if (p.receipt.undoing) text = `${p.receipt.undoing.length} sessions | interrupted undo, reconciled on the next move`
      report('pending', text)
      process.exitCode = 1
      return args.json ? emit({ done: true, ok: false, dry: true, recoveryRequired: true, planned: null }) : out.write('  dry run     plan unavailable until the next move reconciles this state\n')
    }
    const inv = await inventory(from, to, paths, report)
    summary(inv)
    const retiring = owners(inv.sources, carrying(inv, inv.move.map((history) => ({ history })))).filter(({ s, owner }) => !(owner.history.strategy === 'rehome' ? rehomeOwnership(s) : ownership(s))).length
    if (retiring) report('retire', `${count(retiring)} source records once the target records verify`)
    const failures = inventoryFailures(inv)
    if (failures.length) process.exitCode = 1
    return args.json
      ? emit({ done: true, ok: !failures.length, dry: true, moved: 0, planned: inv.move.length, retiring, failed: failures })
      : out.write(inv.move.length || retiring ? '  dry run     nothing written\n' : failures.length ? '  dry run     blocked records must be resolved\n' : '  nothing to move\n')
  }
  const result = await locked(paths, async () => {
    const reconciled = await reconcile(paths)
    if (reconciled) return { reconciled, recoveryRequired: true, ok: false }
    const latest = await accounts(paths)
    const currentFrom = from.map((account) => fresh(latest, account))
    const currentTo = fresh(latest, to)
    const inv = await inventory(currentFrom, currentTo, paths, report, { writeCache: true })
    summary(inv)
    return inv.move.length || inv.there.length || inventoryFailures(inv).length ? transfer(inv, currentTo, paths, report) : null
  })
  if (result?.recoveryRequired) {
    process.exitCode = 1
    report('reconciled', `${result.reconciled.title} | ${result.reconciled.error}`)
    return args.json
      ? emit({ done: true, ok: false, recoveryRequired: true, reconciled: result.reconciled })
      : out.write('  move        not run, run it again after reviewing the recovery\n')
  }
  if (!result) return args.json ? emit({ done: true, ok: true, moved: 0 }) : out.write('  nothing to move\n')
  const { file, receipt, checks, problems, ok } = result
  if (!ok) process.exitCode = 1
  const retired = retiredCount(receipt)
  const note = receipt.sessions.length || receipt.superseded.length ? NOTE : null
  if (args.json) {
    return emit({ done: true, ok, receipt: file, moved: receipt.sessions.length, superseded: receipt.superseded.length - retired, retired, failed: receipt.failed, problems, checks, note, restart: Boolean(note) })
  }
  const troubles = [
    ...receipt.failed.map((f) => `${f.title || f.id} | ${f.error}`),
    ...problems.map((p) => `${p.title ? `${p.title} | ` : ''}${short(p.id)} | ${p.check} check failed`)
  ]
  if (troubles.length) out.write(`  failed      ${troubles.join('\n              ')}\n`)
  if (!file) return
  out.write(`\n  receipt     ${file}\n  undo        npx claude-transplant undo\n${note ? `  then        ${note}\n` : ''}`)
}

const invoked = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()

if (invoked) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`claude-transplant: ${error.message}\n`)
    process.exitCode = error.code === 130 ? 130 : 1
  })
}
