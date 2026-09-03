import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { accounts, fork, inventory, layout, move, normalize, semantic, step, undo } from './transplant.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = '00000000-0000-4000-8000-000000000001'
const MESSAGES = new Set(['user', 'assistant', 'attachment', 'system'])
const id = (k) => `00000000-0000-4000-8000-${String(k).padStart(12, '0')}`
const lines = (text) => text.split('\n').filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
const fixture = async (name) => lines(await readFile(path.join(here, 'fixtures', name), 'utf8'))
const entry = (type, k, parent, session, extra = {}) => ({
  type,
  uuid: id(k),
  parentUuid: parent === null ? null : id(parent),
  sessionId: session,
  timestamp: `2026-09-01T00:00:${String(k % 60).padStart(2, '0')}.000Z`,
  cwd: '/tmp/fixture',
  isSidechain: false,
  message: { role: type, content: `message ${k}` },
  ...extra
})
const cli = (home, args) => promisify(execFile)(process.execPath, [path.join(here, 'transplant.js'), ...args], {
  env: { ...process.env, HOME: home },
  cwd: here
}).then((r) => ({ ...r, code: 0 }), (e) => ({ stdout: e.stdout, stderr: e.stderr, code: e.code }))

async function hold(file) {
  const guard = spawn('/usr/bin/lockf', ['-k', '-t', '0', file, '/bin/sh', '-c', 'printf ready; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] })
  await once(guard.stdout, 'data')
  return guard
}

async function duringSecondRead(file, text, action) {
  const first = await open(file, 'w')
  await first.writeFile(text)
  await unlink(file)
  await promisify(execFile)('/usr/bin/mkfifo', [file])
  const secondOpening = open(file, 'w')
  await first.close()
  const second = await secondOpening
  await action()
  await second.writeFile(text)
  await second.close()
  await unlink(file)
  await writeFile(file, text)
}

function shape(entries) {
  const fresh = new Map()
  const swap = (v) => {
    if (typeof v !== 'string' || !/^[0-9a-f-]{36}$/.test(v) || v.startsWith('00000000-0000-4000-8000-')) return v
    if (!fresh.has(v)) fresh.set(v, `#${fresh.size}`)
    return fresh.get(v)
  }
  const last = entries.findLastIndex((e) => MESSAGES.has(e.type))
  return entries.map((raw, i) => {
    const e = JSON.parse(JSON.stringify(raw))
    const out = Object.fromEntries(Object.entries(e).map(([k, v]) => [k, ['uuid', 'parentUuid', 'logicalParentUuid', 'sessionId'].includes(k) ? swap(v) : v]))
    if (!MESSAGES.has(e.type) || i === last) { if ('timestamp' in out) out.timestamp = '<now>'; if ('ts' in out) out.ts = '<now>' }
    return out
  })
}

test('fork matches the official SDK golden', async () => {
  const port = fork(await fixture('source.jsonl'), SOURCE, 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'Fixture moved')
  assert.deepEqual(shape(port), shape(await fixture('fork.jsonl')))
  assert.equal(port.length, 13)
  assert.equal(port[0].type, 'history-suppression')
  assert.equal(port.at(-1).customTitle, 'Fixture moved')
})

test('fork matches the official SDK live', async (t) => {
  try { await import('@anthropic-ai/claude-agent-sdk') } catch (error) { if (process.env.CI) throw error; return t.skip('sdk not installed') }
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ct-')))
  const dir = path.join(root, 'p')
  const config = path.join(root, 'c')
  const project = path.join(config, 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'))
  await mkdir(dir, { recursive: true })
  await mkdir(project, { recursive: true })
  await writeFile(path.join(project, `${SOURCE}.jsonl`), await readFile(path.join(here, 'fixtures', 'source.jsonl')))
  const script = [
    "import { forkSession } from '@anthropic-ai/claude-agent-sdk'",
    `const r = await forkSession(${JSON.stringify(SOURCE)}, { dir: ${JSON.stringify(dir)}, title: 'Fixture moved' })`,
    'console.log(r.sessionId)'
  ].join('\n')
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { cwd: here, env: { ...process.env, CLAUDE_CONFIG_DIR: config } })
  const sdk = lines(await readFile(path.join(project, `${stdout.trim()}.jsonl`), 'utf8'))
  const port = fork(await fixture('source.jsonl'), SOURCE, 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'Fixture moved')
  assert.deepEqual(shape(port), shape(sdk))
})

test('normalize collapses replays and reports conflicts', () => {
  const a = entry('user', 1, null, id(0))
  const b = entry('user', 2, 1, id(0), { toolUseResult: { stdout: '', stderr: '' } })
  const rich = { ...b, toolUseResult: { stdout: 'rich', stderr: '' } }
  const replay = normalize([a, b, rich])
  assert.equal(replay.replays, 1)
  assert.deepEqual(replay.entries, [a, rich])
  const c = entry('assistant', 3, 2, id(0))
  const moved = { ...c, parentUuid: id(1), cwd: '/elsewhere', gitBranch: 'other', slug: 'x', promptId: 'p' }
  assert.equal(normalize([a, b, c, moved]).replays, 1)
  assert.equal(normalize([a, b, { ...b, parentUuid: id(9) }]).conflicts, 1)
  const conflict = normalize([a, b, { ...b, message: { role: 'user', content: 'other' } }])
  assert.equal(conflict.conflicts, 1)
  assert.equal(conflict.entries.length, 3)
})

test('semantic change detection keeps richer output and parse state', () => {
  const a = entry('user', 1, null, id(0))
  const plain = entry('user', 2, 1, id(0), { toolUseResult: { stdout: '', stderr: '' } })
  const rich = { ...plain, toolUseResult: { stdout: 'finished', stderr: '' } }
  assert.notEqual(semantic([a, plain], id(0)), semantic([a, rich], id(0)))
  assert.notEqual(semantic([a, rich], id(0)), semantic([a, rich], id(0), 1))
  const before = [a, rich, { type: 'relocated', sessionId: id(0), relocatedCwd: '/before' }]
  const after = [a, rich, { type: 'relocated', sessionId: id(0), relocatedCwd: '/after' }]
  assert.notEqual(semantic(before, id(0)), semantic(after, id(0)))
})

test('cli exits nonzero on partial failure and undoes over json', async () => {
  const h = await home()
  await writeFile(path.join(h.project, `${SOURCE}.jsonl`), await readFile(path.join(here, 'fixtures', 'source.jsonl')))
  await h.record('P', SOURCE)
  await h.write(id(600), [entry('user', 600, null, id(600))])
  await appendFile(path.join(h.project, `${id(600)}.jsonl`), '{"type":"user","uuid":"broken\n')
  await h.record('P', id(600))
  const run = (args) => cli(h.root, args)
  const orphan = path.join(h.project, `${id(900)}.jsonl`)
  await writeFile(orphan, JSON.stringify({ ...entry('user', 900, null, id(900)), forkedFrom: { sessionId: id(1), messageUuid: id(901) } }) + '\n')
  await mkdir(h.paths.state, { recursive: true })
  const interrupted = {
    at: '2026-01-01T00-00-00-000',
    from: [],
    to: 'x',
    sessions: [],
    failed: [],
    pending: { id: id(900), title: 'Orphan', made: [orphan], events: 1 }
  }
  await writeFile(path.join(h.paths.state, `${interrupted.at}.json`), JSON.stringify(interrupted))
  const dry = await run(['--from', 'p@example.com', '--to', 'z@example.com', '--dry-run', '--json'])
  assert.equal(dry.code, 1)
  assert.ok(dry.stdout.includes('"stage":"pending"'))
  assert.equal(JSON.parse(dry.stdout.trim().split('\n').at(-1)).recoveryRequired, true)
  assert.ok(await readFile(orphan))
  assert.equal(await readdir(path.join(h.paths.state, 'quarantine')).catch(() => 'none'), 'none')
  const list = JSON.parse((await run(['accounts', '--json'])).stdout)
  assert.equal(list.find((a) => a.account === h.acct.P).active, true)
  assert.ok(await readFile(orphan))
  const recovered = await run(['--from', 'p@example.com', '--to', 'z@example.com', '--json'])
  assert.equal(recovered.code, 1)
  const recovery = recovered.stdout.trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(recovery.some((e) => e.stage === 'reconciled'))
  assert.equal(recovery.at(-1).recoveryRequired, true)
  assert.equal(await readFile(orphan).catch(() => 'gone'), 'gone')
  const moved = await run(['--from', 'p@example.com', '--to', 'z@example.com', '--json'])
  assert.equal(moved.code, 1)
  const events = moved.stdout.trim().split('\n').map((l) => JSON.parse(l))
  const done = events.at(-1)
  assert.equal(done.ok, false)
  assert.equal(done.moved, 1)
  assert.equal(done.failed.length, 1)
  assert.equal(done.restart, true)
  const rejected = await run(['undo', '--dry-run'])
  assert.equal(rejected.code, 1)
  assert.match(rejected.stderr, /undo accepts only --json/)
  const undone = await run(['undo', '--json'])
  assert.equal(undone.code, 0)
  assert.equal(JSON.parse(undone.stdout.trim().split('\n').at(-1)).sessions, 1)
})

test('a second move cannot cross the kernel lock', async () => {
  const h = await home()
  await h.write(id(999), [entry('user', 999, null, id(999))])
  await h.record('P', id(999))
  await mkdir(h.paths.state, { recursive: true })
  const guard = await hold(path.join(h.paths.state, 'lock'))
  try {
    const result = await cli(h.root, ['--from', 'p@example.com', '--to', 'z@example.com', '--json'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /another run holds the lock/)
    assert.equal((await readdir(h.dir('Z'))).length, 0)
  } finally {
    const exited = once(guard, 'exit')
    guard.stdin.end()
    await exited
  }
})

test('unreadable Desktop records are counted and fail the move', async () => {
  const h = await home()
  const file = path.join(h.dir('P'), `local_${id(934)}.json`)
  const target = path.join(h.dir('Z'), `local_${id(933)}.json`)
  await writeFile(file, '{broken')
  await writeFile(target, '{broken')
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  assert.deepEqual(by[h.acct.P].unreadable, [file])
  assert.match(by[h.acct.P].stats, /1 unreadable/)
  const inv = await inventory([by[h.acct.P]], by[h.acct.Z], h.paths)
  assert.equal(inv.total, 1)
  assert.equal(inv.unreadable.length, 2)
  const result = await move(inv, by[h.acct.Z], h.paths)
  assert.equal(result.ok, false)
  assert.deepEqual(result.receipt.failed.map((failure) => failure.error), ['unreadable Desktop record', 'unreadable Desktop record'])
})

test('an invalid duplicate is refused, never hidden behind a valid twin', async () => {
  const h = await home()
  const k1 = [entry('user', 950, null, id(950)), entry('assistant', 951, 950, id(950))]
  await h.write(id(950), k1)
  await h.record('P', id(950))
  await h.write(id(960), fork(k1, id(950), id(960), 'K'))
  await appendFile(path.join(h.project, `${id(960)}.jsonl`), '{"type":"user","uuid":"broken\n')
  await h.record('T', id(960))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const inv = await inventory([by[h.acct.P], by[h.acct.T]], by[h.acct.Z], h.paths)
  assert.deepEqual(inv.move.map((s) => s.id).sort(), [id(950), id(960)])
  const result = await move(inv, by[h.acct.Z], h.paths)
  assert.deepEqual(result.receipt.failed.map((f) => f.error), ['1 unparseable lines'])
  assert.equal(result.receipt.sessions.length, 1)
})

test('same-root histories with different content are never folded together', async () => {
  const h = await home()
  const source = [entry('user', 940, null, id(940)), entry('assistant', 941, 940, id(940))]
  await h.write(id(940), source)
  await h.record('P', id(940))
  const changed = fork(source, id(940), id(945), 'Changed')
  changed.push({ type: 'content-replacement', sessionId: id(945), replacements: [{ uuid: id(940), text: 'different' }], uuid: id(946), timestamp: '2026-09-01T00:00:46.000Z' })
  await h.write(id(945), changed)
  await h.record('T', id(945))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const inv = await inventory([by[h.acct.P], by[h.acct.T]], by[h.acct.Z], h.paths)
  assert.equal(inv.twice, 0)
  assert.equal(inv.apart, 2)
  assert.deepEqual(inv.move.map((s) => s.id).sort(), [id(940), id(945)])
})

test('same-root history with richer tool output replaces the empty version', async () => {
  const h = await home()
  const source = [entry('user', 942, null, id(942), { toolUseResult: { stdout: '', stderr: '' } })]
  await h.write(id(942), source)
  await h.record('P', id(942))
  const richer = fork(source, id(942), id(943), 'Richer')
  richer[0].toolUseResult = { stdout: 'finished', stderr: '' }
  await h.write(id(943), richer)
  await h.record('T', id(943))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const inv = await inventory([by[h.acct.P], by[h.acct.T]], by[h.acct.Z], h.paths)
  assert.deepEqual(inv.move.map((s) => s.id), [id(943)])
  assert.equal(inv.twice, 1)
})

test('runtime latch drift does not create another history', async () => {
  const h = await home()
  const source = [entry('user', 944, null, id(944)), { type: 'atis-latch', sessionId: id(944), atis: 'first' }]
  await h.write(id(944), source)
  await h.record('P', id(944))
  const copy = [...fork(source, id(944), id(947), 'Latch'), { type: 'atis-latch', sessionId: id(947), atis: 'second' }]
  await h.write(id(947), copy)
  await h.record('T', id(947))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const inv = await inventory([by[h.acct.P], by[h.acct.T]], by[h.acct.Z], h.paths)
  assert.equal(inv.move.length, 1)
  assert.equal(inv.twice, 1)
})

test('different relocation state keeps both histories', async () => {
  const h = await home()
  const source = [entry('user', 948, null, id(948)), { type: 'relocated', sessionId: id(948), relocatedCwd: '/first' }]
  await h.write(id(948), source)
  await h.record('P', id(948))
  const copy = [...fork(source, id(948), id(949), 'Relocated'), { type: 'relocated', sessionId: id(949), relocatedCwd: '/second' }]
  await h.write(id(949), copy)
  await h.record('T', id(949))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const inv = await inventory([by[h.acct.P], by[h.acct.T]], by[h.acct.Z], h.paths)
  assert.deepEqual(inv.move.map((s) => s.id).sort(), [id(948), id(949)])
})

test('a conflicting same-root history is refused instead of hidden', async () => {
  const h = await home()
  const source = [entry('user', 935, null, id(935)), entry('assistant', 936, 935, id(935))]
  await h.write(id(935), source)
  await h.record('P', id(935))
  const conflict = fork(source, id(935), id(937), 'Conflict')
  const repeated = conflict.find((e) => e.type === 'assistant')
  conflict.push({ ...repeated, message: { role: 'assistant', content: 'different' } })
  await h.write(id(937), conflict)
  await h.record('T', id(937))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const inv = await inventory([by[h.acct.P], by[h.acct.T]], by[h.acct.Z], h.paths)
  assert.deepEqual(inv.move.map((s) => s.id).sort(), [id(935), id(937)])
  const result = await move(inv, by[h.acct.Z], h.paths)
  assert.deepEqual(result.receipt.failed.map((f) => f.error), ['1 conflicting duplicate uuids'])
})

test('a fuller version supersedes the copy this tool made, even across diverged branches, and undo restores it', async () => {
  const h = await home()
  const l1 = [entry('user', 970, null, id(970)), entry('assistant', 971, 970, id(970))]
  await h.write(id(970), l1)
  await h.record('P', id(970))
  const pick = async () => { const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a])); return { from: [by[h.acct.P], by[h.acct.T]], to: by[h.acct.Z] } }
  let p = await pick()
  const first = await move(await inventory(p.from, p.to, h.paths), p.to, h.paths)
  const older = first.receipt.sessions[0].targetId
  await appendFile(path.join(h.project, `${id(970)}.jsonl`), JSON.stringify(entry('user', 972, 971, id(970))) + '\n')
  await h.record('P', id(970))
  await h.write(id(975), [...fork(l1, id(970), id(975), 'L'), entry('user', 973, null, id(975))])
  await h.record('T', id(975))
  p = await pick()
  const inv = await inventory(p.from, p.to, h.paths)
  assert.equal(inv.apart, 2)
  assert.deepEqual(inv.move.map((s) => s.id).sort(), [id(970), id(975)])
  const second = await move(inv, p.to, h.paths)
  assert.equal(second.ok, true)
  assert.equal(second.receipt.sessions.length, 2)
  assert.deepEqual(second.receipt.superseded.filter((s) => !s.source).map((s) => s.id), [older])
  assert.deepEqual(second.receipt.superseded.filter((s) => s.source).map((s) => s.id).sort(), [id(970), id(975)])
  assert.equal(second.receipt.retiring, null)
  assert.deepEqual(await readdir(h.dir('P')), [])
  assert.deepEqual(await readdir(h.dir('T')), [])
  assert.ok(await readFile(path.join(h.project, `${id(970)}.jsonl`), 'utf8'))
  const records = async () => (await readdir(h.dir('Z'))).map((f) => f.slice(6, -5)).sort()
  assert.deepEqual(await records(), second.receipt.sessions.map((r) => r.targetId).sort())
  const dummy = path.join(h.project, 'dummy.txt')
  await writeFile(dummy, 'x')
  const retirement = {
    at: '2099-01-01T00-00-00-000',
    from: [],
    to: 'x',
    sessions: [],
    failed: [],
    superseded: [],
    retiring: [{ id: 'd', title: 'd', by: 'e', moved: [[dummy, path.join(h.paths.state, 'quarantine', 'x', 'dummy.txt')]] }]
  }
  await writeFile(path.join(h.paths.state, `${retirement.at}.json`), JSON.stringify(retirement))
  const recovered = await undo(h.paths)
  assert.ok(recovered.reconciled)
  assert.match(recovered.reconciled.error, /retirement rolled back/)
  const undone = await undo(h.paths)
  assert.ok(undone.dest)
  assert.equal(JSON.parse(await readFile(path.join(undone.dest, 'receipt.json'), 'utf8')).superseded.length, 0)
  assert.equal(await readFile(dummy, 'utf8'), 'x')
  assert.ok((await undo(h.paths)).dest)
  assert.deepEqual(await records(), [older])
  assert.equal((await readdir(h.dir('P'))).length + (await readdir(h.dir('T'))).length, 2)
})

