import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { accounts, fork, inventory, layout, move, normalize, step, undo } from './transplant.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = '00000000-0000-4000-8000-000000000001'
const MESSAGES = new Set(['user', 'assistant', 'attachment', 'system'])
const id = (k) => `00000000-0000-4000-8000-${String(k).padStart(12, '0')}`
const lines = (text) => text.split('\n').filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
const fixture = async (name) => lines(await readFile(path.join(here, 'fixtures', name), 'utf8'))
const entry = (type, k, parent, session, extra = {}) => ({ type, uuid: id(k), parentUuid: parent === null ? null : id(parent), sessionId: session, timestamp: `2026-09-01T00:00:${String(k % 60).padStart(2, '0')}.000Z`, cwd: '/tmp/fixture', isSidechain: false, message: { role: type, content: `message ${k}` }, ...extra })

function shape(entries) {
  const fresh = new Map()
  const swap = (v) => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v) && !v.startsWith('00000000-0000-4000-8000-') ? (fresh.has(v) ? fresh.get(v) : (fresh.set(v, `#${fresh.size}`), fresh.get(v))) : v
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
  const script = `import { forkSession } from '@anthropic-ai/claude-agent-sdk'; const r = await forkSession(${JSON.stringify(SOURCE)}, { dir: ${JSON.stringify(dir)}, title: 'Fixture moved' }); console.log(r.sessionId)`
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
  const conflict = normalize([a, b, { ...b, message: { role: 'user', content: 'other' } }])
  assert.equal(conflict.conflicts, 1)
  assert.equal(conflict.entries.length, 3)
  const c = entry('assistant', 3, 2, id(0))
  const d = entry('user', 4, 3, id(0))
  const x = entry('assistant', 5, 1, id(0))
  assert.equal(normalize([a, b, c, d, { ...d, parentUuid: id(2) }]).replays, 1)
  assert.equal(normalize([a, b, c, d, x, { ...d, parentUuid: id(5) }]).conflicts, 1)
  assert.equal(normalize([a, b, c, { ...d, parentUuid: id(2) }, d]).conflicts, 1)
})

