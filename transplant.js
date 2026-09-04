#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { createDecipheriv, createHash, pbkdf2Sync, randomUUID } from 'node:crypto'
import { createReadStream, realpathSync } from 'node:fs'
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
const CACHE_VERSION = 6
const ACTIVE_WINDOW = 10 * 60 * 1000
const RUNTIME_KEYS = ['slug', 'promptId', 'parentUuid', 'version', 'cwd', 'gitBranch']
const MESSAGE_RUNTIME_KEYS = ['id', 'usage', 'diagnostics', 'stop_reason', 'stop_sequence', 'stop_details']
const REMOTE_TAGS = new Set(['remote-control-sdk', 'remote-control-repl'])
const HELP = `claude-transplant   move Claude Code history between accounts

  claude-transplant             pick from → to, move, retire the source entries, print receipt
  claude-transplant --dry-run   plan only, write nothing, refuses while a move or recovery is pending
  claude-transplant undo        quarantine the last move, put the source entries back
  claude-transplant finish      finish pending cloud work for the active source
  claude-transplant keep-local  cancel pending cloud checks, keep completed local work
  claude-transplant accounts    list accounts
  claude-transplant menubar     install the menubar app, starts at login, --remove uninstalls

  --from <match> --to <match>   skip the picker, match on email, org name, or uuid prefix
  --cloud                       reconcile the active source and queue the others
  --json                        machine-readable output
  --version
`

const sha = (data) => createHash('sha256').update(data).digest('hex')
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v
const stable = (v) => JSON.stringify(sortKeys(v))
const jsonText = (value, spacing = 2) => `${JSON.stringify(value, null, spacing || undefined)}\n`
const short = (id) => id.slice(0, 8)
const count = (v) => v.toLocaleString('en-US')
const quantity = (value, singular, plural = `${singular}s`) => `${count(value)} ${value === 1 ? singular : plural}`
const exists = (p) => stat(p).then(() => true, () => false)
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'))
const stamp = () => new Date().toISOString().slice(0, 23).replace(/[:.]/g, '-')
const accountRef = ({ account, org, label }) => ({ account, org, label })
const sameAccount = (a, b) => Boolean(a && b && a.account === b.account && a.org === b.org)
const accountLabel = (row) => row.accountLabel ?? row.label ?? `${short(row.account)} · ${short(row.org)}`
const openCloudChecks = (receipt) => (receipt.cloudChecks ?? []).filter((check) => !['complete', 'cancelled'].includes(check.status))
const cloudCheckLabels = (receipt) => [...new Set(openCloudChecks(receipt).map((check) => check.label))]
const cancelCloudChecks = (receipt) => {
  for (const check of openCloudChecks(receipt)) {
    check.status = 'cancelled'
    check.cancelledAt = new Date().toISOString()
  }
}
const milliseconds = (value) => {
  const raw = typeof value === 'number' ? value : Date.parse(value ?? '')
  return Number.isFinite(raw) ? (raw < 1e12 ? raw * 1000 : raw) : -1
}
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
    cookies: path.join(support, 'Claude/Cookies'),
    claudeApp: '/Applications/Claude.app',
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

const emptyCache = () => ({ version: CACHE_VERSION, semanticVersion: SEMANTIC_VERSION, histories: {}, manifests: {}, remote: {} })

async function openAnalysisCache(paths, writable) {
  const file = path.join(paths.state, 'cache.json')
  const stored = await readJson(file).catch(() => null)
  const valid = stored?.version === CACHE_VERSION && stored?.semanticVersion === SEMANTIC_VERSION &&
    ['histories', 'manifests', 'remote'].every((key) => stored[key] && typeof stored[key] === 'object' && !Array.isArray(stored[key]))
  return {
    file,
    writable,
    data: valid ? stored : emptyCache(),
    used: { histories: new Set(), manifests: new Set(), remote: new Set() },
    fingerprints: new Map(),
    stats: { historyHits: 0, historyMisses: 0, manifestHits: 0, manifestMisses: 0, remoteHits: 0, remoteMisses: 0 }
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
  manifests: ['manifestHits', 'manifestMisses'],
  remote: ['remoteHits', 'remoteMisses']
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
    manifests: kept('manifests'),
    remote: kept('remote')
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
  const pairs = new Map()
  const take = async (file) => {
    const a = (await readJson(file).catch(() => ({}))).oauthAccount
    if (a?.accountUuid && a.emailAddress) emails.set(a.accountUuid, a.emailAddress)
    if (a?.organizationUuid && a.organizationName) orgs.set(a.organizationUuid, a.organizationType && !/team|enterprise/.test(a.organizationType) ? 'Personal' : a.organizationName)
    if (UUID.test(a?.accountUuid ?? '') && UUID.test(a?.organizationUuid ?? '')) pairs.set(`${a.accountUuid}/${a.organizationUuid}`, { account: a.accountUuid, org: a.organizationUuid })
  }
  for (const e of await readdir(paths.home, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith('.claude')) await take(e.isDirectory() ? path.join(paths.home, e.name, '.claude.json') : path.join(paths.home, e.name))
  }
  for (const f of await readdir(paths.backups).catch(() => [])) if (f.startsWith('.claude.json.backup')) await take(path.join(paths.backups, f))
  await take(paths.login)
  for (const { account, org, files } of await records(paths.agentSessions)) {
    if (UUID.test(account) && UUID.test(org)) pairs.set(`${account}/${org}`, { account, org })
    for (const file of files) {
      if (emails.has(account)) break
      const r = await readJson(file).catch(() => ({}))
      if (r.emailAddress) emails.set(account, r.emailAddress)
    }
  }
  return { emails, orgs, pairs }
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
  const latest = samples.reduce((best, sample) => milliseconds(sample?.t) > best.time ? { org: sample.org, time: milliseconds(sample.t) } : best, { org: null, time: -1 })
  const breadcrumbs = (await readJson(paths.scope).catch(() => ({}))).scope?.breadcrumbs ?? []
  const seen = breadcrumbs.reduce((best, crumb) => {
    const url = crumb?.data?.url
    const match = typeof url === 'string' ? url.match(ORG_URL) : null
    const time = milliseconds(crumb?.timestamp)
    return match && Number.isFinite(time) && time > best.time ? { org: match[1], time } : best
  }, { org: null, time: -1 })
  return { account: desktop.lastKnownAccountUuid ?? null, org: recent(seen.time) ? seen.org : recent(latest.time) ? latest.org : null }
}

const plistValue = (file, key) => {
  const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, file], { encoding: 'utf8', timeout: 10_000 })
  if (result.error || result.status !== 0 || !result.stdout.trim()) throw new Error(`cannot read ${path.basename(file)}`)
  return result.stdout.trim()
}

async function binaryMatch(file, pattern) {
  let carry = ''
  for await (const chunk of createReadStream(file)) {
    const text = carry + chunk.toString('latin1')
    const match = text.match(pattern)
    if (match) return match[1]
    carry = text.slice(-128)
  }
  return null
}

