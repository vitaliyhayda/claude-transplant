import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, open, readdir, readFile, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { accounts, executeMove, finishHeld, finishPending, finishWorkflow, inventory, keepLocal, layout, move, normalize, parseProcesses, restartPlan, resumeLast, semantic, signedIn, step, sweep, undo, verifyPlaced, withDesktopRestart, writeNew } from './transplant.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = '00000000-0000-4000-8000-000000000001'
const MESSAGES = new Set(['user', 'assistant', 'attachment', 'system'])
const id = (k) => `00000000-0000-4000-8000-${String(k).padStart(12, '0')}`
const rehomeRecord = (extra = {}) => ({ forkedFromSessionId: null, ...extra })
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
const remoteState = (status, extra = {}) => ({
  status,
  connection_status: 'disconnected',
  worker_status: 'WORKER_STATUS_UNSPECIFIED',
  client_presence: [],
  last_event_at: '2026-09-01T00:01:00.000Z',
  ...extra
})
const remoteRows = (entries) => entries.map((payload, sequence_num) => ({ event_type: payload.type, payload, sequence_num, created_at: payload.timestamp }))
const remoteSession = (extra = {}) => ({ created_at: '2026-09-01T00:00:00.000Z', environment_kind: 'bridge', tags: ['remote-control-sdk'], status: 'active', ...extra })
const cloudFixture = (h, extra = {}) => ({
  account: h.acct.P,
  org: h.org.P,
  list: async () => [],
  eventRows: async () => [],
  session: async () => remoteState('active'),
  archive: async () => {},
  unarchive: async () => {},
  ...extra
})
async function moveWithPending(h, from, to, cloud = null) {
  const pending = id(997)
  await h.record('T', pending, rehomeRecord({ title: 'Pending local source' }))
  const current = await accounts(h.paths)
  const source = from.map((row) => current.find((account) => account.account === row.account && account.org === row.org))
  const target = current.find((account) => account.account === to.account && account.org === to.org)
  const result = await move(await inventory(source, target, h.paths, () => {}, { cloud, cloudRequested: true }), target, h.paths)
  await unlink(path.join(h.dir('T'), `local_${pending}.json`))
  return result
}
const branchEntries = (count, session, start) => Array.from({ length: count }, (_, index) => entry(index % 2 ? 'assistant' : 'user', start + index, index ? start + index - 1 : null, session))
const cli = (home, args) => promisify(execFile)(process.execPath, [path.join(here, 'transplant.js'), ...args], {
  env: { ...process.env, HOME: home },
  cwd: here
}).then((r) => ({ ...r, code: 0 }), (e) => ({ stdout: e.stdout, stderr: e.stderr, code: e.code }))

test('process identity separates Desktop descendants, external workers, and reused pids', () => {
  const at = 'Fri Sep  4 18:00:00 2026'
  const later = 'Fri Sep  4 18:01:00 2026'
  const table = [
    `10 1 ${at} /Applications/Claude.app/Contents/MacOS/Claude`,
    `11 10 ${at} /Applications/Claude.app/Contents/Helpers/disclaimer`,
    `12 11 ${at} /Library/Application Support/Claude/claude`,
    `13 1 ${at} /tmp/claude`,
    `14 1 ${at} /tmp/claude`,
    `15 16 ${at} /tmp/claude`,
    `16 15 ${at} /bin/sh`
  ].join('\n')
  const commands = [
    `10 1 ${at} Claude`, `11 10 ${at} disclaimer local_${SOURCE}`,
    `12 11 ${at} claude --resume ${id(2)}`, `13 1 ${at} claude --resume ${id(2)}`,
    `14 1 ${later} claude --resume ${SOURCE}`, `15 16 ${at} claude`, `16 15 ${at} sh`
  ].join('\n')
  const rows = parseProcesses(table, commands)
  assert.equal(rows.find((row) => row.pid === 12).desktopPid, 10)
  assert.equal(rows.find((row) => row.pid === 13).desktopPid, null)
  assert.deepEqual(rows.find((row) => row.pid === 14).ids, [])
  assert.deepEqual(rows.find((row) => row.pid === 11).ids, [SOURCE])
  assert.equal(rows.find((row) => row.pid === 15).desktopPid, null)
  assert.throws(() => parseProcesses('unparseable', ''), /process identity/)
  const alternate = parseProcesses(table.replaceAll('/Applications/Claude.app', '/Users/fixture/Applications/Claude.app'), commands)
  assert.equal(alternate.find((row) => row.pid === 11).worker, true)
  assert.equal(alternate.find((row) => row.pid === 12).desktopPid, 10)
})

test('process inventory handles more than one megabyte of unrelated argv', async () => {
  const h = await home()
  const children = Array.from({ length: 9 }, () => spawn('/usr/bin/python3', ['-c', 'import time; time.sleep(30)', 'x'.repeat(120 * 1024)], { stdio: 'ignore' }))
  try {
    await Promise.all(children.map((child) => once(child, 'spawn')))
    const listing = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 2000 })
    assert.equal(listing.status, 0)
    assert.ok(Buffer.byteLength(listing.stdout) > 1024 * 1024)
    const to = (await accounts(h.paths)).find((row) => row.account === h.acct.T)
    assert.equal((await inventory([], to, h.paths)).move.length, 0)
  } finally {
    for (const child of children) child.kill('SIGTERM')
    await Promise.all(children.filter((child) => child.pid && child.exitCode === null && child.signalCode === null).map((child) => once(child, 'exit')))
  }
})

test('publication exposes complete bytes only after creation evidence is saved', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ct-publish-')), file = path.join(root, 'record.json'), payload = '{"title":"complete"}\n'
  await writeNew(file, payload, async (created) => {
    assert.equal(created.size, Buffer.byteLength(payload))
    assert.equal(await readFile(file).catch(() => null), null)
  })
  assert.equal(await readFile(file, 'utf8'), payload)
  assert.deepEqual(await readdir(root), ['record.json'])
})

test('inventory recognizes a live Desktop record id before its CLI uuid enters argv', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  const desktopId = id(800)
  await h.record('P', SOURCE, { sessionId: `local_${desktopId}` })
  await rename(path.join(h.dir('P'), `local_${SOURCE}.json`), path.join(h.dir('P'), `local_${desktopId}.json`))
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P)
  const to = all.find((a) => a.account === h.acct.T)
  const inv = await inventory([from], to, h.paths, () => {}, { processes: [{ pid: 100, worker: true, ids: [desktopId], desktopPid: 50 }] })
  assert.equal(inv.move.length, 0)
  assert.equal(inv.blocked[0].id, SOURCE)
  assert.match(inv.blocked[0].error, /running worker/)
})

const desktopFixture = (session = SOURCE) => [
  { pid: 500, ppid: 1, started: 'first', executable: '/Applications/Claude.app/Contents/MacOS/Claude', ids: [], worker: true, desktopPid: 500 },
  { pid: 501, ppid: 500, started: 'worker', executable: '/tmp/claude', ids: [session], worker: true, desktopPid: 500 }
]

test('restart plans include collateral and refuse to claim external worker ownership', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE)
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P)
  const to = all.find((a) => a.account === h.acct.T)
  const table = [...desktopFixture(), { pid: 502, ppid: 500, started: 'other', executable: '/tmp/claude', ids: [id(400)], worker: true, desktopPid: 500 }]
  const inv = await inventory([from], to, h.paths, () => {}, { processes: table })
  const plan = await restartPlan(inv, h.paths, table)
  assert.equal(plan.held.length, 1)
  assert.equal(plan.held[0].id, SOURCE)
  assert.deepEqual(plan.interrupts.map((row) => row.pid), [502])
  const external = [...table, { pid: 600, ppid: 1, started: 'external', executable: '/tmp/claude', ids: [SOURCE], worker: true, desktopPid: null }]
  assert.equal(await restartPlan(inv, h.paths, external), null)
})

test('a worker on a non-representative Desktop alias holds the whole compatible group', async () => {
  const h = await home(), alias = id(810)
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE, { lastFocusedAt: 1000 })
  await h.record('T', SOURCE, { sessionId: `local_${alias}` })
  await rename(path.join(h.dir('T'), `local_${SOURCE}.json`), path.join(h.dir('T'), `local_${alias}.json`))
  const all = await accounts(h.paths), from = all.filter((row) => [h.acct.P, h.acct.T].includes(row.account)), to = all.find((row) => row.account === h.acct.Z)
  const rows = desktopFixture(alias)
  const inv = await inventory(from, to, h.paths, () => {}, { processes: rows })
  assert.equal(inv.move.length, 0)
  assert.equal(inv.blocked[0].worker, false)
  assert.equal(inv.blocked[0].members.some((row) => row.worker), true)
  const plan = await restartPlan(inv, h.paths, rows)
  assert.equal(plan.held[0].sources.length, 2)
})

test('a worker plus a permanent filename collision never offers a restart', async () => {
  const h = await home(), other = id(400)
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE)
  await h.write(other, [entry('user', 400, null, other)])
  await h.record('T', other, { sessionId: `local_${SOURCE}` })
  await rename(path.join(h.dir('T'), `local_${other}.json`), path.join(h.dir('T'), `local_${SOURCE}.json`))
  const all = await accounts(h.paths), from = all.find((row) => row.account === h.acct.P), to = all.find((row) => row.account === h.acct.T)
  const inv = await inventory([from], to, h.paths, () => {}, { processes: desktopFixture() })
  assert.match(inv.blocked[0].error, /filename collision/)
  assert.equal(await restartPlan(inv, h.paths, desktopFixture()), null)
})

test('a destination arriving after planning is never quarantined by a failed placement', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE)
  const all = await accounts(h.paths), from = all.find((row) => row.account === h.acct.P), to = all.find((row) => row.account === h.acct.T)
  const target = path.join(h.dir('T'), `local_${SOURCE}.json`), foreign = '{"title":"independent arrival"}\n'
  const result = await executeMove([from], to, h.paths, { processes: [], summary: () => writeFileSync(target, foreign) })
  assert.equal(result.ok, false)
  assert.equal(await readFile(target, 'utf8'), foreign)
  assert.ok(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`)))
})

test('independent destination arrivals preserve Undo for successfully moved siblings', async () => {
  for (const identical of [false, true]) {
    const h = await home(), sibling = id(300)
    for (const session of [SOURCE, sibling]) {
      await h.write(session, [entry('user', session === SOURCE ? 1 : 300, null, session)])
      await h.record('P', session)
    }
    const all = await accounts(h.paths), from = all.find((row) => row.account === h.acct.P), to = all.find((row) => row.account === h.acct.T)
    const target = path.join(h.dir('T'), `local_${SOURCE}.json`)
    const record = JSON.parse(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`)))
    const foreign = identical ? JSON.stringify(record, null, 2) + '\n' : '{"title":"foreign sibling"}\n'
    const result = await executeMove([from], to, h.paths, { processes: [], summary: () => writeFileSync(target, foreign) })
    assert.equal(result.ok, false)
    assert.equal(result.receipt.sessions.length, 1)
    assert.equal(await readFile(target, 'utf8'), foreign)
    assert.equal(result.receipt.retained, undefined)
    assert.ok((await undo(h.paths)).dest)
    assert.equal(await readFile(target, 'utf8'), foreign)
    assert.ok(await readFile(path.join(h.dir('P'), `local_${sibling}.json`)))
  }
})

test('restart waits for children, moves only after exit, and reopens on move failure', async () => {
  const h = await home()
  let rows = desktopFixture(), time = 0
  const plan = await restartPlan(null, h.paths, rows)
  const calls = []
  const result = await withDesktopRestart(plan, h.paths, async () => {
    assert.equal(rows.length, 0)
    calls.push('move')
    throw new Error('fixture move failed')
  }, () => {}, {
    now: () => time, budget: 1000, reserve: 200, inspect: () => rows,
    wait: async (ms) => { time += ms; rows = [] },
    command: async (file) => {
      if (file.endsWith('osascript')) { calls.push('quit'); rows = rows.slice(1); return { status: 0 } }
      calls.push('open'); rows = [{ ...desktopFixture()[0], pid: 700, desktopPid: 700, started: 'new' }]; return { status: 0 }
    }
  })
  assert.deepEqual(calls, ['quit', 'move', 'open'])
  assert.equal(result.restart.outcome, 'reopened')
  assert.equal(result.ok, false)
  assert.match(result.error, /fixture move failed/)
  assert.ok(time <= 1000)
})

test('a native quit veto leaves held work untouched and does not reopen the running app', async () => {
  const h = await home()
  const rows = desktopFixture()
  const plan = await restartPlan(null, h.paths, rows)
  let time = 0, moved = false, opened = false
  const result = await withDesktopRestart(plan, h.paths, async () => { moved = true }, () => {}, {
    now: () => time, budget: 1000, reserve: 200, inspect: () => rows, wait: async (ms) => { time += ms },
    command: async (file) => { if (file.endsWith('/open')) opened = true; return { status: 1 } }
  })
  assert.equal(moved, false)
  assert.equal(opened, false)
  assert.equal(result.restart.outcome, 'quit-not-confirmed')
  assert.equal(time, 0)
})

test('post-quit deadline exhaustion still sends a bounded reopen request', async () => {
  const h = await home()
  let rows = desktopFixture(), time = 0
  const plan = await restartPlan(null, h.paths, rows)
  const calls = []
  const result = await withDesktopRestart(plan, h.paths, async () => { time = 1100 }, () => {}, {
    inspect: () => rows, now: () => time, budget: 1000, reserve: 200,
    command: async (file, args, timeout) => {
      calls.push({ file, timeout })
      rows = file.endsWith('osascript') ? [] : [{ ...desktopFixture()[0], pid: 700, desktopPid: 700, started: 'new' }]
      return { status: 0 }
    }
  })
  assert.equal(calls.at(-1).file, '/usr/bin/open')
  assert.ok(calls.at(-1).timeout > 0)
  assert.equal(result.ok, false)
  assert.match(result.error, /exceeded its deadline/)
})

test('a journal failure after quit cannot prevent the reopen request', async () => {
  const h = await home()
  let rows = desktopFixture()
  const plan = await restartPlan(null, h.paths, rows), calls = []
  const result = await withDesktopRestart(plan, h.paths, async () => {
    await rename(h.paths.state, h.paths.state + '.saved')
    await writeFile(h.paths.state, 'state path is unavailable')
  }, () => {}, { inspect: () => rows, command: async (file) => {
    calls.push(file)
    rows = file.endsWith('osascript') ? [] : [{ ...desktopFixture()[0], pid: 700, desktopPid: 700, started: 'new' }]
    return { status: 0 }
  } })
  assert.deepEqual(calls, ['/usr/bin/osascript', '/usr/bin/open'])
  assert.equal(result.restart.outcome, 'reopened')
  assert.equal(result.ok, false)
  assert.match(result.restart.error, /journal could not be saved/)
})

test('new workers invalidate the reviewed restart scope before any quit', async () => {
  const h = await home()
  const rows = desktopFixture()
  const plan = await restartPlan(null, h.paths, rows)
  const changed = [...rows, { ...rows[1], pid: 502, ids: [id(300)] }]
  let called = false
  const result = await withDesktopRestart(plan, h.paths, async () => { called = true }, () => {}, {
    inspect: () => changed, command: async () => { called = true; return { status: 0 } }
  })
  assert.equal(called, false)
  assert.match(result.error, /sessions changed/)
})

test('a slow shutdown uses only its mutation budget and leaves held files untouched', async () => {
  const h = await home()
  const rows = desktopFixture()
  const plan = await restartPlan(null, h.paths, rows)
  let time = 0, moved = false
  const result = await withDesktopRestart(plan, h.paths, async () => { moved = true }, () => {}, {
    now: () => time, budget: 1000, reserve: 200, inspect: () => rows,
    wait: async (ms) => { time += ms }, command: async () => ({ status: 0 })
  })
  assert.equal(moved, false)
  assert.equal(time, 800)
  assert.equal(result.restart.outcome, 'quit-not-confirmed')
})

test('recovery reopens an interrupted approved restart without requesting another shutdown', async () => {
  const h = await home()
  await mkdir(h.paths.state, { recursive: true })
  await writeFile(path.join(h.paths.state, 'restart.json'), JSON.stringify({ outcome: 'moving', desktop: { pid: 500, started: 'first' } }))
  let rows = [], calls = []
  const result = await sweep(h.paths, { io: {
    inspect: () => rows, command: async (file) => { calls.push(file); rows = desktopFixture(); return { status: 0 } }
  } })
  assert.deepEqual(calls, ['/usr/bin/open'])
  assert.equal(result.recovered.title, 'Interrupted restart')
  assert.equal(JSON.parse(await readFile(path.join(h.paths.state, 'restart.json'))).outcome, 'interrupted-reopened')
})

test('an approved plan moves only after shutdown and keeps cloud calls outside its window', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE)
  const all = await accounts(h.paths), from = all.find((row) => row.account === h.acct.P), to = all.find((row) => row.account === h.acct.T)
  let rows = desktopFixture(), time = 0, calls = []
  const io = { inspect: () => rows, now: () => time, budget: 1000, reserve: 200, wait: async (ms) => { time += ms }, command: async (file) => {
    calls.push(file)
    rows = file.endsWith('osascript') ? [] : [{ ...desktopFixture()[0], pid: 700, desktopPid: 700, started: 'new' }]
    return { status: 0 }
  } }
  const planned = await executeMove([from], to, h.paths, { io, cloudRequested: true, cloud: cloudFixture(h) })
  assert.ok(planned.plan.token)
  assert.deepEqual(calls, [])
  assert.ok(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`)))
  assert.equal(await readFile(path.join(h.dir('T'), `local_${SOURCE}.json`)).catch(() => null), null)
  const result = await executeMove([from], to, h.paths, { io, approve: planned.plan.token, cloudRequested: true, report: (stage) => {
    if (stage === 'scan') assert.ok(calls.includes('/usr/bin/osascript'))
  } })
  assert.equal(result.restarted, true)
  assert.equal(result.receipt.sessions.length, 1)
  assert.deepEqual(calls, ['/usr/bin/osascript', '/usr/bin/open'])
  assert.equal(result.receipt.cloudChecks[0].status, 'pending')
  assert.equal(result.receipt.startedAt, planned.plan.requestedAt)
  assert.equal(result.receipt.restart.outcome, 'reopened')
})

test('wrong, modified, and malformed restart approvals never quit Desktop', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE)
  const all = await accounts(h.paths), from = all.find((row) => row.account === h.acct.P), to = all.find((row) => row.account === h.acct.T)
  const calls = [], io = { inspect: () => desktopFixture(), command: async (file) => { calls.push(file); return { status: 0 } } }
  const planned = await executeMove([from], to, h.paths, { io })
  assert.equal((await executeMove([from], to, h.paths, { io, approve: '0'.repeat(64) })).ok, false)
  const file = path.join(h.paths.state, 'restart-plan.json'), changed = JSON.parse(await readFile(file))
  changed.held = []
  await writeFile(file, JSON.stringify(changed))
  assert.equal((await executeMove([from], to, h.paths, { io, approve: planned.plan.token })).ok, false)
  assert.deepEqual(calls, [])
  const malformed = await cli(h.root, ['restart', '--restart-approved', 'invalid', '--json'])
  assert.equal(malformed.code, 1)
  assert.match(malformed.stderr, /approval token/)
  assert.ok(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`)))
})

test('failed source authentication stays pending after an approved restart', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE)
  const all = await accounts(h.paths), from = all.find((row) => row.account === h.acct.P), to = all.find((row) => row.account === h.acct.T)
  let rows = desktopFixture()
  const io = { inspect: () => rows, command: async (file) => {
    rows = file.endsWith('osascript') ? [] : [{ ...desktopFixture()[0], pid: 700, desktopPid: 700, started: 'new' }]
    return { status: 0 }
  } }
  const planned = await executeMove([from], to, h.paths, { io, cloudRequested: true, cloudError: 'authentication unavailable' })
  const result = await executeMove([from], to, h.paths, { io, cloudRequested: true, approve: planned.plan.token })
  assert.equal(result.receipt.cloudChecks[0].account, from.account)
  assert.equal(result.receipt.cloudChecks[0].status, 'pending')
  assert.equal(result.complete, false)
})