test('cli exits nonzero on partial failure and undoes over json', async () => {
  const h = await home()
  await writeFile(path.join(h.project, `${SOURCE}.jsonl`), await readFile(path.join(here, 'fixtures', 'source.jsonl')))
  await h.record('P', SOURCE)
  await h.write(id(700), [entry('user', 700, null, id(700))])
  await appendFile(path.join(h.project, `${id(700)}.jsonl`), 'not json\n')
  await h.record('P', id(700))
  const run = (args) => promisify(execFile)(process.execPath, [path.join(here, 'transplant.js'), ...args], { env: { ...process.env, HOME: h.root } }).then((r) => ({ ...r, code: 0 }), (e) => ({ stdout: e.stdout, code: e.code }))
  const list = JSON.parse((await run(['accounts', '--json'])).stdout)
  assert.equal(list.find((a) => a.account === h.acct.P).active, true)
  const moved = await run(['--from', 'p@example.com', '--to', 'z@example.com', '--json'])
  assert.equal(moved.code, 1)
  const done = JSON.parse(moved.stdout.trim().split('\n').at(-1))
  assert.equal(done.ok, false)
  assert.equal(done.moved, 1)
  assert.deepEqual(done.failed.map((f) => f.error), ['1 unparseable lines'])
  assert.deepEqual(done.problems, [])
  const undone = await run(['undo', '--json'])
  assert.equal(undone.code, 0)
  assert.equal(JSON.parse(undone.stdout).sessions, 1)
  assert.equal((await run(['undo', '--json'])).stdout.trim(), '{"nothing":true}')
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

async function home() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ct-home-'))
  const paths = layout(root)
  const project = path.join(paths.pool, '-tmp-fixture')
  const acct = { P: id(901), T: id(902), Z: id(903), Q: id(904) }
  const org = { P: id(911), T: id(912), Z: id(913), Q: id(914) }
  const dir = (a) => path.join(paths.records, acct[a], org[a])
  for (const a of ['P', 'T', 'Z', 'Q']) await mkdir(dir(a), { recursive: true })
  await mkdir(path.join(root, '.claude-x'))
  await writeFile(path.join(root, '.claude-x', '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: acct.Z, organizationUuid: org.Z, emailAddress: 'z@example.com', organizationName: 'Zed Person', organizationType: 'claude_max' } }))
  await mkdir(project, { recursive: true })
  await mkdir(paths.backups, { recursive: true })
  await writeFile(paths.desktop, JSON.stringify({ lastKnownAccountUuid: acct.P }))
  await writeFile(paths.usage, JSON.stringify({ samples: [{ org: org.T, t: 1 }, { org: org.P, t: 2 }] }))
  await writeFile(paths.login, JSON.stringify({ oauthAccount: { accountUuid: acct.P, organizationUuid: org.P, emailAddress: 'p@example.com', organizationName: 'Personal P' } }))
  await writeFile(path.join(paths.backups, '.claude.json.backup.1'), JSON.stringify({ oauthAccount: { accountUuid: acct.T, organizationUuid: org.T, emailAddress: 't@example.com', organizationName: 'Team T' } }))
  const record = (a, sid, extra = {}) => writeFile(path.join(dir(a), `local_${sid}.json`), JSON.stringify({ sessionId: `local_${sid}`, cliSessionId: sid, cwd: '/tmp/fixture', originCwd: '/tmp/fixture', createdAt: 1, lastActivityAt: 2, lastFocusedAt: 2, model: 'x', isArchived: false, title: `Session ${sid.slice(-3)}`, titleSource: 'user', permissionMode: 'auto', bridgeSessionIds: ['b'], spawnSeed: { a: 1 }, ...extra }, null, 2))
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
  await mkdir(h.paths.state, { recursive: true })
  await writeFile(path.join(h.paths.state, 'lock'), '999999')

  const pick = async () => { const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a])); return { by, from: [by[h.acct.P], by[h.acct.T]], to: by[h.acct.Z] } }
  const plan = async () => { const p = await pick(); return inventory(p.from, p.to, h.paths) }
  const { by, from, to } = await pick()
  assert.equal(by[h.acct.P].label, 'p@example.com · Personal P')
  assert.equal(by[h.acct.T].label, 't@example.com · Team T')
  assert.equal(by[h.acct.Z].label, 'z@example.com · Personal')
  assert.equal(by[h.acct.Q].label, `${h.acct.Q.slice(0, 8)} · ${h.org.Q.slice(0, 8)}`)
  assert.equal(by[h.acct.Q].stats, '0 | —')
  assert.equal(by[h.acct.P].active, true)
  assert.match(by[h.acct.P].stats, / \| active$/)
  assert.equal(by[h.acct.T].active, false)
  assert.match(by[h.acct.Z].stats, /^1 \| .* \| fixture$/)

  const inv = await inventory(from, to, h.paths)
  assert.equal(inv.total, 8)
  assert.equal(inv.missing.length, 1)
  assert.equal(inv.twice, 1)
  assert.equal(inv.there.length, 1)
  assert.deepEqual(inv.move.map((s) => s.id).sort(), [SOURCE, id(200), id(500), id(600), id(800)].sort())

  const stages = []
  const result = await move(inv, to, h.paths, (stage, text, extra = {}) => { if (!extra.live) stages.push(`${stage} ${text}`) })
  assert.equal(result.receipt.sessions.length, 3)
  assert.equal(result.receipt.failed.length, 2)
  assert.equal(result.ok, false)
  assert.deepEqual(result.receipt.failed.map((f) => f.error).sort(), ['1 conflicting duplicate uuids', '1 unparseable lines'])
  assert.deepEqual(result.checks, ['provenance ✓', 'lineage ✓', 'sidecars ✓', 'desktop ✓', 'sources unchanged ✓'])
  assert.deepEqual(result.problems, [])
  assert.match(stages[0], /^fork 3 ✓ \| \d+ events \| 1 replay duplicates collapsed \| 2 failed$/)
  assert.equal(stages[1], 'sidecars 2 files | sha256 ✓')
  assert.equal(stages[2], 'desktop 3 records | 0 archived | 3 active')

  const moved = result.receipt.sessions.find((r) => r.id === SOURCE)
  const copy = await readFile(moved.targetTranscript, 'utf8')
  assert.ok(!copy.includes('\u2028'))
  assert.ok(lines(copy)[1].message.content.includes('\u2028'))
  assert.equal((await readdir(path.join(moved.targetDir, 'subagents'))).length, 2)
  const record = JSON.parse(await readFile(moved.record, 'utf8'))
  assert.equal(record.cliSessionId, moved.targetId)
  assert.equal(record.sessionId, `local_${moved.targetId}`)
  assert.equal(record.title, 'Session 001')
  assert.deepEqual(record.bridgeSessionIds, [])
  assert.deepEqual(record.spawnSeed, {})
  assert.equal(record.forkedFromSessionId, `local_${result.receipt.sessions.find((r) => r.id === id(200)).targetId}`)
  assert.equal(JSON.parse(await readFile(result.receipt.sessions.find((r) => r.id === id(200)).record, 'utf8')).forkedFromSessionId, `local_${id(320)}`)
  assert.equal(JSON.parse(await readFile(result.receipt.sessions.find((r) => r.id === id(800)).record, 'utf8')).forkedFromSessionId, `local_${id(320)}`)
  assert.equal(await readFile(path.join(h.project, `${SOURCE}.jsonl`), 'utf8'), source)
  assert.equal((await readdir(h.dir('Z'))).length, 4)
  assert.equal(await readdir(path.join(h.paths.state, 'quarantine')).catch(() => 'none'), 'none')

  const again = await plan()
  assert.deepEqual(again.move.map((s) => s.id).sort(), [id(500), id(600)])
  assert.equal(again.there.length, 3)

  const undone = await undo(h.paths)
  assert.ok(undone.dest)
  assert.equal((await readdir(h.dir('Z'))).length, 1)
  assert.equal((await readdir(undone.dest)).length, 8)
  assert.equal((await plan()).move.length, 5)
  assert.deepEqual(await undo(h.paths), { nothing: true })
  const orphan = path.join(h.project, `${id(900)}.jsonl`)
  await writeFile(orphan, '{}\n')
  await writeFile(path.join(h.paths.state, '2099-01-01T00-00-00-000.json'), JSON.stringify({ at: '2099-01-01T00-00-00-000', from: [], to: 'x', sessions: [], failed: [], pending: { id: id(900), title: 'Orphan', made: [orphan] } }))
  const reconciled = await undo(h.paths)
  assert.equal(reconciled.receipt.failed[0].error, 'interrupted')
  assert.equal(await readFile(orphan, 'utf8').catch(() => 'gone'), 'gone')
  assert.ok(await readFile(path.join(h.paths.state, 'quarantine', '2099-01-01T00-00-00-000', 'failed', `${id(900)}.jsonl`), 'utf8'))

  const second = await move(await plan(), (await pick()).to, h.paths)
  await appendFile(second.receipt.sessions[0].targetTranscript, JSON.stringify(entry('user', 999, null, second.receipt.sessions[0].targetId)) + '\n')
  const refused = await undo(h.paths)
  assert.deepEqual(refused.changed, [second.receipt.sessions[0].title])
  assert.equal((await readdir(h.dir('Z'))).length, 4)
})