async function desktopUserAgent(paths) {
  const appInfo = path.join(paths.claudeApp, 'Contents/Info.plist')
  const framework = path.join(paths.claudeApp, 'Contents/Frameworks/Electron Framework.framework/Versions/A')
  const claude = plistValue(appInfo, 'CFBundleShortVersionString')
  const electron = plistValue(path.join(framework, 'Resources/Info.plist'), 'CFBundleVersion')
  const chrome = await binaryMatch(path.join(framework, 'Electron Framework'), /Chrome\/(\d+\.\d+\.\d+\.\d+)/)
  if (!chrome) throw new Error('cannot determine Claude Desktop browser version')
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Claude/${claude} Chrome/${chrome} Electron/${electron} Safari/537.36`
}

function decryptCookie(host, encrypted, key, version) {
  if (!encrypted.length || !['v10', 'v11'].includes(encrypted.subarray(0, 3).toString())) throw new Error('unsupported Claude cookie encryption')
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  const plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()])
  if (version < 24) return plain.toString('utf8')
  const digest = createHash('sha256').update(host).digest()
  if (!plain.subarray(0, digest.length).equals(digest)) throw new Error('Claude cookie host verification failed')
  return plain.subarray(digest.length).toString('utf8')
}

function desktopCookies(paths) {
  const options = { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 10_000 }
  const versionResult = spawnSync('/usr/bin/sqlite3', ['-readonly', paths.cookies, "SELECT value FROM meta WHERE key='version';"], options)
  const rowsResult = spawnSync('/usr/bin/sqlite3', ['-readonly', '-separator', '\t', paths.cookies, "SELECT host_key,name,hex(CAST(value AS BLOB)),hex(encrypted_value) FROM cookies WHERE host_key IN ('.claude.ai','claude.ai') ORDER BY length(path) DESC,creation_utc;"], options)
  const secretResult = spawnSync('/usr/bin/security', ['find-generic-password', '-w', '-s', 'Claude Safe Storage'], options)
  if ([versionResult, rowsResult, secretResult].some((result) => result.error || result.status !== 0)) throw new Error('cannot read Claude Desktop login')
  const version = Number(versionResult.stdout.trim())
  const password = secretResult.stdout.trimEnd()
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  const values = new Map()
  for (const line of rowsResult.stdout.split('\n').filter(Boolean)) {
    const [host, name, plainHex, encryptedHex] = line.split('\t')
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name ?? '')) continue
    const value = plainHex ? Buffer.from(plainHex, 'hex').toString('utf8') : decryptCookie(host, Buffer.from(encryptedHex, 'hex'), key, version)
    if (value && !/[;\r\n]/.test(value)) values.set(name, value)
  }
  if (!values.has('sessionKey')) throw new Error('Claude Desktop login cookie is missing')
  return values
}

const wireRemoteId = (id) => {
  if (!/^(?:cse|session)_[A-Za-z0-9_-]+$/.test(id ?? '')) throw new Error('invalid Remote Control session id')
  return id.replace(/^cse_/, 'session_')
}

const remoteId = (id) => {
  try { return wireRemoteId(id) } catch { return null }
}

export async function cloudClient(paths, expected = null) {
  const cookies = desktopCookies(paths)
  const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  const userAgent = await desktopUserAgent(paths)
  const baseHeaders = {
    accept: 'application/json',
    cookie,
    origin: 'https://claude.ai',
    referer: 'https://claude.ai/',
    'user-agent': userAgent,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20'
  }
  const raw = async (endpoint, options = {}, org = null) => {
    const response = await fetch(`https://claude.ai${endpoint}`, {
      ...options,
      headers: { ...baseHeaders, ...(org ? { 'x-organization-uuid': org } : {}), ...(options.headers ?? {}) },
      redirect: 'error',
      signal: options.signal ?? AbortSignal.timeout(15_000)
    })
    if (!response.ok) throw new Error(`Claude ${endpoint.split('?')[0]} returned ${response.status}`)
    if (org && endpoint.startsWith('/v1/code/')) {
      const responseOrg = response.headers.get('anthropic-organization-id')
      if (responseOrg !== org) throw new Error('Claude Remote Control organization changed')
    }
    if (response.status === 204) return null
    const text = await response.text()
    return text ? JSON.parse(text) : null
  }
  const account = await raw('/api/account')
  if (!UUID.test(account?.uuid ?? '')) throw new Error('Claude Desktop account could not be verified')
  const organizations = await raw('/api/organizations')
  const preferredOrg = expected?.org ?? cookies.get('lastActiveOrg') ?? (await current(paths)).org
  const organization = Array.isArray(organizations) ? organizations.find((item) => item.uuid === preferredOrg) : null
  if (!organization) throw new Error('Claude Desktop organization could not be verified')
  if (expected && (account.uuid !== expected.account || organization.uuid !== expected.org)) throw new Error(`sign Claude Desktop into ${expected.label}`)
  const org = organization.uuid
  const request = (endpoint, options) => raw(endpoint, options, org)
  const session = async (id) => {
    const body = await request(`/v1/code/sessions/${wireRemoteId(id)}`)
    const value = body?.response_shape ?? body
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Remote Control session response changed')
    return value
  }
  const eventRows = async (id) => {
    const out = []
    let cursor = null
    let lastSequence = null
    const seen = new Set()
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ limit: '500', sort_order: 'asc' })
      if (cursor) query.set('cursor', cursor)
      const body = await request(`/v1/code/sessions/${wireRemoteId(id)}/events?${query}`)
      if (!Array.isArray(body?.data)) throw new Error('Remote Control history response changed')
      const data = body.data
      if (data.some((event) => !event || typeof event !== 'object' || typeof event.event_type !== 'string' || !event.payload || typeof event.payload !== 'object')) throw new Error('Remote Control event response changed')
      for (const event of data) {
        const sequence = typeof event.sequence_num === 'number' && Number.isSafeInteger(event.sequence_num) && event.sequence_num >= 0
          ? BigInt(event.sequence_num)
          : typeof event.sequence_num === 'string' && /^\d+$/.test(event.sequence_num) ? BigInt(event.sequence_num) : null
        if (sequence === null || (lastSequence !== null && sequence <= lastSequence)) throw new Error('Remote Control event sequence changed')
        lastSequence = sequence
      }
      out.push(...data)
      if (data.length < 500) return out
      cursor = body?.resume_cursor
      if (!cursor || seen.has(cursor)) throw new Error('Remote Control history cursor did not advance')
      seen.add(cursor)
    }
    throw new Error('Remote Control history exceeded 10,000 events')
  }
  return {
    account: account.uuid,
    org,
    list: async () => {
      const query = new URLSearchParams({ statuses: 'active', limit: '100' })
      query.append('statuses', 'paused')
      const body = await request(`/v1/code/sessions?${query}`)
      if (!Array.isArray(body?.data)) throw new Error('Remote Control session list response changed')
      if (body.data.length >= 100) throw new Error('Remote Control session list reached its safety limit')
      return body.data
    },
    eventRows,
    session,
    archive: (id) => request(`/v1/code/sessions/${wireRemoteId(id)}/archive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    unarchive: (id) => request(`/v1/code/sessions/${wireRemoteId(id)}/unarchive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  }
}

const desktopSession = (file, record) => ({
  file,
  id: UUID.test(record.cliSessionId ?? '') ? record.cliSessionId : null,
  cwd: record.cwd ?? '',
  title: record.title ?? '',
  archived: record.isArchived === true,
  createdAt: record.createdAt ?? 0,
  activeAt: record.lastActivityAt ?? 0,
  focusedAt: record.lastFocusedAt ?? 0,
  record
})