test('a new sidecar copy supersedes the equal-root copy this tool made', async () => {
  const h = await home()
  const n1 = [entry('user', 985, null, id(985)), entry('assistant', 986, 985, id(985))]
  await h.write(id(985), n1)
  await h.record('P', id(985))
  const pick = async () => { const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a])); return { from: [by[h.acct.P]], to: by[h.acct.Z] } }
  let p = await pick()
  const first = await move(await inventory(p.from, p.to, h.paths), p.to, h.paths)
  const older = first.receipt.sessions[0].targetId
  await mkdir(path.join(h.project, id(985), 'subagents'), { recursive: true })
  await writeFile(path.join(h.project, id(985), 'subagents', 'agent-n.jsonl'), '{"agent":"n"}\n')
  await h.record('P', id(985))
  p = await pick()
  const inv = await inventory(p.from, p.to, h.paths)
  assert.equal(inv.there.length, 0)
  assert.deepEqual(inv.move.map((s) => s.id), [id(985)])
  const second = await move(inv, p.to, h.paths)
  assert.equal(second.ok, true)
  assert.deepEqual(second.receipt.superseded.filter((s) => !s.source).map((s) => s.id), [older])
  assert.deepEqual((await readdir(h.dir('Z'))).map((f) => f.slice(6, -5)), [second.receipt.sessions[0].targetId])
})