test('held continuation shares one receipt and Undo restores both phases', async () => {
  const h = await home()
  const cold = id(300)
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.write(cold, [entry('user', 300, null, cold)])
  await h.record('P', SOURCE)
  await h.record('P', cold)
  const all = await accounts(h.paths), from = all.find((row) => row.account === h.acct.P), to = all.find((row) => row.account === h.acct.T)
  let rows = desktopFixture()
  const first = await executeMove([from], to, h.paths, { processes: rows, moveOnly: true })
  assert.equal(first.ok, true)
  assert.equal(first.receipt.sessions.length, 1)
  assert.equal(first.receipt.sessions[0].id, cold)
  assert.equal(first.receipt.held.length, 1)
  assert.equal(first.complete, false)
  rows = []
  const finished = await finishHeld(h.paths, { processes: rows })
  assert.equal(finished.file, first.file)
  assert.equal(finished.receipt.sessions.length, 2)
  assert.equal(finished.receipt.held.length, 0)
  assert.equal(finished.ok, true)
  const result = await undo(h.paths)
  assert.ok(result.dest)
  assert.deepEqual((await readdir(h.dir('P'))).sort(), [`local_${SOURCE}.json`, `local_${cold}.json`].sort())
  assert.deepEqual(await readdir(h.dir('T')), [])
})

test('a failed held continuation preserves the earlier completed phase', async () => {
  const h = await home()
  const cold = id(300)
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.write(cold, [entry('user', 300, null, cold)])
  await h.record('P', SOURCE)
  await h.record('P', cold)
  const all = await accounts(h.paths), from = all.find((row) => row.account === h.acct.P), to = all.find((row) => row.account === h.acct.T)
  const first = await executeMove([from], to, h.paths, { processes: desktopFixture(), moveOnly: true })
  await assert.rejects(finishHeld(h.paths, { processes: [], report: (stage, text) => { if (stage === 'retire' && text === 'checking') throw new Error('interrupted append') } }), /interrupted append/)
  const recovered = await undo(h.paths)
  assert.ok(recovered.reconciled)
  const receipt = JSON.parse(await readFile(first.file))
  assert.equal(receipt.sessions.length, 1)
  assert.equal(receipt.sessions[0].id, cold)
  assert.equal(receipt.held.length, 1)
  assert.ok(await readFile(path.join(h.dir('T'), `local_${cold}.json`)))
  assert.ok(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`)))
  assert.equal(await readFile(path.join(h.dir('T'), `local_${SOURCE}.json`)).catch(() => null), null)
  const retry = await finishHeld(h.paths, { processes: [] })
  assert.equal(retry.ok, true)
  assert.deepEqual(retry.receipt.failed, [])
})

test('a stale held continuation cannot start a new move after Undo', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE)
  const all = await accounts(h.paths), from = all.find((row) => row.account === h.acct.P), to = all.find((row) => row.account === h.acct.T)
  const first = await executeMove([from], to, h.paths, { processes: desktopFixture(), moveOnly: true })
  await undo(h.paths)
  const stale = await executeMove([from], to, h.paths, { processes: [], resume: true, resumeFile: first.file })
  assert.equal(stale.ok, false)
  assert.match(stale.reason, /pending move changed/)
  assert.ok(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`)))
  assert.deepEqual(await readdir(h.dir('T')), [])
})

test('held parents retain workerless children in the same continuation', async () => {
  const h = await home(), child = id(701)
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE)
  await h.write(child, [entry('user', 701, null, child)])
  await h.record('P', child, { forkedFromSessionId: `local_${SOURCE}` })
  const all = await accounts(h.paths), from = all.find((row) => row.account === h.acct.P), to = all.find((row) => row.account === h.acct.T)
  const first = await executeMove([from], to, h.paths, { processes: desktopFixture(), moveOnly: true })
  assert.deepEqual(first.receipt.held.map((row) => row.id), [SOURCE, child])
  const finished = await finishHeld(h.paths, { processes: [] })
  assert.equal(finished.ok, true)
  assert.deepEqual(finished.receipt.sessions.map((row) => row.id), [SOURCE, child])
  assert.deepEqual(await readdir(h.dir('P')), [])
})

test('completed cold records may grow before the held phase finishes', async () => {
  const h = await home(), cold = id(300)
  for (const session of [SOURCE, cold]) {
    await h.write(session, [entry('user', session === SOURCE ? 1 : 300, null, session)])
    await h.record('P', session)
  }
  const all = await accounts(h.paths), from = all.find((row) => row.account === h.acct.P), to = all.find((row) => row.account === h.acct.T)
  const first = await executeMove([from], to, h.paths, { processes: desktopFixture(), moveOnly: true })
  const row = first.receipt.sessions[0]
  const record = JSON.parse(await readFile(row.record))
  await writeFile(row.record, JSON.stringify({ ...record, lastFocusedAt: 1000, completedTurns: 2, bridgeSessionIds: ['session_new'] }))
  await appendFile(row.targetTranscript, JSON.stringify(entry('assistant', 301, 300, cold)) + '\n')
  const result = await finishHeld(h.paths, { processes: [] })
  assert.equal(result.ok, true)
  assert.equal(result.receipt.sessions.length, 2)
})

test('a successful held phase cannot hide an earlier placement verification failure', async () => {
  const h = await home(), cold = id(300)
  for (const session of [SOURCE, cold]) {
    await h.write(session, [entry('user', session === SOURCE ? 1 : 300, null, session)])
    await h.record('P', session)
  }
  const all = await accounts(h.paths), from = all.find((row) => row.account === h.acct.P), to = all.find((row) => row.account === h.acct.T)
  const target = path.join(h.dir('T'), `local_${cold}.json`)
  const first = await executeMove([from], to, h.paths, { processes: desktopFixture(), moveOnly: true, report: (stage) => {
    if (stage === 'sidecars') writeFileSync(target, JSON.stringify({ ...JSON.parse(readFileSync(target)), lastFocusedAt: 1000 }))
  } })
  assert.equal(first.receipt.verification.ok, false)
  assert.deepEqual(first.receipt.failed, [])
  const result = await finishHeld(h.paths, { processes: [] })
  assert.equal(result.ok, false)
  assert.equal(result.receipt.verification.ok, false)
  assert.ok(result.problems.some((row) => row.id === cold))
})

test('Keep local reports earlier verification failure while cancelling held work', async () => {
  const h = await home(), cold = id(300)
  for (const session of [SOURCE, cold]) {
    await h.write(session, [entry('user', session === SOURCE ? 1 : 300, null, session)])
    await h.record('P', session)
  }
  const all = await accounts(h.paths), from = all.find((row) => row.account === h.acct.P), to = all.find((row) => row.account === h.acct.T)
  const target = path.join(h.dir('T'), `local_${cold}.json`)
  await executeMove([from], to, h.paths, { processes: desktopFixture(), moveOnly: true, report: (stage) => {
    if (stage === 'sidecars') writeFileSync(target, JSON.stringify({ ...JSON.parse(readFileSync(target)), lastFocusedAt: 1000 }))
  } })
  const kept = await keepLocal(h.paths)
  assert.equal(kept.heldCancelled, 1)
  assert.equal(kept.ok, false)
  assert.equal(kept.receipt.verification.ok, false)
  assert.deepEqual(kept.receipt.held, [])
})

test('Keep local can abandon held work without undoing completed cold moves', async () => {
  const h = await home(), cold = id(300)
  for (const session of [SOURCE, cold]) {
    await h.write(session, [entry('user', session === SOURCE ? 1 : 300, null, session)])
    await h.record('P', session)
  }
  const all = await accounts(h.paths), from = all.find((row) => row.account === h.acct.P), to = all.find((row) => row.account === h.acct.T)
  const first = await executeMove([from], to, h.paths, { processes: desktopFixture(), moveOnly: true })
  const kept = await keepLocal(h.paths)
  assert.equal(kept.file, first.file)
  assert.equal(kept.heldCancelled, 1)
  assert.deepEqual(kept.receipt.held, [])
  assert.ok(await readFile(path.join(h.dir('T'), `local_${cold}.json`)))
  assert.ok(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`)))
})

test('placed verification ignores activity and bridge registration but records title drift without repairing it', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE)
  const all = await accounts(h.paths), from = all.find((row) => row.account === h.acct.P), to = all.find((row) => row.account === h.acct.T)
  const result = await move(await inventory([from], to, h.paths), to, h.paths)
  const file = result.receipt.sessions[0].record
  const record = JSON.parse(await readFile(file))
  record.lastFocusedAt = Date.now()
  record.completedTurns = 100
  record.bridgeSessionIds = ['session_new']
  record.writtenBranches = ['main', 'feature/anything']
  record.prs = [{ prNumber: 1, url: 'https://github.com/example/repo/pull/1' }]
  await writeFile(file, JSON.stringify(record))
  assert.deepEqual((await verifyPlaced(h.paths)).changed, [])
  record.title = 'Different title after placement'
  await writeFile(file, JSON.stringify(record))
  const changed = await verifyPlaced(h.paths)
  assert.equal(changed.changed.length, 1)
  assert.ok(changed.changed[0].fields.includes('title'))
  assert.ok(await readFile(changed.changed[0].placed))
  assert.ok(await readFile(changed.changed[0].found))
  assert.equal(JSON.parse(await readFile(file)).title, record.title)
  record.lastFocusedAt++
  await writeFile(file, JSON.stringify(record))
  assert.equal((await verifyPlaced(h.paths)).changed[0].found, changed.changed[0].found)
})

test('automatic retries never request a restart and leave held workers alone', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE)
  const all = await accounts(h.paths), from = all.find((row) => row.account === h.acct.P), to = all.find((row) => row.account === h.acct.T)
  const rows = desktopFixture()
  const partial = await executeMove([from], to, h.paths, { processes: rows, moveOnly: true })
  assert.equal(partial.receipt.held.length, 1)
  const checked = await sweep(h.paths, { processes: rows })
  assert.equal(checked.result.pendingLocal, true)
  assert.equal(await readFile(path.join(h.paths.state, 'restart-plan.json')).catch(() => null), null)
  assert.ok(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`)))
})

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

function fork(entries, sourceId, targetId, title) {
  const kept = entries.filter((entry) => MESSAGES.has(entry.type) && typeof entry.uuid === 'string' && !entry.isSidechain)
  const fresh = new Map(kept.map((entry) => [entry.uuid, randomUUID()]))
  const moved = kept.map((entry) => ({
    ...entry,
    uuid: fresh.get(entry.uuid),
    parentUuid: fresh.get(entry.parentUuid) ?? null,
    logicalParentUuid: entry.logicalParentUuid == null ? entry.logicalParentUuid : fresh.get(entry.logicalParentUuid) ?? null,
    sessionId: targetId,
    isSidechain: false,
    forkedFrom: { sessionId: sourceId, messageUuid: entry.uuid }
  }))
  moved.push({ type: 'custom-title', sessionId: targetId, customTitle: title, uuid: randomUUID(), timestamp: new Date().toISOString() })
  return moved
}

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
  await h.write(SOURCE, [entry('user', 1, null, SOURCE), entry('assistant', 2, 1, SOURCE)])
  await h.record('P', SOURCE)
  await h.write(id(600), [entry('user', 600, null, id(600))])
  await appendFile(path.join(h.project, `${id(600)}.jsonl`), '{"type":"user","uuid":"broken\n')
  await h.record('P', id(600))
  const run = (args) => cli(h.root, args)
  const orphan = path.join(h.project, `${id(900)}.jsonl`)
  const orphanEntry = { ...entry('user', 900, null, id(900)), forkedFrom: { sessionId: id(1), messageUuid: id(901) } }
  await writeFile(orphan, JSON.stringify(orphanEntry) + '\n')
  await mkdir(h.paths.state, { recursive: true })
  const interrupted = {
    at: '2026-01-01T00-00-00-000',
    from: [],
    to: 'x',
    sessions: [],
    failed: [],
    pending: { strategy: 'remote', id: id(900), title: 'Orphan', targetId: id(900), made: [orphan], targetSemantic: semantic([orphanEntry], id(900)), targetSemanticVersion: 3 }
  }
  await writeFile(path.join(h.paths.state, `${interrupted.at}.json`), JSON.stringify(interrupted))
  const dry = await run(['--from', 'p@example.com', '--to', 'z@example.com', '--dry-run', '--json'])
  assert.equal(dry.code, 1)
  assert.ok(dry.stdout.includes('"stage":"pending"'))
  assert.equal(JSON.parse(dry.stdout.trim().split('\n').at(-1)).recoveryRequired, true)
  assert.ok(await readFile(orphan))
  assert.equal(await readdir(path.join(h.paths.state, 'quarantine')).catch(() => 'none'), 'none')
  const list = JSON.parse((await run(['accounts', '--json'])).stdout)
  assert.equal(list.some((a) => a.active), false)
  assert.equal(list.every((a) => a.identityState === 'unknown'), true)
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
  assert.equal(done.complete, true)
  assert.equal(done.moved, 1)
  assert.equal(done.failed.length, 1)
  assert.equal(done.restart, false)
  const rejected = await run(['undo', '--dry-run'])
  assert.equal(rejected.code, 1)
  assert.match(rejected.stderr, /undo accepts only --json/)
  const undone = await run(['undo', '--json'])
  assert.equal(undone.code, 0)
  assert.equal(JSON.parse(undone.stdout.trim().split('\n').at(-1)).sessions, 1)
})

test('menubar-style cloud moves do not invent pending work for a cleared source', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE, rehomeRecord({ title: 'Offline source' }))
  const moved = await cli(h.root, ['--from', 'p@example.com personal', '--to', 'z@example.com personal', '--cloud', '--json'])
  assert.equal(moved.code, 0)
  const result = JSON.parse(moved.stdout.trim().split('\n').at(-1))
  assert.equal(result.moved, 1)
  assert.equal(result.pendingCloud, 0)
  assert.equal(result.complete, true)
  assert.deepEqual(await readdir(h.dir('P')), [])
  assert.deepEqual(await readdir(h.dir('Z')), [`local_${SOURCE}.json`])

  const listed = await cli(h.root, ['accounts', '--json'])
  const accountRows = JSON.parse(listed.stdout)
  assert.equal(accountRows.find((account) => account.account === h.acct.P && account.org === h.org.P).pending, null)

  const undone = await cli(h.root, ['undo', '--json'])
  assert.equal(undone.code, 0)
  assert.deepEqual(await readdir(h.dir('P')), [`local_${SOURCE}.json`])
  assert.deepEqual(await readdir(h.dir('Z')), [])
})

test('human CLI names staged Undo instead of printing false success', async () => {
  const h = await home()
  const at = '2099-01-03T00-00-00-000'
  const receipt = {
    at,
    from: ['source'],
    to: 'target',
    sessions: [],
    failed: [],
    superseded: [],
    undoing: [],
    remoteUndoing: [{ id: 'cse_pending_undo', title: 'Pending undo', account: h.acct.T, org: h.org.T, accountLabel: 't@example.com · Team T' }]
  }
  await mkdir(h.paths.state, { recursive: true })
  await writeFile(path.join(h.paths.state, `${at}.json`), JSON.stringify(receipt))
  const result = await cli(h.root, ['undo'])

  assert.equal(result.code, 1)
  assert.match(result.stdout, /pending.*t@example.com · Team T/i)
  assert.doesNotMatch(result.stdout, /quarantine\s+undefined/)
  assert.doesNotMatch(result.stdout, /shared transcripts unchanged/)
  const continued = await cli(h.root, ['finish', '--json'])
  assert.equal(continued.code, 1)
  assert.equal(JSON.parse(continued.stdout.trim().split('\n').at(-1)).pendingUndo.length, 1)
})