export async function accounts(paths) {
  const { emails, orgs, pairs } = await logins(paths)
  const cur = await current(paths)
  const out = []
  const stored = await records(paths.records)
  const known = [...pairs.values()].filter((pair) => !stored.some((row) => sameAccount(row, pair))).map(({ account, org }) => ({ account, org, dir: path.join(paths.records, account, org), files: [] }))
  for (const { account, org, dir, files } of [...stored, ...known]) {
    const sessions = []
    const unreadable = []
    for (const file of files) {
      const r = await readJson(file).catch(() => null)
      if (!r) { unreadable.push(file); continue }
      sessions.push(desktopSession(file, r))
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
  'lastSpawnRootDetected', 'promptAppendSnapshot', 'reportFindingsCard', 'scratchPromptRecents'
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

const messageHash = (type, value) => sha(stable({ type, message: without(value, MESSAGE_RUNTIME_KEYS) }))

const conversation = (entries) => entries.flatMap((entry) => {
  if (entry && ['user', 'assistant'].includes(entry.type) && entry.message) return [messageHash(entry.type, entry.message)]
  if (entry?.type === 'attachment' && typeof entry.attachment?.prompt === 'string') return [messageHash('user', { role: 'user', content: entry.attachment.prompt })]
  return []
})

const conversationFromRows = (rows) => conversation(rows.filter((row) => ['user', 'assistant'].includes(row.event_type)).map((row) => row.payload))

const orderedConversation = (source, target) => {
  if (!Array.isArray(source) || !Array.isArray(target) || !source.length) return false
  let at = 0
  for (const event of target) if (source[at] === event) at++
  return at === source.length
}

const multisetConversation = (source, target) => {
  const available = new Map()
  for (const event of target) available.set(event, (available.get(event) ?? 0) + 1)
  for (const event of source) {
    const count = available.get(event) ?? 0
    if (!count) return false
    available.set(event, count - 1)
  }
  return true
}

const conversationLcs = (source, target) => {
  let prior = new Uint16Array(target.length + 1)
  for (const event of source) {
    const next = new Uint16Array(target.length + 1)
    for (let at = 1; at <= target.length; at++) next[at] = event === target[at - 1] ? prior[at - 1] + 1 : Math.max(prior[at], next[at - 1])
    prior = next
  }
  return prior[target.length]
}

const conversationAnchored = (source, target, needed) => {
  if (source.length < needed || target.length < needed) return false
  outer: for (let start = target.indexOf(source[0]); start >= 0; start = target.indexOf(source[0], start + 1)) {
    for (let at = 1; at < needed; at++) if (source[at] !== target[start + at]) continue outer
    return true
  }
  return false
}

const conversationMatch = (source, target) => {
  if (!Array.isArray(source) || !Array.isArray(target) || !source.length) return null
  if (orderedConversation(source, target)) return 'ordered'
  const tolerance = Math.min(8, Math.floor(source.length / 100))
  if (!tolerance || !multisetConversation(source, target)) return null
  return source.length - conversationLcs(source, target) <= tolerance ? 'equivalent' : null
}

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
  const cacheKey = ctx.cache ? sha(stable({ version: CACHE_VERSION, semanticVersion: SEMANTIC_VERSION, id, transcript, cwd, cloud: ctx.cloud })) : null
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
  const bridges = data.entries.filter((entry) => entry.type === 'bridge-session')
  const bridgeIds = [...new Set(bridges.map((entry) => entry.bridgeSessionId ?? entry.bridge_session_id).filter((value) => typeof value === 'string'))]
  const result = { roots, events, conversation: ctx.cloud ? conversation(normalized.entries) : undefined, forks: ctx.scans.get(transcript)?.forked.size ?? 0, state, bridge: bridges.length > 0, bridgeIds, invalid: data.invalid, conflicts, comparable, snapshot: semantic(data.entries, id, data.invalid), contentSha: data.sha }
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
const desktopRecordOf = (row) => row.session?.record ?? row.record ?? {}
const desktopFileOf = (row) => row.session?.file ?? row.file
const bridgeIdsOf = (row) => [row, ...(row.members ?? [])].flatMap((member) => {
  const record = desktopRecordOf(member)
  return [...(member.bridgeIds ?? []), ...(record.bridgeSessionIds ?? [])]
})
const remoteIdsOf = (row) => [...new Set(bridgeIdsOf(row).map(remoteId).filter(Boolean))]
const validDesktopRecord = (row) => {
  const record = desktopRecordOf(row)
  const file = desktopFileOf(row)
  return LOCAL_RECORD.test(record.sessionId ?? '') && typeof file === 'string' && path.basename(file) === `${record.sessionId}.json`
}

async function cloudInventory(cloud, from, targets, move, cache, report, cutoff = null) {
  if (!cloud) return { checked: false, matches: [], blocked: [], later: [], client: null }
  const account = from.find((candidate) => sameAccount(candidate, cloud))
  if (!account) return { checked: false, matches: [], blocked: [], later: [], client: cloud }
  const candidate = (kind, row, title) => {
    const remoteIds = new Set(remoteIdsOf(row))
    return { kind, id: row.id, title, conversation: row.conversation, remoteIds, row }
  }
  const candidates = [
    ...targets.map((target) => candidate('existing', target, target.session.title)),
    ...move.map((source) => candidate('move', source, source.title))
  ]
  let listed
  try {
    listed = await cloud.list()
  } catch (error) {
    return {
      checked: true,
      matches: [],
      blocked: [{ id: null, title: 'Remote Control', account, error: `cloud check failed: ${error.message}` }],
      later: [],
      client: cloud,
      account: cloud.account,
      org: cloud.org,
      source: account
    }
  }
  const blocked = []
  const later = []
  const cutoffTime = cutoff ? milliseconds(cutoff) : null
  if (cutoff && cutoffTime < 0) throw new Error('pending move creation time is invalid')
  const sessions = listed.filter((session) =>
    session?.environment_kind === 'bridge' &&
    Array.isArray(session.tags) && session.tags.some((tag) => REMOTE_TAGS.has(tag)) &&
    REMOTE_OPEN.has(session.status)
  ).filter((session) => {
    if (cutoffTime === null) return true
    const createdAt = milliseconds(session.created_at)
    if (createdAt > cutoffTime) {
      later.push({ id: session.id ?? null, title: session.title ?? 'Remote Control', createdAt: session.created_at })
      return false
    }
    if (createdAt >= 0) return true
    blocked.push({ id: session.id ?? null, title: session.title ?? 'Remote Control', account, error: 'Remote Control creation time is missing, check refused to widen the original move' })
    return false
  })
  const matches = []
  let completed = 0
  if (sessions.length) progress(report, 'cloud scan', completed, sessions.length)
  const analyze = async (session) => {
    try {
      const sessionId = wireRemoteId(session.id)
      const named = candidates.filter((candidate) => candidate.title === session.title)
      const linked = candidates.filter((candidate) => candidate.remoteIds.has(sessionId))
      if (linked.length > 1) return { blocked: { id: session.id, title: session.title, account, error: 'multiple local targets carry the Remote Control id' } }
      const detail = await cloud.session(session.id)
      assertRemoteIdle(detail)
      const signature = sha(stable({ id: session.id, updatedAt: session.updated_at, lastEventAt: detail.last_event_at, status: detail.status }))
      let remoteConversation = cacheLookup(cache, 'remote', session.id, signature)?.conversation
      let rows = null
      if (!remoteConversation) {
        rows = (await stableRemoteRows(cloud, session.id)).rows
        remoteConversation = conversationFromRows(rows)
        cacheStore(cache, 'remote', session.id, signature, { conversation: remoteConversation })
      }
      const findCovered = (items) => items.flatMap((candidate) => {
        const matchMode = conversationMatch(remoteConversation, candidate.conversation)
        return matchMode ? [{ ...candidate, matchMode }] : []
      })
      const eligible = remoteConversation.length >= 4 ? candidates : [...new Set([...named, ...linked])]
      const covered = findCovered(eligible)
      if (covered.length > 1) return { blocked: { id: session.id, title: session.title, account, error: 'multiple verified local target histories' } }
      if (covered.length === 1) return { match: { session, target: covered[0], conversationSha: sha(stable(remoteConversation)), account } }
      if (remoteConversation.length < 4 && findCovered(candidates.filter((candidate) => !eligible.includes(candidate))).length) return { blocked: { id: session.id, title: session.title, account, error: 'remote history is too short to match a renamed local target' } }
      const anchors = linked.length ? linked : named
      if (anchors.length !== 1) return { blocked: { id: session.id, title: session.title, account, error: anchors.length ? 'multiple divergent local targets' : 'no linked or same-title local target' } }
      const base = anchors[0]
      const minimumAnchor = 8
      if (!linked.length && !conversationAnchored(remoteConversation, base.conversation, minimumAnchor)) return { blocked: { id: session.id, title: session.title, account, error: 'same-title local target does not share a branch segment' } }
      if (!rows) {
        rows = (await stableRemoteRows(cloud, session.id)).rows
        const currentConversation = conversationFromRows(rows)
        if (sha(stable(currentConversation)) !== sha(stable(remoteConversation))) throw new Error('Remote Control history changed since cached analysis')
      }
      rescuePayloads(rows)
      const record = desktopRecordOf(base.row)
      if (base.row.taskOwned || base.row.worker || record.scheduledTaskId || record.notifySessionId) return { blocked: { id: session.id, title: session.title, account, error: 'local rescue target owns a task, notification, or running worker' } }
      return { match: { session, target: { kind: 'rescue', base, id: null, title: session.title, matchMode: 'rescue' }, conversationSha: sha(stable(remoteConversation)), account } }
    } catch (error) {
      return { blocked: { id: session.id, title: session.title, account, error: `Remote Control history unreadable: ${error.message}` } }
    } finally {
      progress(report, 'cloud scan', ++completed, sessions.length)
    }
  }
  for (let at = 0; at < sessions.length; at += 8) {
    const batch = await Promise.all(sessions.slice(at, at + 8).map(analyze))
    for (const result of batch) {
      if (result.match) matches.push(result.match)
      else blocked.push(result.blocked)
    }
  }
  return { checked: true, matches, blocked, later, client: cloud, account: cloud.account, org: cloud.org, source: account }
}

const rehomeReason = (source, to, targetIds, targetNames) => {
  if (new Set(source.members?.map((member) => member.transcript)).size > 1) return 'multiple compatible source versions require merging'
  if (sameAccount(source.account, to)) return 'source and destination are the same'
  if (source.invalid) return `${source.invalid} unparseable lines`
  if (source.conflicts) return `${source.conflicts} conflicting duplicate uuids`
  if (!source.comparable) return 'history cannot be compared safely'
  if (source.record.scheduledTaskId) return 'scheduled task owns the Desktop record'
  if (source.record.notifySessionId) return 'notification route owns the Desktop record'
  if (source.taskOwned) return 'scheduled task registry owns the Desktop record'
  if (source.worker) return 'running worker owns the session'
  if (targetIds.has(source.id)) return 'target session id collision'
  if (targetNames.has(path.basename(source.file))) return 'target Desktop filename collision'
  return null
}

export async function inventory(from, to, paths, report = () => {}, options = {}) {
  const requestedAt = options.requestedAt ?? new Date().toISOString()
  const cloudRequested = options.cloudRequested === true || Boolean(options.cloud)
  const brokenTasks = [...from, to].find((account) => account.taskError)
  if (brokenTasks) throw new Error(`${brokenTasks.label}: ${brokenTasks.taskError}`)
  const workTotal = from.reduce((sum, account) => sum + account.sessions.length, 0) + to.sessions.length
  let completed = 0
  progress(report, 'scan', completed, workTotal)
  const cache = await openAnalysisCache(paths, options.writeCache === true)
  const ctx = { index: await index(paths.pool), scans: new Map(), workers: workers(), cache, cloud: Boolean(options.cloud) }
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
          const source = { ...s, account, transcript, ...detail, taskOwned: account.taskSessions.has(s.record.sessionId), worker: ctx.workers.has(s.id.toLowerCase()), recordSha: sha(await readFile(s.file)), recordSemantic: recordSemantic(s.record) }
          if (validDesktopRecord(source)) found.push(source)
          else rejected.push({ id: s.id, title: s.title, account, error: 'Desktop record identity is invalid' })
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
        if (detail?.roots.size) {
          const target = { record: s.record.sessionId, id: s.id, ...detail, session: s, account: to, taskOwned: to.taskSessions.has(s.record.sessionId), worker: ctx.workers.has(s.id.toLowerCase()), transcript, transcriptFingerprint: await fingerprint(transcript, cache), sidecar: await sidecars(transcript, s.id, cache), recordSha: sha(await readFile(s.file)), recordSemantic: recordSemantic(s.record) }
          if (validDesktopRecord(target)) targets.push(target)
          else rejected.push({ id: s.id, title: s.title, account: to, target: true, error: 'Desktop record identity is invalid' })
        }
      } catch (error) {
        rejected.push({ id: s.id, title: s.title, account: to, target: true, error: error.message })
      }
    } finally {
      progress(report, 'scan', ++completed, workTotal)
    }
  }
  for (const target of targets) {
    const remembered = options.cloudBridgeIds?.get(target.id) ?? []
    if (remembered.length) target.bridgeIds = [...new Set([...(target.bridgeIds ?? []), ...remembered.map(remoteId).filter(Boolean)])]
  }
  const covering = (s) => targets.find((target) => target.record && s.members.every((member) => included(member, target))) ?? null
  const there = []
  const pending = []
  for (const s of reps) {
    const covered = covering(s)
    if (covered && !s.invalid) {
      s.cloudTargetId = covered.id
      there.push(s)
    } else pending.push(s)
  }
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
  const cloudCutoff = options.cloudCutoff ?? (cloudRequested ? requestedAt : null)
  const cloudPlan = await cloudInventory(options.cloud, from, targets, options.cloudTargetOnly ? [] : move, cache, report, cloudCutoff)
  await saveAnalysisCache(cache)
  return {
    total,
    missing,
    unreadable,
    rejected,
    blocked,
    twice: found.length - reps.length,
    apart,
    there,
    move,
    targets,
    sources: found,
    from: from.map((a) => a.label),
    fromAccounts: from.map(accountRef),
    toAccount: accountRef(to),
    requestedAt,
    cloudRequested,
    cloudError: options.cloudError ?? null,
    cacheStats: cache.stats,
    cloud: cloudPlan
  }
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
  if (current.cliSessionId !== s.id || !validDesktopRecord({ file: s.file, record: current })) throw new Error('source Desktop record changed identity')
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
  const recordText = jsonText(placed)
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
  const record = desktopRecordOf(row)
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
const retirementOwnership = (inv, row, owner, liveWorkers) => owner.history.strategy === 'rehome' || inv.cloudRequested ? rehomeOwnership(row, liveWorkers) : ownership(row, liveWorkers)
const inventoryFailure = (item) => ({
  id: item.id ?? null,
  title: item.members?.length > 1
    ? item.members.map((member) => `${member.account.label} | ${member.title || path.basename(member.file)}`).join(' + ')
    : `${item.account.label} | ${item.title || path.basename(item.file)}`,
  error: item.error ?? 'unreadable Desktop record'
})
const taggedCloudFailure = (cloud, failure) => ({ ...failure, cloudAccount: cloud.account, cloudOrg: cloud.org })
const cloudTagged = (row, cloud) => row.cloudAccount === cloud.account && row.cloudOrg === cloud.org
const inventoryFailures = (inv) => [
  ...[...inv.unreadable, ...inv.rejected, ...(inv.blocked ?? [])].map(inventoryFailure),
  ...(inv.cloud?.blocked ?? []).map((item) => taggedCloudFailure(inv.cloud, inventoryFailure(item)))
]

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

async function latestReceipt(paths) {
  const name = (await receipts(paths)).at(-1)
  if (!name) return null
  const file = path.join(paths.state, name)
  const receipt = await readJson(file).catch(() => null)
  return receipt ? { name, file, receipt } : { name, file, corrupt: true }
}

async function deferredWorkflow(paths) {
  const latest = await latestReceipt(paths)
  if (!latest || latest.corrupt) return null
  const { receipt } = latest
  if (receipt.remoteUndoing?.length) {
    const sources = [...new Map(receipt.remoteUndoing.map((row) => [`${row.account}/${row.org}`, { account: row.account, org: row.org, label: accountLabel(row) }])).values()]
    return { ...latest, mode: 'undo', sources }
  }
  const sources = openCloudChecks(receipt)
  return sources.length ? { ...latest, mode: 'cloud', sources } : null
}

const saveText = async (file, text) => {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, text, { flag: 'wx', mode: 0o600 })
    await rename(temp, file)
    return text
  } finally {
    await unlink(temp).catch(() => {})
  }
}