test('nested histories merge non-conflicting sidecars into one destination', async () => {
  const h = await home()
  const base = [entry('user', 860, null, id(860)), entry('assistant', 861, 860, id(860))]
  await h.write(id(860), base)
  await h.record('P', id(860))
  await mkdir(path.join(h.project, id(860), 'subagents'), { recursive: true })
  await writeFile(path.join(h.project, id(860), 'subagents', 'old.jsonl'), '{"old":true}\n')
  await h.write(id(870), [...fork(base, id(860), id(870), 'Merged'), entry('user', 862, null, id(870))])
  await h.record('T', id(870))
  await mkdir(path.join(h.project, id(870), 'subagents'), { recursive: true })
  await writeFile(path.join(h.project, id(870), 'subagents', 'new.jsonl'), '{"new":true}\n')
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const inv = await inventory([by[h.acct.P], by[h.acct.T]], by[h.acct.Z], h.paths)
  assert.equal(inv.twice, 1)
  assert.deepEqual(inv.move.map((s) => s.id), [id(870)])
  assert.equal(inv.move[0].sidecar.count, 2)
  const result = await move(inv, by[h.acct.Z], h.paths)
  assert.equal(result.ok, true)
  assert.deepEqual(await readdir(path.join(result.receipt.sessions[0].targetDir, 'subagents')), ['new.jsonl', 'old.jsonl'])
  assert.deepEqual(await readdir(h.dir('P')), [])
  assert.deepEqual(await readdir(h.dir('T')), [])
})

test('a conflicting sidecar path keeps both nested histories', async () => {
  const h = await home()
  const base = [entry('user', 880, null, id(880)), entry('assistant', 881, 880, id(880))]
  await h.write(id(880), base)
  await h.record('P', id(880))
  await mkdir(path.join(h.project, id(880), 'subagents'), { recursive: true })
  await writeFile(path.join(h.project, id(880), 'subagents', 'agent.jsonl'), '{"version":1}\n')
  await h.write(id(890), [...fork(base, id(880), id(890), 'Conflict'), entry('user', 882, null, id(890))])
  await h.record('T', id(890))
  await mkdir(path.join(h.project, id(890), 'subagents'), { recursive: true })
  await writeFile(path.join(h.project, id(890), 'subagents', 'agent.jsonl'), '{"version":2}\n')
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const inv = await inventory([by[h.acct.P], by[h.acct.T]], by[h.acct.Z], h.paths)
  assert.equal(inv.twice, 0)
  assert.deepEqual(inv.move.map((s) => s.id).sort(), [id(880), id(890)].sort())
})

test('sidecar drift after inventory cannot retire the complete target copy', async () => {
  const h = await home()
  const source = [entry('user', 987, null, id(987)), entry('assistant', 988, 987, id(987))]
  await h.write(id(987), source)
  const sidecar = path.join(h.project, id(987), 'subagents', 'agent.jsonl')
  await mkdir(path.dirname(sidecar), { recursive: true })
  await writeFile(sidecar, '{"agent":true}\n')
  await h.record('P', id(987))
  const pick = async () => { const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a])); return { from: [by[h.acct.P]], to: by[h.acct.Z] } }
  let p = await pick()
  const first = await move(await inventory(p.from, p.to, h.paths), p.to, h.paths)
  const older = first.receipt.sessions[0].targetId
  await appendFile(path.join(h.project, `${id(987)}.jsonl`), JSON.stringify(entry('user', 989, 988, id(987))) + '\n')
  await h.record('P', id(987))
  p = await pick()
  const inv = await inventory(p.from, p.to, h.paths)
  await unlink(sidecar)
  const second = await move(inv, p.to, h.paths)
  assert.equal(second.ok, false)
  assert.match(second.receipt.failed[0].error, /source sidecars changed since inventory/)
  assert.deepEqual(second.receipt.superseded, [])
  assert.ok((await readdir(h.dir('Z'))).includes(`local_${older}.json`))
})

test('a version this tool never made is superseded when the fuller one lands', async () => {
  const h = await home()
  const q1 = [entry('user', 940, null, id(940)), entry('assistant', 941, 940, id(940))]
  await h.write(id(940), [...q1, entry('user', 942, 941, id(940))])
  await h.record('P', id(940))
  await h.write(id(945), fork(q1, id(940), id(945), 'Q'))
  await h.record('Z', id(945))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const inv = await inventory([by[h.acct.P]], by[h.acct.Z], h.paths)
  assert.deepEqual(inv.move.map((s) => s.id), [id(940)])
  const result = await move(inv, by[h.acct.Z], h.paths)
  assert.equal(result.ok, true)
  assert.deepEqual(result.receipt.superseded.filter((s) => !s.source).map((s) => s.id), [id(945)])
  assert.deepEqual((await readdir(h.dir('Z'))).map((f) => f.slice(6, -5)), [result.receipt.sessions[0].targetId])
  assert.deepEqual(await readdir(h.dir('P')), [])
  assert.ok((await undo(h.paths)).dest)
  assert.deepEqual((await readdir(h.dir('Z'))).map((f) => f.slice(6, -5)), [id(945)])
  assert.equal((await readdir(h.dir('P'))).length, 1)
})