test('human CLI reports Finish recovery without an undefined pending count', async () => {
  const h = await home()
  const at = '2099-01-04T00-00-00-000'
  const receipt = {
    at,
    from: ['source'],
    to: 'target',
    sessions: [],
    failed: [],
    superseded: [],
    finalizing: true,
    cloudChecks: [{ account: h.acct.T, org: h.org.T, label: 't@example.com · Team T', status: 'pending' }]
  }
  await mkdir(h.paths.state, { recursive: true })
  await writeFile(path.join(h.paths.state, `${at}.json`), JSON.stringify(receipt))
  const result = await cli(h.root, ['finish'])

  assert.equal(result.code, 1)
  assert.match(result.stdout, /recovered.*finalization rolled back/i)
  assert.doesNotMatch(result.stdout, /undefined cloud checks/)
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

test('a non-Claude process mentioning a session id is not a worker', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE)
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)', SOURCE], { stdio: 'ignore' })
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  try {
    const by = Object.fromEntries((await accounts(h.paths)).map((account) => [account.account, account]))
    const inv = await inventory([by[h.acct.P]], by[h.acct.Z], h.paths)
    assert.equal(inv.move.length, 1)
    assert.equal((await move(inv, by[h.acct.Z], h.paths)).ok, true)
  } finally {
    child.kill()
    await once(child, 'exit')
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
  assert.deepEqual(inv.move.map((s) => s.id), [id(950)])
  assert.deepEqual(inv.blocked.map((s) => s.id), [id(960)])
  assert.match(inv.blocked[0].error, /1 unparseable lines/)
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

test('compatible source versions that need merging are blocked', async () => {
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
  assert.deepEqual(inv.move, [])
  assert.equal(inv.blocked.length, 1)
  assert.match(inv.blocked[0].error, /multiple compatible source versions require merging/)
  assert.equal(inv.twice, 1)
})

test('runtime latch drift remains one blocked history', async () => {
  const h = await home()
  const source = [entry('user', 944, null, id(944)), { type: 'atis-latch', sessionId: id(944), atis: 'first' }]
  await h.write(id(944), source)
  await h.record('P', id(944))
  const copy = [...fork(source, id(944), id(947), 'Latch'), { type: 'atis-latch', sessionId: id(947), atis: 'second' }]
  await h.write(id(947), copy)
  await h.record('T', id(947))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const inv = await inventory([by[h.acct.P], by[h.acct.T]], by[h.acct.Z], h.paths)
  assert.equal(inv.move.length, 0)
  assert.equal(inv.blocked.length, 1)
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
  assert.deepEqual(inv.move.map((s) => s.id), [id(935)])
  assert.deepEqual(inv.blocked.map((s) => s.id), [id(937)])
  const result = await move(inv, by[h.acct.Z], h.paths)
  assert.match(result.receipt.failed[0].error, /conflicting duplicate uuids/)
})

test('new sidecars remain visible through a shared transcript', async () => {
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
  assert.equal(inv.there.length, 1)
  assert.deepEqual(inv.move, [])
  const second = await move(inv, p.to, h.paths)
  assert.equal(second.ok, true)
  assert.equal(second.receipt.sessions.length, 0)
  assert.deepEqual(await readdir(h.dir('P')), [])
  assert.deepEqual((await readdir(h.dir('Z'))).map((f) => f.slice(6, -5)), [older])
})

test('nested histories with split sidecars are blocked instead of copied', async () => {
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
  assert.deepEqual(inv.move, [])
  assert.equal(inv.blocked.length, 1)
  assert.match(inv.blocked[0].error, /multiple compatible source versions require merging/)
  assert.equal((await readdir(h.dir('P'))).length, 1)
  assert.equal((await readdir(h.dir('T'))).length, 1)
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

test('target sidecar drift after inventory keeps the source record', async () => {
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
  assert.match(second.receipt.failed[0].error, /destination changed since inventory/)
  assert.deepEqual(second.receipt.superseded, [])
  assert.ok((await readdir(h.dir('Z'))).includes(`local_${older}.json`))
})

test('a contained destination supersedes only its Desktop record', async () => {
  const h = await home()
  const q1 = [entry('user', 940, null, id(940)), entry('assistant', 941, 940, id(940))]
  await h.write(id(940), [...q1, entry('user', 942, 941, id(940))])
  await h.record('P', id(940))
  await h.write(id(945), fork(q1, id(940), id(945), 'Q'))
  const olderTranscript = path.join(h.project, `${id(945)}.jsonl`)
  await h.record('Z', id(945))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const inv = await inventory([by[h.acct.P]], by[h.acct.Z], h.paths)
  assert.deepEqual(inv.move.map((s) => s.id), [id(940)])
  const result = await move(inv, by[h.acct.Z], h.paths)
  assert.equal(result.ok, true)
  assert.deepEqual(result.receipt.superseded.filter((s) => !s.source).map((s) => s.id), [id(945)])
  assert.ok(await readFile(olderTranscript))
  assert.deepEqual((await readdir(h.dir('Z'))).map((f) => f.slice(6, -5)), [result.receipt.sessions[0].targetId])
  assert.deepEqual(await readdir(h.dir('P')), [])
  assert.ok((await undo(h.paths)).dest)
  assert.ok(await readFile(olderTranscript))
  assert.deepEqual((await readdir(h.dir('Z'))).map((f) => f.slice(6, -5)), [id(945)])
  assert.equal((await readdir(h.dir('P'))).length, 1)
})

test('an existing bridge makes target supersession a separate refusal, not a restart', async () => {
  const h = await home()
  const entries = [entry('user', 940, null, id(940)), entry('assistant', 941, 940, id(940))]
  await h.write(id(940), [...entries, entry('user', 942, 941, id(940))])
  await h.record('P', id(940))
  await h.write(id(945), fork(entries, id(940), id(945), 'Q'))
  await h.record('Z', id(945), { bridgeSessionIds: ['session_existing'] })
  const all = await accounts(h.paths), from = all.find((row) => row.account === h.acct.P), to = all.find((row) => row.account === h.acct.Z)
  const rows = desktopFixture(id(945))
  const inv = await inventory([from], to, h.paths, () => {}, { processes: rows })
  assert.equal(await restartPlan(inv, h.paths, rows), null)
})

test('a target without a Desktop record id never covers and retires a valid source', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE, rehomeRecord({ title: 'Valid source' }))
  await h.record('Z', SOURCE, rehomeRecord({ sessionId: null, title: 'Invalid target identity' }))
  const all = await accounts(h.paths)
  const from = all.find((account) => account.account === h.acct.P && account.org === h.org.P)
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const inv = await inventory([from], to, h.paths)

  assert.equal(inv.there.length, 0)
  assert.equal(inv.move.length, 0)
  assert.match(inv.blocked[0].error, /target session id collision/)
  const result = await move(inv, to, h.paths)
  assert.equal(result.ok, false)
  assert.ok(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`)))
})

test('a malformed source already present in the target is named and left untouched', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE, rehomeRecord({ sessionId: null, title: 'Malformed source' }))
  await h.record('Z', SOURCE, rehomeRecord({ title: 'Valid target' }))
  const all = await accounts(h.paths)
  const from = all.find((account) => account.account === h.acct.P && account.org === h.org.P)
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const inv = await inventory([from], to, h.paths)
  const result = await move(inv, to, h.paths)

  assert.equal(inv.there.length, 0)
  assert.match(inv.rejected[0].error, /Desktop record identity is invalid/)
  assert.equal(result.ok, false)
  assert.ok(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`)))
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
  const second = await move(inv, p.to, h.paths, (stage, text, extra = {}) => { if (!extra.live) stages.push(`${stage} ${text}`) })
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

test('cloud bridges rehome while destination task ownership stays locked', async () => {
  const h = await home()
  const base = [entry('user', 922, null, id(922))]
  await h.write(id(922), [...base, entry('assistant', 923, 922, id(922)), { type: 'bridge-session', sessionId: id(922), bridgeSessionId: 'remote' }])
  await h.record('P', id(922), { bridgeSessionIds: ['remote'] })
  await h.write(id(924), fork(base, id(922), id(924), 'Owned'))
  await h.record('Z', id(924))
  await writeFile(path.join(h.dir('Z'), 'scheduled-tasks.json'), JSON.stringify({ scheduledTasks: [{ id: 'task', notifySessionId: `local_${id(924)}` }] }))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const result = await move(await inventory([by[h.acct.P]], by[h.acct.Z], h.paths), by[h.acct.Z], h.paths)
  assert.equal(result.ok, false)
  assert.deepEqual(result.receipt.failed.map((row) => row.error), ['scheduled task registry kept in destination'])
  assert.deepEqual(JSON.parse(await readFile(result.receipt.sessions[0].record, 'utf8')).bridgeSessionIds, [])
  assert.deepEqual(await readdir(h.dir('P')), [])
  assert.ok((await readdir(h.dir('Z'))).includes(`local_${id(924)}.json`))
})

test('an unreadable scheduled task registry fails closed', async () => {
  const h = await home()
  await h.write(id(929), [entry('user', 929, null, id(929))])
  await h.record('P', id(929))
  const taskFile = path.join(h.dir('P'), 'scheduled-tasks.json')
  await writeFile(taskFile, '[]')
  let by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  assert.match(by[h.acct.P].taskError, /invalid scheduled task registry/)
  assert.match(by[h.acct.P].stats, /task registry unreadable/)
  await assert.rejects(inventory([by[h.acct.P]], by[h.acct.Z], h.paths), /invalid scheduled task registry/)
  await writeFile(taskFile, JSON.stringify({ scheduledTasks: [] }))
  by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const inv = await inventory([by[h.acct.P]], by[h.acct.Z], h.paths)
  await assert.rejects(move(inv, by[h.acct.Z], h.paths, (stage) => {
    if (stage === 'sidecars') writeFileSync(taskFile, '{broken')
  }), /unreadable scheduled task registry/)
  assert.equal((await readdir(h.dir('P'))).filter((file) => file.startsWith('local_')).length, 1)
})

test('undo allows shared sidecar growth but refuses Desktop record changes', async () => {
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
  assert.match(refused.changed[0], /desktop record changed/)
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

test('duplicate source records for one transcript move once and retire every owner', async () => {
  const h = await home()
  await h.write(id(926), [entry('user', 926, null, id(926))])
  await h.record('P', id(926))
  await h.record('T', id(926))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const inv = await inventory([by[h.acct.P], by[h.acct.T]], by[h.acct.Z], h.paths)
  assert.equal(inv.sources.length, 2)
  assert.equal(inv.move.length, 1)
  assert.equal(inv.blocked.length, 0)
  const result = await move(inv, by[h.acct.Z], h.paths)
  assert.equal(result.ok, true)
  assert.equal(result.receipt.sessions.length, 1)
  assert.equal(result.receipt.superseded.filter((row) => row.source).length, 2)
  assert.deepEqual(await readdir(h.dir('P')), [])
  assert.deepEqual(await readdir(h.dir('T')), [])
  assert.deepEqual(await readdir(h.dir('Z')), [`local_${id(926)}.json`])
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
  assert.match(result.receipt.failed[0].error, /source changed during retirement/)
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

test('interrupted undo resumes from its journal', async () => {
  const h = await home()
  await h.write(id(918), [entry('user', 918, null, id(918))])
  await h.record('P', id(918))
  const by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const result = await move(await inventory([by[h.acct.P]], by[h.acct.Z], h.paths), by[h.acct.Z], h.paths)
  const receipt = JSON.parse(await readFile(result.file, 'utf8'))
  const row = receipt.sessions[0]
  const dest = path.join(h.paths.state, 'quarantine', receipt.at)
  const items = [row.record]
  receipt.undoing = [{
    id: row.targetId,
    title: row.title,
    required: items,
    hashes: [],
    trees: [],
    semantics: [[row.record, row.recordSemantic]],
    moved: items.map((file) => [file, path.join(dest, path.basename(file))])
  }]
  await writeFile(result.file, JSON.stringify(receipt))
  const source = receipt.superseded.find((item) => item.source).moved[0]
  await rename(source[1], source[0])
  await mkdir(dest, { recursive: true })
  await rename(row.record, path.join(dest, path.basename(row.record)))
  const resumed = await undo(h.paths)
  assert.equal(resumed.dest, dest)
  assert.ok(await readFile(source[0]))
  assert.equal(await readFile(row.record).catch(() => null), null)
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
    pending: { strategy: 'remote', id: id(898), title: 'Changed', targetId, made: [target], targetSemantic: semantic([entry('user', 898, null, targetId)], targetId), targetSemanticVersion: 3 }
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

const localTime = (time) => {
  const date = new Date(time)
  const part = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`
}

async function identityFixture(h) {
  const started = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000) * 1000
  const processes = [{ pid: 500, started: new Date(started).toString(), executable: '/Applications/Claude.app/Contents/MacOS/Claude' }]
  const event = (offset, text) => `${localTime(started + offset * 1000)} [info] ${text}\n`
  const init = (offset = 0, account = h.acct.P, org = h.org.P) => event(offset, `[LocalSessionManager] Initialization succeeded \u2014 accountId=${account}, orgId=${org}, existingSessions=0`)
  await mkdir(h.paths.logs, { recursive: true })
  const write = (text, name = 'main.log') => writeFile(path.join(h.paths.logs, name), text)
  await write(init())
  return { started, processes, event, init, write }
}

test('signed-in identity survives inactivity and ignores usage, focus, and allowlist refreshes', async () => {
  const h = await home(), f = await identityFixture(h)
  const team = path.join(h.paths.records, h.acct.P, h.org.T)
  await mkdir(team, { recursive: true })
  await writeFile(path.join(team, `local_${id(999)}.json`), JSON.stringify({ sessionId: `local_${id(999)}`, cliSessionId: id(999), cwd: '/tmp/fixture', lastFocusedAt: Date.now() }))
  await writeFile(path.join(path.dirname(h.paths.desktop), 'plan-usage-history.json'), JSON.stringify({ samples: [{ org: h.org.T, t: Date.now() }] }))
  const scope = path.join(path.dirname(h.paths.desktop), 'sentry/scope_v3.json')
  await mkdir(path.dirname(scope), { recursive: true })
  await writeFile(scope, JSON.stringify({ scope: { breadcrumbs: [{ timestamp: Date.now(), data: { url: `https://claude.ai/api/organizations/${h.org.T}/usage` } }] } }))
  await writeFile(h.paths.desktop, JSON.stringify({ lastKnownAccountUuid: h.acct.P, [`dxt:allowlistLastUpdated:${h.org.T}`]: new Date().toISOString() }))
  const result = await signedIn(h.paths, f.processes)
  assert.deepEqual(result, { account: h.acct.P, org: h.org.P, state: 'known', source: 'log', at: new Date(f.started).toISOString() })
  const list = await accounts(h.paths, f.processes)
  assert.deepEqual(list.filter((row) => row.active).map((row) => row.org), [h.org.P])
  assert.equal(list.filter((row) => row.account === h.acct.P).every((row) => row.signedIn), true)
  assert.equal(list.filter((row) => row.account !== h.acct.P).some((row) => row.signedIn), false)
})

test('signed-in identity invalidates incomplete transitions, logout, and initialization failures', async () => {
  const h = await home(), f = await identityFixture(h)
  for (const [event, state] of [
    [`[LocalSessionManager] Org changed from ${h.org.P} to ${h.org.T}, reinitializing sessions`, 'unknown'],
    [`[LocalSessionManager] Org changed from null to ${h.org.T}, reinitializing sessions`, 'unknown'],
    [`[account] Login-state transition (loggedOut: false \u2192 true, uuid: ${h.acct.P} \u2192 <none>), clearing oauth cache`, 'logged-out'],
    [`[account] Login-state transition (loggedOut: false \u2192 false, uuid: ${h.acct.P} \u2192 ${h.acct.T}), clearing oauth cache`, 'unknown'],
    ['[LocalSessionManager] Account logged out, marking for re-init on next login', 'logged-out'],
    ['[LocalSessionManager] Cannot initialize sessions: accountId=null, orgId=null. Keeping existing sessions.', 'unknown'],
    ['[LocalSessionManager] loadSessions failed during account transition', 'unknown'],
    ['[LocalSessionManager] Initialization succeeded, accountId=invalid, orgId=invalid', 'unknown']
  ]) {
    await f.write(f.init() + f.event(1, event))
    const result = await signedIn(h.paths, f.processes)
    assert.equal(result.state, state, event)
    assert.equal(result.account, null)
    assert.equal(result.org, null)
    await f.write(f.init() + f.event(1, event) + f.init(2, h.acct.P, h.org.T))
    assert.equal((await signedIn(h.paths, f.processes)).org, h.org.T)
  }
})

test('signed-in identity reads rotations, accepts the launch second, and rejects a previous launch', async () => {
  const h = await home(), f = await identityFixture(h)
  await f.write(f.event(10, '[display] unrelated display event'))
  await f.write(f.init(), 'main1.log')
  await f.write(f.init(-30, h.acct.T, h.org.T), 'main2.log')
  assert.equal((await signedIn(h.paths, f.processes)).org, h.org.P)
  const restarted = [{ ...f.processes[0], started: new Date(f.started + 1000).toString() }]
  assert.equal((await signedIn(h.paths, restarted)).state, 'unknown')
  await f.write(f.event(15, '[LocalSessionManager] Initialization wording changed'))
  assert.equal((await signedIn(h.paths, restarted)).state, 'unknown')
  assert.equal((await signedIn(h.paths, [])).state, 'unknown')
  assert.equal((await signedIn(h.paths, [...f.processes, { ...f.processes[0], pid: 501 }])).state, 'unknown')
})

test('signed-in identity rejects account conflicts and recovers only from a paired entry', async () => {
  const h = await home(), f = await identityFixture(h)
  await writeFile(h.paths.desktop, JSON.stringify({ lastKnownAccountUuid: h.acct.T }))
  assert.equal((await signedIn(h.paths, f.processes)).state, 'unknown')
  await f.write(f.init() + f.event(1, `[LocalSessionManager] Org changed from ${h.org.P} to ${h.org.T}, reinitializing sessions`))
  assert.equal((await signedIn(h.paths, f.processes)).state, 'unknown')
  await f.write(f.init() + f.init(2, h.acct.T, h.org.T))
  assert.equal((await signedIn(h.paths, f.processes)).account, h.acct.T)
  await writeFile(h.paths.desktop, '{}')
  assert.equal((await signedIn(h.paths, f.processes)).account, h.acct.T)
})

test('signed-in identity handles missing, future, and partially written log evidence', async () => {
  const h = await home(), f = await identityFixture(h)
  await f.write(f.init() + f.init(2, h.acct.P, h.org.T).trimEnd())
  assert.equal((await signedIn(h.paths, f.processes)).state, 'unknown')
  await f.write(f.init(48 * 60 * 60))
  assert.equal((await signedIn(h.paths, f.processes)).state, 'unknown')
  await unlink(path.join(h.paths.logs, 'main.log'))
  assert.equal((await signedIn(h.paths, f.processes)).state, 'unknown')
})

test('signed-in identity follows an offline switch without using network-dependent markers', async (t) => {
  const h = await home(), f = await identityFixture(h)
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline') })
  await writeFile(h.paths.desktop, JSON.stringify({ lastKnownAccountUuid: h.acct.P, [`dxt:allowlistLastUpdated:${h.org.P}`]: new Date().toISOString() }))
  await f.write(f.init() + f.event(1, `[LocalSessionManager] Org changed from ${h.org.P} to ${h.org.T}, reinitializing sessions`) + f.init(2, h.acct.P, h.org.T) + f.event(3, 'Failed to check allowlist status: offline'))
  assert.equal((await signedIn(h.paths, f.processes)).org, h.org.T)
  assert.equal(network.mock.callCount(), 0)
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

test('accounts includes a known login organization with no Desktop directory', async () => {
  const h = await home()
  const account = id(920)
  const org = id(921)
  const profile = path.join(h.root, '.claude-known')
  await mkdir(profile)
  await writeFile(path.join(profile, '.claude.json'), JSON.stringify({
    oauthAccount: { accountUuid: account, organizationUuid: org, emailAddress: 'known@example.com', organizationName: 'Known Team', organizationType: 'team' }
  }))
  const row = (await accounts(h.paths)).find((candidate) => candidate.account === account && candidate.org === org)

  assert.equal(row.label, 'known@example.com · Known Team')
  assert.equal(row.sessions.length, 0)
  assert.equal(await stat(row.dir).then(() => true, () => false), false)
})

test('menubar snapshot renders live accounts without installing', async () => {
  const h = await home()
  const output = path.join(h.root, 'snapshot', 'panel.png')
  const result = await cli(h.root, ['menubar', '--snapshot', output])
  const png = await readFile(output)

  assert.equal(result.code, 0, result.stderr)
  assert.equal(png.subarray(1, 4).toString(), 'PNG')
  assert.equal(await stat(path.join(h.paths.state, 'Claude Transplant.app')).then(() => true, () => false), false)
  assert.equal(await stat(path.join(h.root, 'Library/LaunchAgents/io.github.vitaliyhayda.claude-transplant.plist')).then(() => true, () => false), false)
})

test('same-account organization moves rehome one record without copying history', async () => {
  const h = await home()
  const teamDir = path.join(h.paths.records, h.acct.P, h.org.T)
  await mkdir(teamDir, { recursive: true })
  const transcript = path.join(h.project, `${SOURCE}.jsonl`)
  const entries = [
    entry('user', 1, null, SOURCE),
    entry('assistant', 2, 1, SOURCE),
    { type: 'bridge-session', sessionId: SOURCE, bridgeSessionId: 'session_fixture', ownerAccountUuid: h.acct.P, ownerOrganizationUuid: h.org.P }
  ]
  await h.write(SOURCE, entries)
  await mkdir(path.join(h.project, SOURCE, 'subagents'), { recursive: true })
  await writeFile(path.join(h.project, SOURCE, 'subagents', 'agent.jsonl'), '{"fixture":true}\n')
  const recordId = `local_${id(777)}`
  const recordName = `${recordId}.json`
  await h.record('P', SOURCE, rehomeRecord({ sessionId: recordId, bridgeSessionIds: ['session_fixture'] }))
  await rename(path.join(h.dir('P'), `local_${SOURCE}.json`), path.join(h.dir('P'), recordName))
  const before = await readFile(transcript)
  const beforeStat = await stat(transcript)

  const select = async (fromOrg, toOrg) => {
    const all = await accounts(h.paths)
    return {
      from: all.find((a) => a.account === h.acct.P && a.org === fromOrg),
      to: all.find((a) => a.account === h.acct.P && a.org === toOrg)
    }
  }

  let picked = await select(h.org.P, h.org.T)
  let inv = await inventory([picked.from], picked.to, h.paths)
  assert.equal(inv.move.length, 1)
  assert.equal(inv.move[0].strategy, 'rehome')
  const first = await move(inv, picked.to, h.paths)
  assert.equal(first.ok, true)
  assert.equal(first.receipt.sessions[0].strategy, 'rehome')
  assert.equal(first.receipt.sessions[0].targetId, SOURCE)
  assert.deepEqual(await readFile(transcript), before)
  assert.equal((await stat(transcript)).mtimeMs, beforeStat.mtimeMs)
  assert.deepEqual((await readdir(h.project)).sort(), [SOURCE, `${SOURCE}.jsonl`].sort())
  assert.deepEqual(await readdir(h.dir('P')), [])
  assert.deepEqual(await readdir(teamDir), [recordName])

  picked = await select(h.org.T, h.org.P)
  inv = await inventory([picked.from], picked.to, h.paths)
  assert.equal(inv.move[0].strategy, 'rehome')
  const second = await move(inv, picked.to, h.paths)
  assert.equal(second.ok, true)
  assert.deepEqual(await readFile(transcript), before)
  assert.deepEqual(await readdir(h.dir('P')), [recordName])
  assert.deepEqual(await readdir(teamDir), [])

  for (let round = 1; round < 10; round++) {
    picked = await select(h.org.P, h.org.T)
    inv = await inventory([picked.from], picked.to, h.paths)
    assert.equal(inv.move[0].strategy, 'rehome')
    assert.equal((await move(inv, picked.to, h.paths)).ok, true)
    picked = await select(h.org.T, h.org.P)
    inv = await inventory([picked.from], picked.to, h.paths)
    assert.equal(inv.move[0].strategy, 'rehome')
    assert.equal((await move(inv, picked.to, h.paths)).ok, true)
    assert.deepEqual(await readFile(transcript), before)
    assert.deepEqual((await readdir(h.project)).sort(), [SOURCE, `${SOURCE}.jsonl`].sort())
  }

  const bytes = async (root) => {
    let total = 0
    for (const item of await readdir(root, { withFileTypes: true })) {
      const file = path.join(root, item.name)
      total += item.isDirectory() ? await bytes(file) : (await stat(file)).size
    }
    return total
  }
  assert.ok(await bytes(h.paths.state) < 1_000_000)

  const undone = await undo(h.paths)
  assert.ok(undone.dest)
  assert.deepEqual(await readdir(h.dir('P')), [])
  assert.deepEqual(await readdir(teamDir), [recordName])
  assert.deepEqual(await readFile(transcript), before)
})

test('cross-login moves rehome across same and different organizations', async () => {
  for (const targetOrg of ['P', 'Z']) {
    const h = await home()
    await h.write(SOURCE, [entry('user', 1, null, SOURCE), entry('assistant', 2, 1, SOURCE)])
    await h.record('P', SOURCE, rehomeRecord())
    const targetDir = path.join(h.paths.records, h.acct.Z, h.org[targetOrg])
    await mkdir(targetDir, { recursive: true })
    const before = await readFile(path.join(h.project, `${SOURCE}.jsonl`))
    const all = await accounts(h.paths)
    const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
    const to = all.find((a) => a.account === h.acct.Z && a.org === h.org[targetOrg])
    const inv = await inventory([from], to, h.paths)
    assert.equal(inv.move[0].strategy, 'rehome')
    const result = await move(inv, to, h.paths)
    assert.equal(result.ok, true)
    assert.equal(result.receipt.sessions[0].strategy, 'rehome')
    assert.equal(result.receipt.sessions[0].targetId, SOURCE)
    assert.deepEqual(await readFile(path.join(h.project, `${SOURCE}.jsonl`)), before)
    assert.deepEqual(await readdir(h.dir('P')), [])
    assert.deepEqual(await readdir(targetDir), [`local_${SOURCE}.json`])
  }
})

test('local moves finish while inaccessible source cloud checks stay pending', async () => {
  const h = await home()
  const first = id(701)
  const second = id(702)
  await h.write(first, [entry('user', 1, null, first)])
  await h.record('P', first, rehomeRecord({ title: 'First source' }))
  await h.record('T', second, rehomeRecord({ title: 'Second source' }))
  const cloud = cloudFixture(h)
  const all = await accounts(h.paths)
  const from = [
    all.find((account) => account.account === h.acct.P && account.org === h.org.P),
    all.find((account) => account.account === h.acct.T && account.org === h.org.T)
  ]
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const inv = await inventory(from, to, h.paths, () => {}, { cloud, cloudRequested: true })
  const result = await move(inv, to, h.paths)

  assert.equal(result.ok, true)
  assert.equal(result.complete, false)
  assert.equal(result.pendingCloud, 1)
  assert.deepEqual(result.receipt.cloudChecks.map(({ label, status }) => ({ label, status })), [
    { label: from[0].label, status: 'complete' },
    { label: from[1].label, status: 'pending' }
  ])
  assert.deepEqual(await readdir(h.dir('Z')), [`local_${first}.json`])
  assert.deepEqual(await readdir(h.dir('P')), [])
  assert.deepEqual(await readdir(h.dir('T')), [`local_${second}.json`])
  const blocked = await cli(h.root, ['--from', 'z@example.com personal', '--to', 'p@example.com personal', '--json'])
  assert.equal(blocked.code, 1)
  assert.match(JSON.parse(blocked.stdout.trim().split('\n').at(-1)).reason, /pending move/)
})

test('a zero-record source creates no speculative cloud check', async () => {
  const h = await home()
  const all = await accounts(h.paths)
  const from = all.find((account) => account.account === h.acct.T && account.org === h.org.T)
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const result = await move(await inventory([from], to, h.paths, () => {}, { cloudRequested: true }), to, h.paths)

  assert.equal(result, null)
  assert.equal(await readdir(h.paths.state).then((names) => names.filter((name) => /^\d.*\.json$/.test(name)).length), 0)
})

test('completed local movement suppresses speculative pending', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE, rehomeRecord())
  const all = await accounts(h.paths)
  const from = all.find((account) => account.account === h.acct.P && account.org === h.org.P)
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const result = await move(await inventory([from], to, h.paths, () => {}, { cloudRequested: true }), to, h.paths)

  assert.equal(result.complete, true)
  assert.equal(result.pendingCloud, 0)
  assert.deepEqual(result.receipt.cloudChecks, [])
})

test('a late move failure restores the source cloud check', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('T', SOURCE, rehomeRecord())
  const all = await accounts(h.paths)
  const from = all.find((account) => account.account === h.acct.T && account.org === h.org.T)
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const inv = await inventory([from], to, h.paths, () => {}, { cloudRequested: true })
  await appendFile(path.join(h.project, `${SOURCE}.jsonl`), `${JSON.stringify(entry('assistant', 2, 1, SOURCE))}\n`)
  const result = await move(inv, to, h.paths)

  assert.equal(result.ok, false)
  assert.equal(result.pendingCloud, 1)
  assert.ok(await readFile(path.join(h.dir('T'), `local_${SOURCE}.json`)))
})

test('a refused retirement restores the source cloud check', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('T', SOURCE, rehomeRecord({ scheduledTaskId: 'task_fixture' }))
  await h.record('Z', SOURCE, rehomeRecord())
  const all = await accounts(h.paths)
  const from = all.find((account) => account.account === h.acct.T && account.org === h.org.T)
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const inv = await inventory([from], to, h.paths, () => {}, { cloudRequested: true })
  assert.equal(inv.cloudCheckAccounts.length, 0)
  const result = await move(inv, to, h.paths)

  assert.equal(result.pendingCloud, 1)
  assert.ok(await readFile(path.join(h.dir('T'), `local_${SOURCE}.json`)))
})

test('an unreadable source record prevents an empty-source assumption', async () => {
  const h = await home()
  await writeFile(path.join(h.dir('T'), `local_${SOURCE}.json`), '{')
  const all = await accounts(h.paths)
  const from = all.find((account) => account.account === h.acct.T && account.org === h.org.T)
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const inv = await inventory([from], to, h.paths, () => {}, { cloudRequested: true })

  assert.equal(inv.cloudCheckAccounts.length, 1)
})

test('Keep local retains a verified bridge rehome while its remote check is unavailable', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('T', SOURCE, rehomeRecord({ title: 'Keep local source', bridgeSessionIds: ['session_keep_local'] }))
  const all = await accounts(h.paths)
  const from = all.find((account) => account.account === h.acct.T && account.org === h.org.T)
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const moved = await moveWithPending(h, [from], to)
  const kept = await keepLocal(h.paths)

  assert.equal(kept.cancelled, 1)
  assert.equal(kept.receipt.cloudChecks[0].status, 'cancelled')
  assert.deepEqual(await readdir(h.dir('T')), [])
  assert.deepEqual(await readdir(h.dir('Z')), [`local_${SOURCE}.json`])
  assert.equal((await cli(h.root, ['--dry-run', '--from', 'z@example.com personal', '--to', 'p@example.com personal', '--json'])).code, 0)
  assert.ok((await undo(h.paths)).dest)
  assert.equal(moved.file, kept.file)
})

test('Keep local accepts a valid rehome record used after the move', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('T', SOURCE, rehomeRecord({ title: 'Original title', titleSource: 'auto' }))
  const all = await accounts(h.paths)
  const from = all.find((account) => account.account === h.acct.T && account.org === h.org.T)
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const cloud = cloudFixture(h, { account: h.acct.T, org: h.org.T, list: async () => { throw new Error('offline') } })
  await move(await inventory([from], to, h.paths, () => {}, { cloud, cloudRequested: true }), to, h.paths)
  const record = path.join(h.dir('Z'), `local_${SOURCE}.json`)
  await writeFile(record, JSON.stringify({ ...JSON.parse(await readFile(record)), title: 'Continued title', titleSource: 'user', completedTurns: 2 }))
  const kept = await keepLocal(h.paths)

  assert.equal(kept.ok, true)
  assert.equal(kept.cancelled, 1)
})

test('Keep local refuses structural rehome record drift', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('T', SOURCE, rehomeRecord({ cwd: '/tmp/original' }))
  const all = await accounts(h.paths)
  const from = all.find((account) => account.account === h.acct.T && account.org === h.org.T)
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const cloud = cloudFixture(h, { account: h.acct.T, org: h.org.T, list: async () => { throw new Error('offline') } })
  await move(await inventory([from], to, h.paths, () => {}, { cloud, cloudRequested: true }), to, h.paths)
  const record = path.join(h.dir('Z'), `local_${SOURCE}.json`)
  await writeFile(record, JSON.stringify({ ...JSON.parse(await readFile(record)), cwd: '/tmp/changed' }))
  const kept = await keepLocal(h.paths)

  assert.match(kept.refused[0], /desktop record changed/)
})

test('Keep local keeps strict validation for older receipts', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('T', SOURCE, rehomeRecord({ cwd: '/tmp/original' }))
  const all = await accounts(h.paths)
  const from = all.find((account) => account.account === h.acct.T && account.org === h.org.T)
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const moved = await moveWithPending(h, [from], to)
  const receipt = JSON.parse(await readFile(moved.file, 'utf8'))
  delete receipt.sessions[0].recordKeepSemantic
  await writeFile(moved.file, JSON.stringify(receipt))
  const record = path.join(h.dir('Z'), `local_${SOURCE}.json`)
  await writeFile(record, JSON.stringify({ ...JSON.parse(await readFile(record)), cwd: '/tmp/changed' }))

  assert.match((await keepLocal(h.paths)).refused[0], /desktop record changed/)
})

test('Keep local refuses when a moved destination record disappeared', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('T', SOURCE, rehomeRecord({ title: 'Vanished local target' }))
  const all = await accounts(h.paths)
  const from = all.find((account) => account.account === h.acct.T && account.org === h.org.T)
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  await moveWithPending(h, [from], to)
  await unlink(path.join(h.dir('Z'), `local_${SOURCE}.json`))
  const result = await keepLocal(h.paths)

  assert.match(result.refused[0], /desktop record changed/)
  assert.equal(result.receipt.cloudChecks[0].status, 'pending')
  assert.equal((await undo(h.paths)).changed.length > 0, true)
})