const saveJson = (file, value, spacing = 2) => saveText(file, jsonText(value, spacing))

async function recoveryPending(paths) {
  const latest = await latestReceipt(paths)
  if (!latest || latest.corrupt) return latest
  const { name, file, receipt } = latest
  return receipt.pending || receipt.retiring || receipt.finalizing || receipt.undoing || receipt.remotePending || receipt.remoteUndoing?.length ? { name, file, receipt } : null
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
    ...await restoreProblems(receipt.undoing ?? [], root),
    ...await activationProblems(receipt)
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
  await restoreActivations(receipt)
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

async function reconcile(paths, options = {}) {
  const p = await recoveryPending(paths)
  if (!p) return null
  if (p.corrupt) {
    await rename(p.file, `${p.file}.corrupt`)
    return { title: p.name, error: 'corrupt receipt set aside' }
  }
  const { receipt } = p
  receipt.failed ??= []
  receipt.superseded ??= []
  if (receipt.undoing) {
    const remote = await restoreRemote(receipt, p.file, paths, options.cloud)
    if (remote.problems.length) return { title: 'Remote Control undo recovery blocked', error: remote.problems.join(', '), problems: remote.problems }
    if (remote.pending.length) return { title: 'Undo pending', error: `sign Claude Desktop into ${remote.pending.join(' or ')}`, pendingUndo: remote.pending, remoteRestored: remote.restored, receipt }
    const result = await finishUndo(receipt, p.file, paths)
    if (result.restoreProblems) return { title: 'undo recovery blocked', error: result.restoreProblems.join(', '), problems: result.restoreProblems }
    return { title: `${receipt.sessions.length} sessions`, error: 'interrupted undo completed', undo: result }
  }
  if (receipt.remotePending) {
    const row = receipt.remotePending
    try {
      const cloud = await receiptCloud(receipt, paths, options.cloud)
      const current = await cloud.session(row.id)
      if (current.status === 'archived') {
        receipt.remote ??= []
        if (!receipt.remote.some((item) => item.id === row.id)) receipt.remote.push(row)
        receipt.failed = receipt.failed.filter((item) => item.id !== row.id)
        delete receipt.remotePending
        await saveJson(p.file, receipt)
        return { title: row.title, error: 'interrupted Remote Control archive completed' }
      }
      if (['active', 'paused'].includes(current.status)) {
        await rollbackActivation(row.activation)
        addCloudFailure(receipt, row, { id: row.id, title: row.title, error: 'interrupted Remote Control archive not applied' })
        delete receipt.remotePending
        await saveJson(p.file, receipt)
        return { title: row.title, error: 'interrupted Remote Control archive not applied' }
      }
      return { title: row.title, error: `Remote Control recovery blocked at ${current.status ?? 'unknown'}` }
    } catch (error) {
      return { title: row.title, error: `Remote Control recovery blocked: ${error.message}` }
    }
  }
  if (receipt.retiring) {
    const plan = receipt.retiring
    const root = path.join(paths.state, 'quarantine')
    const blocked = await restoreProblems(plan, root, true)
    if (blocked.length) return { title: 'retirement recovery blocked', error: blocked.join(', '), problems: blocked }
    await restore(plan, root)
    receipt.retiring = null
    receipt.finalizing = false
    cancelCloudChecks(receipt)
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
    const changedCopy = strategy === 'rehome' ? 'target record' : strategy === 'remote' ? 'remote rescue' : 'legacy copy'
    const error = used ? `interrupted, ${changedCopy} changed since, left in place` : 'interrupted'
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
    cancelCloudChecks(receipt)
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
    const sameTask = !row.account?.taskFile || (await taskSessions(row.account.taskFile)).has(desktopRecordOf(row).sessionId) === row.taskOwned
    const shared = Boolean(currentTranscript) && (!expectedSidecars.count || await exists(sidecarRoot)) && (!checkShared || (currentTranscript === row.transcriptFingerprint && currentSidecars?.fingerprint === expectedSidecars.fingerprint))
    return shared && sameTask && !liveWorkers?.has(row.id.toLowerCase())
  }
  const now = await sidecars(row.transcript, row.id).catch(() => null)
  const sameTask = !row.account?.taskFile || (await taskSessions(row.account.taskFile)).has(desktopRecordOf(row).sessionId) === row.taskOwned
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
      const claim = retirementOwnership(inv, s, owner, liveWorkers)
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

const REMOTE_OPEN = new Set(['active', 'paused'])
const REMOTE_IDLE = new Set([
  'WORKER_STATUS_UNSPECIFIED', 'WORKER_STATUS_IDLE', 'WORKER_STATUS_DISCONNECTED',
  'idle', 'disconnected', 'stopped'
])
const remoteBusy = (session) => session?.connection_status !== 'disconnected' ||
  !Array.isArray(session?.client_presence) || session.client_presence.length > 0 ||
  !REMOTE_IDLE.has(session?.worker_status)

function assertRemoteIdle(session) {
  if (!REMOTE_OPEN.has(session?.status)) throw new Error(`Remote Control status changed to ${session?.status ?? 'unknown'}`)
  if (remoteBusy(session)) throw new Error('Remote Control session is not proven disconnected and idle')
  if (!['string', 'number'].includes(typeof session.last_event_at)) throw new Error('Remote Control event marker is missing')
  return session.last_event_at
}

async function stableRemoteRows(cloud, id) {
  const before = await cloud.session(id)
  const marker = assertRemoteIdle(before)
  const rows = await cloud.eventRows(id)
  const after = await cloud.session(id)
  assertRemoteIdle(after)
  if (after.last_event_at !== marker) throw new Error('Remote Control history changed while reading')
  return { rows, marker, session: after }
}

const REMOTE_BLOCKS = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use', 'tool_result', 'tool_reference', 'image', 'document'])
const REMOTE_RESULT_BLOCKS = new Set(['text', 'tool_reference', 'image', 'document'])
const RESCUE_RECORD_KEYS = [
  'classifierSummaryEnabled', 'effort', 'model', 'originCwd', 'remoteMcpServersConfig', 'sessionSettings'
]
const jsonLine = (value) => JSON.stringify(value).replace(/\u0085/g, '\\u0085').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

const supportedRemoteSource = (source, blockType) => {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false
  if (source.type === 'base64') {
    const media = typeof source.media_type === 'string' && (blockType === 'image' ? source.media_type.startsWith('image/') : source.media_type === 'application/pdf')
    return media && typeof source.data === 'string' && source.data.length > 0 && source.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(source.data)
  }
  if (source.type === 'url') {
    try { return ['http:', 'https:'].includes(new URL(source.url).protocol) } catch { return false }
  }
  if (source.type === 'text') return blockType === 'document' && source.media_type === 'text/plain' && typeof source.data === 'string'
  return false
}

const supportedRemoteBlock = (block) => {
  if (!block || typeof block !== 'object' || !REMOTE_BLOCKS.has(block.type)) return false
  if (block.type === 'text') return typeof block.text === 'string'
  if (block.type === 'thinking') return typeof block.thinking === 'string'
  if (block.type === 'redacted_thinking') return typeof block.data === 'string'
  if (block.type === 'tool_use') return typeof block.id === 'string' && typeof block.name === 'string' && block.input && typeof block.input === 'object' && !Array.isArray(block.input)
  if (block.type === 'tool_reference') return typeof block.tool_name === 'string'
  if (block.type === 'image' || block.type === 'document') return supportedRemoteSource(block.source, block.type)
  if (typeof block.tool_use_id !== 'string') return false
  if (typeof block.content === 'string') return true
  return Array.isArray(block.content) && block.content.every((nested) => REMOTE_RESULT_BLOCKS.has(nested?.type) && supportedRemoteBlock(nested))
}

function rescuePayloads(rows) {
  const messages = rows.filter((row) => ['user', 'assistant'].includes(row.event_type))
  if (!messages.length) throw new Error('Remote Control history has no messages to rescue')
  for (const row of messages) {
    const payload = row.payload
    if (payload.type !== row.event_type || !payload.message || typeof payload.message !== 'object' || payload.message.role !== row.event_type) throw new Error('Remote Control message response changed')
    const content = payload.message.content
    if (typeof content !== 'string' && !Array.isArray(content)) throw new Error('Remote Control message content changed')
    if (Array.isArray(content) && content.some((block) => !supportedRemoteBlock(block))) throw new Error('Remote Control history contains an unsupported content block')
  }
  return messages
}

async function rescueRemote(match, to, cloud, journal) {
  const base = match.target.base.row
  if (!(await untouched(base, workers()))) throw new Error('local rescue anchor changed since inventory')
  const { rows, session: after } = await stableRemoteRows(cloud, match.session.id)
  if (!(await untouched(base, workers()))) throw new Error('local rescue anchor changed while reading remote history')
  const messages = rescuePayloads(rows)
  const remoteHistory = conversationFromRows(messages)
  const remoteMessageSha = sha(stable(messages.map((row) => row.payload.message)))
  if (sha(stable(remoteHistory)) !== match.conversationSha) throw new Error('Remote Control history changed since inventory')

  const baseRecordFile = base.session?.file ?? base.file
  const baseRecord = await readJson(baseRecordFile)
  if (recordSemantic(baseRecord) !== base.recordSemantic) throw new Error('local rescue target changed since inventory')
  const baseEntries = (await load(base.transcript)).entries
  const template = baseEntries.findLast((entry) => entry.version) ?? {}
  const targetId = randomUUID()
  const targetTranscript = path.join(path.dirname(base.transcript), `${targetId}.jsonl`)
  const record = path.join(to.dir, `local_${targetId}.json`)
  const common = {
    cwd: baseRecord.cwd,
    entrypoint: template.entrypoint,
    gitBranch: template.gitBranch ?? null,
    isSidechain: false,
    sessionId: targetId,
    userType: template.userType ?? 'external',
    version: template.version
  }
  const entries = []
  let parentUuid = null
  for (const row of messages) {
    const payload = row.payload
    const uuid = randomUUID()
    const entry = {
      ...common,
      type: row.event_type,
      uuid,
      parentUuid,
      timestamp: payload.timestamp ?? row.created_at ?? after.last_event_at
    }
    if (payload.message) entry.message = structuredClone(payload.message)
    if (payload.origin !== undefined) entry.origin = payload.origin
    if (payload.request_id !== undefined) entry.requestId = payload.request_id
    if (payload.tool_use_result !== undefined) entry.toolUseResult = structuredClone(payload.tool_use_result)
    if (payload.tool_use_meta !== undefined) entry.toolUseMeta = structuredClone(payload.tool_use_meta)
    entries.push(entry)
    parentUuid = uuid
  }
  if (sha(stable(entries.filter((entry) => ['user', 'assistant'].includes(entry.type)).map((entry) => entry.message))) !== remoteMessageSha) throw new Error('rescued transcript does not preserve exact remote message payloads')
  if (sha(stable(conversation(entries))) !== match.conversationSha) throw new Error('rescued transcript does not contain the remote message history')
  const now = new Date().toISOString()
  entries.push({ type: 'custom-title', customTitle: match.session.title, sessionId: targetId, uuid: randomUUID(), timestamp: now })
  const transcriptText = `${entries.map(jsonLine).join('\n')}\n`
  const createdAt = milliseconds(match.session.created_at)
  const lastActivityAt = milliseconds(after.last_event_at)
  const settings = Object.fromEntries(RESCUE_RECORD_KEYS.filter((key) => baseRecord[key] !== undefined).map((key) => [key, structuredClone(baseRecord[key])]))
  const placed = { ...settings, sessionId: `local_${targetId}`, cliSessionId: targetId, cwd: baseRecord.cwd, title: match.session.title, titleSource: 'user', permissionMode: 'default', alwaysAllowedReasons: [], sessionPermissionUpdates: [], isArchived: false, bridgeSessionIds: [], createdAt: createdAt >= 0 ? createdAt : Date.now(), lastActivityAt: lastActivityAt >= 0 ? lastActivityAt : Date.now(), lastFocusedAt: lastActivityAt >= 0 ? lastActivityAt : Date.now(), completedTurns: rows.reduce((turns, row) => Math.max(turns, Number(row.payload?.num_turns) || 0), 0) }
  const recordText = jsonText(placed)
  const made = [targetTranscript, record]
  const targetSemantic = semantic(entries, targetId)
  await journal({ strategy: 'remote', id: targetId, targetId, made, targetSha: sha(transcriptText), targetSemantic, targetSemanticVersion: SEMANTIC_VERSION })
  await writeNew(targetTranscript, transcriptText)
  await writeNew(record, recordText)
  const sidecarRoot = path.join(path.dirname(targetTranscript), targetId)
  const sidecarFingerprint = (await treeFingerprint(sidecarRoot)).fingerprint
  const remoteEventSha = sha(stable(rows.map((row) => ({ eventType: row.event_type, payload: row.payload, sequence: row.sequence_num }))))
  return {
    strategy: 'remote',
    id: targetId,
    remoteId: match.session.id,
    rescueAnchorId: base.id,
    remoteMessageSha,
    targetId,
    title: match.session.title,
    archived: false,
    transcript: targetTranscript,
    targetTranscript,
    targetDir: null,
    record,
    recordSha: sha(recordText),
    recordSemantic: recordSemantic(placed),
    targetRecordId: placed.sessionId,
    taskFile: to.taskFile,
    taskOwned: false,
    transcriptFingerprint: await fingerprint(targetTranscript),
    targetSemantic,
    targetSemanticVersion: SEMANTIC_VERSION,
    targetSha: sha(transcriptText),
    sidecars: { count: 0, bytes: 0, sha: sha(stable([])), fingerprint: sidecarFingerprint },
    events: remoteHistory.length,
    remoteEvents: rows.length,
    remoteEventSha
  }
}

async function waitRemote(cloud, id, statuses) {
  let current = null
  for (let attempt = 0; attempt < 12; attempt++) {
    current = await cloud.session(id)
    if (statuses.includes(current.status)) return current
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return current
}

const remoteReceipt = (match) => ({
  id: match.session.id,
  title: match.session.title,
  account: match.account.account,
  accountLabel: match.account.label,
  org: match.account.org,
  status: match.session.status,
  conversationSha: match.conversationSha,
  targetId: match.target.id,
  targetKind: match.target.kind,
  matchMode: match.target.matchMode
})

async function targetActivation(row) {
  const record = path.isAbsolute(row?.record ?? '') ? row.record : row?.session?.file
  const raw = record ? await readFile(record, 'utf8').catch(() => null) : null
  if (!raw) throw new Error('local target record is missing')
  const current = JSON.parse(raw)
  if (recordSemantic(current) !== row.recordSemantic) throw new Error('local target record changed before Remote Control archival')
  if (current.isArchived !== true) return null
  const after = { ...current, isArchived: false }
  const afterText = jsonText(after)
  return { record, beforeSha: sha(raw), beforeSemantic: recordSemantic(current), afterSha: sha(afterText), afterSemantic: recordSemantic(after), after }
}

async function applyActivation(activation, row) {
  if (!activation) return
  if (sha(await readFile(activation.record)) !== activation.beforeSha) throw new Error('local target record changed before activation')
  await saveText(activation.record, jsonText(activation.after))
  if (sha(await readFile(activation.record)) !== activation.afterSha) throw new Error('local target activation verification failed')
  row.recordSha = activation.afterSha
  row.recordSemantic = activation.afterSemantic
  row.archived = false
  if (row.session) {
    row.session.record = activation.after
    row.session.archived = false
  }
  delete activation.after
}

async function activationProblems(receipt) {
  const problems = []
  for (const row of [...(receipt.remote ?? []), receipt.remotePending].filter(Boolean)) {
    const activation = row.activation
    if (!activation) continue
    const raw = await readFile(activation.record).catch(() => null)
    let unchanged = Boolean(raw)
    try {
      if (raw) unchanged = [activation.beforeSemantic, activation.afterSemantic].includes(recordSemantic(JSON.parse(raw)))
    } catch { unchanged = false }
    if (!unchanged) problems.push(`${row.title} | activated target record changed`)
  }
  return problems
}

async function restoreActivations(receipt) {
  for (const row of [...(receipt.remote ?? [])].reverse()) {
    const activation = row.activation
    if (!activation || !(await exists(activation.record))) continue
    const current = await readJson(activation.record)
    const semantic = recordSemantic(current)
    if (semantic === activation.beforeSemantic) continue
    if (semantic !== activation.afterSemantic) throw new Error('activated target record changed during Undo')
    await saveJson(activation.record, { ...current, isArchived: true })
  }
}

async function rollbackActivation(activation) {
  if (!activation) return
  const raw = await readFile(activation.record).catch(() => null)
  let current = null
  try { if (raw) current = JSON.parse(raw) } catch {}
  const semantic = current ? recordSemantic(current) : null
  if (semantic === activation.beforeSemantic) return
  if (semantic !== activation.afterSemantic) throw new Error('activated target record changed during recovery')
  await saveJson(activation.record, { ...current, isArchived: true })
}

function receiptCloudCheck(receipt, cloud) {
  return (receipt.cloudChecks ?? []).find((check) => sameAccount(check, cloud)) ?? null
}

function clearCloudAttempt(receipt, cloud) {
  receipt.failed = (receipt.failed ?? []).filter((failure) => !cloudTagged(failure, cloud))
  receipt.cloudError = null
  if (receipt.verification) {
    receipt.verification.problems = (receipt.verification.problems ?? []).filter((problem) => !cloudTagged(problem, cloud))
    receipt.verification.ok = receipt.verification.problems.length === 0
  }
  const check = receiptCloudCheck(receipt, cloud)
  if (check) {
    check.status = 'pending'
    delete check.failures
    delete check.later
    delete check.checkedAt
  }
  return check
}

function addCloudFailure(receipt, cloud, failure) {
  receipt.failed.push(taggedCloudFailure(cloud, failure))
}

function finishCloudAttempt(receipt, cloud, later = []) {
  const check = receiptCloudCheck(receipt, cloud)
  if (!check) return null
  const failures = receipt.failed.filter((failure) => cloudTagged(failure, cloud))
  check.status = failures.length ? 'failed' : 'complete'
  check.checkedAt = new Date().toISOString()
  if (failures.length) check.failures = failures.map(({ id, title, error }) => ({ id, title, error }))
  else delete check.failures
  if (later.length) check.later = later
  else delete check.later
  return check
}

async function archiveCloud(inv, receipt, save, report = () => {}) {
  const matches = (inv.cloud?.matches ?? []).filter((match) => !match.target.failed)
  if (!matches.length) return
  const cloud = inv.cloud.client
  const failedVerification = new Set(receipt.verification?.problems?.map((problem) => problem.id) ?? [])
  let archived = 0
  progress(report, 'cloud', archived, matches.length)
  for (const [index, match] of matches.entries()) {
    const row = match.target.kind === 'existing'
      ? match.target.row
      : receipt.sessions.find((session) => session.targetId === match.target.id)
    if (failedVerification.has(row?.targetId ?? match.target.id)) {
      addCloudFailure(receipt, inv.cloud, { id: match.session.id, title: match.session.title, error: 'local target failed verification, Remote Control source kept' })
      progress(report, 'cloud', ++archived, matches.length)
      continue
    }
    const liveWorkers = workers()
    const targetOkay = row?.targetId
      ? !(await targetChanges(row, liveWorkers, true)).length
      : row ? await untouched(row, liveWorkers) : false
    if (!targetOkay) {
      addCloudFailure(receipt, inv.cloud, { id: match.session.id, title: match.session.title, error: 'local target changed before Remote Control archival' })
      progress(report, 'cloud', ++archived, matches.length)
      continue
    }
    let lastEventAt = null
    try {
      const current = await stableRemoteRows(cloud, match.session.id)
      lastEventAt = current.marker
      const currentConversation = conversationFromRows(current.rows)
      if (sha(stable(currentConversation)) !== match.conversationSha) throw new Error('Remote Control history changed since inventory')
    } catch (error) {
      addCloudFailure(receipt, inv.cloud, { id: match.session.id, title: match.session.title, error: error.message })
      progress(report, 'cloud', ++archived, matches.length)
      continue
    }
    let activation
    try {
      activation = await targetActivation(row)
    } catch (error) {
      addCloudFailure(receipt, inv.cloud, { id: match.session.id, title: match.session.title, error: error.message })
      progress(report, 'cloud', ++archived, matches.length)
      continue
    }
    const pending = { ...remoteReceipt(match), lastEventAt, activation }
    receipt.remotePending = pending
    await save()
    let attempted = false
    try {
      await applyActivation(pending.activation, row)
      await save()
      const current = await cloud.session(pending.id)
      assertRemoteIdle(current)
      if (current.last_event_at !== pending.lastEventAt) throw new Error('Remote Control history changed before archival')
      attempted = true
      await cloud.archive(pending.id)
      const after = await waitRemote(cloud, pending.id, ['archived'])
      if (after.status !== 'archived') throw new Error(`Remote Control archive verification returned ${after.status ?? 'unknown'}`)
      receipt.remote ??= []
      receipt.remote.push(pending)
      delete receipt.remotePending
      await save()
    } catch (error) {
      let rolledBack = false
      if (!attempted) {
        try {
          await rollbackActivation(pending.activation)
          delete receipt.remotePending
          rolledBack = true
        } catch {}
      }
      addCloudFailure(receipt, inv.cloud, { id: pending.id, title: pending.title, error: error.message })
      if (!rolledBack) {
        for (const skipped of matches.slice(index + 1)) addCloudFailure(receipt, inv.cloud, { id: skipped.session.id, title: skipped.session.title, error: 'not attempted while Remote Control recovery is pending' })
      }
      await save()
      if (!rolledBack) break
    }
    progress(report, 'cloud', ++archived, matches.length)
  }
  if (receipt.remote?.length) report('cloud', `${count(receipt.remote.length)} source mirrors archived`)
}

async function rescueCloud(inv, receipt, to, paths, save, report = () => {}) {
  const rescues = inv.cloud?.matches.filter((match) => match.target.kind === 'rescue') ?? []
  const rows = []
  let events = 0
  progress(report, 'rescue', 0, rescues.length)
  for (const [i, match] of rescues.entries()) {
    receipt.pending = { strategy: 'remote', id: match.session.id, title: match.session.title, targetId: null, made: [] }
    await save()
    try {
      const row = await rescueRemote(match, to, inv.cloud.client, async (journal) => { Object.assign(receipt.pending, journal); await save() })
      receipt.sessions.push(row)
      rows.push(row)
      match.target.id = row.targetId
      events += row.events
    } catch (error) {
      await quarantine(receipt.pending.made ?? [], path.join(paths.state, 'quarantine', receipt.at, 'failed'))
      addCloudFailure(receipt, inv.cloud, { id: match.session.id, title: match.session.title, error: error.message })
      match.target.failed = true
    }
    receipt.pending = null
    await save()
    progress(report, 'rescue', i + 1, rescues.length)
  }
  return { rows, events }
}

async function receiptCloud(receipt, paths, supplied) {
  const row = receipt.remotePending ?? receipt.remote?.[0]
  if (!row) return null
  const cloud = supplied ?? await cloudClient(paths)
  if (!sameAccount(cloud, row)) throw new Error(`sign Claude Desktop into the source account ${accountLabel(row)}`)
  return cloud
}

async function restoreRemote(receipt, file, paths, supplied) {
  if (!receipt.remoteUndoing?.length) return { problems: [], pending: [] }
  let restored = 0
  let cloud
  try { cloud = supplied ?? await cloudClient(paths) } catch (error) {
    return { problems: [], pending: [...new Set(receipt.remoteUndoing.map(accountLabel))], restored, error: error.message }
  }
  const matching = receipt.remoteUndoing.filter((row) => sameAccount(row, cloud))
  for (const row of matching) {
    try {
      const current = await cloud.session(row.id)
      if (current.status === 'archived') await cloud.unarchive(row.id)
      const after = await waitRemote(cloud, row.id, ['active', 'paused'])
      if (!REMOTE_OPEN.has(after.status)) return { problems: [`${row.title} | Remote Control unarchive verification returned ${after.status ?? 'unknown'}`], pending: [], restored }
      receipt.remoteUndoing = receipt.remoteUndoing.filter((candidate) => candidate !== row)
      restored++
      await saveJson(file, receipt)
    } catch (error) {
      return { problems: [`${row.title} | ${error.message}`], pending: [], restored }
    }
  }
  if (!receipt.remoteUndoing.length) delete receipt.remoteUndoing
  await saveJson(file, receipt)
  return {
    problems: [],
    pending: [...new Set((receipt.remoteUndoing ?? []).map(accountLabel))],
    restored
  }
}

async function transfer(inv, to, paths, report) {
  const deferred = await deferredWorkflow(paths)
  if (deferred) return { deferred, ok: false, complete: false, pendingCloud: deferred.mode === 'cloud' ? deferred.sources.length : 0 }
  const started = Date.now()
  const startedAt = inv.requestedAt ?? new Date(started).toISOString()
  const at = stamp()
  const initialFailures = inventoryFailures(inv)
  const receipt = {
    at,
    startedAt,
    from: inv.from,
    to: to.label,
    fromAccounts: inv.fromAccounts ?? [],
    toAccount: inv.toAccount ?? accountRef(to),
    cloudChecks: inv.cloudRequested ? (inv.fromAccounts ?? []).map((account) => ({ ...account, status: 'pending' })) : [],
    cloudError: inv.cloudError || null,
    cloudLinks: [...inv.move, ...inv.there].flatMap((source) => (source.members ?? [source]).flatMap((member) => {
      const bridgeIds = remoteIdsOf(member)
      return bridgeIds.length ? [{ account: member.account.account, org: member.account.org, targetId: source.cloudTargetId ?? source.id, bridgeIds }] : []
    })),
    sessions: [],
    remote: [],
    failed: initialFailures,
    superseded: [],
    finalizing: true
  }
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
  const rescues = inv.cloud?.matches.filter((match) => match.target.kind === 'rescue') ?? []
  const rescued = await rescueCloud(inv, receipt, to, paths, save, report)
  events += rescued.events
  const done = receipt.sessions.length
  if (inv.move.length || rescues.length) {
    const rehomed = receipt.sessions.filter((row) => row.strategy === 'rehome').length
    const rescuedCount = receipt.sessions.filter((row) => row.strategy === 'remote').length
    await save()
    report('move', [
      `${count(done)} ✓`,
      `${count(events)} events`,
      rehomed ? `${count(rehomed)} zero-copy` : null,
      rescuedCount ? `${count(rescuedCount)} rescued` : null,
      receipt.failed.length ? `${receipt.failed.length} failed` : null
    ].filter(Boolean).join(' | '))
    report('sidecars', `${count(receipt.sessions.reduce((n, r) => n + r.sidecars.count, 0))} files | unchanged ✓`)
  }
  const { ok, lines, problems } = await verify(receipt.sessions, report)
  const rescueIds = new Set(rescued.rows.map((row) => row.targetId))
  const recordedProblems = problems.map((problem) => rescueIds.has(problem.id) ? taggedCloudFailure(inv.cloud, problem) : problem)
  receipt.verification = { ok, problems: recordedProblems }
  await save()
  await retire(inv, receipt, paths, at, problems, save, report)
  receipt.finalizing = false
  await save()
  await archiveCloud(inv, receipt, save, report)
  if (inv.cloud?.checked) finishCloudAttempt(receipt, inv.cloud, inv.cloud.later)
  if (inv.cloud?.later.length) report('later', inv.cloud.later.map((row) => row.title).join('\n'))
  const retired = retiredCount(receipt)
  const superseded = receipt.superseded.length - retired
  const pendingCloud = openCloudChecks(receipt).length
  if (pendingCloud) report('pending', quantity(pendingCloud, 'source cloud check'))
  if (!done && !receipt.superseded.length && !receipt.remote.length && !receipt.remotePending && !pendingCloud) {
    await rm(file, { force: true })
    return receipt.failed.length ? { file: null, receipt, checks: [], problems, ok: false, validationOnly: true } : null
  }
  await save()
  if (receipt.sessions.length) {
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
  const resultOkay = ok && receipt.failed.length === 0
  const newerCloud = receipt.cloudChecks.reduce((total, check) => total + (check.later?.length ?? 0), 0)
  return { file, receipt, checks: lines, problems, ok: resultOkay, complete: pendingCloud === 0, pendingCloud, pendingLabels: cloudCheckLabels(receipt), newerCloud }
}

export function finishPending(paths, options = {}) {
  const report = options.report ?? (() => {})
  return locked(paths, async () => {
    const recovery = await recoveryPending(paths)
    if (recovery) {
      const reconciled = await reconcile(paths, { cloud: options.cloud })
      if (reconciled?.undo) return { ...reconciled.undo, ok: true, complete: true, pendingCloud: 0, pendingUndo: [] }
      if (reconciled?.pendingUndo) return { receipt: reconciled.receipt, ok: true, complete: false, pendingCloud: 0, pendingUndo: reconciled.pendingUndo, remoteRestored: reconciled.remoteRestored ?? 0 }
      return { reconciled, recoveryRequired: true, ok: false, complete: false }
    }
    const latest = await latestReceipt(paths)
    if (!latest) return { nothing: true, ok: true, complete: true, pendingCloud: 0 }
    const { file, receipt } = latest
    const outstanding = openCloudChecks(receipt)
    if (!outstanding.length) return { nothing: true, receipt, file, ok: true, complete: true, pendingCloud: 0 }
    const cloud = options.cloud ?? await cloudClient(paths)
    const check = outstanding.find((candidate) => sameAccount(candidate, cloud))
    if (!check) throw new Error(`sign Claude Desktop into one of: ${cloudCheckLabels(receipt).join(', ')}`)
    const all = await accounts(paths)
    const source = all.find((account) => sameAccount(account, check))
    const to = all.find((account) => sameAccount(account, receipt.toAccount))
    if (!source) throw new Error(`${check.label} is no longer available`)
    if (!to) throw new Error(`${receipt.to} is no longer available`)
    clearCloudAttempt(receipt, cloud)
    await saveJson(file, receipt)
    const cloudSource = { ...source, sessions: [], unreadable: [] }
    let inv
    try {
      const cloudBridgeIds = new Map()
      const links = (receipt.cloudLinks ?? []).filter((row) => sameAccount(row, cloud))
      for (const row of links) {
        cloudBridgeIds.set(row.targetId, [...new Set([...(cloudBridgeIds.get(row.targetId) ?? []), ...row.bridgeIds])])
      }
      inv = await inventory([cloudSource], to, paths, report, { cloud, cloudRequested: true, cloudTargetOnly: true, cloudCutoff: receipt.startedAt, cloudBridgeIds, writeCache: true })
    } catch (error) {
      addCloudFailure(receipt, cloud, { id: null, title: check.label, error: error.message })
      finishCloudAttempt(receipt, cloud)
      await saveJson(file, receipt)
      const failed = receipt.failed.filter((failure) => cloudTagged(failure, cloud))
      return { file, receipt, ok: false, complete: false, pendingCloud: openCloudChecks(receipt).length, pendingLabels: cloudCheckLabels(receipt), failed }
    }
    for (const blocked of inv.cloud?.blocked ?? []) addCloudFailure(receipt, cloud, inventoryFailure(blocked))
    if (inv.cloud?.later.length) report('later', inv.cloud.later.map((row) => row.title).join('\n'))
    const save = () => saveJson(file, receipt)
    const beforeRemote = receipt.remote.length
    const rescued = await rescueCloud(inv, receipt, to, paths, save, report)
    const verification = await verify(rescued.rows, report)
    receipt.verification ??= { ok: true, problems: [] }
    receipt.verification.ok = receipt.verification.ok && verification.ok
    receipt.verification.problems = [...(receipt.verification.problems ?? []), ...verification.problems.map((problem) => taggedCloudFailure(inv.cloud, problem))]
    await save()
    await archiveCloud(inv, receipt, save, report)
    finishCloudAttempt(receipt, cloud, inv.cloud.later)
    await save()
    const completedRemote = receipt.remote.slice(beforeRemote)
    const pendingCloud = openCloudChecks(receipt).length
    const failed = receipt.failed.filter((failure) => cloudTagged(failure, cloud))
    const ok = verification.ok && failed.length === 0
    return {
      file,
      receipt,
      ok,
      complete: pendingCloud === 0,
      pendingCloud,
      pendingLabels: cloudCheckLabels(receipt),
      rescued: rescued.rows.length,
      cloudArchived: completedRemote.length,
      cloudChecked: 1,
      newerCloud: inv.cloud.later.length,
      failed,
      problems: verification.problems,
      checks: verification.lines,
      restart: rescued.rows.length > 0 || completedRemote.length > 0
    }
  })
}

export function keepLocal(paths) {
  return locked(paths, async () => {
    const recovery = await recoveryPending(paths)
    if (recovery) return { recoveryRequired: true, recovery }
    const latest = await latestReceipt(paths)
    if (!latest) return { nothing: true }
    const { file, receipt } = latest
    const checks = openCloudChecks(receipt)
    if (!checks.length) return { nothing: true, file, receipt }
    const unsafe = (receipt.verification?.problems ?? []).filter((problem) => checks.some((check) => cloudTagged(problem, check)))
    const refused = unsafe.map((problem) => `${problem.title ?? problem.id} | ${problem.check} verification failed`)
    const liveWorkers = workers()
    for (const row of receipt.sessions) {
      const changes = await targetChanges(row, liveWorkers, row.strategy !== 'rehome')
      if (changes.length) refused.push(`${row.title} | ${changes.join(', ')} changed`)
    }
    const to = (await accounts(paths)).find((account) => sameAccount(account, receipt.toAccount))
    const existing = (receipt.superseded ?? []).filter((row) => row.source && !receipt.sessions.some((session) => session.targetId === row.by))
    refused.push(...await restoreProblems(receipt.superseded ?? [], path.join(paths.state, 'quarantine')))
    const sourceSessions = []
    for (const source of existing) {
      const file = source.moved?.[0]?.[1]
      const record = file ? await readJson(file).catch(() => null) : null
      if (record) sourceSessions.push(desktopSession(file, record))
      else refused.push(`${source.title} | source recovery record missing`)
    }
    if (sourceSessions.length && to) {
      const auditSource = { account: 'retired', org: 'retired', label: 'retired sources', sessions: sourceSessions, unreadable: [], taskFile: path.join(paths.state, 'keep-local-audit-tasks.json'), taskSessions: new Set(), taskError: null }
      try {
        const audit = await inventory([auditSource], to, paths)
        const covered = new Set(audit.there.flatMap((source) => (source.members ?? [source]).map((member) => member.file)))
        for (const source of sourceSessions) if (!covered.has(source.file)) refused.push(`${source.title} | destination no longer contains source history`)
      } catch (error) {
        refused.push(`destination verification failed | ${error.message}`)
      }
    }
    if (sourceSessions.length && !to) refused.push(`${receipt.to} | destination account missing`)
    if (refused.length) return { file, receipt, refused }
    cancelCloudChecks(receipt)
    receipt.failed = (receipt.failed ?? []).filter((failure) => !checks.some((check) => cloudTagged(failure, check)))
    receipt.cloudError = null
    await saveJson(file, receipt)
    return { file, receipt, cancelled: checks.length, labels: checks.map((check) => check.label), ok: true, complete: true }
  })
}

export const move = (inv, to, paths, report = () => {}) => locked(paths, async () => {
  const reconciled = await reconcile(paths, { cloud: inv.cloud?.client })
  return reconciled ? { reconciled, recoveryRequired: true, ok: false } : transfer(inv, to, paths, report)
})

export function undo(paths, options = {}) {
  return locked(paths, async () => {
    const reconciled = await reconcile(paths, options)
    if (reconciled?.undo) return reconciled.undo
    if (reconciled?.pendingUndo) return { receipt: reconciled.receipt, pendingUndo: reconciled.pendingUndo, remoteRestored: reconciled.remoteRestored ?? 0 }
    if (reconciled) return { reconciled }
    const latest = await latestReceipt(paths)
    if (!latest) return { nothing: true }
    const { file, receipt } = latest
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
    const activationBlocked = await activationProblems(receipt)
    if (activationBlocked.length) return { receipt, restoreProblems: activationBlocked }
    receipt.undoing = plan
    if (receipt.remote?.length) receipt.remoteUndoing = structuredClone(receipt.remote)
    cancelCloudChecks(receipt)
    await saveJson(file, receipt)
    const remote = await restoreRemote(receipt, file, paths, options.cloud)
    if (remote.problems.length) return { receipt, restoreProblems: remote.problems }
    if (remote.pending.length) return { receipt, pendingUndo: remote.pending, remoteRestored: remote.restored }
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
  const account = all.find((candidate) => sameAccount(candidate, selected))
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
  const args = { from: [], to: null, cmd: null, dry: false, cloud: false, json: false, help: false, version: false, remove: false }
  const value = (i) => { if (argv[i] === undefined || argv[i].startsWith('-')) throw new Error(`${argv[i - 1]} needs a value`); return argv[i] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--from') args.from.push(value(++i))
    else if (a === '--to') args.to = value(++i)
    else if (a === '--dry-run') args.dry = true
    else if (a === '--cloud') args.cloud = true
    else if (a === '--json') args.json = true
    else if (a === '--remove') args.remove = true
    else if (a === '--version' || a === '-v') args.version = true
    else if (a === '--help' || a === '-h') args.help = true
    else if (!a.startsWith('-') && !args.cmd) args.cmd = a
    else throw new Error(`unknown argument ${a}`)
  }
  if ((args.from.length > 0) !== Boolean(args.to)) throw new Error('--from and --to go together')
  if ((args.help || args.version) && argv.length > 1) throw new Error(`${args.help ? '--help' : '--version'} goes alone`)
  if (args.cmd === 'accounts' && (args.from.length || args.to || args.dry || args.cloud || args.remove)) throw new Error('accounts accepts only --json')
  if (args.cmd === 'finish' && (args.from.length || args.to || args.dry || args.cloud || args.remove)) throw new Error('finish accepts only --json')
  if (args.cmd === 'keep-local' && (args.from.length || args.to || args.dry || args.cloud || args.remove)) throw new Error('keep-local accepts only --json')
  if (args.cmd === 'undo' && (args.from.length || args.to || args.dry || args.cloud || args.remove)) throw new Error('undo accepts only --json')
  if (args.cmd === 'menubar' && (args.from.length || args.to || args.dry || args.cloud || args.json)) throw new Error('menubar accepts only --remove')
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
  if (args.cmd === 'keep-local') {
    const result = await keepLocal(paths)
    if (result.recoveryRequired || result.refused || result.ok === false) process.exitCode = 1
    if (args.json) {
      if (result.nothing) return emit({ nothing: true })
      if (result.recoveryRequired) return emit({ done: true, ok: false, recoveryRequired: true, reason: 'Recovery must finish before cloud checks can be cancelled' })
      if (result.refused) return emit({ refused: result.refused, reason: 'Keep local refused because a rescued target failed verification' })
      return emit({ done: true, ok: result.ok, complete: result.complete, keptLocal: result.cancelled, labels: result.labels, failed: [] })
    }
    if (result.nothing) return out.write('nothing pending\n')
    if (result.recoveryRequired) return out.write('  refused     recovery must finish before cloud checks can be cancelled\n')
    if (result.refused) return out.write(`  refused     ${result.refused.join('\n              ')}\n`)
    return out.write(`  kept local  ${quantity(result.cancelled, 'cloud check')} cancelled\n`)
  }
  if (args.cmd === 'finish') {
    const report = reporter(args.json)
    const result = await finishPending(paths, { report })
    if (result.recoveryRequired || result.restoreProblems?.length || result.failed?.length || result.pendingUndo?.length) process.exitCode = 1
    if (args.json) {
      if (result.nothing) return emit({ nothing: true })
      if (result.reconciled) return emit({ done: true, ok: false, recoveryRequired: true, reconciled: result.reconciled })
      if (result.recoveryRequired) return emit({ done: true, ok: false, recoveryRequired: true, reason: 'Recovery remains pending' })
      if (result.dest) return emit({ undone: result.receipt.at, sessions: result.receipt.sessions.length, restored: retiredCount(result.receipt), cloudRestored: result.receipt.remote?.length ?? 0, restart: Boolean(result.receipt.sessions.length || result.receipt.superseded?.length || result.receipt.remote?.length) })
      return emit({
        done: true,
        ok: result.ok,
        complete: result.complete,
        receipt: result.file,
        rescued: result.rescued ?? 0,
        cloudArchived: result.cloudArchived ?? 0,
        cloudRestored: result.remoteRestored ?? 0,
        cloudChecked: result.cloudChecked ?? 0,
        newerCloud: result.newerCloud ?? 0,
        pendingCloud: result.pendingCloud ?? 0,
        pendingUndo: result.pendingUndo ?? [],
        pendingLabels: result.pendingLabels ?? result.pendingUndo ?? [],
        failed: result.failed ?? result.receipt?.failed ?? [],
        problems: result.problems ?? [],
        restart: result.restart ?? false
      })
    }
    if (result.nothing) return out.write('nothing pending\n')
    if (result.reconciled) return out.write(`recovered   ${result.reconciled.title} | ${result.reconciled.error}\n  finish      not run, review the recovery and try again\n`)
    if (result.recoveryRequired) return out.write('  pending     recovery remains incomplete\n')
    if (result.dest) return out.write(`Undo  ${result.receipt.at} completed\n`)
    if (result.pendingUndo?.length) return out.write(`  pending     sign Claude Desktop into ${result.pendingUndo.join(' or ')} and run finish again\n`)
    if (result.failed?.length) out.write(`  failed      ${result.failed.map((failure) => `${failure.title || failure.id} | ${failure.error}`).join('\n              ')}\n`)
    const pending = result.pendingLabels?.length ? ` | ${result.pendingLabels.join(', ')}` : ''
    return out.write(result.complete ? '  cloud       all source checks complete\n' : `  pending     ${result.pendingCloud} cloud checks${pending}\n`)
  }
  if (args.cmd === 'undo') {
    const result = await undo(paths)
    if (result.changed || result.retained || result.restoreProblems || result.reconciled || result.pendingUndo) process.exitCode = 1
    if (args.json) {
      if (result.nothing) return emit({ nothing: true })
      if (result.reconciled) return emit({ reconciled: result.reconciled, retry: true })
      if (result.pendingUndo) return emit({ done: true, ok: true, complete: false, pendingUndo: result.pendingUndo, pendingLabels: result.pendingUndo, cloudRestored: result.remoteRestored ?? 0, note: `sign Claude Desktop into ${result.pendingUndo.join(' or ')} and click Finish pending` })
      if (result.retained) return emit({ refused: result.retained.map((r) => `${r.title || r.id} | ${short(r.targetId)}`), retained: true, at: result.receipt.at })
      if (result.changed) return emit({ refused: result.changed, at: result.receipt.at })
      if (result.restoreProblems) return emit({ refused: result.restoreProblems, reason: 'Undo refused, recovery artifacts are missing or blocked', at: result.receipt.at })
      return emit({
        undone: result.receipt.at,
        quarantine: result.dest,
        sessions: result.receipt.sessions.length,
        restored: retiredCount(result.receipt),
        cloudRestored: result.receipt.remote?.length ?? 0,
        note: NOTE,
        restart: Boolean(result.receipt.sessions.length || result.receipt.superseded?.length || result.receipt.remote?.length)
      })
    }
    if (result.nothing) return out.write('nothing to undo\n')
    if (result.reconciled) return out.write(`reconciled  ${result.reconciled.title} | ${result.reconciled.error}\n  undo        not run, run it again if still wanted\n`)
    const { receipt } = result
    out.write(`Undo  ${receipt.at} | ${receipt.from.join(' + ')} → ${receipt.to}\n`)
    if (result.pendingUndo) return out.write(`  pending     sign Claude Desktop into ${result.pendingUndo.join(' or ')} and run finish\n`)
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
    const rescued = receipt.sessions.filter((row) => row.strategy === 'remote')
    const legacy = receipt.sessions.filter((row) => !['rehome', 'remote'].includes(row.strategy))
    const rehomed = receipt.sessions.length - legacy.length - rescued.length
    const files = legacy.reduce((n, row) => n + row.sidecars.count, 0)
    const back = retiredCount(receipt)
    const cloudBack = receipt.remote?.length ?? 0
    return out.write([
      rehomed ? `  ${count(rehomed)} desktop records → quarantine` : null,
      rescued.length ? `  ${count(rescued.length)} rescued remote transcripts | ${count(rescued.length)} desktop records → quarantine` : null,
      legacy.length ? `  ${count(legacy.length)} legacy transcripts | ${count(files)} sidecar files | ${count(legacy.length)} desktop records → quarantine` : null,
      back ? `  ${count(back)} source records put back` : null,
      cloudBack ? `  ${count(cloudBack)} cloud mirrors restored` : null,
      '  shared transcripts unchanged ✓',
      `  quarantine  ${result.dest}`,
      `  then        ${NOTE}`,
      ''
    ].filter((line) => line !== null).join('\n'))
  }
  const all = await accounts(paths)
  if (args.cmd === 'accounts') {
    if (args.json) {
      const deferred = await deferredWorkflow(paths)
      return emit(all.map(({ account, org, email, orgName, label, stats, active, sessions, unreadable, activeAt }) => {
        const source = deferred?.sources.find((candidate) => sameAccount(candidate, { account, org }))
        return {
          account,
          org,
          email,
          orgName,
          label,
          stats,
          active,
          sessions: sessions.length,
          unreadable: unreadable.length,
          activeAt,
          pending: source ? deferred.mode : null,
          pendingFailures: source?.failures ?? []
        }
      }))
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
  if (new Set(from.map((account) => `${account.account}/${account.org}`)).size !== from.length) throw new Error('from accounts must be unique')
  if (from.includes(to)) throw new Error('to must differ from from')
  const report = reporter(args.json)
  let cloud = null
  let cloudError = null
  if (args.cloud) {
    try { cloud = await cloudClient(paths) } catch (error) { cloudError = error.message }
  }
  const deferred = await deferredWorkflow(paths)
  if (deferred) {
    const labels = deferred.sources.map((source) => source.label).join(', ')
    report('pending', `${deferred.mode === 'undo' ? 'Undo' : 'Cloud checks'} | ${labels}`)
    process.exitCode = 1
    return args.json
      ? emit({ done: true, ok: false, complete: false, pendingCloud: deferred.mode === 'cloud' ? deferred.sources.length : 0, pendingUndo: deferred.mode === 'undo' ? deferred.sources.map((source) => source.label) : [], pendingLabels: deferred.sources.map((source) => source.label), reason: 'Finish or undo the pending move before starting another' })
      : out.write('  pending     finish or undo the pending move before starting another\n')
  }
  if (!args.json) out.write(`From  ${describe(from)}\nTo    ${to.label}\n\n`)
  const plannedCloudPending = (inv) => inv.cloudRequested ? inv.fromAccounts.length - (inv.cloud.checked && !inv.cloud.blocked.length ? 1 : 0) : 0
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
      inv.cloud?.matches.length ? `${count(inv.cloud.matches.length)} cloud mirrors` : null,
      inv.cloud?.matches.some((match) => match.target.kind === 'rescue') ? `${count(inv.cloud.matches.filter((match) => match.target.kind === 'rescue').length)} cloud rescue` : null,
      inv.cloud?.blocked.length ? `${count(inv.cloud.blocked.length)} cloud blocked` : null,
      inv.cloud?.later.length ? `${count(inv.cloud.later.length)} newer cloud sessions left for next move` : null,
      plannedCloudPending(inv) ? `${quantity(plannedCloudPending(inv), 'cloud check')} pending` : null,
      `${count(inv.move.length)} to move`
    ].filter(Boolean).join(' | '))
    if (inv.cloudError) report('cloud', `deferred | ${inv.cloudError}`)
  }
  if (args.dry) {
    const p = await recoveryPending(paths)
    if (p) {
      let text = `${p.receipt?.sessions?.length ?? 0} sessions | interrupted finalization, reconciled on the next move`
      if (p.corrupt) text = `${p.name} | corrupt receipt, set aside on the next move`
      else if (p.receipt.pending) text = `${p.receipt.pending.title} | interrupted ${p.receipt.pending.strategy === 'rehome' ? 'record placement' : p.receipt.pending.strategy === 'remote' ? 'remote rescue' : 'legacy copy'}, reconciled on the next move`
      else if (p.receipt.retiring) text = `${p.receipt.retiring.length} entries | interrupted retirement, reconciled on the next move`
      else if (p.receipt.undoing) text = `${p.receipt.undoing.length} sessions | interrupted undo, reconciled on the next move`
      report('pending', text)
      process.exitCode = 1
      return args.json ? emit({ done: true, ok: false, dry: true, recoveryRequired: true, planned: null }) : out.write('  dry run     plan unavailable until the next move reconciles this state\n')
    }
    const inv = await inventory(from, to, paths, report, { cloud, cloudRequested: args.cloud, cloudError })
    summary(inv)
    const retiring = owners(inv.sources, carrying(inv, inv.move.map((history) => ({ history })))).filter(({ s, owner }) => !retirementOwnership(inv, s, owner)).length
    if (retiring) report('retire', `${count(retiring)} source records once the target records verify`)
    const failures = inventoryFailures(inv)
    if (failures.length) process.exitCode = 1
    return args.json
      ? emit({ done: true, ok: !failures.length, dry: true, moved: 0, planned: inv.move.length, cloudPlanned: inv.cloud.matches.length, cloudRescues: inv.cloud.matches.filter((match) => match.target.kind === 'rescue').length, pendingCloud: plannedCloudPending(inv), retiring, failed: failures })
      : out.write(inv.move.length || retiring ? '  dry run     nothing written\n' : failures.length ? '  dry run     blocked records must be resolved\n' : '  nothing to move\n')
  }
  const result = await locked(paths, async () => {
    const reconciled = await reconcile(paths, { cloud })
    if (reconciled) return { reconciled, recoveryRequired: true, ok: false }
    const latest = await accounts(paths)
    const currentFrom = from.map((account) => fresh(latest, account))
    const currentTo = fresh(latest, to)
    const inv = await inventory(currentFrom, currentTo, paths, report, { writeCache: true, cloud, cloudRequested: args.cloud, cloudError })
    summary(inv)
    return inv.move.length || inv.there.length || inv.cloud.matches.length || inventoryFailures(inv).length || inv.cloudRequested ? transfer(inv, currentTo, paths, report) : null
  })
  if (result?.deferred) {
    const labels = result.deferred.sources.map((source) => source.label)
    process.exitCode = 1
    return args.json
      ? emit({ done: true, ok: false, complete: false, pendingCloud: result.pendingCloud, pendingUndo: result.deferred.mode === 'undo' ? labels : [], pendingLabels: labels, reason: 'Finish or undo the pending move before starting another' })
      : out.write('  pending     finish or undo the pending move before starting another\n')
  }
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
  const note = receipt.sessions.length || receipt.superseded.length || receipt.remote.length ? NOTE : null
  if (args.json) {
    return emit({ done: true, ok, complete: result.complete, receipt: file, moved: receipt.sessions.length, rescued: receipt.sessions.filter((row) => row.strategy === 'remote').length, cloudArchived: receipt.remote.length, newerCloud: result.newerCloud, pendingCloud: result.pendingCloud, pendingLabels: result.pendingLabels, superseded: receipt.superseded.length - retired, retired, failed: receipt.failed, problems, checks, note, restart: Boolean(note) })
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