test('stale source entries retire when the destination already holds them', async () => {
  const h = await home()
  await h.write(id(960), [entry('user', 960, null, id(960)), entry('assistant', 961, 960, id(960))])
  await h.record('P', id(960))
  const pick = async () => { const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a])); return { from: [by[h.acct.P]], to: by[h.acct.Z] } }
  let p = await pick()
  const first = await move(await inventory(p.from, p.to, h.paths), p.to, h.paths)
  assert.equal(first.receipt.sessions.length, 1)
  await h.record('P', id(960))
  p = await pick()
  const inv = await inventory(p.from, p.to, h.paths)
  assert.equal(inv.move.length, 0)
  assert.equal(inv.there.length, 1)
  const stages = []
  const second = await move(inv, p.to, h.paths, (stage, text) => stages.push(`${stage} ${text}`))
  assert.deepEqual(stages, ['retired 1 source records → quarantine | transcripts untouched'])
  assert.equal(second.receipt.sessions.length, 0)
  assert.deepEqual(await readdir(h.dir('P')), [])
  assert.ok(await readFile(path.join(h.project, `${id(960)}.jsonl`), 'utf8'))
  assert.equal((await readdir(h.dir('Z'))).length, 1)
  assert.ok((await undo(h.paths)).dest)
  assert.equal((await readdir(h.dir('P'))).length, 1)
  assert.equal((await readdir(h.dir('Z'))).length, 1)
})

test('a vanished existing destination keeps the source entry', async () => {
  const h = await home()
  await h.write(id(920), [entry('user', 920, null, id(920))])
  await h.record('P', id(920))
  const pick = async () => { const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a])); return { from: [by[h.acct.P]], to: by[h.acct.Z] } }
  let p = await pick()
  const first = await move(await inventory(p.from, p.to, h.paths), p.to, h.paths)
  await h.record('P', id(920))
  p = await pick()
  const inv = await inventory(p.from, p.to, h.paths)
  assert.equal(inv.there.length, 1)
  await unlink(first.receipt.sessions[0].targetTranscript)
  const second = await move(inv, p.to, h.paths)
  assert.equal(second.ok, false)
  assert.match(second.receipt.failed[0].error, /destination changed since inventory/)
  assert.equal((await readdir(h.dir('P'))).length, 1)
})

test('undo refuses before removing the destination when a source recovery artifact is missing', async () => {
  const h = await home()
  await h.write(id(921), [entry('user', 921, null, id(921))])
  await h.record('P', id(921))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const result = await move(await inventory([by[h.acct.P]], by[h.acct.Z], h.paths), by[h.acct.Z], h.paths)
  const [original, parked] = result.receipt.superseded.find((row) => row.source).moved[0]
  await unlink(parked)
  const refused = await undo(h.paths)
  assert.match(refused.restoreProblems[0], /recovery artifact missing/)
  assert.ok(await readFile(result.receipt.sessions[0].record))
  assert.deepEqual(await readdir(h.dir('P')), [])
  await writeFile(original, '{broken')
  const corrupt = await undo(h.paths)
  assert.match(corrupt.restoreProblems[0], /recovery artifact changed/)
  assert.ok(await readFile(result.receipt.sessions[0].record))
})

test('ownership locks keep source and contained target records', async () => {
  const h = await home()
  const base = [entry('user', 922, null, id(922))]
  await h.write(id(922), [...base, entry('assistant', 923, 922, id(922)), { type: 'bridge-session', sessionId: id(922), bridgeSessionId: 'remote' }])
  await h.record('P', id(922))
  await h.write(id(924), fork(base, id(922), id(924), 'Owned'))
  await h.record('Z', id(924))
  await writeFile(path.join(h.dir('Z'), 'scheduled-tasks.json'), JSON.stringify({ scheduledTasks: [{ id: 'task', notifySessionId: `local_${id(924)}` }] }))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const result = await move(await inventory([by[h.acct.P]], by[h.acct.Z], h.paths), by[h.acct.Z], h.paths)
  assert.equal(result.ok, false)
  assert.deepEqual(result.receipt.failed.map((row) => row.error).sort(), ['scheduled task registry kept in destination', 'transcript bridge kept in source'])
  assert.equal((await readdir(h.dir('P'))).length, 1)
  assert.ok((await readdir(h.dir('Z'))).includes(`local_${id(924)}.json`))
})

test('an unreadable scheduled task registry fails closed', async () => {
  const h = await home()
  await h.write(id(929), [entry('user', 929, null, id(929))])
  await h.record('P', id(929))
  const taskFile = path.join(h.dir('P'), 'scheduled-tasks.json')
  await writeFile(taskFile, '[]')
  await assert.rejects(accounts(h.paths), /invalid scheduled task registry/)
  await writeFile(taskFile, JSON.stringify({ scheduledTasks: [] }))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const inv = await inventory([by[h.acct.P]], by[h.acct.Z], h.paths)
  await assert.rejects(move(inv, by[h.acct.Z], h.paths, (stage) => {
    if (stage === 'sidecars') writeFileSync(taskFile, '{broken')
  }), /unreadable scheduled task registry/)
  assert.equal((await readdir(h.dir('P'))).filter((file) => file.startsWith('local_')).length, 1)
})

test('undo refuses sidecar and Desktop record changes', async () => {
  const h = await home()
  await h.write(id(925), [entry('user', 925, null, id(925))])
  await mkdir(path.join(h.project, id(925), 'subagents'), { recursive: true })
  await writeFile(path.join(h.project, id(925), 'subagents', 'before.jsonl'), 'before\n')
  await h.record('P', id(925))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const result = await move(await inventory([by[h.acct.P]], by[h.acct.Z], h.paths), by[h.acct.Z], h.paths)
  const row = result.receipt.sessions[0]
  await writeFile(path.join(row.targetDir, 'subagents', 'after.jsonl'), 'after\n')
  const changedRecord = JSON.parse(await readFile(row.record, 'utf8'))
  changedRecord.title = 'changed after move'
  await writeFile(row.record, JSON.stringify(changedRecord))
  const refused = await undo(h.paths)
  assert.match(refused.changed[0], /sidecars, desktop record changed/)
  assert.ok(await readFile(row.record))
})

test('undo allows harmless Desktop focus drift', async () => {
  const h = await home()
  await h.write(id(928), [entry('user', 928, null, id(928))])
  await h.record('P', id(928))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const result = await move(await inventory([by[h.acct.P]], by[h.acct.Z], h.paths), by[h.acct.Z], h.paths)
  const row = result.receipt.sessions[0]
  const focused = JSON.parse(await readFile(row.record, 'utf8'))
  focused.lastFocusedAt++
  await writeFile(row.record, JSON.stringify(focused))
  assert.ok((await undo(h.paths)).dest)
})

test('retirement records the exact bytes after harmless source focus drift', async () => {
  const h = await home()
  await h.write(id(928), [entry('user', 928, null, id(928))])
  await h.record('P', id(928))
  const sourceRecord = path.join(h.dir('P'), `local_${id(928)}.json`)
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const result = await move(await inventory([by[h.acct.P]], by[h.acct.Z], h.paths), by[h.acct.Z], h.paths, (stage) => {
    if (stage !== 'sidecars') return
    const focused = JSON.parse(readFileSync(sourceRecord, 'utf8'))
    writeFileSync(sourceRecord, JSON.stringify({ ...focused, lastFocusedAt: focused.lastFocusedAt + 1 }))
  })
  assert.equal(result.ok, true)
  assert.ok((await undo(h.paths)).dest)
  assert.equal(JSON.parse(await readFile(sourceRecord, 'utf8')).lastFocusedAt, 3)
})

test('one shared transcript retires every owning source record', async () => {
  const h = await home()
  await h.write(id(926), [entry('user', 926, null, id(926))])
  await h.record('P', id(926))
  await h.record('T', id(926))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const inv = await inventory([by[h.acct.P], by[h.acct.T]], by[h.acct.Z], h.paths)
  assert.equal(inv.sources.length, 2)
  assert.equal(inv.move.length, 1)
  const result = await move(inv, by[h.acct.Z], h.paths)
  assert.equal(result.ok, true)
  assert.equal(result.receipt.superseded.filter((row) => row.source).length, 2)
  assert.deepEqual(await readdir(h.dir('P')), [])
  assert.deepEqual(await readdir(h.dir('T')), [])
})

test('insufficient disk space fails before writing', async () => {
  const h = await home()
  await h.write(id(927), [entry('user', 927, null, id(927))])
  await h.record('P', id(927))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const inv = await inventory([by[h.acct.P]], by[h.acct.Z], h.paths)
  await assert.rejects(move(inv, by[h.acct.Z], { ...h.paths, freeBytes: async () => 0 }), /insufficient disk space/)
  assert.equal((await readdir(h.dir('P'))).length, 1)
  assert.deepEqual(await readdir(h.dir('Z')), [])
})