test('Keep local refuses when an existing carrier no longer contains the retired source', async () => {
  const h = await home()
  const target = id(711)
  const sourceEntries = [entry('user', 42, null, SOURCE)]
  await h.write(SOURCE, sourceEntries)
  await h.write(target, fork(sourceEntries, SOURCE, target, 'Carrier'))
  await h.record('T', SOURCE, rehomeRecord({ title: 'Contained source' }))
  await h.record('Z', target, rehomeRecord({ title: 'Carrier' }))
  const all = await accounts(h.paths)
  const from = all.find((account) => account.account === h.acct.T && account.org === h.org.T)
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const moved = await moveWithPending(h, [from], to)
  assert.equal(moved.receipt.sessions.length, 0)
  await h.write(target, [entry('user', 43, null, target, { message: { role: 'user', content: 'unrelated replacement' } })])
  const kept = await keepLocal(h.paths)

  assert.match(kept.refused[0], /no longer contains source history/)
  assert.equal(kept.receipt.cloudChecks[0].status, 'pending')
})

test('Keep local rejects a quarantined source record changed after retirement', async () => {
  const h = await home()
  const target = id(712)
  const sourceEntries = [entry('user', 44, null, SOURCE)]
  await h.write(SOURCE, sourceEntries)
  await h.write(target, fork(sourceEntries, SOURCE, target, 'Carrier'))
  await h.record('T', SOURCE, rehomeRecord({ title: 'Tamper source' }))
  await h.record('Z', target, rehomeRecord({ title: 'Tamper carrier' }))
  const all = await accounts(h.paths)
  const from = all.find((account) => account.account === h.acct.T && account.org === h.org.T)
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const moved = await moveWithPending(h, [from], to)
  await h.write(target, [entry('user', 45, null, target, { message: { role: 'user', content: 'replacement history' } })])
  const sourcePlan = moved.receipt.superseded.find((row) => row.source)
  const parkedRecord = sourcePlan.moved[0][1]
  const changed = JSON.parse(await readFile(parkedRecord, 'utf8'))
  await writeFile(parkedRecord, JSON.stringify({ ...changed, cliSessionId: target }))
  const kept = await keepLocal(h.paths)

  assert.match(kept.refused[0], /recovery artifact changed/)
  assert.equal(kept.receipt.cloudChecks[0].status, 'pending')
})

test('Keep local validates quarantine for a source rehomed by this move', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 46, null, SOURCE)])
  await h.record('T', SOURCE, rehomeRecord({ title: 'Moved quarantine source' }))
  const all = await accounts(h.paths)
  const from = all.find((account) => account.account === h.acct.T && account.org === h.org.T)
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const moved = await moveWithPending(h, [from], to)
  const parked = moved.receipt.superseded.find((row) => row.source).moved[0][1]
  await writeFile(parked, `${await readFile(parked, 'utf8')} `)
  const kept = await keepLocal(h.paths)

  assert.match(kept.refused[0], /recovery artifact changed/)
  assert.equal(kept.receipt.cloudChecks[0].status, 'pending')
})

test('a source cloud outage never blocks its eligible local move', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE, rehomeRecord({ title: 'Cloud outage source' }))
  const cloud = cloudFixture(h, {
    list: async () => { throw new Error('service unavailable') },
  })
  const all = await accounts(h.paths)
  const from = all.find((account) => account.account === h.acct.P && account.org === h.org.P)
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const inv = await inventory([from], to, h.paths, () => {}, { cloud, cloudRequested: true })
  const result = await move(inv, to, h.paths)

  assert.equal(result.ok, false)
  assert.equal(result.pendingCloud, 1)
  assert.equal(result.receipt.cloudChecks[0].status, 'failed')
  assert.match(result.receipt.failed[0].error, /service unavailable/)
  assert.deepEqual(await readdir(h.dir('P')), [])
  assert.deepEqual(await readdir(h.dir('Z')), [`local_${SOURCE}.json`])
})

test('Finish pending closes the same logical receipt under the matching source login', async () => {
  const h = await home()
  const first = id(703)
  const second = id(704)
  const firstEntries = [entry('user', 3, null, first)]
  const secondEntries = [entry('user', 4, null, second), entry('assistant', 5, 4, second)]
  await h.write(first, firstEntries)
  await h.write(second, secondEntries)
  await h.record('P', first, rehomeRecord({ title: 'First deferred source' }))
  await h.record('T', second, rehomeRecord({ title: 'Second deferred source', isArchived: true }))
  const emptyCloud = cloudFixture(h)
  const all = await accounts(h.paths)
  const from = [
    all.find((account) => account.account === h.acct.P && account.org === h.org.P),
    all.find((account) => account.account === h.acct.T && account.org === h.org.T)
  ]
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const moved = await moveWithPending(h, from, to, emptyCloud)
  let status = 'active'
  const deferredCloud = cloudFixture(h, {
    account: h.acct.T,
    org: h.org.T,
    list: async () => [remoteSession({ id: 'cse_deferred', title: 'Second deferred source', status })],
    eventRows: async () => remoteRows(secondEntries),
    session: async () => remoteState(status, { id: 'cse_deferred' }),
    archive: async () => { status = 'archived' },
    unarchive: async () => { status = 'active' }
  })
  const finished = await finishPending(h.paths, { cloud: deferredCloud })

  assert.equal(finished.file, moved.file)
  assert.equal(finished.ok, true)
  assert.equal(finished.complete, true)
  assert.equal(finished.pendingCloud, 0)
  assert.equal(finished.receipt.cloudChecks.every((check) => check.status === 'complete'), true)
  assert.equal(finished.receipt.remote.length, 1)
  assert.equal(finished.restart, true)
  assert.equal(JSON.parse(await readFile(path.join(h.dir('Z'), `local_${second}.json`), 'utf8')).isArchived, false)
  assert.equal(status, 'archived')
  assert.deepEqual((await readdir(h.paths.state)).filter((name) => /^\d.*\.json$/.test(name)), [path.basename(moved.file)])
})

test('automatic cloud follow-up waits for its named source login and completes the same receipt', async () => {
  const h = await home(), f = await identityFixture(h)
  const entries = [entry('user', 1, null, SOURCE)]
  await h.write(SOURCE, entries)
  await h.record('T', SOURCE, rehomeRecord({ title: 'Automatic source' }))
  const all = await accounts(h.paths)
  const from = all.find((row) => row.account === h.acct.T)
  const to = all.find((row) => row.account === h.acct.Z)
  const moved = await moveWithPending(h, [from], to)
  let reads = 0, status = 'active'
  const cloud = cloudFixture(h, {
    account: h.acct.T, org: h.org.T,
    list: async () => { reads++; return [remoteSession({ id: 'cse_auto', title: 'Automatic source', status })] },
    eventRows: async () => remoteRows(entries), session: async () => remoteState(status),
    archive: async () => { status = 'archived' }
  })
  await sweep(h.paths, { processes: f.processes, cloud })
  assert.equal(reads, 0)
  await writeFile(h.paths.desktop, JSON.stringify({ lastKnownAccountUuid: from.account }))
  await f.write(f.init() + f.event(1, `[account] Login-state transition (loggedOut: false \u2192 false, uuid: ${h.acct.P} \u2192 ${from.account}), clearing oauth cache`))
  await sweep(h.paths, { processes: f.processes, cloud })
  assert.equal(reads, 0)
  await appendFile(path.join(h.paths.logs, 'main.log'), f.init(2, from.account, from.org))
  const finished = await sweep(h.paths, { processes: f.processes, cloud })
  assert.equal(status, 'archived')
  assert.equal(finished.result.file, moved.file)
  assert.equal(finished.result.complete, true)
  assert.equal(finished.result.receipt.remote.length, 1)
  assert.equal(await readFile(path.join(h.paths.state, 'restart-plan.json')).catch(() => null), null)
  assert.deepEqual((await verifyPlaced(h.paths)).changed, [])
})

test('automatic cloud retries bind their receipt and claim backoff under the mutation lock', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('T', SOURCE)
  const all = await accounts(h.paths), from = all.find((row) => row.account === h.acct.T), to = all.find((row) => row.account === h.acct.Z)
  const first = await moveWithPending(h, [from], to)
  let calls = 0
  const cloud = cloudFixture(h, { account: h.acct.T, org: h.org.T, list: async () => { calls++; throw new Error('fixture offline') } })
  const stale = await finishPending(h.paths, { cloud, receiptFile: first.file + '.old', automatic: from })
  assert.equal(stale.nothing, true)
  assert.equal(calls, 0)
  await sweep(h.paths, { active: from, cloud })
  assert.equal(calls, 1)
  await sweep(h.paths, { active: from, cloud })
  assert.equal(calls, 1)
  const receipt = JSON.parse(await readFile(first.file))
  assert.equal(receipt.cloudChecks[0].status, 'failed')
  assert.equal(receipt.automaticCloudAttempt.key, `${from.account}/${from.org}`)
})

test('a successful cloud phase preserves an earlier local verification failure', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('T', SOURCE)
  await h.record('T', id(997))
  const all = await accounts(h.paths), from = all.find((row) => row.account === h.acct.T), to = all.find((row) => row.account === h.acct.Z)
  const target = path.join(h.dir('Z'), `local_${SOURCE}.json`)
  const first = await move(await inventory([from], to, h.paths, () => {}, { cloudRequested: true }), to, h.paths, (stage) => {
    if (stage === 'sidecars') writeFileSync(target, JSON.stringify({ ...JSON.parse(readFileSync(target)), lastFocusedAt: 1000 }))
  })
  assert.equal(first.receipt.verification.ok, false)
  const result = await finishPending(h.paths, { cloud: cloudFixture(h, { account: from.account, org: from.org }) })
  assert.equal(result.ok, false)
  assert.equal(result.receipt.verification.ok, false)
  assert.ok(result.problems.some((row) => row.id === SOURCE))
})