test('a source that changed after the plan keeps its entry', async () => {
  const h = await home()
  await h.write(id(930), [entry('user', 930, null, id(930)), entry('assistant', 931, 930, id(930))])
  await h.record('P', id(930))
  const pick = async () => { const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a])); return { from: [by[h.acct.P]], to: by[h.acct.Z] } }
  let p = await pick()
  await move(await inventory(p.from, p.to, h.paths), p.to, h.paths)
  await h.record('P', id(930))
  p = await pick()
  const inv = await inventory(p.from, p.to, h.paths)
  assert.equal(inv.there.length, 1)
  await appendFile(path.join(h.project, `${id(930)}.jsonl`), JSON.stringify(entry('user', 932, 931, id(930))) + '\n')
  const result = await move(inv, p.to, h.paths)
  assert.equal(result.ok, false)
  assert.match(result.receipt.failed[0].error, /source changed/)
  assert.equal((await readdir(h.dir('P'))).length, 1)
})

test('a source changing inside the final retirement guard stays visible', async () => {
  const h = await home()
  const session = id(938)
  const transcript = path.join(h.project, `${session}.jsonl`)
  const record = path.join(h.dir('P'), `local_${session}.json`)
  const taskFile = path.join(h.dir('P'), 'scheduled-tasks.json')
  const validTasks = JSON.stringify({ scheduledTasks: [] })
  await h.write(session, [entry('user', 938, null, session)])
  await h.record('P', session)
  await writeFile(taskFile, validTasks)
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const inv = await inventory([by[h.acct.P]], by[h.acct.Z], h.paths)
  await unlink(taskFile)
  await promisify(execFile)('/usr/bin/mkfifo', [taskFile])
  const coordinate = duringSecondRead(taskFile, validTasks, () => appendFile(transcript, `${JSON.stringify(entry('user', 939, 938, session))}\n`))
  const result = await move(inv, by[h.acct.Z], h.paths)
  await coordinate
  assert.equal(result.ok, false)
  assert.match(result.receipt.failed[0].error, /source changed during retirement/)
  assert.ok(await readFile(record))
})

test('a Desktop record changing inside the final guard stays visible and undoable', async () => {
  const h = await home()
  const session = id(936)
  const record = path.join(h.dir('P'), `local_${session}.json`)
  const taskFile = path.join(h.dir('P'), 'scheduled-tasks.json')
  const validTasks = JSON.stringify({ scheduledTasks: [] })
  await h.write(session, [entry('user', 936, null, session)])
  await h.record('P', session)
  await writeFile(taskFile, validTasks)
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const inv = await inventory([by[h.acct.P]], by[h.acct.Z], h.paths)
  await unlink(taskFile)
  await promisify(execFile)('/usr/bin/mkfifo', [taskFile])
  const coordinate = duringSecondRead(taskFile, validTasks, async () => {
    const current = JSON.parse(await readFile(record, 'utf8'))
    await writeFile(record, JSON.stringify({ ...current, title: 'changed inside final guard' }))
  })
  const result = await move(inv, by[h.acct.Z], h.paths)
  await coordinate
  assert.equal(result.ok, false)
  assert.match(result.receipt.failed[0].error, /retirement artifact changed/)
  assert.equal(JSON.parse(await readFile(record, 'utf8')).title, 'changed inside final guard')
  assert.ok((await undo(h.paths)).dest)
})

test('unsupported sidecar entries name the path instead of looking like drift', async () => {
  const h = await home()
  await h.write(id(984), [entry('user', 984, null, id(984))])
  const dir = path.join(h.project, id(984))
  await mkdir(dir, { recursive: true })
  await symlink('/tmp', path.join(dir, 'linked'))
  await h.record('P', id(984))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const inv = await inventory([by[h.acct.P]], by[h.acct.Z], h.paths)
  assert.match(inv.rejected[0].error, /unsupported entry .*linked/)
  const result = await move(inv, by[h.acct.Z], h.paths)
  assert.equal(result.validationOnly, true)
  assert.equal(result.receipt.failed[0].id, id(984))
})

test('versions that grew apart both move and are counted', async () => {
  const h = await home()
  const m1 = [entry('user', 980, null, id(980)), entry('assistant', 981, 980, id(980))]
  await h.write(id(980), [...m1, entry('user', 982, 981, id(980))])
  await h.record('P', id(980))
  await h.write(id(990), [...fork(m1, id(980), id(990), 'M'), entry('user', 983, null, id(990))])
  await h.record('T', id(990))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const inv = await inventory([by[h.acct.P], by[h.acct.T]], by[h.acct.Z], h.paths)
  assert.equal(inv.apart, 2)
  assert.deepEqual(inv.move.map((s) => s.id).sort(), [id(980), id(990)])
})

test('real-shape sync replays collapse without conflicts', async () => {
  const shaped = normalize(await fixture('replay.jsonl'))
  assert.equal(shaped.replays, 20)
  assert.equal(shaped.conflicts, 0)
})

test('verification catches target corruption and identifies the copy', async () => {
  const h = await home()
  await h.write(id(930), [entry('user', 930, null, id(930)), entry('assistant', 931, 930, id(930))])
  await h.record('P', id(930))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const inv = await inventory([by[h.acct.P]], by[h.acct.Z], h.paths)
  const result = await move(inv, by[h.acct.Z], h.paths, (stage) => {
    if (stage !== 'sidecars') return
    const target = readdirSync(h.project).find((name) => name.endsWith('.jsonl') && name !== `${id(930)}.jsonl`)
    appendFileSync(path.join(h.project, target), '{broken\n')
  })
  assert.equal(result.ok, false)
  assert.equal(result.problems[0].id, result.receipt.sessions[0].targetId)
  assert.equal(result.problems[0].check, 'provenance')
})

test('verification catches richer source output added after copying', async () => {
  const h = await home()
  const source = [entry('user', 925, null, id(925)), entry('user', 926, 925, id(925), { toolUseResult: { stdout: '', stderr: '' } })]
  await h.write(id(925), source)
  await h.record('P', id(925))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const inv = await inventory([by[h.acct.P]], by[h.acct.Z], h.paths)
  const result = await move(inv, by[h.acct.Z], h.paths, (stage) => {
    if (stage === 'sidecars') appendFileSync(path.join(h.project, `${id(925)}.jsonl`), JSON.stringify({ ...source[1], toolUseResult: { stdout: 'finished', stderr: '' } }) + '\n')
  })
  assert.equal(result.ok, false)
  assert.ok(result.problems.some((p) => p.check === 'sources'))
})

test('verification catches source relocation after copying', async () => {
  const h = await home()
  const source = [entry('user', 923, null, id(923)), { type: 'relocated', sessionId: id(923), relocatedCwd: '/before' }]
  await h.write(id(923), source)
  await h.record('P', id(923))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const inv = await inventory([by[h.acct.P]], by[h.acct.Z], h.paths)
  const result = await move(inv, by[h.acct.Z], h.paths, (stage) => {
    if (stage === 'sidecars') appendFileSync(path.join(h.project, `${id(923)}.jsonl`), JSON.stringify({ type: 'relocated', sessionId: id(923), relocatedCwd: '/after' }) + '\n')
  })
  assert.equal(result.ok, false)
  assert.ok(result.problems.some((p) => p.check === 'sources'))
})

test('old receipts use their byte hash instead of a newer semantic algorithm', async () => {
  const h = await home()
  await h.write(id(920), [entry('user', 920, null, id(920))])
  await h.record('P', id(920))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const result = await move(await inventory([by[h.acct.P]], by[h.acct.Z], h.paths), by[h.acct.Z], h.paths)
  const receipt = JSON.parse(await readFile(result.file, 'utf8'))
  delete receipt.sessions[0].targetSemanticVersion
  await writeFile(result.file, JSON.stringify(receipt))
  await appendFile(result.receipt.sessions[0].targetTranscript, JSON.stringify({ type: 'mode', sessionId: result.receipt.sessions[0].targetId, mode: 'x' }) + '\n')
  assert.equal((await undo(h.paths)).changed.length, 1)
})

test('interrupted finalization rolls back untouched copies', async () => {
  const h = await home()
  await h.write(id(910), [entry('user', 910, null, id(910))])
  await h.record('P', id(910))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const result = await move(await inventory([by[h.acct.P]], by[h.acct.Z], h.paths), by[h.acct.Z], h.paths)
  const receipt = JSON.parse(await readFile(result.file, 'utf8'))
  receipt.finalizing = true
  receipt.verification = null
  await writeFile(result.file, JSON.stringify(receipt))
  const target = result.receipt.sessions[0].targetTranscript
  await undo(h.paths)
  assert.equal(await readFile(target).catch(() => 'gone'), 'gone')
})

test('finalization recovery resumes after parking only the target transcript', async () => {
  const h = await home()
  await h.write(id(919), [entry('user', 919, null, id(919))])
  await h.record('P', id(919))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const result = await move(await inventory([by[h.acct.P]], by[h.acct.Z], h.paths), by[h.acct.Z], h.paths)
  const receipt = JSON.parse(await readFile(result.file, 'utf8'))
  receipt.finalizing = true
  await writeFile(result.file, JSON.stringify(receipt))
  const source = receipt.superseded.find((item) => item.source).moved[0]
  await rename(source[1], source[0])
  const row = receipt.sessions[0]
  const failed = path.join(h.paths.state, 'quarantine', receipt.at, 'failed')
  await mkdir(failed, { recursive: true })
  await rename(row.targetTranscript, path.join(failed, path.basename(row.targetTranscript)))
  const recovered = await undo(h.paths)
  assert.match(recovered.reconciled.error, /finalization rolled back/)
  assert.equal(await readFile(row.targetTranscript).catch(() => null), null)
  assert.equal(await readFile(row.record).catch(() => null), null)
  assert.ok(await readFile(path.join(failed, path.basename(row.targetTranscript))))
  assert.ok(await readFile(path.join(failed, path.basename(row.record))))
})

test('blocked finalization recovery puts its partially parked target back', async () => {
  const h = await home()
  await h.write(id(917), [entry('user', 917, null, id(917))])
  await h.record('P', id(917))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const result = await move(await inventory([by[h.acct.P]], by[h.acct.Z], h.paths), by[h.acct.Z], h.paths)
  const receipt = JSON.parse(await readFile(result.file, 'utf8'))
  receipt.finalizing = true
  await writeFile(result.file, JSON.stringify(receipt))
  const source = receipt.superseded.find((item) => item.source).moved[0]
  await rename(source[1], source[0])
  const row = receipt.sessions[0]
  const failed = path.join(h.paths.state, 'quarantine', receipt.at, 'failed')
  await mkdir(failed, { recursive: true })
  await rename(row.targetTranscript, path.join(failed, path.basename(row.targetTranscript)))
  const changed = JSON.parse(await readFile(row.record, 'utf8'))
  await writeFile(row.record, JSON.stringify({ ...changed, title: 'changed during recovery' }))
  const recovered = await undo(h.paths)
  assert.match(recovered.reconciled.error, /changed copies left in place/)
  assert.ok(await readFile(row.targetTranscript))
  assert.ok(await readFile(row.record))
  assert.equal(await readFile(path.join(failed, path.basename(row.targetTranscript))).catch(() => null), null)
})

test('interrupted undo resumes from its journal', async () => {
  const h = await home()
  await h.write(id(918), [entry('user', 918, null, id(918))])
  await h.record('P', id(918))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const result = await move(await inventory([by[h.acct.P]], by[h.acct.Z], h.paths), by[h.acct.Z], h.paths)
  const receipt = JSON.parse(await readFile(result.file, 'utf8'))
  const row = receipt.sessions[0]
  const dest = path.join(h.paths.state, 'quarantine', receipt.at)
  const items = [row.targetTranscript, row.record]
  receipt.undoing = [{
    id: row.targetId,
    title: row.title,
    required: items,
    hashes: [[row.targetTranscript, row.targetSha]],
    trees: [],
    semantics: [[row.record, row.recordSemantic]],
    moved: items.map((file) => [file, path.join(dest, path.basename(file))])
  }]
  await writeFile(result.file, JSON.stringify(receipt))
  const source = receipt.superseded.find((item) => item.source).moved[0]
  await rename(source[1], source[0])
  await rename(row.targetTranscript, path.join(dest, path.basename(row.targetTranscript)))
  const focused = JSON.parse(await readFile(row.record, 'utf8'))
  await writeFile(row.record, JSON.stringify({ ...focused, lastFocusedAt: focused.lastFocusedAt + 1 }))
  const resumed = await undo(h.paths)
  assert.equal(resumed.dest, dest)
  assert.ok(await readFile(source[0]))
  assert.equal(await readFile(row.targetTranscript).catch(() => null), null)
  assert.equal(await readFile(row.record).catch(() => null), null)
  assert.ok(await readFile(path.join(dest, path.basename(row.targetTranscript))))
  assert.ok(await readFile(path.join(dest, path.basename(row.record))))
})

test('a corrupt latest receipt stops undo before the previous batch', async () => {
  const h = await home()
  await h.write(id(905), [entry('user', 905, null, id(905))])
  await h.record('P', id(905))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const moved = await move(await inventory([by[h.acct.P]], by[h.acct.Z], h.paths), by[h.acct.Z], h.paths)
  const target = moved.receipt.sessions[0].targetTranscript
  const corrupt = path.join(h.paths.state, '2099-12-31T23-59-59-999.json')
  await writeFile(corrupt, '{broken')
  const result = await undo(h.paths)
  assert.match(result.reconciled.error, /corrupt receipt/)
  assert.ok(await readFile(target))
  assert.ok(await readFile(`${corrupt}.corrupt`))
})

test('a changed interrupted copy stays tracked and blocks undo', async () => {
  const h = await home()
  const targetId = id(899)
  const target = path.join(h.project, `${targetId}.jsonl`)
  await h.write(targetId, [entry('user', 899, null, targetId)])
  await mkdir(h.paths.state, { recursive: true })
  const receipt = {
    at: '2099-01-01T00-00-00-000',
    from: [],
    to: 'x',
    sessions: [],
    failed: [],
    pending: { id: id(898), title: 'Changed', targetId, made: [target] }
  }
  const file = path.join(h.paths.state, `${receipt.at}.json`)
  await writeFile(file, JSON.stringify(receipt))
  assert.ok((await undo(h.paths)).reconciled)
  const recovered = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(recovered.retained[0].targetId, targetId)
  assert.deepEqual(recovered.retained[0].artifacts, [target])
  assert.equal((await undo(h.paths)).retained[0].targetId, targetId)
  assert.ok(await readFile(target))
})

test('dry-run describes interrupted retirement without changing it', async () => {
  const h = await home()
  await mkdir(h.paths.state, { recursive: true })
  const receipt = { at: '2099-01-01T00-00-00-000', from: [], to: 'x', sessions: [], failed: [], superseded: [], finalizing: true, retiring: [{ id: 'x', title: 'x', by: 'y', moved: [] }] }
  const file = path.join(h.paths.state, `${receipt.at}.json`)
  await writeFile(file, JSON.stringify(receipt))
  const result = await cli(h.root, ['--from', 'p@example.com', '--to', 'z@example.com', '--dry-run', '--json'])
  assert.equal(result.code, 1)
  assert.match(result.stdout, /interrupted retirement/)
  assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).planned, null)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), receipt)
})

test('interrupted retirement restores partially parked entries', async () => {
  const h = await home()
  const at = '2099-01-01T00-00-00-000'
  const original = path.join(h.project, 'retired.json')
  const parked = path.join(h.paths.state, 'quarantine', at, 'sources', 'retired.json')
  await writeFile(original, '{}')
  await mkdir(path.dirname(parked), { recursive: true })
  await rename(original, parked)
  const receipt = { at, from: [], to: 'x', sessions: [], failed: [], superseded: [], finalizing: true, retiring: [{ id: 'x', title: 'x', by: 'y', required: [original], moved: [[original, parked]] }] }
  const file = path.join(h.paths.state, `${at}.json`)
  await writeFile(file, JSON.stringify(receipt))
  const result = await undo(h.paths)
  assert.match(result.reconciled.error, /retirement rolled back/)
  assert.equal(await readFile(original, 'utf8'), '{}')
  assert.equal(await readFile(parked).catch(() => null), null)
  const recovered = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(recovered.retiring, null)
  assert.equal(recovered.finalizing, false)
})