test('Finish pending preserves a record-only bridge identity after local rehome', async () => {
  const h = await home()
  const session = id(709)
  const local = [entry('user', 31, null, session, { message: { role: 'user', content: 'local history' } })]
  const remote = [entry('user', 32, null, 'cse_record_only', { message: { role: 'user', content: 'remote branch' } })]
  await h.write(session, local)
  await h.record('T', session, rehomeRecord({ title: 'Original local title', bridgeSessionIds: ['session_record_only'] }))
  const all = await accounts(h.paths)
  const from = all.find((account) => account.account === h.acct.T && account.org === h.org.T)
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const moved = await moveWithPending(h, [from], to)
  let status = 'active'
  const cloud = cloudFixture(h, {
    account: h.acct.T,
    org: h.org.T,
    list: async () => [remoteSession({ id: 'cse_record_only', title: 'Renamed remote title', status })],
    eventRows: async () => remoteRows(remote),
    session: async () => remoteState(status, { id: 'cse_record_only' }),
    archive: async () => { status = 'archived' },
    unarchive: async () => { status = 'active' }
  })
  const finished = await finishPending(h.paths, { cloud })

  assert.equal(moved.receipt.cloudLinks[0].bridgeIds.includes('session_record_only'), true)
  assert.equal(finished.ok, true)
  assert.equal(finished.complete, true)
  assert.equal(finished.rescued, 1)
  assert.equal(status, 'archived')
})

test('Finish pending preserves a record-only bridge identity when history was already there', async () => {
  const h = await home()
  const local = [entry('user', 33, null, SOURCE, { message: { role: 'user', content: 'local history' } })]
  const remote = [entry('user', 34, null, 'cse_existing_record_only', { message: { role: 'user', content: 'remote branch' } })]
  await h.write(SOURCE, local)
  await h.record('T', SOURCE, rehomeRecord({ title: 'Already there source', bridgeSessionIds: ['session_existing_record_only'] }))
  await h.record('Z', SOURCE, rehomeRecord({ title: 'Already there target' }))
  const all = await accounts(h.paths)
  const from = all.find((account) => account.account === h.acct.T && account.org === h.org.T)
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const moved = await moveWithPending(h, [from], to)
  assert.equal(moved.receipt.sessions.length, 0)
  let status = 'active'
  const cloud = cloudFixture(h, {
    account: h.acct.T,
    org: h.org.T,
    list: async () => [remoteSession({ id: 'cse_existing_record_only', title: 'Renamed remote title', status })],
    eventRows: async () => remoteRows(remote),
    session: async () => remoteState(status, { id: 'cse_existing_record_only' }),
    archive: async () => { status = 'archived' },
    unarchive: async () => { status = 'active' }
  })
  const finished = await finishPending(h.paths, { cloud })

  assert.equal(finished.ok, true)
  assert.equal(finished.rescued, 1)
  assert.equal(status, 'archived')
})

test('duplicate owners keep record-only bridge identities scoped to each source account', async () => {
  const h = await home()
  const local = [entry('user', 37, null, SOURCE, { message: { role: 'user', content: 'shared local history' } })]
  const remote = [entry('user', 38, null, 'cse_second_owner', { message: { role: 'user', content: 'second owner remote branch' } })]
  await h.write(SOURCE, local)
  await h.record('P', SOURCE, rehomeRecord({ title: 'First owner', bridgeSessionIds: ['session_first_owner'] }))
  await h.record('T', SOURCE, rehomeRecord({ title: 'Second owner', bridgeSessionIds: ['session_second_owner'] }))
  const all = await accounts(h.paths)
  const from = [
    all.find((account) => account.account === h.acct.P && account.org === h.org.P),
    all.find((account) => account.account === h.acct.T && account.org === h.org.T)
  ]
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const moved = await moveWithPending(h, from, to)
  assert.equal(moved.receipt.cloudLinks.some((row) => row.account === h.acct.T && row.bridgeIds.includes('session_second_owner')), true)
  let status = 'active'
  const cloud = cloudFixture(h, {
    account: h.acct.T,
    org: h.org.T,
    list: async () => [remoteSession({ id: 'cse_second_owner', title: 'Renamed second owner', status })],
    eventRows: async () => remoteRows(remote),
    session: async () => remoteState(status, { id: 'cse_second_owner' }),
    archive: async () => { status = 'archived' },
    unarchive: async () => { status = 'active' }
  })
  const finished = await finishPending(h.paths, { cloud })

  assert.equal(finished.ok, true)
  assert.equal(finished.rescued, 1)
  assert.equal(status, 'archived')
})

test('Finish pending never sweeps in a Remote Control session created after Move', async () => {
  const h = await home()
  const session = id(708)
  const entries = [entry('user', 30, null, session)]
  await h.write(session, entries)
  await h.record('T', session, rehomeRecord({ title: 'Later remote source' }))
  const all = await accounts(h.paths)
  const from = all.find((account) => account.account === h.acct.T && account.org === h.org.T)
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const moved = await moveWithPending(h, [from], to)
  let archived = false
  const cloud = cloudFixture(h, {
    account: h.acct.T,
    org: h.org.T,
    list: async () => [remoteSession({ id: 'cse_created_later', title: 'Later remote source', created_at: new Date(Date.parse(moved.receipt.startedAt) + 60_000).toISOString() })],
    eventRows: async () => remoteRows(entries),
    session: async () => remoteState('active', { id: 'cse_created_later' }),
    archive: async () => { archived = true },
    unarchive: async () => {}
  })
  const finished = await finishPending(h.paths, { cloud })

  assert.equal(finished.ok, true)
  assert.equal(finished.complete, true)
  assert.equal(finished.pendingCloud, 0)
  assert.equal(finished.receipt.remote.length, 0)
  assert.equal(finished.newerCloud, 1)
  assert.equal(finished.receipt.cloudChecks[0].later[0].title, 'Later remote source')
  assert.equal(archived, false)
})

test('the first cloud attempt uses the same creation cutoff as its retry', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 39, null, SOURCE)])
  await h.record('P', SOURCE, rehomeRecord({ title: 'Cutoff source' }))
  const all = await accounts(h.paths)
  const from = all.find((account) => account.account === h.acct.P && account.org === h.org.P)
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  let archived = false
  const requestedAt = new Date().toISOString()
  const cloud = cloudFixture(h, {
    list: async () => [remoteSession({ id: 'cse_after_click', title: 'Cutoff source', created_at: new Date(Date.parse(requestedAt) + 60_000).toISOString() })],
    eventRows: async () => remoteRows([entry('user', 40, null, 'cse_after_click')]),
    session: async () => remoteState('active'),
    archive: async () => { archived = true },
    unarchive: async () => {}
  })
  const result = await move(await inventory([from], to, h.paths, () => {}, { cloud, cloudRequested: true, requestedAt }), to, h.paths)

  assert.equal(result.ok, true)
  assert.equal(result.pendingCloud, 0)
  assert.equal(result.receipt.remote.length, 0)
  assert.equal(result.newerCloud, 1)
  assert.equal(archived, false)
})

test('Finish pending refuses an undated remote row instead of widening the move', async () => {
  const h = await home()
  const all = await accounts(h.paths)
  const from = all.find((account) => account.account === h.acct.T && account.org === h.org.T)
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  await moveWithPending(h, [from], to)
  let archived = false
  const cloud = cloudFixture(h, {
    account: h.acct.T,
    org: h.org.T,
    list: async () => [remoteSession({ id: 'cse_undated', title: 'Undated remote', created_at: undefined })],
    eventRows: async () => [],
    session: async () => remoteState('active'),
    archive: async () => { archived = true },
    unarchive: async () => {}
  })
  const result = await finishPending(h.paths, { cloud })

  assert.equal(result.ok, false)
  assert.equal(result.pendingCloud, 1)
  assert.match(result.receipt.failed[0].error, /creation time is missing/)
  assert.equal(archived, false)
})

test('a failed deferred cloud session remains explicit and retryable', async () => {
  const h = await home()
  const session = id(705)
  const shared = branchEntries(8, session, 10)
  const local = [...shared, entry('assistant', 18, 17, session, { message: { role: 'assistant', content: 'local branch' } })]
  await h.write(session, local)
  await h.record('T', session, rehomeRecord({ title: 'Retryable cloud source' }))
  const all = await accounts(h.paths)
  const from = all.find((account) => account.account === h.acct.T && account.org === h.org.T)
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const moved = await moveWithPending(h, [from], to)
  let supported = false
  let status = 'active'
  const remote = [
    ...shared,
    entry('user', 19, 17, 'cse_retryable', {
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'remote branch' }]
      }
    })
  ]
  const cloud = cloudFixture(h, {
    account: h.acct.T,
    org: h.org.T,
    list: async () => [remoteSession({ id: 'cse_retryable', title: 'Retryable cloud source', status })],
    eventRows: async () => {
      if (!supported) throw new Error('Remote Control history contains an unsupported content block')
      return remoteRows(remote)
    },
    session: async () => remoteState(status, { id: 'cse_retryable' }),
    archive: async () => { status = 'archived' },
    unarchive: async () => { status = 'active' }
  })

  const failed = await finishPending(h.paths, { cloud })
  assert.equal(failed.file, moved.file)
  assert.equal(failed.ok, false)
  assert.equal(failed.pendingCloud, 1)
  assert.equal(failed.receipt.cloudChecks[0].status, 'failed')
  assert.match(failed.receipt.failed.at(-1).error, /unsupported content block/)
  assert.equal(status, 'active')

  supported = true
  const retried = await finishPending(h.paths, { cloud })
  assert.equal(retried.ok, true)
  assert.equal(retried.complete, true)
  assert.equal(retried.pendingCloud, 0)
  assert.equal(retried.receipt.failed.length, 0)
  assert.equal(retried.receipt.sessions.filter((row) => row.strategy === 'remote').length, 1)
  assert.equal(status, 'archived')
})

test('a deferred rescue verification failure can be retried after harmless record drift', async () => {
  const h = await home()
  const session = id(710)
  const local = [entry('user', 35, null, session, { message: { role: 'user', content: 'local history' } })]
  const remote = [entry('user', 36, null, 'cse_verify_retry', { message: { role: 'user', content: 'remote branch' } })]
  await h.write(session, local)
  await h.record('T', session, rehomeRecord({ title: 'Verification retry', bridgeSessionIds: ['session_verify_retry'] }))
  const all = await accounts(h.paths)
  const from = all.find((account) => account.account === h.acct.T && account.org === h.org.T)
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  await moveWithPending(h, [from], to)
  let status = 'active'
  const cloud = cloudFixture(h, {
    account: h.acct.T,
    org: h.org.T,
    list: async () => [remoteSession({ id: 'cse_verify_retry', title: 'Verification retry remote', status })],
    eventRows: async () => remoteRows(remote),
    session: async () => remoteState(status, { id: 'cse_verify_retry' }),
    archive: async () => { status = 'archived' },
    unarchive: async () => { status = 'active' }
  })
  let damaged = false
  const report = (stage, _text, progress) => {
    if (stage !== 'verify' || progress?.completed !== 0 || damaged) return
    damaged = true
    const rescueFile = readdirSync(h.dir('Z')).map((name) => path.join(h.dir('Z'), name)).find((file) => !file.endsWith(`${session}.json`))
    const record = JSON.parse(readFileSync(rescueFile, 'utf8'))
    writeFileSync(rescueFile, JSON.stringify({ ...record, lastFocusedAt: record.lastFocusedAt + 1 }))
  }
  const failed = await finishPending(h.paths, { cloud, report })
  assert.equal(failed.ok, false)
  assert.equal(failed.receipt.cloudChecks[0].status, 'failed')
  assert.equal(status, 'active')
  assert.match((await keepLocal(h.paths)).refused[0], /verification failed/)

  const retried = await finishPending(h.paths, { cloud })
  assert.equal(retried.ok, true)
  assert.equal(retried.complete, true)
  assert.equal(retried.receipt.verification.ok, true)
  assert.equal(retried.receipt.verification.problems.length, 0)
  assert.equal(status, 'archived')
})

test('Undo cancels unchecked cloud sources and completes across source logins', async () => {
  const h = await home()
  const first = id(706)
  const second = id(707)
  const firstEntries = [entry('user', 20, null, first), entry('assistant', 21, 20, first)]
  const secondEntries = [entry('user', 22, null, second), entry('assistant', 23, 22, second)]
  await h.write(first, firstEntries)
  await h.write(second, secondEntries)
  await h.record('P', first, rehomeRecord({ title: 'First undo source' }))
  await h.record('T', second, rehomeRecord({ title: 'Second undo source' }))
  const states = { first: 'active', second: 'active' }
  const makeCloud = (account, org, key, remote, title, entries) => cloudFixture(h, {
    account,
    org,
    list: async () => [remoteSession({ id: remote, title, status: states[key] })],
    eventRows: async () => remoteRows(entries),
    session: async () => remoteState(states[key], { id: remote }),
    archive: async () => { states[key] = 'archived' },
    unarchive: async () => { states[key] = 'active' }
  })
  const firstCloud = makeCloud(h.acct.P, h.org.P, 'first', 'cse_first_undo', 'First undo source', firstEntries)
  const secondCloud = makeCloud(h.acct.T, h.org.T, 'second', 'cse_second_undo', 'Second undo source', secondEntries)
  const all = await accounts(h.paths)
  const from = [
    all.find((account) => account.account === h.acct.P && account.org === h.org.P),
    all.find((account) => account.account === h.acct.T && account.org === h.org.T)
  ]
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  await moveWithPending(h, from, to, firstCloud)
  await finishPending(h.paths, { cloud: secondCloud })
  assert.deepEqual(states, { first: 'archived', second: 'archived' })

  const staged = await undo(h.paths, { cloud: firstCloud })
  assert.deepEqual(states, { first: 'active', second: 'archived' })
  assert.deepEqual(staged.pendingUndo, [from[1].label])
  assert.equal(staged.dest, undefined)
  assert.equal(staged.receipt.cloudChecks.every((check) => check.status === 'cancelled' || check.status === 'complete'), true)
  assert.deepEqual((await readdir(h.dir('Z'))).sort(), [`local_${first}.json`, `local_${second}.json`].sort())

  const finished = await finishPending(h.paths, { cloud: secondCloud })
  assert.deepEqual(states, { first: 'active', second: 'active' })
  assert.ok(finished.dest)
  assert.deepEqual((await readdir(h.dir('P'))), [`local_${first}.json`])
  assert.deepEqual((await readdir(h.dir('T'))), [`local_${second}.json`])
  assert.deepEqual(await readdir(h.dir('Z')), [])
})

test('a verified target archives its source Remote Control mirror and Undo restores it', async () => {
  const h = await home()
  const entries = [entry('user', 1, null, SOURCE), entry('assistant', 2, 1, SOURCE)]
  await h.write(SOURCE, [entry('user', 50, null, SOURCE), ...entries])
  await h.record('Z', SOURCE, rehomeRecord({ isArchived: true }))
  let status = 'active'
  const calls = []
  const cloud = cloudFixture(h, {
    list: async () => [remoteSession({ id: 'cse_fixture', title: `Session ${SOURCE.slice(-3)}`, status })],
    eventRows: async () => remoteRows(entries.map((row) => ({
      type: row.type,
      uuid: id(Number(row.uuid.slice(-12)) + 100),
      session_id: 'cse_fixture',
      message: row.type === 'assistant' ? { ...row.message, usage: { output_tokens: 999 }, stop_reason: null } : row.message
    }))),
    session: async () => remoteState(status, { id: 'cse_fixture' }),
    archive: async () => { calls.push('archive'); status = 'archived' },
    unarchive: async () => { calls.push('unarchive'); status = 'active' }
  })
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.Z && a.org === h.org.Z)
  const inv = await inventory([from], to, h.paths, () => {}, { cloud })
  assert.equal(inv.move.length, 0)
  assert.equal(inv.cloud.matches.length, 1)
  assert.equal(inv.cloud.blocked.length, 0)

  const result = await move(inv, to, h.paths)
  assert.equal(result.ok, true, JSON.stringify(result.receipt.failed))
  assert.deepEqual(calls, ['archive'])
  assert.equal(result.receipt.remote.length, 1)
  assert.equal(status, 'archived')
  const targetFile = path.join(h.dir('Z'), `local_${SOURCE}.json`)
  const activated = JSON.parse(await readFile(targetFile, 'utf8'))
  assert.equal(activated.isArchived, false)
  activated.lastFocusedAt = Date.now()
  activated.promptAppendSnapshot = { append: 'current Desktop prompt', cliVersion: 'fixture' }
  await writeFile(targetFile, JSON.stringify(activated))

  const undone = await undo(h.paths, { cloud })
  assert.ok(undone.dest)
  assert.deepEqual(calls, ['archive', 'unarchive'])
  assert.equal(status, 'active')
  const restored = JSON.parse(await readFile(targetFile, 'utf8'))
  assert.equal(restored.isArchived, true)
  assert.deepEqual(restored.promptAppendSnapshot, activated.promptAppendSnapshot)
})

test('attachment prompts and tiny ordering drift prove semantic Remote Control containment', async () => {
  const h = await home()
  const remote = Array.from({ length: 100 }, (_, index) => entry(index % 2 ? 'assistant' : 'user', index + 100, index ? index + 99 : null, SOURCE))
  const local = structuredClone(remote)
  const prompt = local[80].message.content
  local.splice(80, 1, { type: 'attachment', uuid: id(800), sessionId: SOURCE, attachment: { prompt } })
  ;[local[20], local[21]] = [local[21], local[20]]
  await h.write(SOURCE, local)
  await h.record('Z', SOURCE, rehomeRecord())
  const cloud = cloudFixture(h, {
    list: async () => [remoteSession({ id: 'cse_equivalent', title: `Session ${SOURCE.slice(-3)}` })],
    eventRows: async () => remoteRows(remote),
    session: async () => remoteState('active'),
    archive: async () => {},
    unarchive: async () => {}
  })
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.Z && a.org === h.org.Z)
  const inv = await inventory([from], to, h.paths, () => {}, { cloud })
  assert.equal(inv.cloud.matches.length, 1)
  assert.equal(inv.cloud.matches[0].target.kind, 'existing')
  assert.equal(inv.cloud.matches[0].target.matchMode, 'equivalent')
})

test('a divergent Remote Control history becomes a separate verified local session', async () => {
  const h = await home()
  const sharedLocal = branchEntries(8, SOURCE, 20)
  const localPrelude = [entry('user', 6, null, SOURCE), entry('assistant', 7, 6, SOURCE)]
  await h.write(SOURCE, [...localPrelude, ...sharedLocal, entry('user', 28, 27, SOURCE, { message: { role: 'user', content: 'local branch' } })])
  await h.record('Z', SOURCE, rehomeRecord({
    alwaysAllowedReasons: ['anchor-only'],
    chromeTabGroupId: 'anchor-tab',
    chromePermissionMode: 'skip_all_permission_checks',
    enabledMcpTools: ['anchor-only'],
    lastSpawnRootDetected: '/anchor-only',
    permissionMode: 'bypassPermissions',
    promptAppendSnapshot: { append: 'anchor prompt' },
    remoteMcpServersConfig: [{ name: 'anchor-only' }],
    sessionPermissionUpdates: [{ tool: 'anchor-only' }],
    sessionSettings: { safe: true },
    spawnSeed: { anchor: true }
  }))
  const remote = [
    ...branchEntries(8, 'cse_rescue', 20),
    entry('user', 28, 27, 'cse_rescue', { message: { role: 'user', content: 'remote branch question\u2028with separator' } }),
    entry('assistant', 29, 28, 'cse_rescue', { message: { role: 'assistant', content: [{ type: 'text', text: 'remote branch answer' }] } }),
    entry('user', 30, 29, 'cse_rescue', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_fixture', content: [{ type: 'tool_reference', tool_name: 'Read' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } }] }] } }),
    { type: 'system', subtype: 'worker_shutting_down', reason: 'fixture', timestamp: '2026-09-01T00:00:14.000Z' }
  ]
  let status = 'active'
  const createdAtSeconds = 1_788_000_000
  const lastEventSeconds = 1_788_000_060
  const cloud = cloudFixture(h, {
    list: async () => [remoteSession({ id: 'cse_rescue', title: `Session ${SOURCE.slice(-3)}`, created_at: createdAtSeconds, status })],
    eventRows: async () => remoteRows(remote),
    session: async () => remoteState(status, { last_event_at: lastEventSeconds }),
    archive: async () => { status = 'archived' },
    unarchive: async () => { status = 'active' }
  })
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.Z && a.org === h.org.Z)
  const inv = await inventory([from], to, h.paths, () => {}, { cloud })
  assert.equal(inv.cloud.matches[0].target.kind, 'rescue')
  const result = await move(inv, to, h.paths)
  assert.equal(result.ok, true, JSON.stringify(result.receipt.failed))
  assert.equal(status, 'archived')
  assert.equal(result.receipt.sessions.length, 1)
  assert.equal(result.receipt.sessions[0].strategy, 'remote')
  assert.equal(result.receipt.remote[0].targetKind, 'rescue')
  const rescued = result.receipt.sessions[0]
  assert.match(await readFile(rescued.targetTranscript, 'utf8'), /\\u2028/)
  const rescuedEntries = lines(await readFile(rescued.targetTranscript, 'utf8'))
  assert.deepEqual(rescuedEntries.filter((row) => row.message).map((row) => row.message), remote.filter((row) => ['user', 'assistant'].includes(row.type)).map((row) => row.message))
  assert.equal(rescuedEntries.some((row) => row.type === 'system'), false)
  assert.equal(rescued.rescueAnchorId, SOURCE)
  assert.match(rescued.remoteMessageSha, /^[0-9a-f]{64}$/)
  const rescuedRecord = JSON.parse(await readFile(rescued.record, 'utf8'))
  assert.equal(rescuedRecord.title, `Session ${SOURCE.slice(-3)}`)
  assert.equal(rescuedRecord.createdAt, createdAtSeconds * 1000)
  assert.equal(rescuedRecord.lastActivityAt, lastEventSeconds * 1000)
  assert.equal(rescuedRecord.permissionMode, 'default')
  assert.deepEqual(rescuedRecord.alwaysAllowedReasons, [])
  assert.deepEqual(rescuedRecord.remoteMcpServersConfig, [{ name: 'anchor-only' }])
  assert.deepEqual(rescuedRecord.sessionPermissionUpdates, [])
  assert.deepEqual(rescuedRecord.sessionSettings, { safe: true })
  for (const key of ['chromePermissionMode', 'chromeTabGroupId', 'enabledMcpTools', 'lastSpawnRootDetected', 'promptAppendSnapshot', 'spawnSeed']) assert.equal(rescuedRecord[key], undefined)
  await writeFile(rescued.record, JSON.stringify({ ...rescuedRecord, lastSpawnRootDetected: true, promptAppendSnapshot: { append: '', cliVersion: 'fixture' } }))
  assert.ok((await undo(h.paths, { cloud })).dest)
  assert.equal(status, 'active')
  assert.equal(await readFile(path.join(h.dir('Z'), `local_${SOURCE}.json`), 'utf8').then(() => true), true)
  assert.equal(await readFile(rescued.targetTranscript).then(() => true, () => false), false)
  assert.equal(await readFile(rescued.record).then(() => true, () => false), false)
})

test('an unrelated same-title local session cannot anchor a remote rescue', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('Z', SOURCE, rehomeRecord())
  const remote = [
    entry('user', 10, null, 'cse_unrelated', { message: { role: 'user', content: 'unrelated question' } }),
    entry('assistant', 11, 10, 'cse_unrelated', { message: { role: 'assistant', content: 'unrelated answer' } })
  ]
  let archived = false
  const cloud = {
    account: h.acct.P,
    org: h.org.P,
    list: async () => [remoteSession({ id: 'cse_unrelated', title: `Session ${SOURCE.slice(-3)}` })],
    eventRows: async () => remoteRows(remote),
    session: async () => remoteState('active'),
    archive: async () => { archived = true },
    unarchive: async () => {}
  }
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.Z && a.org === h.org.Z)
  const inv = await inventory([from], to, h.paths, () => {}, { cloud })
  assert.equal(inv.cloud.matches.length, 0)
  assert.match(inv.cloud.blocked[0].error, /does not share a branch segment/)
  const result = await move(inv, to, h.paths)
  assert.equal(result.ok, false)
  assert.equal(archived, false)
})

test('an exact bridge id anchors a renamed divergent remote session', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE), { type: 'bridge-session', sessionId: SOURCE, bridgeSessionId: 'session_exact' }])
  await h.record('Z', SOURCE, rehomeRecord({ title: 'Renamed local session' }))
  const remote = [
    entry('user', 10, null, 'cse_exact', { message: { role: 'user', content: 'remote-only question' } }),
    entry('assistant', 11, 10, 'cse_exact', { message: { role: 'assistant', content: 'remote-only answer' } })
  ]
  let status = 'active'
  const cloud = {
    account: h.acct.P,
    org: h.org.P,
    list: async () => [remoteSession({ id: 'cse_exact', title: 'Remote renamed session', status })],
    eventRows: async () => remoteRows(remote),
    session: async () => remoteState(status),
    archive: async () => { status = 'archived' },
    unarchive: async () => { status = 'active' }
  }
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.Z && a.org === h.org.Z)
  const inv = await inventory([from], to, h.paths, () => {}, { cloud })
  assert.equal(inv.cloud.matches[0].target.kind, 'rescue')
  assert.equal(inv.cloud.matches[0].target.base.id, SOURCE)
  const result = await move(inv, to, h.paths)
  assert.equal(result.ok, true, JSON.stringify(result.receipt.failed))
  assert.equal(status, 'archived')
})

test('a rescue anchor changing after inventory keeps the remote source active', async () => {
  const h = await home()
  const shared = branchEntries(8, SOURCE, 30)
  await h.write(SOURCE, [...shared, entry('user', 38, 37, SOURCE, { message: { role: 'user', content: 'local branch' } })])
  await h.record('Z', SOURCE, rehomeRecord())
  const remote = [...branchEntries(8, 'cse_anchor_drift', 30), entry('user', 38, 37, 'cse_anchor_drift', { message: { role: 'user', content: 'remote branch' } })]
  let archived = false
  let eventRowCalls = 0
  const cloud = {
    account: h.acct.P,
    org: h.org.P,
    list: async () => [remoteSession({ id: 'cse_anchor_drift', title: `Session ${SOURCE.slice(-3)}` })],
    eventRows: async () => {
      eventRowCalls++
      if (eventRowCalls === 2) await appendFile(path.join(h.project, `${SOURCE}.jsonl`), `${JSON.stringify(entry('assistant', 39, 38, SOURCE))}\n`)
      return remoteRows(remote)
    },
    session: async () => remoteState('active'),
    archive: async () => { archived = true },
    unarchive: async () => {}
  }
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.Z && a.org === h.org.Z)
  const inv = await inventory([from], to, h.paths, () => {}, { cloud })
  assert.equal(inv.cloud.matches[0].target.kind, 'rescue')
  const result = await move(inv, to, h.paths)
  assert.equal(result.ok, false)
  assert.equal(archived, false)
  assert.equal(eventRowCalls, 2)
  assert.match(result.receipt.failed[0].error, /anchor changed/)
})

test('a short remote history is not matched to a differently titled local session', async () => {
  const h = await home()
  const remote = [entry('user', 1, null, SOURCE), entry('assistant', 2, 1, SOURCE)]
  await h.write(SOURCE, remote)
  await h.record('Z', SOURCE, rehomeRecord({ title: 'Renamed local session' }))
  const cloud = {
    account: h.acct.P,
    org: h.org.P,
    list: async () => [remoteSession({ id: 'cse_short', title: 'Different remote title' })],
    eventRows: async () => remoteRows(remote),
    session: async () => remoteState('active'),
    archive: async () => {},
    unarchive: async () => {}
  }
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.Z && a.org === h.org.Z)
  const inv = await inventory([from], to, h.paths, () => {}, { cloud })
  assert.equal(inv.cloud.matches.length, 0)
  assert.match(inv.cloud.blocked[0].error, /too short to match a renamed local target/)
})

test('an unsupported remote content block is never rescued or archived', async () => {
  const h = await home()
  const shared = branchEntries(8, SOURCE, 40)
  await h.write(SOURCE, [...shared, entry('user', 48, 47, SOURCE, { message: { role: 'user', content: 'local branch' } })])
  await h.record('Z', SOURCE, rehomeRecord())
  const remote = [
    ...shared,
    entry('user', 48, 47, 'cse_unsupported', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_fixture', content: [{ type: 'image', source: { type: 'text', media_type: 'text/plain', data: 'not an image' } }] }] } })
  ]
  let archived = false
  const cloud = {
    account: h.acct.P,
    org: h.org.P,
    list: async () => [remoteSession({ id: 'cse_unsupported', title: `Session ${SOURCE.slice(-3)}` })],
    eventRows: async () => remoteRows(remote),
    session: async () => remoteState('active'),
    archive: async () => { archived = true },
    unarchive: async () => {}
  }
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.Z && a.org === h.org.Z)
  const inv = await inventory([from], to, h.paths, () => {}, { cloud })
  assert.equal(inv.cloud.matches.length, 0)
  assert.match(inv.cloud.blocked[0].error, /unsupported content block/)
  const result = await move(inv, to, h.paths)
  assert.equal(result.ok, false)
  assert.equal(result.pendingCloud, 1)
  assert.equal(result.receipt.cloudChecks[0].status, 'failed')
  assert.equal(archived, false)
  assert.match(result.receipt.failed[0].error, /unsupported content block/)
  assert.deepEqual((await readdir(h.dir('Z'))).filter((name) => name.endsWith('.json')), [`local_${SOURCE}.json`])
})

test('an unreadable assistant payload cannot disappear from remote containment checks', async () => {
  const h = await home(), entries = [entry('user', 1, null, SOURCE)]
  await h.write(SOURCE, entries)
  await h.record('P', SOURCE)
  let archived = false
  const cloud = cloudFixture(h, {
    list: async () => [remoteSession({ id: 'cse_unreadable_message', title: 'Session 001' })],
    eventRows: async () => [...remoteRows(entries), { event_type: 'assistant', sequence_num: 2, payload: { type: 'assistant', unknown_body: 'new data' } }],
    session: async () => remoteState('active'), archive: async () => { archived = true }
  })
  const all = await accounts(h.paths), from = all.find((row) => row.account === h.acct.P), to = all.find((row) => row.account === h.acct.Z)
  const result = await move(await inventory([from], to, h.paths, () => {}, { cloud }), to, h.paths)
  assert.equal(archived, false)
  assert.equal(result.ok, false)
  assert.ok(result.receipt.failed.some((row) => row.error.includes('payload is unreadable')))
})

test('pending remote actions are refused even when worker status says idle', async () => {
  for (const extra of [{ requires_action_details_list: [{ request_id: 'queued' }] }, { external_metadata: { pending_action: { request_id: 'queued' } } }, { external_metadata: { pending_actions: '[{"request_id":"queued"}]' } }]) {
    const h = await home(), entries = [entry('user', 1, null, SOURCE)]
    await h.write(SOURCE, entries)
    await h.record('P', SOURCE)
    let archived = false
    const cloud = cloudFixture(h, { list: async () => [remoteSession({ id: 'cse_queued', title: 'Session 001' })], eventRows: async () => remoteRows(entries), session: async () => remoteState('active', extra), archive: async () => { archived = true } })
    const all = await accounts(h.paths), from = all.find((row) => row.account === h.acct.P), to = all.find((row) => row.account === h.acct.Z)
    const result = await move(await inventory([from], to, h.paths, () => {}, { cloud }), to, h.paths)
    assert.equal(archived, false)
    assert.equal(result.ok, false)
    assert.ok(result.receipt.failed.some((row) => row.error.includes('pending actions')))
  }
})

test('changed remote history or input is refused even when its event marker is unchanged', async () => {
  for (const added of [{ event_type: 'assistant', sequence_num: 2, payload: entry('assistant', 2, 1, SOURCE) }, { event_type: 'control_request', sequence_num: 2, payload: { type: 'control_request', request_id: 'new', request: { subtype: 'interrupt' } } }]) {
  const h = await home(), entries = [entry('user', 1, null, SOURCE)]
  await h.write(SOURCE, entries)
  await h.record('P', SOURCE)
  let reads = 0, archived = false
  const cloud = cloudFixture(h, {
    list: async () => [remoteSession({ id: 'cse_input', title: 'Session 001' })],
    eventRows: async () => [...remoteRows(entries), ...(++reads >= 3 ? [added] : [])],
    session: async () => remoteState('active'), archive: async () => { archived = true }
  })
  const all = await accounts(h.paths), from = all.find((row) => row.account === h.acct.P), to = all.find((row) => row.account === h.acct.Z)
  const result = await move(await inventory([from], to, h.paths, () => {}, { cloud }), to, h.paths)
  assert.equal(archived, false)
  assert.equal(result.ok, false)
  assert.ok(result.receipt.failed.some((row) => row.error.includes('history or input changed')))
  }
})

test('missing Remote Control readiness fields fail closed', async () => {
  const h = await home()
  const entries = [entry('user', 1, null, SOURCE)]
  await h.write(SOURCE, entries)
  await h.record('Z', SOURCE, rehomeRecord())
  let archived = false
  const cloud = {
    account: h.acct.P,
    org: h.org.P,
    list: async () => [remoteSession({ id: 'cse_unknown', title: `Session ${SOURCE.slice(-3)}` })],
    eventRows: async () => remoteRows(entries),
    session: async () => ({ status: 'active', last_event_at: '2026-09-01T00:01:00.000Z' }),
    archive: async () => { archived = true },
    unarchive: async () => {}
  }
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.Z && a.org === h.org.Z)
  const inv = await inventory([from], to, h.paths, () => {}, { cloud })
  assert.equal(inv.cloud.matches.length, 0)
  assert.match(inv.cloud.blocked[0].error, /not proven disconnected and idle/)
  const result = await move(inv, to, h.paths)
  assert.equal(result.ok, false)
  assert.equal(archived, false)
  assert.match(result.receipt.failed[0].error, /not proven disconnected and idle/)
})

test('a Remote Control mirror stays active when no local target shares its title', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('Z', SOURCE, rehomeRecord({ title: 'Different local session' }))
  let archived = false
  const cloud = {
    account: h.acct.P,
    org: h.org.P,
    list: async () => [remoteSession({ id: 'cse_other', title: `Session ${SOURCE.slice(-3)}` })],
    eventRows: async () => remoteRows([entry('user', 9, null, 'cse_other', { message: { role: 'user', content: 'different history' } })]),
    session: async () => remoteState(archived ? 'archived' : 'active', { id: 'cse_other' }),
    archive: async () => { archived = true },
    unarchive: async () => { archived = false }
  }
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.Z && a.org === h.org.Z)
  const inv = await inventory([from], to, h.paths, () => {}, { cloud })
  assert.equal(inv.cloud.matches.length, 0)
  assert.equal(inv.cloud.blocked.length, 1)
  assert.match(inv.cloud.blocked[0].error, /no linked or same-title local target/)
  const result = await move(inv, to, h.paths)
  assert.equal(result.ok, false)
  assert.equal(result.pendingCloud, 1)
  assert.equal(result.receipt.cloudChecks[0].status, 'failed')
  assert.equal(archived, false)
})

test('a local move lands before its matching Remote Control mirror archives', async () => {
  const h = await home()
  const entries = [entry('user', 1, null, SOURCE), entry('assistant', 2, 1, SOURCE)]
  await h.write(SOURCE, entries)
  await h.record('P', SOURCE, rehomeRecord({ isArchived: true }))
  let status = 'active'
  const targetRecord = path.join(h.dir('Z'), `local_${SOURCE}.json`)
  const cloud = {
    account: h.acct.P,
    org: h.org.P,
    list: async () => [remoteSession({ id: 'cse_move', title: `Session ${SOURCE.slice(-3)}`, tags: ['remote-control-repl'], status })],
    eventRows: async () => remoteRows(entries),
    session: async () => remoteState(status, { id: 'cse_move' }),
    archive: async () => { assert.ok(await readFile(targetRecord)); status = 'archived' },
    unarchive: async () => { status = 'active' }
  }
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.Z && a.org === h.org.Z)
  const inv = await inventory([from], to, h.paths, () => {}, { cloud })
  assert.equal(inv.move.length, 1)
  assert.equal(inv.cloud.matches[0].target.kind, 'move')
  const result = await move(inv, to, h.paths)
  assert.equal(result.ok, true)
  assert.equal(result.receipt.remote.length, 1)
  assert.equal(status, 'archived')
  assert.deepEqual(await readdir(h.dir('P')), [])
  assert.equal(JSON.parse(await readFile(targetRecord, 'utf8')).isArchived, false)
  assert.ok((await undo(h.paths, { cloud })).dest)
  assert.equal(status, 'active')
  assert.equal(JSON.parse(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`), 'utf8')).isArchived, true)
})

test('Keep local accepts a rehome target activated by cloud archival', async () => {
  const h = await home()
  const entries = [entry('user', 1, null, SOURCE), entry('assistant', 2, 1, SOURCE)]
  await h.write(SOURCE, entries)
  await h.record('P', SOURCE, rehomeRecord({ isArchived: true }))
  let status = 'active'
  const cloud = cloudFixture(h, {
    list: async () => [remoteSession({ id: 'cse_keep_activation', title: `Session ${SOURCE.slice(-3)}`, status })],
    eventRows: async () => remoteRows(entries),
    session: async () => remoteState(status),
    archive: async () => { status = 'archived' },
    unarchive: async () => { status = 'active' }
  })
  const all = await accounts(h.paths)
  const from = [
    all.find((account) => account.account === h.acct.P && account.org === h.org.P),
    all.find((account) => account.account === h.acct.T && account.org === h.org.T)
  ]
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const moved = await moveWithPending(h, from, to, cloud)

  assert.equal(moved.pendingCloud, 1)
  assert.equal(JSON.parse(await readFile(path.join(h.dir('Z'), `local_${SOURCE}.json`), 'utf8')).isArchived, false)
  assert.equal((await keepLocal(h.paths)).ok, true)
})

test('activation rollback restores receipt hashes for Keep local and Undo', async () => {
  const h = await home()
  const entries = [entry('user', 1, null, SOURCE), entry('assistant', 2, 1, SOURCE)]
  await h.write(SOURCE, entries)
  await h.record('P', SOURCE, rehomeRecord({ isArchived: true }))
  let reads = 0
  const cloud = cloudFixture(h, {
    list: async () => [remoteSession({ id: 'cse_rollback', title: `Session ${SOURCE.slice(-3)}` })],
    eventRows: async () => remoteRows(entries),
    session: async () => remoteState('active', { last_event_at: ++reads >= 6 ? 'changed' : 'stable' }),
    archive: async () => { throw new Error('archive should not run') }
  })
  const all = await accounts(h.paths)
  const from = [
    all.find((account) => account.account === h.acct.P && account.org === h.org.P),
    all.find((account) => account.account === h.acct.T && account.org === h.org.T)
  ]
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const moved = await moveWithPending(h, from, to, cloud)
  const target = path.join(h.dir('Z'), `local_${SOURCE}.json`)

  assert.equal(JSON.parse(await readFile(target, 'utf8')).isArchived, true)
  assert.equal((await keepLocal(h.paths)).ok, true)
  assert.ok((await undo(h.paths, { cloud })).dest)
})

test('a local verification failure keeps its Remote Control source active', async () => {
  const h = await home()
  const entries = [entry('user', 1, null, SOURCE), entry('assistant', 2, 1, SOURCE)]
  await h.write(SOURCE, entries)
  await h.record('P', SOURCE, rehomeRecord())
  let status = 'active'
  let archived = false
  const cloud = {
    account: h.acct.P,
    org: h.org.P,
    list: async () => [remoteSession({ id: 'cse_verify', title: `Session ${SOURCE.slice(-3)}`, status })],
    eventRows: async () => remoteRows(entries),
    session: async () => remoteState(status),
    archive: async () => { archived = true; status = 'archived' },
    unarchive: async () => { status = 'active' }
  }
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.Z && a.org === h.org.Z)
  const targetRecord = path.join(h.dir('Z'), `local_${SOURCE}.json`)
  const report = (stage, _text, progress) => {
    if (stage !== 'verify' || progress?.completed !== 0) return
    const record = JSON.parse(readFileSync(targetRecord, 'utf8'))
    writeFileSync(targetRecord, JSON.stringify({ ...record, lastFocusedAt: Date.now() }))
  }
  const result = await move(await inventory([from], to, h.paths, () => {}, { cloud }), to, h.paths, report)
  assert.equal(result.ok, false)
  assert.equal(archived, false)
  assert.match(result.receipt.failed.at(-1).error, /failed verification/)
  assert.ok(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`)))
})