test('interrupted retirement keeps its journal when a required artifact vanished', async () => {
  const h = await home()
  const at = '2099-01-01T00-00-00-000'
  const original = path.join(h.project, 'missing.json')
  const parked = path.join(h.paths.state, 'quarantine', at, 'sources', 'missing.json')
  const receipt = { at, from: [], to: 'x', sessions: [], failed: [], superseded: [], finalizing: true, retiring: [{ id: 'x', title: 'x', by: 'y', required: [original], moved: [[original, parked]] }] }
  const file = path.join(h.paths.state, `${at}.json`)
  await mkdir(h.paths.state, { recursive: true })
  await writeFile(file, JSON.stringify(receipt))
  const result = await undo(h.paths)
  assert.match(result.reconciled.error, /recovery artifact missing/)
  const unresolved = JSON.parse(await readFile(file, 'utf8'))
  assert.ok(unresolved.retiring)
  assert.equal(unresolved.finalizing, true)
})

test('picker reducer', () => {
  let s = { cursor: 0, chosen: new Set(), size: 3, multi: true }
  s = step(s, 'up')
  assert.equal(s.cursor, 2)
  s = step(step(s, 'down'), 'space')
  assert.deepEqual([...s.chosen], [0])
  assert.equal(step({ ...s, chosen: new Set() }, 'return').done, undefined)
  assert.equal(step(s, 'return').done, true)
  const single = step({ cursor: 1, chosen: new Set(), size: 3, multi: false }, 'return')
  assert.deepEqual([...single.chosen], [1])
  assert.equal(single.done, true)
})

test('active account follows the latest organization request, not background usage polling', async () => {
  const h = await home()
  const team = path.join(h.paths.records, h.acct.P, h.org.T)
  const teamRecord = path.join(team, `local_${id(999)}.json`)
  await mkdir(team, { recursive: true })
  await writeFile(teamRecord, JSON.stringify({
    sessionId: `local_${id(999)}`,
    cliSessionId: id(999),
    cwd: '/tmp/fixture',
    lastActivityAt: 1,
    lastFocusedAt: 1,
    title: 'Same account, team organization'
  }))
  await writeFile(h.paths.usage, JSON.stringify({ samples: [{ org: h.org.P, t: 1 }, { org: h.org.T, t: 2 }] }))
  await mkdir(path.dirname(h.paths.scope), { recursive: true })
  await writeFile(h.paths.scope, JSON.stringify({ scope: { breadcrumbs: [
    { timestamp: Date.now() / 1000 - 1, data: { url: `https://claude.ai/api/organizations/${h.org.T}/usage` } },
    { timestamp: new Date().toISOString(), data: { url: `https://claude.ai/api/bootstrap/${h.org.P}/current_user_access` } }
  ] } }))
  const withScope = await accounts(h.paths)
  assert.equal(withScope.find((a) => a.account === h.acct.P && a.org === h.org.P).active, true)
  assert.equal(withScope.find((a) => a.account === h.acct.P && a.org === h.org.T).active, false)
  await unlink(h.paths.scope)
  await writeFile(h.paths.usage, JSON.stringify({ samples: [{ org: h.org.P, t: Date.now() - 2 }, { org: h.org.T, t: Date.now() - 1 }] }))
  const withoutScope = await accounts(h.paths)
  assert.equal(withoutScope.find((a) => a.account === h.acct.P && a.org === h.org.T).active, true)
  await writeFile(h.paths.usage, JSON.stringify({ samples: [{ org: h.org.T, t: 1 }] }))
  const expired = await accounts(h.paths)
  assert.equal(expired.some((a) => a.active), false)
  await writeFile(h.paths.scope, JSON.stringify({ scope: { breadcrumbs: [{ timestamp: Date.now() + 60000, data: { url: `https://claude.ai/api/organizations/${h.org.P}/usage` } }] } }))
  const future = await accounts(h.paths)
  assert.equal(future.some((a) => a.active), false)
  const focused = JSON.parse(await readFile(teamRecord, 'utf8'))
  await writeFile(teamRecord, JSON.stringify({ ...focused, lastFocusedAt: Date.now() + 60000 }))
  const futureFocus = await accounts(h.paths)
  assert.equal(futureFocus.some((a) => a.active), false)
})

async function home() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ct-home-'))
  const paths = layout(root)
  const project = path.join(paths.pool, '-tmp-fixture')
  const acct = { P: id(901), T: id(902), Z: id(903), Q: id(904) }
  const org = { P: id(911), T: id(912), Z: id(913), Q: id(914) }
  const dir = (a) => path.join(paths.records, acct[a], org[a])
  for (const a of ['P', 'T', 'Z', 'Q']) await mkdir(dir(a), { recursive: true })
  await mkdir(path.join(root, '.claude-x'))
  await writeFile(path.join(root, '.claude-x', '.claude.json'), JSON.stringify({
    oauthAccount: {
      accountUuid: acct.Z,
      organizationUuid: org.Z,
      emailAddress: 'z@example.com',
      organizationName: 'Zed Person',
      organizationType: 'claude_max'
    }
  }))
  await mkdir(project, { recursive: true })
  await mkdir(paths.backups, { recursive: true })
  await writeFile(paths.desktop, JSON.stringify({ lastKnownAccountUuid: acct.P }))
  await writeFile(paths.usage, JSON.stringify({ samples: [{ org: org.T, t: Date.now() - 1 }, { org: org.P, t: Date.now() }] }))
  await writeFile(paths.login, JSON.stringify({ oauthAccount: { accountUuid: acct.P, organizationUuid: org.P, emailAddress: 'p@example.com', organizationName: 'Personal P' } }))
  await writeFile(path.join(paths.backups, '.claude.json.backup.1'), JSON.stringify({
    oauthAccount: { accountUuid: acct.T, organizationUuid: org.T, emailAddress: 't@example.com', organizationName: 'Team T' }
  }))
  const record = (a, sid, extra = {}) => writeFile(path.join(dir(a), `local_${sid}.json`), JSON.stringify({
    sessionId: `local_${sid}`,
    cliSessionId: sid,
    cwd: '/tmp/fixture',
    originCwd: '/tmp/fixture',
    createdAt: 1,
    lastActivityAt: 2,
    lastFocusedAt: 2,
    model: 'x',
    isArchived: false,
    title: `Session ${sid.slice(-3)}`,
    titleSource: 'user',
    permissionMode: 'auto',
    bridgeSessionIds: [],
    spawnSeed: { a: 1 },
    ...extra
  }, null, 2))
  const write = (sid, entries) => writeFile(path.join(project, `${sid}.jsonl`), entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  return { root, paths, project, acct, org, dir, record, write }
}