test('Undo stages the matching cloud identity before changing local records', async () => {
  const h = await home()
  const entries = [entry('user', 1, null, SOURCE)]
  await h.write(SOURCE, entries)
  await h.record('Z', SOURCE, rehomeRecord())
  let status = 'active'
  const cloud = {
    account: h.acct.P,
    org: h.org.P,
    list: async () => [remoteSession({ id: 'cse_identity', title: `Session ${SOURCE.slice(-3)}`, status })],
    eventRows: async () => remoteRows(entries),
    session: async () => remoteState(status),
    archive: async () => { status = 'archived' },
    unarchive: async () => { status = 'active' }
  }
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.Z && a.org === h.org.Z)
  const result = await move(await inventory([from], to, h.paths, () => {}, { cloud }), to, h.paths)
  assert.equal(result.ok, true)
  const wrong = { ...cloud, account: h.acct.Q, org: h.org.Q }
  const staged = await undo(h.paths, { cloud: wrong })
  assert.deepEqual(staged.pendingUndo, [from.label])
  assert.equal(status, 'archived')
  assert.ok(await readFile(path.join(h.dir('Z'), `local_${SOURCE}.json`)))
})

test('Undo checks an activated target before restoring its cloud mirror', async () => {
  const h = await home()
  const entries = [entry('user', 1, null, SOURCE)]
  await h.write(SOURCE, entries)
  await h.record('Z', SOURCE, rehomeRecord({ isArchived: true }))
  let status = 'active'
  let unarchived = false
  const cloud = {
    account: h.acct.P,
    org: h.org.P,
    list: async () => [remoteSession({ id: 'cse_changed', title: `Session ${SOURCE.slice(-3)}`, status })],
    eventRows: async () => remoteRows(entries),
    session: async () => remoteState(status),
    archive: async () => { status = 'archived' },
    unarchive: async () => { unarchived = true; status = 'active' }
  }
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.Z && a.org === h.org.Z)
  await move(await inventory([from], to, h.paths, () => {}, { cloud }), to, h.paths)
  const targetFile = path.join(h.dir('Z'), `local_${SOURCE}.json`)
  const changed = JSON.parse(await readFile(targetFile, 'utf8'))
  changed.permissionMode = 'changed after move'
  await writeFile(targetFile, JSON.stringify(changed))

  const refused = await undo(h.paths, { cloud })
  assert.match(refused.restoreProblems[0], /activated target record changed/)
  assert.equal(unarchived, false)
  assert.equal(status, 'archived')
})

test('interrupted target activation restoration resumes when the prior state is already present', async () => {
  const h = await home()
  const entries = [entry('user', 1, null, SOURCE)]
  await h.write(SOURCE, entries)
  await h.record('Z', SOURCE, rehomeRecord({ isArchived: true }))
  let status = 'active'
  const cloud = {
    account: h.acct.P,
    org: h.org.P,
    list: async () => [remoteSession({ id: 'cse_activation_resume', title: `Session ${SOURCE.slice(-3)}`, status })],
    eventRows: async () => remoteRows(entries),
    session: async () => remoteState(status),
    archive: async () => { status = 'archived' },
    unarchive: async () => { status = 'active' }
  }
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.Z && a.org === h.org.Z)
  const moved = await move(await inventory([from], to, h.paths, () => {}, { cloud }), to, h.paths)
  const targetFile = path.join(h.dir('Z'), `local_${SOURCE}.json`)
  const target = JSON.parse(await readFile(targetFile, 'utf8'))
  await writeFile(targetFile, JSON.stringify({ ...target, isArchived: true }))
  const receipt = JSON.parse(await readFile(moved.file, 'utf8'))
  receipt.undoing = []
  delete receipt.remoteUndoing
  status = 'active'
  await writeFile(moved.file, JSON.stringify(receipt))
  const recovered = await undo(h.paths, { cloud })
  assert.ok(recovered.dest)
  assert.equal(JSON.parse(await readFile(targetFile, 'utf8')).isArchived, true)
})

test('a connected Remote Control session is never archived or locally activated', async () => {
  const h = await home()
  const entries = [entry('user', 1, null, SOURCE)]
  await h.write(SOURCE, entries)
  await h.record('Z', SOURCE, rehomeRecord({ isArchived: true }))
  let archived = false
  const cloud = {
    account: h.acct.P,
    org: h.org.P,
    list: async () => [remoteSession({ id: 'cse_busy', title: `Session ${SOURCE.slice(-3)}` })],
    eventRows: async () => remoteRows(entries),
    session: async () => remoteState('active', { connection_status: 'connected' }),
    archive: async () => { archived = true },
    unarchive: async () => {}
  }
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.Z && a.org === h.org.Z)
  const result = await move(await inventory([from], to, h.paths, () => {}, { cloud }), to, h.paths)
  assert.equal(result.ok, true)
  assert.equal(result.pendingCloud, 1)
  assert.equal(result.receipt.failed.length, 0)
  assert.equal(result.receipt.cloudChecks[0].status, 'waiting')
  assert.equal(archived, false)
  assert.equal(JSON.parse(await readFile(path.join(h.dir('Z'), `local_${SOURCE}.json`), 'utf8')).isArchived, true)
})

test('an interrupted Remote Control archive is recovered from server state', async () => {
  const h = await home()
  const entries = [entry('user', 1, null, SOURCE)]
  await h.write(SOURCE, entries)
  await h.record('Z', SOURCE, rehomeRecord({ isArchived: true }))
  let status = 'active'
  let first = true
  const cloud = {
    account: h.acct.P,
    org: h.org.P,
    list: async () => [remoteSession({ id: 'cse_interrupted', title: `Session ${SOURCE.slice(-3)}`, status })],
    eventRows: async () => remoteRows(entries),
    session: async () => remoteState(status),
    archive: async () => { status = 'archived'; if (first) { first = false; throw new Error('connection lost after archive') } },
    unarchive: async () => { status = 'active' }
  }
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.Z && a.org === h.org.Z)
  const inv = await inventory([from], to, h.paths, () => {}, { cloud })
  const interrupted = await move(inv, to, h.paths)
  assert.equal(interrupted.ok, false)
  assert.ok(interrupted.receipt.remotePending)
  assert.equal(JSON.parse(await readFile(path.join(h.dir('Z'), `local_${SOURCE}.json`), 'utf8')).isArchived, false)
  const recovered = await move(inv, to, h.paths)
  assert.equal(recovered.recoveryRequired, true)
  const receipt = JSON.parse(await readFile(interrupted.file, 'utf8'))
  assert.equal(receipt.remotePending, undefined)
  assert.equal(receipt.remote.length, 1)
  assert.ok((await undo(h.paths, { cloud })).dest)
  assert.equal(status, 'active')
  assert.equal(JSON.parse(await readFile(path.join(h.dir('Z'), `local_${SOURCE}.json`), 'utf8')).isArchived, true)
})

test('an interrupted unapplied archive leaves a tagged failure that retry clears', async () => {
  const h = await home()
  const entries = [entry('user', 41, null, SOURCE)]
  await h.write(SOURCE, entries)
  await h.record('Z', SOURCE, rehomeRecord({ isArchived: true }))
  let status = 'active'
  let interrupt = true
  const cloud = {
    account: h.acct.P,
    org: h.org.P,
    list: async () => [remoteSession({ id: 'cse_unapplied', title: `Session ${SOURCE.slice(-3)}`, status })],
    eventRows: async () => remoteRows(entries),
    session: async () => remoteState(status, { id: 'cse_unapplied' }),
    archive: async () => {
      if (interrupt) throw new Error('connection failed before archive')
      status = 'archived'
    },
    unarchive: async () => { status = 'active' }
  }
  const all = await accounts(h.paths)
  const from = all.find((account) => account.account === h.acct.P && account.org === h.org.P)
  const to = all.find((account) => account.account === h.acct.Z && account.org === h.org.Z)
  const inv = await inventory([from], to, h.paths, () => {}, { cloud, cloudRequested: true })
  const interrupted = await move(inv, to, h.paths)
  assert.ok(interrupted.receipt.remotePending)

  const recovered = await move(inv, to, h.paths)
  assert.equal(recovered.recoveryRequired, true)
  interrupt = false
  const retried = await finishPending(h.paths, { cloud })
  assert.equal(retried.ok, true)
  assert.equal(retried.complete, true)
  assert.equal(retried.receipt.failed.length, 0)
  assert.equal(status, 'archived')
})

test('rehome eligibility stays narrow around ownership locks', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE), entry('assistant', 2, 1, SOURCE)])
  await h.record('P', SOURCE, rehomeRecord())
  const teamDir = path.join(h.paths.records, h.acct.P, h.org.T)
  await mkdir(teamDir, { recursive: true })
  const sourceRecord = JSON.parse(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`), 'utf8'))
  await writeFile(path.join(h.dir('P'), `local_${SOURCE}.json`), JSON.stringify({ ...sourceRecord, scheduledTaskId: 'task_fixture' }))
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.P && a.org === h.org.T)
  const inv = await inventory([from], to, h.paths)
  assert.equal(inv.move.length, 0)
  assert.equal(inv.blocked.length, 1)
  assert.match(inv.blocked[0].error, /scheduled task/)
})

test('an unresolved parent is named and left untouched', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE, { forkedFromSessionId: `local_${id(778)}` })
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.Z && a.org === h.org.Z)
  const inv = await inventory([from], to, h.paths)
  assert.deepEqual(inv.move, [])
  assert.equal(inv.blocked.length, 1)
  assert.match(inv.blocked[0].error, /parent Desktop record is absent/)
  const result = await move(inv, to, h.paths)
  assert.equal(result.ok, false)
  assert.equal(result.validationOnly, true)
  assert.ok(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`)))
  assert.deepEqual(await readdir(h.dir('Z')), [])
})

test('same-account rehome preserves a parent link when both records move', async () => {
  const h = await home()
  const teamDir = path.join(h.paths.records, h.acct.P, h.org.T)
  await mkdir(teamDir, { recursive: true })
  const child = id(778)
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.write(child, [entry('user', 2, null, child)])
  await h.record('P', SOURCE, rehomeRecord())
  await h.record('P', child, rehomeRecord({ forkedFromSessionId: `local_${SOURCE}` }))
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.P && a.org === h.org.T)
  const inv = await inventory([from], to, h.paths)
  assert.deepEqual(inv.move.map((row) => row.strategy), ['rehome', 'rehome'])
  const result = await move(inv, to, h.paths)
  assert.equal(result.ok, true)
  assert.equal(result.receipt.sessions.every((row) => row.strategy === 'rehome'), true)
  const childRecord = JSON.parse(await readFile(path.join(teamDir, `local_${child}.json`), 'utf8'))
  assert.equal(childRecord.forkedFromSessionId, `local_${SOURCE}`)
  assert.deepEqual((await readdir(h.project)).sort(), [`${SOURCE}.jsonl`, `${child}.jsonl`].sort())
})

test('progress begins before analysis and every counted phase reaches its total', async () => {
  const h = await home()
  const teamDir = path.join(h.paths.records, h.acct.P, h.org.T)
  await mkdir(teamDir, { recursive: true })
  await h.write(SOURCE, [entry('user', 1, null, SOURCE), entry('assistant', 2, 1, SOURCE)])
  await h.record('P', SOURCE, rehomeRecord())
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.P && a.org === h.org.T)
  const progress = []
  const report = (stage, text, extra = {}) => {
    if (extra.live) progress.push({ stage, text, completed: extra.completed, total: extra.total })
  }
  const inv = await inventory([from], to, h.paths, report)
  await move(inv, to, h.paths, report)
  assert.deepEqual(progress[0], { stage: 'scan', text: '0/1', completed: 0, total: 1 })
  for (const stage of ['scan', 'move', 'verify', 'retire']) {
    const rows = progress.filter((row) => row.stage === stage && Number.isInteger(row.completed) && Number.isInteger(row.total))
    assert.ok(rows.length >= 2, `${stage} did not report a counted phase`)
    assert.equal(rows[0].completed, 0)
    assert.equal(rows.at(-1).completed, rows.at(-1).total)
    assert.ok(rows.every((row, i) => i === 0 || row.completed >= rows[i - 1].completed))
  }
})

test('dry-run and real move agree that bridges rehome across logins', async () => {
  const h = await home()
  await h.write(SOURCE, [
    entry('user', 1, null, SOURCE),
    { type: 'bridge-session', sessionId: SOURCE, bridgeSessionId: 'session_fixture' }
  ])
  await h.record('P', SOURCE, rehomeRecord({ bridgeSessionIds: ['session_fixture'] }))
  const sourceRecord = JSON.parse(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`), 'utf8'))
  const dry = await cli(h.root, ['--from', `${h.acct.P} ${h.org.P}`, '--to', `${h.acct.Z} ${h.org.Z}`, '--dry-run', '--json'])
  assert.equal(dry.code, 0, dry.stderr || dry.stdout)
  const planned = dry.stdout.trim().split('\n').map((line) => JSON.parse(line)).at(-1)
  assert.equal(planned.planned, 1)
  assert.equal(planned.retiring, 1)
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.Z && a.org === h.org.Z)
  const result = await move(await inventory([from], to, h.paths), to, h.paths)
  assert.equal(result.ok, true)
  assert.equal(result.receipt.sessions[0].strategy, 'rehome')
  const placed = JSON.parse(await readFile(path.join(h.dir('Z'), `local_${SOURCE}.json`), 'utf8'))
  assert.deepEqual(placed.bridgeSessionIds, [])
  assert.equal(placed.cliSessionId, SOURCE)
  assert.deepEqual({ ...placed, bridgeSessionIds: ['session_fixture'] }, sourceRecord)
  assert.ok((await undo(h.paths)).dest)
  const restored = JSON.parse(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`), 'utf8'))
  assert.deepEqual(restored.bridgeSessionIds, ['session_fixture'])
})

test('a bridge marker without a recognized id remains conservatively bridged', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE), { type: 'bridge-session', sessionId: SOURCE }])
  await h.record('P', SOURCE, rehomeRecord())
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.Z && a.org === h.org.Z)
  const inv = await inventory([from], to, h.paths)
  assert.equal(inv.move[0].bridge, true)
  assert.deepEqual(inv.move[0].bridgeIds, [])
})

test('the planning cache skips unchanged analysis but never authorizes a move', async () => {
  const h = await home()
  const teamDir = path.join(h.paths.records, h.acct.P, h.org.T)
  await mkdir(teamDir, { recursive: true })
  const transcript = path.join(h.project, `${SOURCE}.jsonl`)
  await h.write(SOURCE, [entry('user', 1, null, SOURCE), entry('assistant', 2, 1, SOURCE)])
  await h.record('P', SOURCE, rehomeRecord())
  const pick = async () => {
    const all = await accounts(h.paths)
    return {
      from: all.find((a) => a.account === h.acct.P && a.org === h.org.P),
      to: all.find((a) => a.account === h.acct.P && a.org === h.org.T)
    }
  }
  const selected = await pick()
  const cold = await inventory([selected.from], selected.to, h.paths, () => {}, { writeCache: true })
  assert.ok(cold.cacheStats.historyMisses > 0)
  const cache = JSON.parse(await readFile(path.join(h.paths.state, 'cache.json'), 'utf8'))
  assert.ok(Object.values(cache.histories).every((row) => typeof row.value.result.contentSha === 'string'))
  const warm = await inventory([selected.from], selected.to, h.paths)
  assert.ok(warm.cacheStats.historyHits > 0)
  assert.equal(warm.cacheStats.historyMisses, 0)
  assert.ok(warm.cacheStats.manifestHits > 0)

  await appendFile(transcript, `${JSON.stringify(entry('user', 3, 2, SOURCE))}\n`)
  const refused = await move(warm, selected.to, h.paths)
  assert.equal(refused.receipt.sessions.length, 0)
  assert.match(refused.receipt.failed[0].error, /source changed since inventory/)
  assert.deepEqual(await readdir(h.dir('P')), [`local_${SOURCE}.json`])
  assert.deepEqual(await readdir(teamDir), [])
})

test('rehome verification catches transcript and sidecar drift after placement', async () => {
  const h = await home()
  const teamDir = path.join(h.paths.records, h.acct.P, h.org.T)
  await mkdir(teamDir, { recursive: true })
  const transcript = path.join(h.project, `${SOURCE}.jsonl`)
  const sidecar = path.join(h.project, SOURCE, 'subagents', 'agent.jsonl')
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await mkdir(path.dirname(sidecar), { recursive: true })
  await writeFile(sidecar, '{"before":true}\n')
  await h.record('P', SOURCE, rehomeRecord())
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.P && a.org === h.org.T)
  const inv = await inventory([from], to, h.paths)
  const result = await move(inv, to, h.paths, (stage) => {
    if (stage !== 'sidecars') return
    appendFileSync(transcript, `${JSON.stringify(entry('assistant', 2, 1, SOURCE))}\n`)
    appendFileSync(sidecar, '{"after":true}\n')
  })
  assert.equal(result.ok, false)
  assert.ok(result.problems.some((row) => row.check === 'transcript'))
  assert.ok(result.problems.some((row) => row.check === 'sidecars'))
  assert.deepEqual(await readdir(h.dir('P')), [`local_${SOURCE}.json`])
  assert.deepEqual(await readdir(teamDir), [`local_${SOURCE}.json`])
})

test('rehome retirement allows shared growth without duplicate records', async () => {
  const h = await home()
  const teamDir = path.join(h.paths.records, h.acct.P, h.org.T)
  await mkdir(teamDir, { recursive: true })
  const transcript = path.join(h.project, `${SOURCE}.jsonl`)
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE, rehomeRecord())
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.P && a.org === h.org.T)
  let changed = false
  const result = await move(await inventory([from], to, h.paths), to, h.paths, (stage, text) => {
    if (stage !== 'retire' || text !== 'checking' || changed) return
    changed = true
    appendFileSync(transcript, `${JSON.stringify(entry('assistant', 2, 1, SOURCE))}\n`)
  })
  assert.equal(result.ok, true)
  assert.equal(changed, true)
  assert.deepEqual(await readdir(h.dir('P')), [])
  assert.deepEqual(await readdir(teamDir), [`local_${SOURCE}.json`])
  assert.ok((await readFile(transcript, 'utf8')).includes('message 2'))
})