test('move, rerun, undo across accounts', async () => {
  const h = await home()
  const source = await readFile(path.join(here, 'fixtures', 'source.jsonl'), 'utf8')
  await writeFile(path.join(h.project, `${SOURCE}.jsonl`), source)
  await mkdir(path.join(h.project, SOURCE, 'subagents'), { recursive: true })
  await writeFile(path.join(h.project, SOURCE, 'subagents', 'agent-1.jsonl'), '{"agent":1}\n')
  await writeFile(path.join(h.project, SOURCE, 'subagents', 'agent-1.meta.json'), '{"m":1}\n')
  await h.record('P', SOURCE, { forkedFromSessionId: `local_${id(200)}` })
  const b = [entry('user', 200, null, id(200)), entry('assistant', 201, 200, id(200)), entry('user', 202, 201, id(200), { toolUseResult: { stdout: '', stderr: '' } })]
  await h.write(id(200), [...b, { ...b[2], toolUseResult: { stdout: 'rich', stderr: '' } }])
  await h.record('P', id(200), { forkedFromSessionId: `local_${id(300)}` })
  const c1 = [entry('user', 300, null, id(300)), entry('assistant', 301, 300, id(300))]
  await h.write(id(300), c1)
  await h.record('P', id(300))
  const c2 = fork(c1, id(300), id(310), 'C')
  await h.write(id(310), c2)
  await h.record('T', id(310))
  await h.write(id(320), fork(c2, id(310), id(320), 'C'))
  await h.record('Z', id(320))
  await h.record('T', id(400))
  const e = [entry('user', 500, null, id(500)), entry('assistant', 501, 500, id(500))]
  await h.write(id(500), [...e, { ...e[1], message: { role: 'assistant', content: 'conflict' } }])
  await h.record('T', id(500))
  await h.write(id(600), [entry('user', 600, null, id(600))])
  await appendFile(path.join(h.project, `${id(600)}.jsonl`), '{"type":"user","uuid":"broken\n')
  await h.record('T', id(600))
  await h.write(id(800), [entry('user', 800, null, id(800)), entry('assistant', 801, 800, id(800))])
  await h.record('T', id(800), { forkedFromSessionId: `local_${id(310)}` })
  const h1 = [entry('user', 700, null, id(700)), entry('assistant', 701, 700, id(700))]
  await h.write(id(700), h1)
  await h.record('P', id(700))
  await h.write(id(710), [...fork(h1, id(700), id(710), 'H'), entry('user', 702, null, id(710))])
  await h.record('T', id(710), { forkedFromSessionId: `local_${id(700)}` })
  const j1 = [entry('user', 720, null, id(720)), entry('assistant', 721, 720, id(720))]
  await h.write(id(720), j1)
  await mkdir(path.join(h.project, id(720), 'subagents'), { recursive: true })
  await writeFile(path.join(h.project, id(720), 'subagents', 'agent-j.jsonl'), '{"agent":"j"}\n')
  await h.record('P', id(720))
  await h.write(id(730), [...fork(j1, id(720), id(730), 'J'), entry('user', 722, null, id(730))])
  await h.record('T', id(730))
  await mkdir(h.paths.state, { recursive: true })
  await writeFile(path.join(h.paths.state, 'lock'), '999999')

  const pick = async () => { const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a])); return { by, from: [by[h.acct.P], by[h.acct.T]], to: by[h.acct.Z] } }
  const plan = async () => { const p = await pick(); return inventory(p.from, p.to, h.paths) }
  const { by, from, to } = await pick()
  assert.equal(by[h.acct.P].label, 'p@example.com · Personal P')
  assert.equal(by[h.acct.T].label, 't@example.com · Team T')
  assert.equal(by[h.acct.Z].label, 'z@example.com · Personal')
  assert.equal(by[h.acct.Q].label, `${h.acct.Q.slice(0, 8)} · ${h.org.Q.slice(0, 8)}`)
  assert.equal(by[h.acct.Q].stats, '0 | -')
  assert.equal(by[h.acct.P].active, true)
  assert.match(by[h.acct.P].stats, / \| active$/)
  assert.equal(by[h.acct.T].active, false)
  assert.match(by[h.acct.Z].stats, /^1 \| .* \| fixture$/)

  const inv = await inventory(from, to, h.paths)
  assert.equal(inv.total, 12)
  assert.equal(inv.missing.length, 1)
  assert.equal(inv.twice, 3)
  assert.equal(inv.there.length, 1)
  assert.deepEqual(inv.move.map((s) => s.id).sort(), [SOURCE, id(200), id(500), id(600), id(710), id(730), id(800)].sort())
  await h.record('P', SOURCE, { forkedFromSessionId: `local_${id(200)}`, title: 'Session 001 renamed' })

  const stages = []
  const result = await move(inv, to, h.paths, (stage, text, extra = {}) => { if (!extra.live) stages.push(`${stage} ${text}`) })
  assert.ok(await readFile(path.join(h.paths.state, 'lock')))
  assert.equal(result.receipt.sessions.length, 5)
  assert.equal(result.receipt.failed.length, 2)
  assert.equal(result.ok, false)
  assert.deepEqual(result.receipt.failed.map((f) => f.error).sort(), ['1 conflicting duplicate uuids', '1 unparseable lines'])
  assert.deepEqual(result.checks, ['provenance ✓', 'lineage ✓', 'sidecars ✓', 'desktop ✓', 'sources unchanged ✓'])
  assert.deepEqual(result.problems, [])
  assert.match(stages[0], /^fork 5 ✓ \| \d+ events \| 1 replay duplicates collapsed \| 2 failed$/)
  assert.equal(stages[1], 'sidecars 3 files | sha256 ✓')
  assert.equal(stages[2], 'desktop 5 records | 0 archived | 5 active')
  assert.equal('forkedFromSessionId' in JSON.parse(await readFile(result.receipt.sessions.find((r) => r.id === id(710)).record, 'utf8')), false)
  assert.deepEqual(await readdir(path.join(result.receipt.sessions.find((r) => r.id === id(730)).targetDir, 'subagents')), ['agent-j.jsonl'])

  const moved = result.receipt.sessions.find((r) => r.id === SOURCE)
  const copy = await readFile(moved.targetTranscript, 'utf8')
  assert.ok(!copy.includes('\u2028'))
  assert.ok(lines(copy)[1].message.content.includes('\u2028'))
  assert.equal((await readdir(path.join(moved.targetDir, 'subagents'))).length, 2)
  const record = JSON.parse(await readFile(moved.record, 'utf8'))
  assert.equal(record.cliSessionId, moved.targetId)
  assert.equal(record.sessionId, `local_${moved.targetId}`)
  assert.equal(record.title, 'Session 001 renamed')
  assert.deepEqual(record.bridgeSessionIds, [])
  assert.deepEqual(record.spawnSeed, {})
  assert.equal(record.createdAt, 1)
  assert.equal(record.lastActivityAt, 2)
  assert.equal(record.lastFocusedAt, 2)
  assert.equal(record.forkedFromSessionId, `local_${result.receipt.sessions.find((r) => r.id === id(200)).targetId}`)
  assert.equal(JSON.parse(await readFile(result.receipt.sessions.find((r) => r.id === id(200)).record, 'utf8')).forkedFromSessionId, `local_${id(320)}`)
  assert.equal(JSON.parse(await readFile(result.receipt.sessions.find((r) => r.id === id(800)).record, 'utf8')).forkedFromSessionId, `local_${id(320)}`)
  assert.equal(await readFile(path.join(h.project, `${SOURCE}.jsonl`), 'utf8'), source)
  assert.equal((await readdir(h.dir('Z'))).length, 6)
  assert.equal(stages[4], 'retired 9 source records → quarantine | transcripts untouched')
  assert.deepEqual(await readdir(h.dir('P')), [])
  assert.deepEqual((await readdir(h.dir('T'))).map((f) => f.slice(6, -5)).sort(), [id(400), id(500), id(600)].sort())
  assert.deepEqual(await readdir(path.join(h.paths.state, 'quarantine')), [result.receipt.at])

  const again = await plan()
  assert.equal(again.total, 3)
  assert.deepEqual(again.move.map((s) => s.id).sort(), [id(500), id(600)])
  assert.equal(again.there.length, 0)

  const undone = await undo(h.paths)
  assert.ok(undone.dest)
  assert.equal((await readdir(h.dir('Z'))).length, 1)
  assert.equal((await readdir(h.dir('P'))).length, 5)
  assert.equal((await readdir(h.dir('T'))).length, 7)
  assert.equal((await readdir(undone.dest)).length, 13)
  assert.equal((await plan()).move.length, 7)
  assert.deepEqual(await undo(h.paths), { nothing: true })
  const orphan = path.join(h.project, `${id(900)}.jsonl`)
  await writeFile(orphan, '{}\n')
  const pending = { at: '2099-01-01T00-00-00-000', from: [], to: 'x', sessions: [], failed: [], pending: { id: id(900), title: 'Orphan', made: [orphan] } }
  await writeFile(path.join(h.paths.state, `${pending.at}.json`), JSON.stringify(pending))
  const reconciled = await undo(h.paths)
  assert.equal(reconciled.reconciled.error, 'interrupted')
  assert.equal(await readFile(orphan, 'utf8').catch(() => 'gone'), 'gone')
  assert.ok(await readFile(path.join(h.paths.state, 'quarantine', '2099-01-01T00-00-00-000', 'failed', `${id(900)}.jsonl`), 'utf8'))
  assert.ok((await undo(h.paths)).dest)

  const second = await move(await plan(), (await pick()).to, h.paths)
  await appendFile(second.receipt.sessions[0].targetTranscript, JSON.stringify({ type: 'mode', sessionId: second.receipt.sessions[0].targetId, mode: 'x' }) + '\n')
  assert.ok((await undo(h.paths)).dest)
  const third = await move(await plan(), (await pick()).to, h.paths)
  await appendFile(third.receipt.sessions[0].targetTranscript, JSON.stringify({
    type: 'content-replacement',
    sessionId: third.receipt.sessions[0].targetId,
    replacements: [{ uuid: id(1), text: 'x' }]
  }) + '\n')
  const refused = await undo(h.paths)
  assert.deepEqual(refused.changed, [`${third.receipt.sessions[0].title} | ${third.receipt.sessions[0].targetId.slice(0, 8)} | transcript changed`])
  assert.equal((await readdir(h.dir('Z'))).length, 6)
})