test('a corrupt planning cache is ignored', async () => {
  const h = await home()
  const teamDir = path.join(h.paths.records, h.acct.P, h.org.T)
  await mkdir(teamDir, { recursive: true })
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE, rehomeRecord())
  await mkdir(h.paths.state, { recursive: true })
  await writeFile(path.join(h.paths.state, 'cache.json'), '{broken')
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.P && a.org === h.org.T)
  const inv = await inventory([from], to, h.paths)
  assert.equal(inv.move.length, 1)
  assert.ok(inv.cacheStats.historyMisses > 0)
})

test('an interrupted rehome removes only its unchanged target record', async () => {
  const h = await home()
  const teamDir = path.join(h.paths.records, h.acct.P, h.org.T)
  await mkdir(teamDir, { recursive: true })
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE, rehomeRecord())
  const sourceRecord = path.join(h.dir('P'), `local_${SOURCE}.json`)
  const targetRecord = path.join(teamDir, `local_${SOURCE}.json`)
  const record = await readFile(sourceRecord)
  await writeFile(targetRecord, record)
  const at = '2099-01-02T00-00-00-000'
  const receipt = {
    at,
    from: ['source'],
    to: 'target',
    sessions: [],
    failed: [],
    superseded: [],
    cloudChecks: [{ account: h.acct.P, org: h.org.P, label: 'source', status: 'pending' }],
    finalizing: true,
    pending: {
      strategy: 'rehome',
      id: SOURCE,
      targetId: SOURCE,
      title: 'Session 001',
      made: [targetRecord],
      recordSha: createHash('sha256').update(record).digest('hex')
    }
  }
  await mkdir(h.paths.state, { recursive: true })
  await writeFile(path.join(h.paths.state, `${at}.json`), JSON.stringify(receipt))
  const all = await accounts(h.paths)
  const to = all.find((a) => a.account === h.acct.P && a.org === h.org.T)
  const result = await move({ move: [] }, to, h.paths)
  assert.equal(result.recoveryRequired, true)
  assert.ok(await readFile(sourceRecord))
  assert.ok(await readFile(path.join(h.project, `${SOURCE}.jsonl`)))
  assert.equal(await readFile(targetRecord).catch(() => null), null)
  assert.deepEqual(await readdir(path.join(h.paths.state, 'quarantine', at, 'failed')), [`local_${SOURCE}.json`])
  assert.equal(JSON.parse(await readFile(path.join(h.paths.state, `${at}.json`), 'utf8')).cloudChecks[0].status, 'cancelled')
})

test('interrupted placement leaves a foreign byte-identical target untouched', async () => {
  for (const replaced of [false, true]) {
    const h = await home()
    await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
    await h.record('P', SOURCE)
    const target = path.join(h.dir('T'), `local_${SOURCE}.json`)
    const text = JSON.stringify(JSON.parse(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`))), null, 2) + '\n'
    await writeFile(target, text)
    const identity = await stat(target)
    if (replaced) {
      await rename(target, target + '.original')
      await writeFile(target, text)
    }
    const at = '2099-01-02T00-00-00-000'
    const receipt = { at, sessions: [], superseded: [], failed: [], finalizing: true, pending: {
      strategy: 'rehome', id: SOURCE, title: 'Interrupted', targetId: SOURCE, made: [target],
      recordSha: createHash('sha256').update(text).digest('hex'), creationRequired: true,
      ...(replaced ? { created: { dev: identity.dev, ino: identity.ino } } : {})
    } }
    await mkdir(h.paths.state, { recursive: true })
    const file = path.join(h.paths.state, at + '.json')
    await writeFile(file, JSON.stringify(receipt))
    assert.ok((await undo(h.paths)).reconciled)
    assert.equal(await readFile(target, 'utf8'), text)
    assert.equal(JSON.parse(await readFile(file)).retained, undefined)
  }
})

test('interrupted rehome rollback keeps shared transcript and sidecar changes', async () => {
  const h = await home()
  const teamDir = path.join(h.paths.records, h.acct.P, h.org.T)
  await mkdir(teamDir, { recursive: true })
  const transcript = path.join(h.project, `${SOURCE}.jsonl`)
  const sidecar = path.join(h.project, SOURCE, 'subagents', 'agent.jsonl')
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await mkdir(path.dirname(sidecar), { recursive: true })
  await writeFile(sidecar, '{"before":true}\n')
  await h.record('P', SOURCE, rehomeRecord())
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.P && a.org === h.org.T)
  const moved = await move(await inventory([from], to, h.paths), to, h.paths)
  const receipt = JSON.parse(await readFile(moved.file, 'utf8'))
  receipt.finalizing = true
  await writeFile(moved.file, JSON.stringify(receipt))
  await appendFile(transcript, `${JSON.stringify(entry('assistant', 2, 1, SOURCE))}\n`)
  await appendFile(sidecar, '{"after":true}\n')
  const recovered = await undo(h.paths)
  assert.match(recovered.reconciled.error, /finalization rolled back/)
  assert.ok((await readFile(transcript, 'utf8')).includes('message 2'))
  assert.ok((await readFile(sidecar, 'utf8')).includes('after'))
  assert.ok(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`)))
  assert.equal(await readFile(path.join(teamDir, `local_${SOURCE}.json`)).catch(() => null), null)
})

test('interrupted rehome recovery identifies vanished shared artifacts', async () => {
  const h = await home()
  const teamDir = path.join(h.paths.records, h.acct.P, h.org.T)
  await mkdir(teamDir, { recursive: true })
  const transcript = path.join(h.project, `${SOURCE}.jsonl`)
  const sidecarDir = path.join(h.project, SOURCE)
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await mkdir(sidecarDir, { recursive: true })
  await writeFile(path.join(sidecarDir, 'agent.jsonl'), '{"before":true}\n')
  await h.record('P', SOURCE, rehomeRecord())
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.P && a.org === h.org.T)
  const moved = await move(await inventory([from], to, h.paths), to, h.paths)
  const receipt = JSON.parse(await readFile(moved.file, 'utf8'))
  receipt.finalizing = true
  await writeFile(moved.file, JSON.stringify(receipt))
  await rename(transcript, `${transcript}.missing`)
  await rename(sidecarDir, `${sidecarDir}.missing`)
  const recovered = await undo(h.paths)
  assert.match(recovered.reconciled.error, /changed copies left in place/)
  const tracked = JSON.parse(await readFile(moved.file, 'utf8'))
  assert.match(tracked.failed.at(-1).error, new RegExp(`${SOURCE}\\.jsonl is missing, ${SOURCE} is missing`))
  assert.ok(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`)))
  assert.ok(await readFile(path.join(teamDir, `local_${SOURCE}.json`)))
})

test('rehome undo keeps shared transcript and sidecar changes', async () => {
  const h = await home()
  const teamDir = path.join(h.paths.records, h.acct.P, h.org.T)
  await mkdir(teamDir, { recursive: true })
  const transcript = path.join(h.project, `${SOURCE}.jsonl`)
  const sidecar = path.join(h.project, SOURCE, 'subagents', 'agent.jsonl')
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await mkdir(path.dirname(sidecar), { recursive: true })
  await writeFile(sidecar, '{"before":true}\n')
  await h.record('P', SOURCE, rehomeRecord())
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.P && a.org === h.org.T)
  assert.equal((await move(await inventory([from], to, h.paths), to, h.paths)).ok, true)
  await appendFile(transcript, `${JSON.stringify(entry('assistant', 2, 1, SOURCE))}\n`)
  await appendFile(sidecar, '{"after":true}\n')
  const undone = await undo(h.paths)
  assert.ok(undone.dest)
  assert.ok((await readFile(transcript, 'utf8')).includes('message 2'))
  assert.ok((await readFile(sidecar, 'utf8')).includes('after'))
  assert.ok(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`)))
  assert.equal(await readFile(path.join(teamDir, `local_${SOURCE}.json`)).catch(() => null), null)
})

test('rehome undo refuses when shared artifacts vanished', async () => {
  const h = await home()
  const teamDir = path.join(h.paths.records, h.acct.P, h.org.T)
  await mkdir(teamDir, { recursive: true })
  const transcript = path.join(h.project, `${SOURCE}.jsonl`)
  const sidecarDir = path.join(h.project, SOURCE)
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await mkdir(sidecarDir, { recursive: true })
  await writeFile(path.join(sidecarDir, 'agent.jsonl'), '{"before":true}\n')
  await h.record('P', SOURCE, rehomeRecord())
  const all = await accounts(h.paths)
  const from = all.find((a) => a.account === h.acct.P && a.org === h.org.P)
  const to = all.find((a) => a.account === h.acct.P && a.org === h.org.T)
  assert.equal((await move(await inventory([from], to, h.paths), to, h.paths)).ok, true)
  await rename(transcript, `${transcript}.missing`)
  await rename(sidecarDir, `${sidecarDir}.missing`)
  const refused = await undo(h.paths)
  assert.match(refused.changed[0], /transcript missing, sidecars missing changed/)
  assert.equal(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`)).catch(() => null), null)
  assert.ok(await readFile(path.join(teamDir, `local_${SOURCE}.json`)))
})

test('restart reuses preparation across cloud and local phases and reparses only changed history', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE)
  await Promise.all(Array.from({ length: 180 }, async (_, offset) => {
    const session = id(2000 + offset)
    await h.write(session, [entry('user', 10000 + offset, null, session)])
    await h.record('T', session)
  }))
  const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
  let rows = desktopFixture(), scanned
  const cloud = cloudFixture(h)
  const io = { inspect: () => rows, command: async (file) => {
    if (file.endsWith('osascript')) {
      await appendFile(path.join(h.project, `${SOURCE}.jsonl`), JSON.stringify(entry('assistant', 2, 1, SOURCE)) + '\n')
      rows = []
    } else rows = [{ ...desktopFixture()[0], pid: 700, desktopPid: 700, started: 'new' }]
    return { status: 0 }
  } }
  const planned = await executeMove([from], to, h.paths, { cloud, io })
  assert.ok(planned.plan)
  const result = await executeMove([from], to, h.paths, { cloudRequested: true, io, approve: planned.plan.token, summary: inv => { scanned = inv.cacheStats } })
  assert.equal(result.ok, true)
  assert.equal(result.receipt.sessions.length, 1)
  assert.equal(scanned.historyHits, 180)
  assert.equal(scanned.historyMisses, 1)
  assert.equal(result.receipt.sessions[0].events, 2)
})

test('inventory interrupts preparation at record boundaries when its deadline is spent', async () => {
  const h = await home()
  for (const session of [SOURCE, id(2)]) {
    await h.write(session, [entry('user', Number(session.slice(-1)), null, session)])
    await h.record('P', session)
  }
  const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
  let completed = 0
  await assert.rejects(inventory([from], to, h.paths, (stage, text, progress) => {
    if (stage === 'scan') completed = progress.completed
  }, { processes: [], check: () => { if (completed > 0) throw new Error('fixture deadline spent') } }), /fixture deadline spent/)
  assert.equal(completed, 1)
  assert.equal((await readdir(h.dir('T'))).length, 0)
})

test('restart warnings group a helper and its child as one session and resolve copied records', async () => {
  const h = await home(), other = id(400)
  await h.record('P', SOURCE, { title: 'First session' })
  await h.record('T', other, { title: 'Second session' })
  await h.record('Z', other, { title: 'Second session' })
  const rows = [
    desktopFixture()[0],
    { pid: 501, ppid: 500, started: 'helper one', executable: '/Applications/Claude.app/Contents/Helpers/disclaimer', worker: true, desktopPid: 500, ids: [] },
    { pid: 502, ppid: 501, started: 'child one', executable: '/tmp/claude', worker: true, desktopPid: 500, ids: [SOURCE] },
    { pid: 503, ppid: 500, started: 'helper two', executable: '/Applications/Claude.app/Contents/Helpers/disclaimer', worker: true, desktopPid: 500, ids: [] },
    { pid: 504, ppid: 503, started: 'child two', executable: '/tmp/claude', worker: true, desktopPid: 500, ids: [other] }
  ]
  const plan = await restartPlan(null, h.paths, rows)
  assert.equal(plan.affected.length, 2)
  assert.deepEqual(plan.affected.map(row => row.title), ['First session', 'Second session'])
  assert.deepEqual(plan.affected.map(row => row.pids), [[501, 502], [503, 504]])
  assert.equal(plan.members.length, 5)
  const unknown = await restartPlan(null, h.paths, rows.map(row => ({ ...row, ids: [] })))
  assert.equal(unknown.affected.length, 2)
})

test('connected Remote Control is waiting, not failed, and completes in the same receipt after disconnect', async () => {
  const h = await home()
  const entries = [entry('user', 1, null, SOURCE)]
  await h.write(SOURCE, entries)
  await h.record('P', SOURCE, { bridgeSessionIds: ['session_live'] })
  let connected = true, status = 'active', historyReads = 0
  const cloud = cloudFixture(h, {
    list: async () => [remoteSession({ id: 'cse_live', title: 'Session 001', status })],
    session: async () => remoteState(status, { connection_status: connected ? 'connected' : 'disconnected' }),
    eventRows: async () => { historyReads++; return remoteRows(entries) },
    archive: async () => { status = 'archived' }
  })
  const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
  const inv = await inventory([from], to, h.paths, () => {}, { cloud, processes: [] })
  assert.equal(inv.cloud.blocked.length, 0)
  assert.equal(inv.cloud.waiting.length, 1)
  assert.equal(inv.cloud.waiting[0].localId, SOURCE)
  assert.equal(inv.pendingCloud, 1)
  assert.equal(historyReads, 0)
  const moved = await move(inv, to, h.paths)
  assert.equal(moved.receipt.failed.length, 0)
  assert.equal(moved.receipt.cloudChecks[0].status, 'waiting')
  assert.equal(moved.pendingCloud, 1)
  connected = false
  const finished = await finishPending(h.paths, { cloud })
  assert.equal(finished.file, moved.file)
  assert.equal(finished.complete, true)
  assert.equal(finished.receipt.failed.length, 0)
  assert.equal(status, 'archived')
})


test('a legacy partial move resumes its named records and mirrors with one receipt and one Undo', async () => {
  const h = await home(), cold = id(2)
  const hotEntries = [entry('user', 1, null, SOURCE)]
  await h.write(SOURCE, hotEntries)
  await h.write(cold, [entry('user', 2, null, cold)])
  await h.record('P', SOURCE, { title: 'Legacy open session', bridgeSessionIds: ['session_legacy'] })
  await h.record('P', cold)
  const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
  const moved = await move(await inventory([from], to, h.paths, () => {}, { processes: desktopFixture(), cloudRequested: true }), to, h.paths)
  assert.equal(moved.receipt.sessions.length, 1)
  const legacy = structuredClone(moved.receipt)
  delete legacy.held
  legacy.cloudChecks[0].status = 'cancelled'
  legacy.cloudChecks[0].cancelledAt = new Date().toISOString()
  legacy.cloudChecks[0].failures = [{ id: 'cse_legacy', title: 'Legacy open session', error: 'Remote Control session is not proven disconnected and idle' }]
  await writeFile(moved.file, JSON.stringify(legacy))
  await assert.rejects(resumeLast(h.paths, { receiptFile: moved.file + '.old', includeCancelled: true, processes: [] }), /previous move changed/)
  const resumed = await resumeLast(h.paths, { receiptFile: moved.file, includeCancelled: true, processes: desktopFixture() })
  assert.equal(resumed.receipt.held.length, 1)
  assert.equal(resumed.receipt.cloudChecks[0].status, 'pending')
  assert.deepEqual(resumed.receipt.cloudChecks[0].sessionIds, ['session_legacy'])
  assert.equal(resumed.receipt.failed.length, 0)
  const finishedLocal = await finishHeld(h.paths, { processes: [] })
  assert.equal(finishedLocal.file, moved.file)
  assert.equal(finishedLocal.receipt.sessions.length, 2)
  let status = 'active'
  const cloud = cloudFixture(h, {
    list: async () => [remoteSession({ id: 'cse_legacy', title: 'Legacy open session', status }), remoteSession({ id: 'cse_unselected', title: 'Unselected old remote session' })],
    session: async id => { assert.equal(id, 'cse_legacy'); return remoteState(status) },
    eventRows: async id => { assert.equal(id, 'cse_legacy'); return remoteRows(hotEntries) },
    archive: async () => { status = 'archived' }, unarchive: async () => { status = 'active' }
  })
  const finished = await finishPending(h.paths, { cloud })
  assert.equal(finished.file, moved.file)
  assert.equal(finished.complete, true)
  assert.equal(status, 'archived')
  assert.equal((await readdir(h.paths.state)).filter(name => /^\d.*\.json$/.test(name)).length, 1)
  const undone = await undo(h.paths, { cloud })
  assert.ok(undone.dest)
  assert.equal(status, 'active')
  assert.deepEqual((await readdir(h.dir('P'))).sort(), [`local_${SOURCE}.json`, `local_${cold}.json`].sort())
  assert.deepEqual(await readdir(h.dir('T')), [])
})


test('Finish pending offers a receipt-bound restart for a connected mirror and completes after reopen', async () => {
  const h = await home(), entries = [entry('user', 1, null, SOURCE)]
  await h.write(SOURCE, entries)
  await h.record('P', SOURCE, { bridgeSessionIds: ['session_open'] })
  let connected = true, status = 'active', rows = desktopFixture(), quits = 0
  const cloud = cloudFixture(h, {
    list: async () => [remoteSession({ id: 'cse_open', title: 'Session 001', status })],
    session: async () => remoteState(status, { connection_status: connected ? 'connected' : 'disconnected' }),
    eventRows: async () => remoteRows(entries), archive: async () => { status = 'archived' }
  })
  const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
  const moved = await move(await inventory([from], to, h.paths, () => {}, { cloud, processes: [] }), to, h.paths)
  const io = { inspect: () => rows, command: async file => {
    if (file.endsWith('osascript')) { quits++; rows = []; connected = false }
    else rows = [{ ...desktopFixture()[0], pid: 700, desktopPid: 700, started: 'new' }]
    return { status: 0 }
  } }
  const planned = await finishWorkflow(h.paths, { cloud, io })
  assert.equal(planned.plan.kind, 'finish')
  assert.equal(planned.plan.receiptFile, moved.file)
  assert.equal(quits, 0)
  const completed = await finishWorkflow(h.paths, { cloud, io, approve: planned.plan.token })
  assert.equal(completed.complete, true)
  assert.equal(completed.file, moved.file)
  assert.equal(completed.receipt.remote.length, 1)
  assert.equal(completed.receipt.failed.length, 0)
  assert.equal(quits, 1)
  const stale = await finishWorkflow(h.paths, { cloud, io, approve: planned.plan.token })
  assert.equal(stale.ok, false)
  assert.equal(quits, 1)
})


test('process registry identifies a new worker without argv ids and rejects stale pid reuse', () => {
  const started = 'Fri Sep  4 18:00:00 2026'
  const utc = new Date(started).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (.*) GMT$/, '$1 $3 $2 $5 $4')
  const processes = `500 1 ${started} /Applications/Claude.app/Contents/MacOS/Claude\n501 500 ${started} /Applications/Claude.app/Contents/Helpers/disclaimer\n502 501 ${started} /tmp/claude`
  const commands = `500 1 ${started} Claude\n501 500 ${started} disclaimer\n502 501 ${started} claude --input-format stream-json`
  const registration = { pid: 502, sessionId: SOURCE, cwd: '/tmp/fixture', name: 'A new session', procStart: utc, pidDomain: 'darwin' }
  const rows = parseProcesses(processes, commands, '/Applications/Claude.app', [registration])
  assert.deepEqual(rows.find(row => row.pid === 502).ids, [SOURCE])
  assert.equal(rows.find(row => row.pid === 502).desktopPid, 500)
  const stale = parseProcesses(processes, commands, '/Applications/Claude.app', [{ ...registration, procStart: 'Thu Sep 3 00:00:00 2026' }])
  assert.deepEqual(stale.find(row => row.pid === 502).ids, [])
  const foreign = parseProcesses(processes, commands, '/Applications/Claude.app', [{ ...registration, pidDomain: 'linux' }])
  assert.deepEqual(foreign.find(row => row.pid === 502).ids, [])
})
