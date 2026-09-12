import assert from 'node:assert/strict'
import childProcess, { execFile, spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import fs, { appendFile, mkdir, mkdtemp, open, readdir, readFile, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { accounts, cloudClient, executeMove, finishHeld, finishPending, finishWorkflow, inventory, keepLocal, layout, move, normalize, parseProcesses, restartPlan, resumeLast, semantic, signedIn, step, sweep, undo, verifyPlaced, withDesktopRestart, writeNew } from './transplant.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureCommand = run => (file, ...args) => {
  if (file === '/usr/bin/security') return { status: 1, stdout: '', stderr: 'fixture login unavailable' }
  if (['/usr/bin/osascript', '/usr/bin/open', '/bin/launchctl'].includes(file)) throw new Error('fixture native command requires a mock')
  return run(file, ...args)
}
childProcess.spawnSync = fixtureCommand(childProcess.spawnSync)
childProcess.spawn = fixtureCommand(childProcess.spawn)
syncBuiltinESMExports()
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
const cli = (home, args) => promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
  import childProcess from 'node:child_process'
  import { syncBuiltinESMExports } from 'node:module'
  childProcess.spawnSync = (${fixtureCommand.toString()})(childProcess.spawnSync)
  childProcess.spawn = (${fixtureCommand.toString()})(childProcess.spawn)
  syncBuiltinESMExports()
  process.argv.splice(1, 0, ${JSON.stringify(path.join(here, 'transplant.js'))})
  await import(${JSON.stringify(path.join(here, 'transplant.js'))})
`, '--', ...args], {
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

test('a failed progress callback cannot prevent the mandatory reopen', async () => {
  const h = await home()
  let rows = desktopFixture(), reportedAfterOpen = false
  const plan = await restartPlan(null, h.paths, rows), calls = []
  const result = await withDesktopRestart(plan, h.paths, async () => ({ ok: true }), stage => {
    if (stage === 'reopen') {
      reportedAfterOpen = calls.includes('/usr/bin/open')
      throw new Error('progress output unavailable')
    }
  }, { inspect: () => rows, command: async file => {
    calls.push(file)
    rows = file.endsWith('osascript') ? [] : [{ ...desktopFixture()[0], pid: 700, desktopPid: 700, started: 'new' }]
    return { status: 0 }
  } })
  assert.deepEqual(calls, ['/usr/bin/osascript', '/usr/bin/open'])
  assert.equal(reportedAfterOpen, true)
  assert.equal(result.restart.outcome, 'reopened')
  assert.equal(result.ok, true)
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

test('a failed held continuation preserves the earlier completed phase with a legacy checkpoint', async () => {
  const h = await home()
  const cold = id(300)
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.write(cold, [entry('user', 300, null, cold)])
  await h.record('P', SOURCE)
  await h.record('P', cold)
  const all = await accounts(h.paths), from = all.find((row) => row.account === h.acct.P), to = all.find((row) => row.account === h.acct.T)
  const first = await executeMove([from], to, h.paths, { processes: desktopFixture(), moveOnly: true })
  await assert.rejects(finishHeld(h.paths, { processes: [], report: (stage, text) => { if (stage === 'retire' && text === 'checking') throw new Error('interrupted append') } }), /interrupted append/)
  const interrupted = JSON.parse(await readFile(first.file))
  assert.equal(interrupted.appendCheckpoint.taskTransfers, 0)
  delete interrupted.appendCheckpoint.taskTransfers
  delete interrupted.taskTransfers
  await writeFile(first.file, JSON.stringify(interrupted))
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
  const first = await executeMove([from], to, h.paths, { processes: desktopFixture(), moveOnly: true, report: (stage, _text, progress) => {
    if (stage === 'verify' && progress?.completed === 0) writeFileSync(target, JSON.stringify({ ...JSON.parse(readFileSync(target)), lastFocusedAt: 1000 }))
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
  await executeMove([from], to, h.paths, { processes: desktopFixture(), moveOnly: true, report: (stage, _text, progress) => {
    if (stage === 'verify' && progress?.completed === 0) writeFileSync(target, JSON.stringify({ ...JSON.parse(readFileSync(target)), lastFocusedAt: 1000 }))
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
  record.branch = 'feature/anything'
  record.prState = 'merged'
  record.model = 'claude-opus-5'
  record.contextExceededCount = 3
  record.alwaysAllowedReasons = ['Bash']
  record.someFutureDesktopField = { anything: true }
  await writeFile(file, JSON.stringify(record))
  assert.deepEqual((await verifyPlaced(h.paths)).changed, [])
  record.title = 'Different title after placement'
  record.isArchived = true
  await writeFile(file, JSON.stringify(record))
  const changed = await verifyPlaced(h.paths)
  assert.equal(changed.changed.length, 1)
  assert.deepEqual(changed.changed[0].fields.sort(), ['isArchived', 'title'])
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

test('file-read replays keep the full payload and refuse incompatible copies', () => {
  const parent = entry('assistant', 1, null, SOURCE)
  const full = entry('user', 2, 1, SOURCE, { toolUseResult: { type: 'text', file: { filePath: '/tmp/fixture.txt', content: 'full file body', numLines: 1 } } })
  const replay = { ...full, toolUseResult: { ...full.toolUseResult, file: { ...full.toolUseResult.file, content: '' } } }
  for (const rows of [[parent, full, replay], [parent, replay, full]]) {
    const result = normalize(rows)
    assert.equal(result.conflicts, 0)
    assert.equal(result.replays, 1)
    assert.deepEqual(result.entries, [parent, full])
    assert.equal(semantic(rows, SOURCE), semantic([parent, full], SOURCE))
  }
  for (const content of ['different file body', null, { text: 'unexpected shape' }]) {
    const changed = { ...replay, toolUseResult: { ...replay.toolUseResult, file: { ...replay.toolUseResult.file, content } } }
    assert.equal(normalize([parent, full, changed]).conflicts, 1)
  }
  const otherFile = { ...replay, toolUseResult: { ...replay.toolUseResult, file: { ...replay.toolUseResult.file, filePath: '/tmp/other.txt' } } }
  assert.equal(normalize([parent, full, otherFile]).conflicts, 1)
})

test('a transcript with a compact file-read replay rehomes intact and is not retired into a poorer fork', async () => {
  const h = await home()
  const parent = entry('assistant', 1, null, SOURCE)
  const full = entry('user', 2, 1, SOURCE, { toolUseResult: { type: 'text', file: { filePath: '/tmp/fixture.txt', content: 'full file body', numLines: 1 } } })
  const replay = { ...full, toolUseResult: { ...full.toolUseResult, file: { ...full.toolUseResult.file, content: '' } } }
  await h.write(SOURCE, [parent, full, replay])
  await h.record('P', SOURCE, rehomeRecord({ title: 'Replayed file read' }))
  await h.write(id(991), fork([parent, replay], SOURCE, id(991), 'Poorer fork'))
  await h.record('T', id(991), rehomeRecord({ title: 'Poorer fork' }))
  const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
  const transcript = path.join(h.project, `${SOURCE}.jsonl`)
  const before = await readFile(transcript), beforeStat = await stat(transcript)
  const inv = await inventory([from], to, h.paths)
  assert.equal(inv.blocked.length, 0)
  assert.equal(inv.there.length, 0)
  assert.equal(inv.move.length, 1)
  const moved = await move(inv, to, h.paths)
  assert.equal(moved.ok, true)
  assert.equal(moved.receipt.sessions[0].strategy, 'rehome')
  assert.deepEqual(await readFile(transcript), before)
  assert.equal((await stat(transcript)).ino, beforeStat.ino)
  assert.equal((await accounts(h.paths)).find(row => row.account === h.acct.P).sessions.length, 0)
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

test('idle Finish reports refused sessions quietly while verification errors remain failures', async () => {
  const h = await home()
  const bad = entry('user', 1, null, SOURCE)
  await h.write(SOURCE, [bad, { ...bad, message: { role: 'user', content: 'conflicting body' } }])
  await h.record('P', SOURCE, rehomeRecord({ title: 'Needs attention' }))
  await h.write(id(994), [entry('user', 2, null, id(994))])
  await h.record('P', id(994), rehomeRecord({ title: 'Good history' }))
  const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
  const moved = await move(await inventory([from], to, h.paths), to, h.paths)
  assert.equal(moved.receipt.sessions.length, 1)
  assert.equal(moved.receipt.failed.length, 1)
  const result = await cli(h.root, ['finish', '--json'])
  assert.equal(result.code, 0)
  const idle = lines(result.stdout).find(row => row.nothing)
  assert.match(idle.failed[0].error, /conflicting duplicate uuids/)
  const text = await cli(h.root, ['finish'])
  assert.equal(text.code, 0)
  assert.match(text.stdout, /nothing pending\n.*not moved.*conflicting duplicate uuids/s)
  const refused = lines((await cli(h.root, ['sweep', '--json'])).stdout)[0]
  assert.equal(refused.receipt, moved.file)
  assert.equal(refused.complete, true)
  assert.equal(refused.failed.length, 0)
  assert.equal(refused.notMoved.length, 1)
  const receipt = JSON.parse(await readFile(moved.file, 'utf8'))
  receipt.failed = []
  await writeFile(moved.file, JSON.stringify(receipt))
  const clean = lines((await cli(h.root, ['sweep', '--json'])).stdout)[0]
  assert.equal(clean.complete, true)
  assert.equal(clean.receipt, moved.file)
  receipt.verification = { ok: false, problems: [{ id: id(994), check: 'transcript' }] }
  await writeFile(moved.file, JSON.stringify(receipt))
  const unverified = await cli(h.root, ['finish', '--json'])
  assert.equal(unverified.code, 1)
  assert.deepEqual(lines(unverified.stdout).find(row => row.done).problems, receipt.verification.problems)
  const details = await cli(h.root, ['finish'])
  assert.equal(details.code, 1)
  assert.ok(details.stdout.includes(`${id(994)} | transcript verification failed`))
  const checked = lines((await cli(h.root, ['sweep', '--json'])).stdout)[0]
  assert.equal(checked.ok, false)
  assert.match(checked.error, /transcript verification failed/)
  await writeFile(moved.file, '{')
  const corrupt = lines((await cli(h.root, ['sweep', '--json'])).stdout)[0]
  assert.equal(corrupt.ok, false)
  assert.match(corrupt.error, /corrupt receipt/)
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
  const blocked = await inventory([by[h.acct.P]], by[h.acct.Z], h.paths)
  assert.equal(blocked.move.length, 0)
  assert.match(blocked.blocked[0].error, /invalid scheduled task registry/)
  await writeFile(taskFile, JSON.stringify({ scheduledTasks: [] }))
  by = Object.fromEntries((await accounts(h.paths)).map((a) => [a.account, a]))
  const inv = await inventory([by[h.acct.P]], by[h.acct.Z], h.paths)
  await assert.rejects(move(inv, by[h.acct.Z], h.paths, (stage, _text, progress) => {
    if (stage === 'verify' && progress?.completed === 0) writeFileSync(taskFile, '{broken')
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
  const result = await move(await inventory([by[h.acct.P]], by[h.acct.Z], h.paths), by[h.acct.Z], h.paths, (stage, _text, progress) => {
    if (stage !== 'verify' || progress?.completed !== 0) return
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

test('Finish uses the active Desktop organization when its saved cookie still names the previous organization', async (t) => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE, rehomeRecord({ title: 'Switched organization' }))
  await h.record('P', id(997), rehomeRecord({ title: 'Pending source' }))
  const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
  const moved = await move(await inventory([from], to, h.paths, () => {}, { cloudRequested: true }), to, h.paths)
  assert.equal(moved.pendingCloud, 1)
  await unlink(path.join(h.dir('P'), `local_${id(997)}.json`))
  const requestedOrgs = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const endpoint = new URL(url).pathname
    if (endpoint === '/api/account') return Response.json({ uuid: h.acct.P })
    if (endpoint === '/api/organizations') return Response.json([{ uuid: h.org.P }, { uuid: h.org.T }])
    assert.equal(endpoint, '/v1/code/sessions')
    assert.equal(options.method ?? 'GET', 'GET')
    requestedOrgs.push(options.headers['x-organization-uuid'])
    return Response.json({ data: [] }, { headers: { 'anthropic-organization-id': options.headers['x-organization-uuid'] } })
  })
  const cloud = await cloudClient(h.paths, null, {
    active: { account: h.acct.P, org: h.org.P, state: 'known' },
    cookies: new Map([['sessionKey', 'fixture'], ['lastActiveOrg', h.org.T]]),
    userAgent: 'fixture'
  })
  const finished = await finishPending(h.paths, { cloud })
  assert.equal(finished.ok, true)
  assert.equal(finished.complete, true)
  assert.equal(finished.pendingCloud, 0)
  assert.deepEqual(requestedOrgs, [h.org.P])
})

test('cloud identity rejects a stale authenticated account even when both logins share the organization', async (t) => {
  const h = await home(), requested = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(new URL(url).pathname)
    if (requested.at(-1) === '/api/account') return Response.json({ uuid: h.acct.T })
    return Response.json([{ uuid: h.org.P }])
  })
  await assert.rejects(cloudClient(h.paths, null, {
    active: { account: h.acct.P, org: h.org.P, state: 'known' },
    cookies: new Map([['sessionKey', 'fixture'], ['lastActiveOrg', h.org.P]]),
    userAgent: 'fixture'
  }), /login is still updating/)
  assert.deepEqual(requested, ['/api/account'])
})

test('cloud identity retains verified cookie fallback for unknown Desktop state and rejects an explicit logout', async (t) => {
  const h = await home(), requested = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(new URL(url).pathname)
    return Response.json(requested.at(-1) === '/api/account' ? { uuid: h.acct.P } : [{ uuid: h.org.P }, { uuid: h.org.T }])
  })
  const io = { active: { state: 'unknown', account: null, org: null }, cookies: new Map([['sessionKey', 'fixture'], ['lastActiveOrg', h.org.P]]), userAgent: 'fixture' }
  assert.equal((await cloudClient(h.paths, null, io)).org, h.org.P)
  assert.equal((await cloudClient(h.paths, { account: h.acct.P, org: h.org.T, label: 'Team' }, io)).org, h.org.T)
  requested.length = 0
  await assert.rejects(cloudClient(h.paths, null, { ...io, active: { state: 'logged-out' } }), /signed out/)
  assert.deepEqual(requested, [])
  await assert.rejects(cloudClient(h.paths, { account: h.acct.T, org: h.org.T, label: 'Other login' }, io), /sign Claude Desktop into Other login/)
  assert.deepEqual(requested, ['/api/account'])
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

test('accounts labels a login held in a claude-acc account directory', async () => {
  const h = await home()
  const account = id(922)
  const org = id(923)
  const profile = path.join(h.paths.switchAccounts, 'work')
  await mkdir(profile, { recursive: true })
  await writeFile(path.join(profile, '.claude.json'), JSON.stringify({
    oauthAccount: { accountUuid: account, organizationUuid: org, emailAddress: 'switched@example.com', organizationName: 'Switched Team', organizationType: 'team' }
  }))
  const row = (await accounts(h.paths)).find((candidate) => candidate.account === account && candidate.org === org)

  assert.equal(row.label, 'switched@example.com \u00b7 Switched Team')
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
  assert.equal(inv.cloudCheckAccounts.length, 1)
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

test('Keep local tolerates independent Desktop metadata and destination bridges', async () => {
  for (const extra of [
    { bridgeSessionIds: ['session_destination'] },
    { toolSurfaceSnapshot: { familyHashes: { builtin: 'changed' }, recordedAt: 123 } },
    { bridgeSessionIds: ['session_destination'], toolSurfaceSnapshot: { recordedAt: 456 } },
    { lastActivityAt: 999, completedTurns: 8, futureMetadata: { display: true } }
  ]) {
    const h = await home()
    await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
    await h.record('T', SOURCE, rehomeRecord())
    const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.T), to = all.find(row => row.account === h.acct.Z)
    const moved = await moveWithPending(h, [from], to)
    const row = moved.receipt.sessions[0]
    await writeFile(row.record, JSON.stringify({ ...JSON.parse(await readFile(row.record)), ...extra }))
    const kept = await keepLocal(h.paths)
    assert.equal(kept.ok, true)
    assert.equal(kept.cancelled, 1)
    assert.deepEqual(JSON.parse(await readFile(row.record)).bridgeSessionIds, extra.bridgeSessionIds ?? [])
    if (extra.bridgeSessionIds) assert.match((await undo(h.paths)).changed[0], /desktop record/)
  }
})

test('Finish cloud success retains historical local refusals as information', async () => {
  for (const failure of ['none', 'verification', 'verification without details', 'cloud']) {
    const h = await home()
    await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
    await h.record('T', SOURCE, rehomeRecord())
    const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.T), to = all.find(row => row.account === h.acct.Z)
    const moved = await moveWithPending(h, [from], to)
    const receipt = JSON.parse(await readFile(moved.file))
    receipt.failed.push({ id: id(998), title: 'Unmoved task', error: 'scheduled task family missing' })
    if (failure.startsWith('verification')) receipt.verification = { ok: false, problems: failure === 'verification' ? [{ id: SOURCE, check: 'transcript' }] : [] }
    await writeFile(moved.file, JSON.stringify(receipt))
    const cloud = cloudFixture(h, { account: from.account, org: from.org,
      list: async () => { if (failure === 'cloud') throw new Error('fixture offline'); return [] } })
    const result = await finishPending(h.paths, { cloud })
    assert.equal(result.ok, failure === 'none')
    assert.equal(result.complete, failure !== 'cloud')
    assert.equal(result.receipt.failed.some(row => row.title === 'Unmoved task'), true)
    assert.equal(result.failed.length, failure === 'cloud' ? 1 : 0)
    if (failure !== 'cloud') assert.equal((await cli(h.root, ['finish', '--json'])).code, failure === 'none' ? 0 : 1)
  }
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
  delete receipt.sessions[0].recordSnapshot
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
  const first = await move(await inventory([from], to, h.paths, () => {}, { cloudRequested: true }), to, h.paths, (stage, _text, progress) => {
    if (stage === 'verify' && progress?.completed === 0) writeFileSync(target, JSON.stringify({ ...JSON.parse(readFileSync(target)), lastFocusedAt: 1000 }))
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

test('a unique bridge link selects a fully verified Desktop fork and Undo restores its archive state', async () => {
  for (const location of ['P', 'T']) {
    const h = await home(), child = id(777), base = branchEntries(4, SOURCE, 1)
    await h.write(SOURCE, base)
    await h.record('T', SOURCE, rehomeRecord({ title: 'Parent', isArchived: true }))
    await h.write(child, [...fork(base, SOURCE, child, 'Fork'), { type: 'bridge-session', sessionId: child, bridgeSessionId: 'cse_linked_fork' }])
    await h.record(location, child, rehomeRecord({ title: 'Fork', isArchived: true, forkedFromSessionId: `local_${SOURCE}`, bridgeSessionIds: ['session_linked_fork'] }))
    const parentFile = path.join(h.dir('T'), `local_${SOURCE}.json`), targetFile = path.join(h.dir('T'), `local_${child}.json`)
    const originalParent = await readFile(parentFile), originalFork = JSON.parse(await readFile(path.join(h.dir(location), `local_${child}.json`)))
    let status = 'active'
    const cloud = cloudFixture(h, {
      list: async () => [remoteSession({ id: 'cse_linked_fork', title: 'Renamed remote fork', status })],
      eventRows: async () => remoteRows(base),
      session: async () => remoteState(status),
      archive: async () => { assert.ok(await readFile(targetFile)); status = 'archived' },
      unarchive: async () => { status = 'active' }
    })
    const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
    const inv = await inventory([from], to, h.paths, () => {}, { cloud })
    assert.deepEqual(inv.cloud.blocked, [])
    assert.deepEqual(inv.cloud.matches.map(row => [row.target.kind, row.target.id]), [[location === 'P' ? 'move' : 'existing', child]])
    const moved = await move(inv, to, h.paths)
    assert.equal(moved.ok, true)
    assert.equal(status, 'archived')
    assert.deepEqual(moved.receipt.remote.map(row => row.targetId), [child])
    assert.deepEqual(await readdir(h.dir('P')), [])
    const placed = JSON.parse(await readFile(targetFile))
    assert.equal(placed.isArchived, false)
    assert.equal(placed.forkedFromSessionId, `local_${SOURCE}`)
    assert.deepEqual(placed.bridgeSessionIds, location === 'P' ? [] : ['session_linked_fork'])
    assert.deepEqual(await readFile(parentFile), originalParent)
    assert.ok((await undo(h.paths, { cloud })).dest)
    assert.equal(status, 'active')
    assert.deepEqual(await readFile(parentFile), originalParent)
    assert.deepEqual(JSON.parse(await readFile(path.join(h.dir(location), `local_${child}.json`))), originalFork)
  }
})

test('overlapping verified histories refuse absent, ambiguous, or unverified bridge links', async () => {
  for (const links of ['none', 'multiple', 'unverified']) {
    const h = await home(), child = id(777), base = branchEntries(4, SOURCE, 1)
    const bridgeSessionIds = links === 'multiple' ? ['session_linked_fork'] : []
    await h.write(SOURCE, base)
    await h.record('T', SOURCE, rehomeRecord({ bridgeSessionIds }))
    await h.write(child, fork(base, SOURCE, child, 'Fork'))
    await h.record('P', child, rehomeRecord({ forkedFromSessionId: `local_${SOURCE}`, bridgeSessionIds }))
    if (links === 'unverified') {
      const shorter = id(778)
      await h.write(shorter, fork(base.slice(0, 3), SOURCE, shorter, 'Shorter fork'))
      await h.record('T', shorter, rehomeRecord({ forkedFromSessionId: `local_${SOURCE}`, bridgeSessionIds: ['session_linked_fork'] }))
    }
    const cloud = cloudFixture(h, {
      list: async () => [remoteSession({ id: 'cse_linked_fork', title: 'Remote fork' })],
      eventRows: async () => remoteRows(base)
    })
    const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
    const inv = await inventory([from], to, h.paths, () => {}, { cloud })
    assert.deepEqual(inv.cloud.matches, [])
    assert.equal(inv.cloud.blocked.length, 1)
    assert.match(inv.cloud.blocked[0].error, /multiple .*local target/)
  }
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

async function taskFamilyFixture(enabled = false, taskCount = 2, eventCount = 1) {
  const h = await home(), run = id(701), second = id(702), cold = id(703)
  const runs = [run, second].slice(0, taskCount)
  const tasks = runs.map((sid, index) => ({ id: `task_${index}`, notifySessionId: `local_${SOURCE}`,
    enabled, fireAt: 123456 + index, filePath: path.join(h.root, '.claude', 'scheduled-tasks', `task_${index}`, 'SKILL.md'), createdAt: 123,
    lastRunAt: '2026-09-01T00:00:00Z', lastScheduledFor: '2026-09-01T00:00:00Z' }))
  for (const task of tasks) {
    await mkdir(path.dirname(task.filePath), { recursive: true })
    await writeFile(task.filePath, `---\nname: ${task.id}\n---\nSynthetic reminder prompt\n`)
  }
  for (const [index, sid] of [SOURCE, ...runs, cold].entries()) {
    await h.write(sid, branchEntries(eventCount, sid, 80 + index * eventCount))
    await h.record('P', sid, rehomeRecord(runs.includes(sid) ? { scheduledTaskId: tasks[index - 1].id, notifySessionId: `local_${SOURCE}` } : {}))
  }
  const skips = Object.fromEntries(tasks.map(task => [task.id, [{ at: '2026-09-02T00:00:00Z', reason: 'app_closed' }]]))
  const retries = { task_0: { slot: '2026-09-02T00:00:00Z', attempts: 2, notBefore: '2026-09-02T00:05:00Z' } }
  const unrelatedSkips = { unrelated_task: [{ at: '2026-09-01T01:00:00Z', reason: 'missed' }] }
  const unrelatedRetries = { unrelated_task: { slot: '2026-09-01T01:00:00Z', attempts: 1, notBefore: '2026-09-01T01:05:00Z' } }
  const sourceRegistry = { scheduledTasks: tasks, recordedSkips: { ...skips, ...unrelatedSkips }, runRetries: { ...retries, ...unrelatedRetries }, sundayAliasBoundaryStamped: true,
    dayFieldsOrBoundaryStamped: false, future: { preserved: 'source' } }
  const targetRegistry = { scheduledTasks: [{ id: 'unrelated_task', enabled: true, cronExpression: '0 0 * * *', filePath: '/tmp/fixture/other.md' }],
    recordedSkips: { other_task: [{ at: '2026-09-03T00:00:00Z', reason: 'disabled' }] }, runRetries: { other_task: { slot: '2026-09-03T00:00:00Z', attempts: 3, notBefore: '2026-09-03T00:10:00Z' } }, future: { preserved: 'target' } }
  const sourceAfter = { ...sourceRegistry, scheduledTasks: [], recordedSkips: unrelatedSkips, runRetries: unrelatedRetries }
  const targetAfter = { ...targetRegistry, scheduledTasks: [...targetRegistry.scheduledTasks, ...tasks], recordedSkips: { ...targetRegistry.recordedSkips, ...skips }, runRetries: { ...targetRegistry.runRetries, ...retries } }
  const sourceFile = path.join(h.dir('P'), 'scheduled-tasks.json'), targetFile = path.join(h.dir('T'), 'scheduled-tasks.json')
  await writeFile(sourceFile, JSON.stringify(sourceRegistry))
  await writeFile(targetFile, JSON.stringify(targetRegistry))
  const selection = async () => {
    const all = await accounts(h.paths, [])
    return { from: all.find(row => row.account === h.acct.P), to: all.find(row => row.account === h.acct.T) }
  }
  return { ...h, run, second, cold, tasks, sourceRegistry, targetRegistry, sourceAfter, targetAfter, sourceFile, targetFile, selection }
}

async function fixtureSnapshot(h, directories = [h.paths.records, h.paths.pool, h.paths.state]) {
  const files = {}
  const visit = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (dir !== h.paths.state || /^\d.*\.json(?:\.journal)?$/.test(entry.name)) files[file] = createHash('sha256').update(await readFile(file)).digest('hex')
    }
  }
  for (const dir of directories) await visit(dir)
  return files
}

async function taskCheckpointFixture() {
  const h = await home(), sessions = [SOURCE, id(791)]
  const sourceFile = path.join(h.dir('P'), 'scheduled-tasks.json'), targetFile = path.join(h.dir('T'), 'scheduled-tasks.json')
  const tasks = sessions.map((sid, index) => ({ id: `task_${index + 1}`, notifySessionId: `local_${sid}`, enabled: true, fireAt: 123456 + index }))
  const sourceRegistry = { scheduledTasks: tasks,
    recordedSkips: Object.fromEntries(tasks.map(task => [task.id, [{ at: '2026-09-02T00:00:00Z', reason: 'app_closed' }]])),
    runRetries: Object.fromEntries(tasks.map(task => [task.id, { slot: '2026-09-02T00:00:00Z', attempts: 2, notBefore: '2026-09-02T00:05:00Z' }])) }
  for (const [index, sid] of sessions.entries()) {
    await h.write(sid, [entry('user', 810 + index, null, sid)])
    await h.record('P', sid, rehomeRecord())
  }
  const originalRecords = await Promise.all(sessions.map(sid => readFile(path.join(h.dir('P'), `local_${sid}.json`))))
  await writeFile(sourceFile, JSON.stringify(sourceRegistry))
  return { ...h, sessions, tasks, sourceFile, targetFile, sourceRegistry, originalRecords }
}

async function checkpointAccountsFixture() {
  const h = await taskCheckpointFixture()
  await interruptTaskFamily({ ...h, interruptAfter: 2 }, 'move', 'source')
  const file = path.join(h.paths.state, (await readdir(h.paths.state)).find(name => /^\d.*\.json$/.test(name)))
  const original = await readFile(file), receipt = JSON.parse(original)
  assert.equal(receipt.taskTransfers.length, 2)
  assert.deepEqual([receipt.appendCheckpoint.sessions, receipt.appendCheckpoint.superseded, receipt.appendCheckpoint.taskTransfers], [1, 1, 1])
  receipt.appendCheckpoint.taskTransfers = 0
  await writeFile(file, JSON.stringify(receipt))
  const before = await fixtureSnapshot(h)
  const discovered = (await accounts(h.paths, [])).map(row => [row.account, row.org, row.sessions.length, row.unreadable.length])
  const corrupted = await cli(h.root, ['accounts', '--json'])
  assert.equal(corrupted.code, 0, corrupted.stderr)
  assert.equal(lines(corrupted.stdout).length, 1)
  const listed = lines(corrupted.stdout)[0]
  assert.equal(listed.length, 4)
  assert.deepEqual(listed.map(row => [row.account, row.org, row.sessions, row.unreadable]), discovered)
  for (const row of listed) {
    assert.deepEqual(row.recoveryProblem, { receipt: file, error: 'invalid append checkpoint' })
    assert.equal(row.pending, null)
    assert.equal(row.pendingAction, null)
  }
  assert.deepEqual(await fixtureSnapshot(h), before)
  await writeFile(file, original)
  const repairedBefore = await fixtureSnapshot(h)
  const repaired = await cli(h.root, ['accounts', '--json'])
  assert.equal(repaired.code, 0, repaired.stderr)
  const restored = lines(repaired.stdout)[0]
  assert.ok(restored.every(row => row.recoveryProblem === null))
  assert.deepEqual(restored.filter(row => row.pending).map(row => [row.account, row.pending, row.pendingAction, row.receipt]), [[h.acct.P, 'recovery', 'finish', file]])
  assert.deepEqual(await fixtureSnapshot(h), repairedBefore)
  return { corrupted: corrupted.stdout.trim(), repaired: repaired.stdout.trim() }
}

test('CLI accounts reports checkpoint corruption without changing recovery data', async () => {
  await checkpointAccountsFixture()
})

test('Undo validates every supplied approval before changing records or receipts', async () => {
  for (const scenario of ['stale receipt', 'invalid', 'empty', 'wrong operation', 'consumed', 'stopped scheduler', 'pending recovery']) {
    const h = await taskFamilyFixture(), { from, to } = await h.selection()
    const moved = await executeMove([from], to, h.paths, { processes: [] })
    let rows = [desktopFixture()[0]]
    const calls = [], io = { inspect: () => rows, command: async file => {
      calls.push(file)
      rows = file.endsWith('osascript') ? [] : [{ ...desktopFixture()[0], pid: 700, desktopPid: 700, started: 'reopened' }]
      return { status: 0 }
    } }
    const planned = await (scenario === 'wrong operation' ? executeMove(null, null, h.paths, { io }) : undo(h.paths, { io }))
    assert.ok(planned.plan, scenario)
    assert.equal(planned.plan.receiptFile, scenario === 'wrong operation' ? null : moved.file)
    if (scenario === 'consumed') assert.ok((await undo(h.paths, { io, approve: planned.plan.token })).dest)
    if (['stale receipt', 'consumed'].includes(scenario)) {
      const sid = id(798)
      await h.write(sid, branchEntries(1, sid, 600))
      await h.record('Q', sid, rehomeRecord())
      const all = await accounts(h.paths, [])
      assert.equal((await executeMove([all.find(row => row.account === h.acct.Q)], all.find(row => row.account === h.acct.T), h.paths, { processes: [] })).ok, true)
    }
    if (scenario === 'pending recovery') {
      const receipt = JSON.parse(await readFile(moved.file))
      receipt.finalizing = true
      await writeFile(moved.file, JSON.stringify(receipt))
    }
    if (scenario === 'stopped scheduler') rows = []
    calls.length = 0
    const before = await fixtureSnapshot(h)
    const refused = await undo(h.paths, { io, approve: scenario === 'empty' ? '' : scenario === 'invalid' || scenario === 'pending recovery' ? '0'.repeat(64) : planned.plan.token })
    assert.equal(refused.ok, false, scenario)
    assert.match(refused.reason, /approval|receipt changed|Open Claude sessions changed/, scenario)
    assert.deepEqual(await fixtureSnapshot(h), before, scenario)
    assert.equal(calls.some(file => file.endsWith('osascript')), false, scenario)
  }
})

test('Undo rechecks its receipt under the lock between preflight and restart planning', async () => {
  const h = await taskFamilyFixture(), { from, to } = await h.selection(), sid = id(798)
  await executeMove([from], to, h.paths, { processes: [] })
  await h.write(sid, branchEntries(1, sid, 600))
  await h.record('Q', sid, rehomeRecord())
  const all = await accounts(h.paths, []), original = fs.mkdir
  let entries = 0, before, rows = [desktopFixture()[0]]
  fs.mkdir = async (...args) => {
    if (args[0] === h.paths.state && ++entries === 2) {
      const next = await executeMove([all.find(row => row.account === h.acct.Q)], all.find(row => row.account === h.acct.T), h.paths, { processes: [] })
      assert.equal(next.ok, true)
      before = await fixtureSnapshot(h)
      rows = []
    }
    return original(...args)
  }
  syncBuiltinESMExports()
  let result
  try { result = await undo(h.paths, { io: { inspect: () => rows, command: async () => assert.fail('stale receipt must not restart') } }) }
  finally { fs.mkdir = original; syncBuiltinESMExports() }
  assert.ok(before)
  assert.equal(result.ok, false)
  assert.match(result.reason, /receipt changed/)
  assert.deepEqual(await fixtureSnapshot(h), before)
})

test('task recovery scopes validation, restart and accounts to the unfinished family', async () => {
  for (const active of ['T', 'Q']) {
    const h = await taskFamilyFixture()
    h.tasks[1].notifySessionId = `local_${h.second}`
    await h.record('P', h.second, rehomeRecord({ scheduledTaskId: h.tasks[1].id, notifySessionId: `local_${h.second}` }))
    for (const sid of [SOURCE, h.run]) await rename(path.join(h.dir('P'), `local_${sid}.json`), path.join(h.dir('Q'), `local_${sid}.json`))
    const firstRegistry = { scheduledTasks: [h.tasks[0]], recordedSkips: { task_0: h.sourceRegistry.recordedSkips.task_0 }, runRetries: { task_0: h.sourceRegistry.runRetries.task_0 } }
    await writeFile(path.join(h.dir('Q'), 'scheduled-tasks.json'), JSON.stringify(firstRegistry))
    h.sourceRegistry.scheduledTasks = [h.tasks[1]]
    delete h.sourceRegistry.recordedSkips.task_0
    delete h.sourceRegistry.runRetries.task_0
    await writeFile(h.sourceFile, JSON.stringify(h.sourceRegistry))
    h.sourceAccounts = [h.acct.Q, h.acct.P]
    await interruptTaskFamily(h, 'move', 'source')
    const file = path.join(h.paths.state, (await readdir(h.paths.state)).find(name => /^\d.*\.json$/.test(name)))
    const interrupted = JSON.parse(await readFile(file))
    assert.equal(interrupted.taskTransfers.length, 2)
    assert.equal(interrupted.appendCheckpoint.taskTransfers, 1)
    const target = JSON.parse(await readFile(h.targetFile)), completed = target.scheduledTasks.find(task => task.id === 'task_0')
    completed.enabled = true
    completed.lastRunAt = '2026-09-10T00:00:00Z'
    await writeFile(h.targetFile, JSON.stringify(target))
    const originals = await Promise.all([SOURCE, h.run].map(sid => readFile(path.join(h.dir('T'), `local_${sid}.json`))))
    const badge = lines((await cli(h.root, ['accounts', '--json'])).stdout).at(-1)
    assert.deepEqual(badge.filter(row => row.pending).map(row => row.account), [h.acct.P])
    const f = await identityFixture(h)
    await writeFile(h.paths.desktop, JSON.stringify({ lastKnownAccountUuid: h.acct[active] }))
    await f.write(f.init(1, h.acct[active], h.org[active]))
    let rows = f.processes
    const calls = [], io = { inspect: () => rows, command: async name => {
      calls.push(name)
      rows = name.endsWith('osascript') ? [] : f.processes
      return { status: 0 }
    } }
    let result = await finishWorkflow(h.paths, { io })
    if (active === 'T') {
      assert.ok(result.plan)
      assert.equal(result.plan.kind, 'recover')
      result = await finishWorkflow(h.paths, { io, approve: result.plan.token })
      assert.equal(result.restarted, true)
    } else {
      assert.equal(result.plan, undefined)
      assert.deepEqual(calls, [])
    }
    assert.equal(result.recoveryRequired, true)
    assert.deepEqual(JSON.parse(await readFile(h.targetFile)), target)
    assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceRegistry)
    assert.deepEqual(await Promise.all([SOURCE, h.run].map(sid => readFile(path.join(h.dir('T'), `local_${sid}.json`)))), originals)
    assert.ok(await readFile(path.join(h.dir('P'), `local_${h.second}.json`)))
    const receipt = JSON.parse(await readFile(file))
    assert.equal(receipt.taskTransfers.length, 1)
    assert.equal(receipt.finalizing, false)
    const before = await fixtureSnapshot(h)
    const refused = await undo(h.paths, { processes: [] })
    assert.match(refused.restoreProblems.join(' '), /registrations changed/)
    assert.deepEqual(await fixtureSnapshot(h), before)
  }
})

test('task checkpoint integrity refuses corruption before recovery writes or restart', async t => {
  const checkpoints = [
    ['inconsistent zero', { taskTransfers: 0 }],
    ['missing offset', { taskTransfers: undefined }],
    ['null offset', { taskTransfers: null }],
    ['negative offset', { taskTransfers: -1 }],
    ['fractional offset', { taskTransfers: 0.5 }],
    ['out-of-range offset', { taskTransfers: 3 }],
    ['uncommitted family offset', { taskTransfers: 2 }],
    ['missing committed records', { sessions: 0 }],
    ['missing committed retirement', { superseded: 0 }],
    ['valid checkpoint', {}]
  ]
  for (const mode of ['stopped Desktop', 'approved restart']) for (const [scenario, patch] of checkpoints) await t.test(`${scenario}, ${mode}`, async () => {
    const h = await taskCheckpointFixture(), { sessions, tasks, sourceFile, targetFile, sourceRegistry, originalRecords } = h
    await interruptTaskFamily({ ...h, interruptAfter: 2 }, 'move', 'source')
    const file = path.join(h.paths.state, (await readdir(h.paths.state)).find(name => /^\d.*\.json$/.test(name)))
    const interrupted = JSON.parse(await readFile(file)), checkpoint = interrupted.appendCheckpoint
    assert.equal(interrupted.finalizing, true)
    assert.deepEqual([checkpoint.sessions, checkpoint.superseded, checkpoint.taskTransfers], [1, 1, 1])
    assert.equal(interrupted.taskTransfers.length, 2)
    const targetBefore = await readFile(targetFile), firstRecord = await readFile(path.join(h.dir('T'), `local_${sessions[0]}.json`))
    assert.deepEqual(JSON.parse(targetBefore).scheduledTasks, [tasks[0]])
    assert.deepEqual(JSON.parse(await readFile(sourceFile)).scheduledTasks, [])
    let rows = mode === 'approved restart' ? [desktopFixture()[0]] : []
    const calls = [], io = { inspect: () => rows, command: async name => {
      calls.push(name)
      rows = name.endsWith('osascript') ? [] : [{ ...desktopFixture()[0], pid: 700, desktopPid: 700, started: 'reopened' }]
      return { status: 0 }
    } }
    const planned = mode === 'approved restart' ? await finishWorkflow(h.paths, { io }) : null
    if (planned) assert.equal(planned.plan.kind, 'recover')
    const options = { io, processes: [], ...(planned ? { approve: planned.plan.token } : {}) }
    const planFile = path.join(h.paths.state, 'restart-plan.json'), planBefore = await readFile(planFile).catch(() => null)
    if (scenario !== 'valid checkpoint') {
      await writeFile(file, JSON.stringify({ ...interrupted, appendCheckpoint: { ...checkpoint, ...patch } }))
      const before = await fixtureSnapshot(h), writes = []
      const originals = new Map(['writeFile', 'appendFile', 'open', 'rename', 'link', 'unlink', 'rm'].map(key => [key, fs[key]]))
      for (const [key, original] of originals) fs[key] = async (...args) => { writes.push(key); return original(...args) }
      syncBuiltinESMExports()
      try {
        await assert.rejects(finishWorkflow(h.paths, options), /invalid append checkpoint/)
        await assert.rejects(planned
          ? executeMove(null, null, h.paths, { ...options, recover: true, receiptFile: file })
          : finishPending(h.paths, options), /invalid append checkpoint/)
      } finally {
        for (const [key, original] of originals) fs[key] = original
        syncBuiltinESMExports()
      }
      assert.deepEqual(writes, [])
      assert.deepEqual(calls, [])
      assert.deepEqual(await fixtureSnapshot(h), before)
      assert.deepEqual(await readFile(planFile).catch(() => null), planBefore)
      const retained = JSON.parse(await readFile(file))
      assert.equal(retained.finalizing, true)
      assert.equal(retained.taskTransfers.length, 2)
      retained.appendCheckpoint = checkpoint
      await writeFile(file, JSON.stringify(retained))
    }
    const recovered = await finishWorkflow(h.paths, options)
    assert.equal(recovered.recoveryRequired, true)
    assert.deepEqual(calls, planned ? ['/usr/bin/osascript', '/usr/bin/open'] : [])
    if (planned) assert.equal(recovered.restarted, true)
    const receipt = JSON.parse(await readFile(file))
    assert.equal(receipt.finalizing, false)
    assert.equal(receipt.appendCheckpoint, undefined)
    assert.deepEqual(receipt.sessions.map(row => row.id), [sessions[0]])
    assert.equal(receipt.superseded.length, 1)
    assert.equal(receipt.taskTransfers.length, 1)
    assert.deepEqual(await readFile(targetFile), targetBefore)
    assert.deepEqual(JSON.parse(await readFile(sourceFile)), { scheduledTasks: [tasks[1]],
      recordedSkips: { task_2: sourceRegistry.recordedSkips.task_2 }, runRetries: { task_2: sourceRegistry.runRetries.task_2 } })
    assert.deepEqual(await readFile(path.join(h.dir('T'), `local_${sessions[0]}.json`)), firstRecord)
    assert.deepEqual(await readFile(path.join(h.dir('P'), `local_${sessions[1]}.json`)), originalRecords[1])
    assert.equal(await stat(path.join(h.dir('P'), `local_${sessions[0]}.json`)).catch(() => null), null)
    assert.equal(await stat(path.join(h.dir('T'), `local_${sessions[1]}.json`)).catch(() => null), null)
    assert.ok((await undo(h.paths, { processes: [] })).dest)
    assert.deepEqual(JSON.parse(await readFile(sourceFile)), sourceRegistry)
    assert.deepEqual(await Promise.all(sessions.map(sid => readFile(path.join(h.dir('P'), `local_${sid}.json`)))), originalRecords)
    assert.equal(await stat(targetFile).catch(() => null), null)
  })
})

test('task checkpoint integrity keeps interrupted Undo scoped to the whole receipt', async () => {
  const h = await taskCheckpointFixture(), all = await accounts(h.paths, [])
  const moved = await executeMove([all.find(row => row.account === h.acct.P)], all.find(row => row.account === h.acct.T), h.paths, { processes: [] })
  assert.equal(moved.ok, true)
  assert.equal(moved.receipt.taskTransfers.length, 2)
  await interruptTaskFamily(h, 'undo', 'target')
  const receipt = JSON.parse(await readFile(moved.file))
  assert.ok(receipt.undoing)
  receipt.appendCheckpoint = { sessions: 1, superseded: 1, taskTransfers: 1, held: [] }
  await writeFile(moved.file, JSON.stringify(receipt))
  assert.ok((await finishWorkflow(h.paths, { processes: [] })).dest)
  assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceRegistry)
  assert.deepEqual(await Promise.all(h.sessions.map(sid => readFile(path.join(h.dir('P'), `local_${sid}.json`)))), h.originalRecords)
  assert.deepEqual(JSON.parse(await readFile(h.targetFile)), { scheduledTasks: [], recordedSkips: {}, runRetries: {} })
  assert.deepEqual(await readdir(h.dir('T')), ['scheduled-tasks.json'])
})

test('a known account without a Desktop directory receives and undoes a task family', async () => {
  const h = await taskFamilyFixture()
  await fs.rm(h.dir('T'), { recursive: true })
  const { from, to } = await h.selection()
  assert.deepEqual(to.sessions, [])
  const moved = await executeMove([from], to, h.paths, { processes: [] })
  assert.equal(moved.ok, true)
  assert.equal(moved.receipt.sessions.length, 4)
  assert.deepEqual(JSON.parse(await readFile(h.targetFile)), { scheduledTasks: h.tasks,
    recordedSkips: { task_0: h.sourceRegistry.recordedSkips.task_0, task_1: h.sourceRegistry.recordedSkips.task_1 }, runRetries: { task_0: h.sourceRegistry.runRetries.task_0 } })
  assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceAfter)
  assert.ok((await undo(h.paths, { processes: [] })).dest)
  assert.deepEqual(await readdir(h.dir('T')), [])
  assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceRegistry)
  for (const sid of [SOURCE, h.run, h.second, h.cold]) assert.ok(await readFile(path.join(h.dir('P'), `local_${sid}.json`)))
})

test('task preflight refuses absent sources and unreadable destination data', async () => {
  for (const scenario of ['missing source', 'unreadable source', 'unreadable target', 'denied target']) {
    const h = await taskFamilyFixture(), { from, to } = await h.selection()
    const inv = await inventory([{ ...from, sessions: from.sessions.filter(row => row.id !== h.cold) }], to, h.paths, () => {}, { processes: [] })
    if (scenario === 'missing source') await fs.rm(h.dir('P'), { recursive: true })
    if (scenario.startsWith('unreadable')) await writeFile(path.join(h.dir(scenario === 'unreadable source' ? 'P' : 'T'), `local_${id(796)}.json`), '{broken')
    const before = await fixtureSnapshot(h, [h.paths.records, h.paths.pool]), original = fs.readdir
    if (scenario === 'denied target') {
      fs.readdir = async (...args) => {
        if (args[0] === h.dir('T')) throw Object.assign(new Error('fixture target access denied'), { code: 'EACCES' })
        return original(...args)
      }
      syncBuiltinESMExports()
    }
    let result
    try { result = await move(inv, to, h.paths) }
    finally { fs.readdir = original; syncBuiltinESMExports() }
    assert.equal(result.ok, false, scenario)
    assert.equal(result.receipt.sessions.length, 0, scenario)
    assert.ok(result.receipt.failed.length, scenario)
    assert.deepEqual(await fixtureSnapshot(h, [h.paths.records, h.paths.pool]), before, scenario)
  }
})

test('task families preserve registration state, generated records and registry fields through Undo', async () => {
  for (const enabled of [false, true]) {
    const h = await taskFamilyFixture(enabled), { from, to } = await h.selection()
    const prompts = await Promise.all(h.tasks.map(task => readFile(task.filePath)))
    const inv = await inventory([from], to, h.paths, () => {}, { processes: [] })
    assert.equal(inv.move.length, 4)
    const moved = await executeMove([from], to, h.paths, { processes: [] })
    assert.equal(moved.ok, true)
    assert.equal(moved.receipt.sessions.length, 4)
    assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceAfter)
    assert.deepEqual(JSON.parse(await readFile(h.targetFile)), h.targetAfter)
    assert.deepEqual(await Promise.all(h.tasks.map(task => readFile(task.filePath))), prompts)
    assert.deepEqual(moved.receipt.taskTransfers[0].state, { recordedSkips: { task_0: h.sourceRegistry.recordedSkips.task_0, task_1: h.sourceRegistry.recordedSkips.task_1 }, runRetries: { task_0: h.sourceRegistry.runRetries.task_0 } })
    for (const sid of [SOURCE, h.run, h.second]) {
      const record = JSON.parse(await readFile(path.join(h.dir('T'), `local_${sid}.json`)))
      assert.equal(record.cliSessionId, sid)
      assert.equal(record.sessionId, `local_${sid}`)
      if (sid !== SOURCE) assert.equal(record.notifySessionId, `local_${SOURCE}`)
    }
    const undone = await undo(h.paths, { processes: [] })
    assert.ok(undone.dest)
    assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceRegistry)
    assert.deepEqual(JSON.parse(await readFile(h.targetFile)), h.targetRegistry)
    assert.deepEqual(await Promise.all(h.tasks.map(task => readFile(task.filePath))), prompts)
    for (const sid of [SOURCE, h.run, h.second, h.cold]) assert.ok(await readFile(path.join(h.dir('P'), `local_${sid}.json`)))
  }
})

test('task family cloud work follows all local placements and reports the entire operation', async () => {
  for (const scenario of ['match', 'rescue', 'remote changed', 'family refused']) {
    const h = await taskFamilyFixture(false, 1, 8), { from, to } = await h.selection()
    const anchor = scenario === 'rescue' ? h.cold : SOURCE
    const base = lines(await readFile(path.join(h.project, `${anchor}.jsonl`), 'utf8'))
    const remote = scenario === 'rescue' ? [...base, entry('assistant', 300, 87, 'cse_task_family')] : base
    let status = 'active', archived = 0, changed = false
    const reports = []
    const cloud = cloudFixture(h, {
      list: async () => [remoteSession({ id: 'cse_task_family', title: `Session ${anchor.slice(-3)}`, status })],
      eventRows: async () => remoteRows(changed ? [...remote, entry('user', 301, 87, 'cse_task_family')] : remote),
      session: async () => remoteState(status),
      archive: async () => {
        assert.deepEqual(JSON.parse(await readFile(h.targetFile)), h.targetAfter)
        for (const sid of [SOURCE, h.run, h.cold]) {
          assert.ok(await readFile(path.join(h.dir('T'), `local_${sid}.json`)))
          assert.equal(await stat(path.join(h.dir('P'), `local_${sid}.json`)).catch(() => null), null)
        }
        archived++
        status = 'archived'
      }
    })
    const inv = await inventory([from], to, h.paths, () => {}, { processes: [], cloud })
    assert.equal(inv.move.length, 3)
    assert.equal(inv.cloud.matches.length, 1)
    assert.deepEqual(inv.cloud.blocked, [])
    if (scenario === 'remote changed') changed = true
    if (scenario === 'family refused') await writeFile(h.sourceFile, JSON.stringify({ ...h.sourceRegistry, scheduledTasks: [{ ...h.tasks[0], notifySessionId: `local_${id(799)}` }] }))
    const moved = await move(inv, to, h.paths, (stage, text, extra) => reports.push({ stage, text, ...extra }))
    assert.equal((await readdir(h.paths.state)).filter(name => /^\d.*\.json$/.test(name)).length, 1)
    const succeeds = ['match', 'rescue'].includes(scenario)
    assert.equal(moved.ok, succeeds, scenario)
    assert.equal(archived, succeeds ? 1 : 0, scenario)
    assert.equal(moved.pendingCloud, succeeds ? 0 : 1, scenario)
    assert.equal(moved.receipt.sessions.length, scenario === 'family refused' ? 1 : scenario === 'rescue' ? 4 : 3, scenario)
    if (succeeds) {
      const moves = reports.filter(row => row.stage === 'move' && !row.live)
      assert.equal(moves.length, 1)
      assert.match(moves[0].text, scenario === 'rescue' ? /4 ✓ \| 33 events/ : /3 ✓ \| 24 events/)
      for (const stage of ['move', 'verify', 'retire']) {
        const progress = reports.filter(row => row.stage === stage && row.completed !== undefined)
        const total = stage === 'retire' ? 3 : moved.receipt.sessions.length
        assert.ok(progress.length, stage)
        assert.ok(progress.every((row, index) => row.total === total && row.completed >= (progress[index - 1]?.completed ?? 0)), stage)
        assert.equal(progress.at(-1).completed, total, stage)
      }
    } else {
      assert.ok(moved.receipt.failed.some(row => row.cloudAccount === h.acct.P))
      assert.match(moved.receipt.failed.map(row => row.error).join(' '), scenario === 'family refused' ? /changed since inventory/ : /Remote Control history changed/)
      if (scenario === 'family refused') assert.ok(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`)))
    }
  }
})

test('deferred cloud rescue preserves a retired destination anchor and rejects changed anchors', async () => {
  for (const scenario of ['ordinary', 'mixed', 'changed', 'unsafe', 'parked changed']) {
    const h = await taskFamilyFixture(false, 1), anchor = id(795), remoteId = 'cse_retired_anchor'
    const prefix = branchEntries(8, h.cold, 800).map(row => ({ ...row, entrypoint: 'anchor-entry' }))
    await h.write(h.cold, [...prefix, entry('user', 808, 807, h.cold, { version: 'survivor-version', entrypoint: 'survivor-entry' })])
    const anchorEntries = fork(prefix, h.cold, anchor, 'Anchor').map(row => ({ ...row, cwd: '/tmp/anchor', version: 'anchor-version', entrypoint: 'anchor-entry', gitBranch: 'anchor-branch' }))
    await h.write(anchor, anchorEntries)
    await h.record('T', anchor, rehomeRecord({ title: 'Remote anchor', cwd: '/tmp/anchor', originCwd: '/tmp/anchor', sessionSettings: { from: 'anchor' }, remoteMcpServersConfig: [{ name: 'anchor-server' }] }))
    await h.record('P', h.cold, rehomeRecord({ title: 'Local branch', sessionSettings: { from: 'survivor' } }))
    const { from, to } = await h.selection(), remote = [...prefix, entry('assistant', 809, 807, remoteId)]
    let status = 'active', archived = 0
    const cloud = cloudFixture(h, {
      list: async () => [remoteSession({ id: remoteId, title: 'Remote anchor', status })],
      eventRows: async () => remoteRows(remote),
      session: async () => remoteState(status),
      archive: async () => { status = 'archived'; archived++ },
      unarchive: async () => { status = 'active' }
    })
    const source = scenario === 'ordinary' ? { ...from, sessions: from.sessions.filter(row => row.id === h.cold) } : from
    const inv = await inventory([source], to, h.paths, () => {}, { processes: [], cloud })
    assert.equal(inv.cloud.matches.length, 1)
    assert.equal(inv.cloud.matches[0].target.base.kind, 'existing')
    assert.equal(inv.cloud.matches[0].target.base.id, anchor)
    const file = path.join(h.dir('T'), `local_${anchor}.json`), before = await readFile(file)
    if (scenario === 'changed') await writeFile(file, JSON.stringify({ ...JSON.parse(before), sessionSettings: { edited: true } }))
    if (scenario === 'unsafe') await writeFile(h.targetFile, JSON.stringify({ ...h.targetRegistry, scheduledTasks: [...h.targetRegistry.scheduledTasks, { id: 'new_anchor_owner', notifySessionId: `local_${anchor}`, enabled: false }] }))
    const original = fs.rename
    let edited = false
    if (scenario === 'parked changed') {
      fs.rename = async (...args) => {
        const result = await original(...args)
        if (args[0] === file && !edited) {
          edited = true
          await writeFile(args[1], JSON.stringify({ ...JSON.parse(before), cwd: '/tmp/changed-anchor' }))
        }
        return result
      }
      syncBuiltinESMExports()
    }
    let result
    try { result = await move(inv, to, h.paths) }
    finally { fs.rename = original; syncBuiltinESMExports() }
    const succeeds = ['ordinary', 'mixed'].includes(scenario)
    assert.equal(result.ok, succeeds, JSON.stringify({ scenario, failed: result.receipt.failed }))
    assert.equal(archived, succeeds ? 1 : 0, scenario)
    assert.equal(status, succeeds ? 'archived' : 'active', scenario)
    if (succeeds) {
      assert.equal(result.receipt.superseded.filter(row => !row.source && row.id === anchor).length, 1)
      assert.equal(await stat(file).catch(() => null), null)
      const rescued = result.receipt.sessions.find(row => row.strategy === 'remote')
      assert.equal(rescued.rescueAnchorId, anchor)
      const record = JSON.parse(await readFile(rescued.record)), entries = lines(await readFile(rescued.targetTranscript, 'utf8')).filter(row => row.message)
      assert.equal(record.cwd, '/tmp/anchor')
      assert.deepEqual(record.sessionSettings, { from: 'anchor' })
      assert.deepEqual(record.remoteMcpServersConfig, [{ name: 'anchor-server' }])
      assert.ok(entries.every(row => row.cwd === '/tmp/anchor' && row.version === 'anchor-version' && row.entrypoint === 'anchor-entry' && row.gitBranch === 'anchor-branch'))
      assert.deepEqual(entries.map(row => row.message), remote.map(row => row.message))
      assert.deepEqual(await readFile(path.join(h.project, `${anchor}.jsonl`), 'utf8'), anchorEntries.map(row => JSON.stringify(row)).join('\n') + '\n')
      assert.ok((await undo(h.paths, { processes: [], cloud })).dest)
      assert.deepEqual(await readFile(file), before)
      assert.equal(status, 'active')
    } else {
      assert.equal(result.receipt.sessions.some(row => row.strategy === 'remote'), false)
      assert.match(result.receipt.failed.map(row => row.error).join(' '), /rescue anchor changed/)
      if (scenario === 'parked changed') assert.equal(edited, true)
    }
  }
})

test('task family preflight errors cannot modify an earlier completed receipt', async () => {
  const h = await taskFamilyFixture(), { from, to } = await h.selection()
  const ordinary = { ...from, sessions: from.sessions.filter(row => row.id === h.cold) }
  const first = await executeMove([ordinary], to, h.paths, { processes: [] })
  const before = await readFile(first.file)
  const fresh = await h.selection()
  const inv = await inventory([fresh.from], fresh.to, h.paths, () => {}, { processes: [] })
  h.sourceRegistry.scheduledTasks[0].notifySessionId = `local_${h.cold}`
  await writeFile(h.sourceFile, JSON.stringify(h.sourceRegistry))
  const result = await move(inv, fresh.to, h.paths)
  assert.equal(result.ok, false)
  assert.notEqual(result.file, first.file)
  assert.deepEqual(await readFile(first.file), before)
  assert.equal(result.receipt.sessions.length, 0)
  assert.equal(result.added ?? 0, 0)
  assert.equal(result.targetChanged ?? false, false)
  assert.match(result.receipt.failed.map(row => row.error).join(' '), /changed since inventory/)
})

test('task state conflicts preserve pre-existing destination entries before and after planning', async () => {
  for (const key of ['recordedSkips', 'runRetries']) for (const late of [false, true]) {
    const h = await taskFamilyFixture(), { from, to } = await h.selection()
    const planned = late ? await inventory([from], to, h.paths, () => {}, { processes: [] }) : null
    const conflict = { ...h.targetRegistry, [key]: { ...h.targetRegistry[key], task_0: { conflict: true } } }
    await writeFile(h.targetFile, JSON.stringify(conflict))
    const fresh = await h.selection()
    const result = await move(planned ?? await inventory([fresh.from], fresh.to, h.paths, () => {}, { processes: [] }), fresh.to, h.paths)
    assert.equal(result.ok, false)
    assert.deepEqual(result.receipt.sessions.map(row => row.id), [h.cold])
    assert.match(result.receipt.failed.map(row => row.error).join(' '), /task state collision/)
    assert.deepEqual(JSON.parse(await readFile(h.targetFile)), conflict)
    assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceRegistry)
  }
})

test('task Undo preserves identical pre-existing selected destination state', async () => {
  const h = await taskFamilyFixture(), { from, to } = await h.selection()
  const target = { ...h.targetRegistry, recordedSkips: { ...h.targetRegistry.recordedSkips, task_0: h.sourceRegistry.recordedSkips.task_0 } }
  await writeFile(h.targetFile, JSON.stringify(target))
  const moved = await executeMove([from], to, h.paths, { processes: [] })
  assert.equal(moved.ok, true)
  assert.ok((await undo(h.paths, { processes: [] })).dest)
  assert.deepEqual(JSON.parse(await readFile(h.targetFile)), target)
  assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceRegistry)
})

test('selected source task state arriving after transfer blocks Undo and recovery', async () => {
  for (const recovery of [false, true]) for (const key of ['recordedSkips', 'runRetries']) {
    const h = await taskFamilyFixture(), { from, to } = await h.selection()
    if (recovery) await interruptTaskFamily(h, 'move', 'target')
    else await executeMove([from], to, h.paths, { processes: [] })
    const before = await readFile(h.sourceFile), target = await readFile(h.targetFile)
    const edited = JSON.parse(before)
    edited[key].task_0 = key === 'recordedSkips' ? [{ at: '2026-09-09T00:00:00Z', reason: 'missed' }] : { slot: '2026-09-09T00:00:00Z', attempts: 1, notBefore: '2026-09-09T00:05:00Z' }
    await writeFile(h.sourceFile, JSON.stringify(edited))
    const refused = await (recovery ? finishWorkflow : undo)(h.paths, { processes: [] })
    assert.match((refused.reconciled?.problems ?? refused.restoreProblems ?? refused.changed).join(' '), /scheduled task state changed/)
    assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), edited)
    assert.deepEqual(await readFile(h.targetFile), target)
    await writeFile(h.sourceFile, before)
    const fixed = await (recovery ? finishWorkflow : undo)(h.paths, { processes: [] })
    assert.ok(recovery ? fixed.recoveryRequired : fixed.dest)
    assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceRegistry)
  }
})

test('unsafe task families leave ordinary records movable', async () => {
  for (const reason of ['missing record', 'missing history', 'task collision', 'source collision', 'record collision', 'omitted member']) {
    const h = await taskFamilyFixture(), { from, to } = await h.selection()
    if (reason === 'missing record') await unlink(path.join(h.dir('P'), `local_${SOURCE}.json`))
    if (reason === 'missing history') await unlink(path.join(h.project, `${h.run}.jsonl`))
    if (reason === 'task collision') await writeFile(h.targetFile, JSON.stringify({ ...h.targetRegistry, scheduledTasks: [...h.targetRegistry.scheduledTasks, h.tasks[0]] }))
    if (reason === 'source collision') {
      await h.record('Q', h.run, rehomeRecord({ scheduledTaskId: h.tasks[0].id }))
      await writeFile(path.join(h.dir('Q'), 'scheduled-tasks.json'), JSON.stringify({ scheduledTasks: [h.tasks[0]] }))
    }
    if (reason === 'record collision') await h.record('T', h.run, rehomeRecord({ scheduledTaskId: h.tasks[0].id }))
    const fresh = await h.selection()
    if (reason === 'omitted member') fresh.from.sessions = fresh.from.sessions.filter(row => row.id !== h.run)
    const sources = [fresh.from]
    if (reason === 'source collision') sources.push((await accounts(h.paths)).find(row => row.account === h.acct.Q))
    const inv = await inventory(sources, fresh.to, h.paths, () => {}, { processes: [] })
    assert.deepEqual(inv.move.map(row => row.id), [h.cold], reason)
    const moved = await move(inv, fresh.to, h.paths)
    assert.equal(moved.receipt.sessions.length, 1, reason)
    assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceRegistry)
  }
})

test('task schedulers require an explicit restart for active or unknown namespaces', async () => {
  for (const identity of ['active', 'unknown', 'inactive']) {
    const h = await taskFamilyFixture(), f = await identityFixture(h)
    if (identity === 'unknown') await f.write(f.event(1, '[LocalSessionManager] Org changed'))
    if (identity === 'inactive') {
      await writeFile(h.paths.desktop, JSON.stringify({ lastKnownAccountUuid: h.acct.Z }))
      await f.write(f.init(1, h.acct.Z, h.org.Z))
    }
    const { from, to } = await h.selection()
    const result = await executeMove([from], to, h.paths, { processes: f.processes })
    if (identity === 'inactive') assert.equal(result.receipt.sessions.length, 4)
    else {
      assert.ok(result.plan)
      assert.equal(new Set(result.plan.held.flatMap(row => row.sources.map(source => source.id))).size, 3)
      assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceRegistry)
      const partial = await executeMove([from], to, h.paths, { processes: f.processes, moveOnly: true })
      assert.equal(partial.receipt.sessions.length, 1)
      assert.equal(partial.complete, false)
      const background = await sweep(h.paths, { processes: f.processes })
      assert.equal(background.result.pendingLocal, true)
      const completed = await finishHeld(h.paths, { processes: [] })
      assert.equal(completed.receipt.sessions.length, 4)
      assert.equal(completed.complete, true)
    }
  }
})

test('a Desktop worker holds the entire task family in the exact source namespace', async () => {
  for (const sameLogin of [false, true]) {
    const h = await taskFamilyFixture(false, 1), f = await identityFixture(h), other = id(704)
    if (sameLogin) { h.acct.Q = h.acct.P; await mkdir(h.dir('Q'), { recursive: true }) }
    await writeFile(h.paths.desktop, JSON.stringify({ lastKnownAccountUuid: h.acct.Z }))
    await f.write(f.init(1, h.acct.Z, h.org.Z))
    await h.write(other, branchEntries(1, other, 400))
    await h.record('Q', other, rehomeRecord({ notifySessionId: `local_${SOURCE}` }))
    const all = await accounts(h.paths, f.processes)
    const from = all.filter(row => [h.org.P, h.org.Q].includes(row.org)), to = all.find(row => row.account === h.acct.T)
    const rows = [{ ...f.processes[0], desktopPid: 500 }, desktopFixture()[1]]
    const inv = await inventory(from, to, h.paths, () => {}, { processes: rows })
    assert.ok(inv.sources.filter(row => row.account.org === h.org.P).every(row => !row.schedulerBusy))
    const plan = await restartPlan(inv, h.paths, rows)
    assert.deepEqual(new Set(plan.held.flatMap(row => row.sources.map(source => source.id))), new Set([SOURCE, h.run]))
    assert.ok(plan.held.every(row => row.sources.every(source => source.account === h.acct.P && source.org === h.org.P)))
    const partial = await executeMove(from, to, h.paths, { processes: rows, moveOnly: true })
    assert.deepEqual(partial.receipt.sessions.map(row => row.id), [h.cold])
    assert.equal(partial.receipt.failed.length, 1)
    assert.equal(partial.receipt.failed[0].id, other)
    assert.ok(!partial.receipt.failed.some(row => [SOURCE, h.run].includes(row.id)))
    assert.equal(new Set(partial.receipt.failed.map(row => JSON.stringify(row))).size, partial.receipt.failed.length)
    const finished = await finishHeld(h.paths, { processes: f.processes })
    assert.equal(finished.ok, true)
    assert.equal(finished.complete, true)
    assert.equal(finished.receipt.sessions.length, 3)
    assert.equal(finished.added, 2)
    assert.equal(finished.targetChanged, true)
    assert.equal(finished.file, partial.file)
    assert.equal(finished.notMoved.length, 1)
    assert.deepEqual(finished.failed, [])
    assert.deepEqual(JSON.parse(await readFile(h.targetFile)), h.targetAfter)
    assert.ok(await readFile(path.join(h.dir('Q'), `local_${other}.json`)))
  }
})

test('resumed mixed ordinary and task work counts every newly placed record', async () => {
  const h = await taskFamilyFixture(), { from, to } = await h.selection(), firstId = id(705)
  await h.write(firstId, branchEntries(1, firstId, 405))
  await h.record('P', firstId, rehomeRecord())
  const fresh = await h.selection()
  const rows = [...desktopFixture(h.cold), { ...desktopFixture(SOURCE)[1], pid: 502, started: 'family worker' }]
  const first = await executeMove([fresh.from], to, h.paths, { processes: rows, moveOnly: true })
  assert.deepEqual(first.receipt.sessions.map(row => row.id), [firstId])
  const finished = await finishHeld(h.paths, { processes: [] })
  assert.equal(finished.file, first.file)
  assert.equal(finished.ok, true)
  assert.equal(finished.added, 4)
  assert.equal(finished.receipt.sessions.length, 5)
  assert.equal(finished.targetChanged, true)
  assert.equal(finished.complete, true)
})

async function interruptTaskFamily(h, operation, stage) {
  const hook = stage === 'record' ? 'link' : 'rename'
  const destination = stage === 'record' ? path.join(h.dir('T'), `local_${h.notificationId ?? SOURCE}.json`) : stage === 'source' ? h.sourceFile : h.targetFile
  const script = `
    import childProcess from 'node:child_process'
    import fs from 'node:fs/promises'
    import { syncBuiltinESMExports } from 'node:module'
    import { accounts, executeMove, layout, undo } from './transplant.js'
    childProcess.spawnSync = (${fixtureCommand.toString()})(childProcess.spawnSync)
    childProcess.spawn = (${fixtureCommand.toString()})(childProcess.spawn)
    const original = fs.${hook}
    let mutations = 0
    fs.${hook} = async (...args) => {
      const result = await original(...args)
      if (args[1] === ${JSON.stringify(destination)} && ++mutations === ${JSON.stringify(h.interruptAfter ?? 1)}) process.exit(23)
      return result
    }
    syncBuiltinESMExports()
    const paths = layout(${JSON.stringify(h.root)})
    const all = await accounts(paths, [])
    if (${JSON.stringify(operation)} === 'undo') await undo(paths, { processes: [] })
    else await executeMove(${JSON.stringify(h.sourceAccounts ?? [h.acct.P])}.map(account => all.find(row => row.account === account)), all.find(row => row.account === ${JSON.stringify(h.acct.T)}), paths, { processes: [] })
  `
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { cwd: here, env: { ...process.env, HOME: h.root } })
    .then(() => ({ code: 0 }), error => error)
  assert.equal(result.code, 23, result.stderr)
}

test('task registry and record interruptions recover in the existing receipt', async () => {
  for (const stage of ['source', 'record', 'target']) {
    const h = await taskFamilyFixture(true)
    await interruptTaskFamily(h, 'move', stage)
    const result = await finishWorkflow(h.paths, { processes: [] })
    assert.equal(result.recoveryRequired, true)
    const files = (await readdir(h.paths.state)).filter(name => /^\d.*\.json$/.test(name))
    assert.equal(files.length, 1)
    const receipt = JSON.parse(await readFile(path.join(h.paths.state, files[0])))
    assert.equal(receipt.finalizing, false)
    assert.deepEqual(receipt.sessions.map(row => row.id), [h.cold])
    assert.deepEqual(receipt.taskTransfers, [])
    assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceRegistry)
    assert.deepEqual(JSON.parse(await readFile(h.targetFile)), h.targetRegistry)
    for (const sid of [SOURCE, h.run, h.second]) {
      assert.ok(await readFile(path.join(h.dir('P'), `local_${sid}.json`)))
      assert.equal(await stat(path.join(h.dir('T'), `local_${sid}.json`)).catch(() => null), null)
    }
    assert.ok((await undo(h.paths, { processes: [] })).dest)
  }
})

test('CLI accounts exposes task recovery through Finish without selecting historical refusals', async () => {
  const h = await taskFamilyFixture(true, 1)
  await interruptTaskFamily(h, 'move', 'target')
  const name = (await readdir(h.paths.state)).find(name => /^\d.*\.json$/.test(name)), file = path.join(h.paths.state, name)
  const receipt = JSON.parse(await readFile(file))
  assert.equal(receipt.finalizing, true)
  assert.deepEqual(receipt.held, [])
  assert.equal(receipt.taskTransfers.length, 1)
  receipt.fromAccounts.push({ account: h.acct.Q, org: h.org.Q, label: 'Unrelated source' })
  receipt.failed.push({ id: id(799), title: 'Historical refusal', error: 'scheduled task family member missing' })
  await writeFile(file, JSON.stringify(receipt))
  const before = await readFile(file)
  const listed = await cli(h.root, ['accounts', '--json'])
  assert.equal(listed.code, 0)
  const pending = lines(listed.stdout)[0].filter(row => row.pending)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].account, h.acct.P)
  assert.equal(pending[0].org, h.org.P)
  assert.equal(pending[0].pending, 'recovery')
  assert.equal(pending[0].pendingAction, 'finish')
  assert.equal(pending[0].receipt, file)
  assert.deepEqual(pending[0].pendingFailures, [])
  assert.deepEqual(await readFile(file), before)
  let rows = [desktopFixture()[0]]
  const calls = [], io = { inspect: () => rows, command: async name => {
    calls.push(name)
    rows = name.endsWith('osascript') ? [] : [{ ...desktopFixture()[0], pid: 700, desktopPid: 700, started: 'reopened' }]
    return { status: 0 }
  } }
  const plan = await finishWorkflow(h.paths, { io })
  assert.ok(plan.plan)
  assert.equal(plan.plan.kind, 'recover')
  assert.equal(plan.plan.receiptFile, file)
  assert.deepEqual(calls, [])
  const recovered = await finishWorkflow(h.paths, { io, approve: plan.plan.token })
  assert.equal(recovered.restarted, true)
  assert.equal(recovered.recoveryRequired, true)
  assert.deepEqual(calls, ['/usr/bin/osascript', '/usr/bin/open'])
  assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceRegistry)
  assert.deepEqual(JSON.parse(await readFile(h.targetFile)), h.targetRegistry)
  const again = lines((await cli(h.root, ['accounts', '--json'])).stdout)[0].filter(row => row.pending)
  assert.deepEqual(again.map(row => [row.account, row.pending, row.pendingAction]), [[h.acct.P, 'local', 'finish']])
  const finished = await finishWorkflow(h.paths, { processes: [] })
  assert.equal(finished.file, file)
  assert.equal(finished.ok, true)
  assert.equal(finished.complete, true)
  assert.equal(finished.receipt.sessions.length, 3)
  assert.ok(finished.notMoved.some(row => row.title === 'Historical refusal'))
  assert.ok(lines((await cli(h.root, ['accounts', '--json'])).stdout)[0].every(row => row.pending === null))
})

test('interrupted task Undo restores registrations and records together', async () => {
  for (const stage of ['target', 'source']) {
    const h = await taskFamilyFixture(true), { from, to } = await h.selection()
    await executeMove([from], to, h.paths, { processes: [] })
    await interruptTaskFamily(h, 'undo', stage)
    const pending = lines((await cli(h.root, ['accounts', '--json'])).stdout)[0].filter(row => row.pending)
    assert.deepEqual(pending.map(row => [row.pending, row.pendingAction]), [['undo', 'finish']])
    const result = await finishWorkflow(h.paths, { processes: [] })
    assert.ok(result.dest)
    assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceRegistry)
    assert.deepEqual(JSON.parse(await readFile(h.targetFile)), h.targetRegistry)
  }
})

test('task edits and dependencies block Undo and interrupted recovery without overwriting registries', async () => {
  for (const recovery of [false, true]) for (const change of ['task', 'dependency', 'skip', 'retry', 'skip removed', 'retry removed', 'retry added']) {
    const h = await taskFamilyFixture(), { from, to } = await h.selection()
    if (recovery) await interruptTaskFamily(h, 'move', 'target')
    else await executeMove([from], to, h.paths, { processes: [] })
    const before = JSON.parse(await readFile(h.targetFile)), changed = structuredClone(before)
    if (change === 'task') changed.scheduledTasks.find(task => task.id === h.tasks[0].id).enabled = true
    else if (change === 'dependency') changed.scheduledTasks.push({ id: 'new_task', notifySessionId: `local_${SOURCE}`, enabled: false })
    else if (change === 'skip') changed.recordedSkips.task_0[0].reason = 'edited'
    else if (change === 'retry') changed.runRetries.task_0.attempts++
    else if (change === 'skip removed') delete changed.recordedSkips.task_0
    else if (change === 'retry removed') delete changed.runRetries.task_0
    else changed.runRetries.task_1 = { slot: '2026-09-05T00:00:00Z', attempts: 1, notBefore: '2026-09-05T00:00:00Z' }
    await writeFile(h.targetFile, JSON.stringify(changed))
    const result = await (recovery ? finishWorkflow : undo)(h.paths, { processes: [] })
    assert.match((result.reconciled?.problems ?? result.restoreProblems ?? result.changed).join(' '), /scheduled task/)
    assert.deepEqual(JSON.parse(await readFile(h.targetFile)), changed)
    assert.ok(await readFile(path.join(h.dir('T'), `local_${SOURCE}.json`)))
    await writeFile(h.targetFile, JSON.stringify(before))
    const retried = await (recovery ? finishWorkflow : undo)(h.paths, { processes: [] })
    assert.ok(recovery ? retried.recoveryRequired : retried.dest)
    assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceRegistry)
  }
})

test('task transfer uses final registration state and preserves later unrelated registry edits', async () => {
  const h = await taskFamilyFixture(), { from, to } = await h.selection()
  const inv = await inventory([from], to, h.paths, () => {}, { processes: [] })
  h.sourceRegistry.scheduledTasks[0].lastRunAt = '2026-09-02T00:00:00Z'
  h.sourceRegistry.scheduledTasks[0].enabled = true
  h.sourceRegistry.recordedSkips.task_0[0].reason = 'missed before transfer'
  h.sourceRegistry.runRetries.task_0.attempts = 4
  await writeFile(h.sourceFile, JSON.stringify(h.sourceRegistry))
  let changed = false
  const result = await move(inv, to, h.paths, (stage, text, extra) => {
    if (stage !== 'move' || extra?.completed !== 1 || changed) return
    const source = JSON.parse(readFileSync(h.sourceFile))
    if (source.scheduledTasks.length) return
    changed = true
    for (const file of [h.sourceFile, h.targetFile]) writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file)), futureDuringMove: { intact: true } }))
  })
  assert.equal(result.ok, true)
  assert.equal(changed, true)
  assert.equal(JSON.parse(await readFile(h.targetFile)).scheduledTasks.find(task => task.id === h.tasks[0].id).enabled, true)
  assert.deepEqual(JSON.parse(await readFile(h.targetFile)).recordedSkips.task_0, h.sourceRegistry.recordedSkips.task_0)
  assert.deepEqual(JSON.parse(await readFile(h.targetFile)).runRetries.task_0, h.sourceRegistry.runRetries.task_0)
  for (const file of [h.sourceFile, h.targetFile]) await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file)), futureDuringUndo: [1, 2] }))
  assert.ok((await undo(h.paths, { processes: [] })).dest)
  assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), { ...h.sourceRegistry, futureDuringMove: { intact: true }, futureDuringUndo: [1, 2] })
  assert.deepEqual(JSON.parse(await readFile(h.targetFile)), { ...h.targetRegistry, futureDuringMove: { intact: true }, futureDuringUndo: [1, 2] })
})

test('task families include parent and fork closure without merging matching history', async () => {
  const h = await taskFamilyFixture(), parent = id(704), child = id(705)
  await h.write(parent, [entry('user', 90, null, parent)])
  await h.record('P', parent, rehomeRecord())
  await h.record('P', SOURCE, rehomeRecord({ forkedFromSessionId: `local_${parent}` }))
  await h.write(child, [entry('user', 91, null, child)])
  await h.record('P', child, rehomeRecord({ forkedFromSessionId: `local_${SOURCE}`, isArchived: true }))
  await h.record('Q', SOURCE, rehomeRecord())
  const { from, to } = await h.selection()
  const inv = await inventory([from], to, h.paths, () => {}, { processes: [] })
  assert.equal(inv.move.filter(row => row.taskFamily).length, 5)
  const result = await move(inv, to, h.paths)
  assert.equal(result.ok, true)
  assert.equal(result.receipt.sessions.length, 6)
  assert.ok(await readFile(path.join(h.dir('Q'), `local_${SOURCE}.json`)))
  assert.ok((await undo(h.paths, { processes: [] })).dest)
})

test('task moves, Undo and recovery use the approved restart and preserve final scheduler state', async () => {
  for (const operation of ['move', 'undo', 'recovery']) {
    const h = await taskFamilyFixture(), { from, to } = await h.selection()
    if (operation === 'undo') await executeMove([from], to, h.paths, { processes: [] })
    if (operation === 'recovery') await interruptTaskFamily(h, 'move', 'target')
    let rows = [desktopFixture()[0]], time = 0
    const calls = []
    const io = { inspect: () => rows, now: () => time, command: async file => {
      calls.push(file)
      time += 100
      if (file.endsWith('osascript')) {
        if (operation === 'move') {
          h.sourceRegistry.scheduledTasks[0].lastScheduledFor = '2026-09-03T00:00:00Z'
          h.sourceRegistry.scheduledTasks[0].enabled = true
          await writeFile(h.sourceFile, JSON.stringify(h.sourceRegistry))
        }
        rows = []
      } else rows = [{ ...desktopFixture()[0], pid: 700, desktopPid: 700, started: 'reopened' }]
      return { status: 0 }
    } }
    const run = options => operation === 'move' ? executeMove([from], to, h.paths, options) : operation === 'undo' ? undo(h.paths, options) : finishWorkflow(h.paths, options)
    const plan = await run({ io })
    assert.ok(plan.plan, operation)
    assert.deepEqual(calls, [])
    const result = await run({ io, approve: plan.plan.token })
    assert.equal(result.restarted, true, JSON.stringify({ operation, reason: result.reason, outcome: result.restartOutcome?.outcome }))
    assert.deepEqual(calls, ['/usr/bin/osascript', '/usr/bin/open'])
    assert.ok(time < 30000)
    if (operation === 'move') {
      assert.equal(result.ok, true)
      assert.deepEqual(JSON.parse(await readFile(h.targetFile)).scheduledTasks.slice(1), h.sourceRegistry.scheduledTasks)
    } else {
      assert.ok(operation === 'undo' ? result.dest : result.recoveryRequired)
      assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceRegistry)
    }
  }
})

test('task workers and changed restart inventories never authorize an external stop', async () => {
  const h = await taskFamilyFixture(), { from, to } = await h.selection()
  const table = [...desktopFixture(), { pid: 600, worker: true, ids: [h.run], desktopPid: null }]
  const result = await executeMove([from], to, h.paths, { processes: table })
  assert.equal(result.plan, undefined)
  assert.deepEqual(result.receipt.sessions.map(row => row.id), [h.cold])
  assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceRegistry)
  const calls = []
  let rows = [desktopFixture()[0]]
  const io = { inspect: () => rows, command: async file => { calls.push(file); return { status: 0 } } }
  const planned = await finishWorkflow(h.paths, { io })
  assert.ok(planned.plan)
  rows = [...rows, { ...desktopFixture(h.run)[1], pid: 701 }]
  const stale = await finishWorkflow(h.paths, { io, approve: planned.plan.token })
  assert.equal(stale.ok, false)
  assert.deepEqual(calls, [])
})

test('task restart deadline preserves held families after completed ordinary work', async () => {
  const h = await taskFamilyFixture(), { from, to } = await h.selection()
  let rows = [desktopFixture()[0]], time = 0
  const io = { inspect: () => rows, now: () => time, command: async file => {
    rows = file.endsWith('osascript') ? [] : [{ ...desktopFixture()[0], pid: 700, desktopPid: 700, started: 'reopened' }]
    return { status: 0 }
  } }
  const planned = await executeMove([from], to, h.paths, { io })
  const original = fs.rename
  fs.rename = async (...args) => {
    const result = await original(...args)
    if (path.dirname(args[1]) === h.paths.state && /^\d.*\.json$/.test(path.basename(args[1]))) {
      const receipt = JSON.parse(await readFile(args[1]))
      if (receipt.finalizing === false && receipt.sessions.length === 1) time = 23000
    }
    return result
  }
  syncBuiltinESMExports()
  let result
  try { result = await executeMove([from], to, h.paths, { io, approve: planned.plan.token }) }
  finally { fs.rename = original; syncBuiltinESMExports() }
  assert.equal(result.ok, false)
  assert.equal(result.restarted, true)
  assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceRegistry)
  const receipts = (await readdir(h.paths.state)).filter(name => /^\d.*\.json$/.test(name))
  const receipt = JSON.parse(await readFile(path.join(h.paths.state, receipts[0])))
  assert.deepEqual(receipt.sessions.map(row => row.id), [h.cold])
  assert.equal(receipt.held.flatMap(row => row.sources).length, 3)
  const finished = await finishHeld(h.paths, { processes: [] })
  assert.equal(finished.ok, true)
  assert.equal(finished.receipt.sessions.length, 4)
})

test('a failed task-family placement rolls back the family and keeps ordinary moves', async () => {
  const h = await taskFamilyFixture(true), { from, to } = await h.selection()
  const original = fs.link
  let failed = false
  fs.link = async (...args) => {
    if (!failed && args[1] === path.join(h.dir('T'), `local_${SOURCE}.json`)) { failed = true; throw new Error('fixture publication failure') }
    return original(...args)
  }
  syncBuiltinESMExports()
  let result
  try { result = await executeMove([from], to, h.paths, { processes: [] }) }
  finally { fs.link = original; syncBuiltinESMExports() }
  assert.equal(result.ok, false)
  assert.deepEqual(result.receipt.sessions.map(row => row.id), [h.cold])
  assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceRegistry)
  assert.deepEqual(JSON.parse(await readFile(h.targetFile)), h.targetRegistry)
  assert.equal((await finishHeld(h.paths, { processes: [] })).receipt.sessions.length, 4)
})

test('registry changes during a task move remain recoverable without lost edits', async () => {
  const h = await taskFamilyFixture(), { from, to } = await h.selection()
  let edited = false
  const result = await executeMove([from], to, h.paths, { processes: [], report: (stage, text, extra) => {
    if (stage !== 'move' || extra?.completed !== 1 || edited) return
    const source = JSON.parse(readFileSync(h.sourceFile))
    if (source.scheduledTasks.length) return
    edited = true
    source.scheduledTasks = [{ ...h.tasks[0], enabled: true }]
    source.unrelatedEdit = 9
    writeFileSync(h.sourceFile, JSON.stringify(source))
  } })
  assert.equal(edited, true)
  assert.equal(result.recoveryRequired, true)
  const changed = JSON.parse(await readFile(h.sourceFile))
  assert.equal(changed.scheduledTasks[0].enabled, true)
  assert.equal(changed.unrelatedEdit, 9)
  changed.scheduledTasks = []
  await writeFile(h.sourceFile, JSON.stringify(changed))
  await finishWorkflow(h.paths, { processes: [] })
  assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), { ...h.sourceRegistry, unrelatedEdit: 9 })
  assert.ok(await readFile(path.join(h.dir('T'), `local_${h.cold}.json`)))
})

test('task transaction boundaries retain late dependencies, worker and record edits for recovery', async () => {
  for (const phase of ['placement', 'retirement', 'publication']) for (const change of ['registration', 'route', 'external worker', 'source edit', 'target edit', 'account switch']) {
    const h = await taskFamilyFixture(false, 1), f = await identityFixture(h)
    await writeFile(h.paths.desktop, JSON.stringify({ lastKnownAccountUuid: h.acct.Z }))
    await f.write(f.init(1, h.acct.Z, h.org.Z))
    const { from, to } = await h.selection()
    let rows = f.processes, injected = false, editedFile, editedBefore, editedAfter
    const hook = phase === 'placement' ? 'link' : phase === 'retirement' ? 'rename' : 'writeFile', original = fs[hook]
    const write = fs.writeFile
    const source = path.join(h.dir('P'), `local_${h.run}.json`), target = path.join(h.dir('T'), `local_${SOURCE}.json`)
    fs[hook] = async (...args) => {
      const result = await original(...args)
      const matches = phase === 'placement' ? args[1] === target : phase === 'retirement' ? args[0] === path.join(h.dir('P'), `local_${SOURCE}.json`) : String(args[0]).startsWith(h.targetFile + '.')
      if (!matches || injected) return result
      injected = true
      if (change === 'external worker') rows = [...rows, { pid: 600, worker: true, ids: [h.run], desktopPid: null }]
      else if (change === 'account switch') {
        editedFile = path.join(h.paths.logs, 'main.log')
        editedBefore = await readFile(editedFile)
        editedAfter = f.event(2, '[LocalSessionManager] Org changed')
      } else {
        editedFile = change === 'registration' ? h.sourceFile : change === 'source edit' ? phase === 'publication' ? path.join(h.dir('P'), `local_${id(797)}.json`) : source : target
        editedBefore = await readFile(editedFile).catch(error => { if (error.code === 'ENOENT') return null; throw error })
        const value = editedBefore ? JSON.parse(editedBefore) : { sessionId: `local_${id(797)}`, cliSessionId: id(797), scheduledTaskId: h.tasks[0].id }
        if (change === 'registration') value.scheduledTasks.push({ id: 'new_dependency', notifySessionId: `local_${SOURCE}`, enabled: false })
        else if (change === 'route') value.notifySessionId = `local_${id(797)}`
        else value.title = 'Edited during transfer'
        editedAfter = JSON.stringify(value)
      }
      if (editedFile) await write(editedFile, editedAfter)
      return result
    }
    syncBuiltinESMExports()
    let result
    try { result = await executeMove([from], to, h.paths, { io: { inspect: () => rows }, processes: f.processes }) }
    finally { fs[hook] = original; syncBuiltinESMExports() }
    assert.equal(injected, true, `${phase}: ${change}`)
    assert.equal(result.ok, false, `${phase}: ${change}`)
    if (editedFile) assert.equal(await readFile(editedFile, 'utf8'), editedAfter, `${phase}: ${change}`)
    assert.deepEqual(JSON.parse(await readFile(h.targetFile)), h.targetRegistry, `${phase}: ${change}`)
    if (editedFile) {
      if (editedBefore) await writeFile(editedFile, editedBefore)
      else await unlink(editedFile)
    }
    rows = []
    if (result.recoveryRequired) await finishWorkflow(h.paths, { processes: [] })
    assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceRegistry, `${phase}: ${change}`)
    const finished = await finishHeld(h.paths, { processes: [] })
    assert.equal(finished.ok, true, `${phase}: ${change}`)
    assert.equal(finished.receipt.sessions.length, 3, `${phase}: ${change}`)
    assert.ok((await undo(h.paths, { processes: [] })).dest)
    assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceRegistry)
  }
})

test('Keep local validates target identity and recovery even when only held work remains', async () => {
  for (const change of ['sessionId', 'cliSessionId', 'cwd', 'missing transcript', 'missing record']) {
    const h = await home()
    await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
    await h.record('P', SOURCE, rehomeRecord())
    await h.write(id(710), [entry('user', 2, null, id(710))])
    await h.record('P', id(710), rehomeRecord())
    const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
    const moved = await executeMove([from], to, h.paths, { processes: desktopFixture(id(710)), moveOnly: true })
    const row = moved.receipt.sessions[0]
    if (change === 'missing transcript') await unlink(row.targetTranscript)
    else if (change === 'missing record') await unlink(row.record)
    else await writeFile(row.record, JSON.stringify({ ...JSON.parse(await readFile(row.record)), [change]: change === 'sessionId' ? `local_${id(711)}` : change === 'cliSessionId' ? id(711) : '/tmp/changed' }))
    const kept = await keepLocal(h.paths)
    assert.ok(kept.refused.length, change)
    assert.equal(kept.receipt.held.length, 1)
  }
})

test('Finish of held local work treats an earlier refusal as information', async () => {
  const h = await home(), cold = id(712)
  for (const [index, sid] of [SOURCE, cold].entries()) {
    await h.write(sid, [entry('user', index + 1, null, sid)])
    await h.record('P', sid, rehomeRecord())
  }
  const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
  const first = await executeMove([from], to, h.paths, { processes: desktopFixture(), moveOnly: true })
  first.receipt.failed.push({ id: id(713), title: 'Earlier refusal', error: 'scheduled task family member missing' })
  await writeFile(first.file, JSON.stringify(first.receipt))
  const finished = await finishWorkflow(h.paths, { processes: [] })
  assert.equal(finished.ok, true)
  assert.equal(finished.complete, true)
  assert.deepEqual(finished.failed, [])
  assert.equal(finished.notMoved.length, 1)
})

test('task scheduler safety uses the exact organization and rechecks account switches', async () => {
  for (const switching of [false, true]) {
    const h = await taskFamilyFixture(), f = await identityFixture(h)
    await f.write(f.init(1, h.acct.P, h.org.Q))
    const { from, to } = await h.selection()
    let switched = false
    const result = await executeMove([from], to, h.paths, { processes: f.processes, report: (stage, text, extra) => {
      if (!switching || switched || stage !== 'move' || extra?.completed !== 1 || JSON.parse(readFileSync(h.sourceFile)).scheduledTasks.length) return
      switched = true
      writeFileSync(path.join(h.paths.logs, 'main.log'), f.event(2, '[LocalSessionManager] Org changed'))
    } })
    if (!switching) assert.equal(result.receipt.sessions.length, 4)
    else {
      assert.equal(switched, true)
      assert.equal(result.recoveryRequired, true)
      assert.deepEqual(JSON.parse(await readFile(h.targetFile)), h.targetRegistry)
      const swept = await sweep(h.paths, { processes: f.processes })
      assert.equal(swept.ok, false)
      assert.match(swept.error, /scheduler requires/)
      await finishWorkflow(h.paths, { processes: [] })
      assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceRegistry)
    }
  }
})

test('task Undo preserves absent registries and registries without a task array', async () => {
  for (const registry of [null, { future: { intact: true } }]) {
    const h = await taskFamilyFixture()
    if (registry) await writeFile(h.targetFile, JSON.stringify(registry))
    else await unlink(h.targetFile)
    const { from, to } = await h.selection()
    const result = await executeMove([from], to, h.paths, { processes: [] })
    assert.equal(result.ok, true)
    assert.ok((await undo(h.paths, { processes: [] })).dest)
    assert.deepEqual(await readFile(h.targetFile).then(JSON.parse, () => null), registry)
  }
})

test('task notification identities may differ from CLI ids and remain protected during recovery', async () => {
  const h = await taskFamilyFixture()
  h.notificationId = id(714)
  await h.record('P', SOURCE, rehomeRecord({ sessionId: `local_${h.notificationId}` }))
  await rename(path.join(h.dir('P'), `local_${SOURCE}.json`), path.join(h.dir('P'), `local_${h.notificationId}.json`))
  for (const task of h.tasks) task.notifySessionId = `local_${h.notificationId}`
  for (const [index, sid] of [h.run, h.second].entries()) await h.record('P', sid, rehomeRecord({ scheduledTaskId: h.tasks[index].id, notifySessionId: `local_${h.notificationId}` }))
  await writeFile(h.sourceFile, JSON.stringify(h.sourceRegistry))
  await interruptTaskFamily(h, 'move', 'record')
  const file = path.join(h.dir('T'), `local_${h.notificationId}.json`), before = await readFile(file)
  await writeFile(file, JSON.stringify({ ...JSON.parse(before), title: 'Changed after interruption' }))
  const refused = await finishWorkflow(h.paths, { processes: [] })
  assert.equal(refused.recoveryRequired, true)
  assert.match(refused.reconciled.error, /task.*record changed/)
  await writeFile(file, before)
  await finishWorkflow(h.paths, { processes: [] })
  const finished = await finishHeld(h.paths, { processes: [] })
  assert.equal(finished.ok, true)
  assert.equal(JSON.parse(await readFile(file)).sessionId, `local_${h.notificationId}`)
  assert.ok((await undo(h.paths, { processes: [] })).dest)
  assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceRegistry)
})

test('task registry edits during publication and Undo retain their values and recovery', async () => {
  for (const phase of ['publication', 'undo']) {
    const h = await taskFamilyFixture(), { from, to } = await h.selection()
    if (phase === 'undo') await executeMove([from], to, h.paths, { processes: [] })
    const hook = phase === 'publication' ? 'writeFile' : 'rename', original = fs[hook]
    let injected = false
    fs[hook] = async (...args) => {
      const result = await original(...args)
      const matches = phase === 'publication' ? String(args[0]).startsWith(h.targetFile + '.') : args[0] === path.join(h.dir('T'), `local_${SOURCE}.json`)
      if (matches && !injected) {
        injected = true
        const registry = JSON.parse(await readFile(h.targetFile))
        registry.duringWrite = { preserved: true }
        if (phase === 'undo') registry.scheduledTasks.push({ ...h.tasks[0], enabled: true })
        await originalWrite(h.targetFile, JSON.stringify(registry))
      }
      return result
    }
    const originalWrite = phase === 'publication' ? original : fs.writeFile
    syncBuiltinESMExports()
    let result
    try { result = phase === 'publication' ? await executeMove([from], to, h.paths, { processes: [] }) : await undo(h.paths, { processes: [] }) }
    finally { fs[hook] = original; syncBuiltinESMExports() }
    assert.equal(injected, true)
    assert.deepEqual(JSON.parse(await readFile(h.targetFile)).duringWrite, { preserved: true })
    if (phase === 'publication') {
      assert.equal(result.ok, false)
      assert.deepEqual(result.receipt.sessions.map(row => row.id), [h.cold])
      assert.equal((await finishHeld(h.paths, { processes: [] })).ok, true)
      assert.ok((await undo(h.paths, { processes: [] })).dest)
    } else {
      assert.match(result.restoreProblems.join(' '), /scheduled task/)
      const registry = JSON.parse(await readFile(h.targetFile))
      assert.equal(registry.scheduledTasks.find(task => task.id === h.tasks[0].id).enabled, true)
      registry.scheduledTasks = registry.scheduledTasks.filter(task => !h.tasks.some(owned => owned.id === task.id))
      await writeFile(h.targetFile, JSON.stringify(registry))
      assert.ok((await finishWorkflow(h.paths, { processes: [] })).dest)
    }
    assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceRegistry)
    assert.deepEqual(JSON.parse(await readFile(h.targetFile)), { ...h.targetRegistry, duringWrite: { preserved: true } })
  }
})

test('a late destination alias cannot take a task family through an id collision', async () => {
  const h = await taskFamilyFixture(), { from, to } = await h.selection(), alias = id(715)
  const inv = await inventory([from], to, h.paths, () => {}, { processes: [] })
  await h.record('T', SOURCE, rehomeRecord({ sessionId: `local_${alias}` }))
  await rename(path.join(h.dir('T'), `local_${SOURCE}.json`), path.join(h.dir('T'), `local_${alias}.json`))
  const result = await move(inv, to, h.paths)
  assert.equal(result.ok, false)
  assert.deepEqual(result.receipt.sessions.map(row => row.id), [h.cold])
  assert.deepEqual(JSON.parse(await readFile(h.sourceFile)), h.sourceRegistry)
  assert.match(result.receipt.failed.at(-1).error, /session id collision/)
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

test('compatible Desktop parent and archived fork move separately and undo without changing history', async () => {
  for (const richer of ['parent', 'fork']) {
    const h = await home(), child = id(777)
    const targetDir = path.join(h.paths.records, h.acct.P, h.org.T)
    await mkdir(targetDir, { recursive: true })
    const base = [entry('user', 1, null, SOURCE), entry('assistant', 2, 1, SOURCE)]
    const branch = fork(base, SOURCE, child, 'Archived fork')
    await h.write(SOURCE, richer === 'parent' ? [...base, entry('user', 3, 2, SOURCE)] : base)
    await h.write(child, richer === 'fork' ? [...branch, entry('user', 4, null, child)] : branch)
    await h.record('P', SOURCE, rehomeRecord({ title: 'Parent', isArchived: false, isStarred: true }))
    await h.record('P', child, rehomeRecord({ title: 'Archived fork', isArchived: true, forkedFromSessionId: `local_${SOURCE}` }))
    const files = []
    for (const sid of [SOURCE, child]) {
      await mkdir(path.join(h.project, sid), { recursive: true })
      const sidecar = path.join(h.project, sid, `${sid}.txt`)
      await writeFile(sidecar, `supporting data for ${sid}`)
      for (const file of [path.join(h.project, `${sid}.jsonl`), sidecar]) files.push({ file, bytes: await readFile(file), inode: (await stat(file)).ino })
    }
    const originalRecords = await Promise.all([SOURCE, child].map(sid => readFile(path.join(h.dir('P'), `local_${sid}.json`))))
    const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P && row.org === h.org.P), to = all.find(row => row.account === h.acct.P && row.org === h.org.T)
    const inv = await inventory([from], to, h.paths)
    assert.deepEqual(inv.blocked.map(row => row.error), [])
    assert.deepEqual(inv.move.map(row => row.id), [SOURCE, child])
    const moved = await move(inv, to, h.paths)
    assert.equal(moved.ok, true)
    assert.equal(moved.receipt.sessions.length, 2)
    assert.equal(moved.receipt.sessions.every(row => row.strategy === 'rehome'), true)
    assert.deepEqual(await readdir(h.dir('P')), [])
    const parent = JSON.parse(await readFile(path.join(targetDir, `local_${SOURCE}.json`)))
    const archived = JSON.parse(await readFile(path.join(targetDir, `local_${child}.json`)))
    assert.equal(parent.title, 'Parent')
    assert.equal(parent.isStarred, true)
    assert.equal(parent.isArchived, false)
    assert.equal(archived.title, 'Archived fork')
    assert.equal(archived.isArchived, true)
    assert.equal(archived.forkedFromSessionId, parent.sessionId)
    for (const file of files) {
      assert.deepEqual(await readFile(file.file), file.bytes)
      assert.equal((await stat(file.file)).ino, file.inode)
    }
    const restored = await undo(h.paths)
    assert.ok(restored.dest)
    assert.deepEqual(await readdir(targetDir), [])
    for (const [index, sid] of [SOURCE, child].entries()) assert.deepEqual(await readFile(path.join(h.dir('P'), `local_${sid}.json`)), originalRecords[index])
  }
})

test('a Desktop fork is preserved when its parent already covers its history in the destination', async () => {
  const h = await home(), child = id(777)
  const base = [entry('user', 1, null, SOURCE), entry('assistant', 2, 1, SOURCE)]
  await h.write(SOURCE, base)
  await h.write(child, fork(base, SOURCE, child, 'Archived fork'))
  await h.record('T', SOURCE, rehomeRecord({ title: 'Parent' }))
  await h.record('P', child, rehomeRecord({ title: 'Archived fork', isArchived: true, forkedFromSessionId: `local_${SOURCE}` }))
  const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
  const inv = await inventory([from], to, h.paths)
  assert.equal(inv.there.length, 0)
  assert.deepEqual(inv.move.map(row => row.id), [child])
  const moved = await move(inv, to, h.paths)
  assert.equal(moved.ok, true)
  assert.equal(moved.receipt.superseded.some(row => !row.source), false)
  assert.deepEqual(await readdir(h.dir('P')), [])
  assert.deepEqual((await readdir(h.dir('T'))).sort(), [`local_${SOURCE}.json`, `local_${child}.json`].sort())
  const archived = JSON.parse(await readFile(path.join(h.dir('T'), `local_${child}.json`)))
  assert.equal(archived.isArchived, true)
  assert.equal(archived.forkedFromSessionId, `local_${SOURCE}`)
})

test('destination parents survive richer replacements while Desktop forks still refer to them', async () => {
  for (const location of ['source', 'destination', 'without history']) for (const isArchived of [false, true]) {
    const h = await home(), richer = id(776), child = id(777)
    const base = branchEntries(2, SOURCE, 1)
    await h.write(SOURCE, base)
    await h.record('T', SOURCE, rehomeRecord({ title: 'Parent' }))
    await h.write(richer, [...fork(base, SOURCE, richer, 'Richer copy'), entry('user', 3, null, richer)])
    await h.record('P', richer, rehomeRecord({ title: 'Richer copy' }))
    if (location !== 'without history') await h.write(child, fork(base, SOURCE, child, 'Fork'))
    await h.record(location === 'source' ? 'P' : 'T', child, rehomeRecord({ title: 'Fork', isArchived, forkedFromSessionId: `local_${SOURCE}` }))
    const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
    const originals = await Promise.all([...from.sessions, ...to.sessions].map(async row => [row.file, await readFile(row.file)]))
    const inv = await inventory([from], to, h.paths)
    assert.deepEqual(inv.move.map(row => row.id), location === 'source' ? [richer, child] : [richer])
    const moved = await move(inv, to, h.paths)
    assert.equal(moved.ok, true)
    assert.equal(moved.receipt.superseded.some(row => !row.source), false)
    assert.deepEqual(await readdir(h.dir('P')), [])
    assert.deepEqual((await readdir(h.dir('T'))).sort(), [SOURCE, richer, child].map(sid => `local_${sid}.json`).sort())
    const placed = JSON.parse(await readFile(path.join(h.dir('T'), `local_${child}.json`)))
    assert.equal(placed.forkedFromSessionId, `local_${SOURCE}`)
    assert.equal(placed.isArchived, isArchived)
    assert.ok((await undo(h.paths)).dest)
    assert.deepEqual((await readdir(h.dir('T'))).sort(), to.sessions.map(row => path.basename(row.file)).sort())
    for (const [file, bytes] of originals) assert.deepEqual(await readFile(file), bytes)
  }
})

test('required Desktop parents move by exact id despite richer compatible histories', async () => {
  for (const location of ['P', 'T']) {
    const h = await home(), richer = id(776), child = id(777), base = branchEntries(2, SOURCE, 1)
    await h.write(SOURCE, base)
    await h.record('P', SOURCE, rehomeRecord())
    await h.write(richer, [...fork(base, SOURCE, richer, 'Richer'), entry('user', 3, null, richer)])
    await h.record(location, richer, rehomeRecord())
    await h.write(child, fork(base, SOURCE, child, 'Fork'))
    await h.record('P', child, rehomeRecord({ isArchived: true, forkedFromSessionId: `local_${SOURCE}` }))
    const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
    const originals = await Promise.all(from.sessions.map(async row => [row.file, await readFile(row.file)]))
    const inv = await inventory([from], to, h.paths)
    assert.deepEqual(inv.blocked, [])
    assert.deepEqual(inv.there, [])
    assert.ok(inv.move.findIndex(row => row.id === SOURCE) < inv.move.findIndex(row => row.id === child))
    const moved = await move(inv, to, h.paths)
    assert.equal(moved.ok, true)
    assert.deepEqual(moved.receipt.failed, [])
    assert.deepEqual(await readdir(h.dir('P')), [])
    const placed = JSON.parse(await readFile(path.join(h.dir('T'), `local_${child}.json`)))
    assert.equal(placed.forkedFromSessionId, `local_${SOURCE}`)
    assert.equal(placed.isArchived, true)
    assert.ok(await readFile(path.join(h.dir('T'), `local_${SOURCE}.json`)))
    assert.ok((await undo(h.paths)).dest)
    for (const [file, bytes] of originals) assert.deepEqual(await readFile(file), bytes)
    assert.deepEqual(await readdir(h.dir('T')), location === 'T' ? [`local_${richer}.json`] : [])
  }
})

test('source parents stay with forks omitted, held, unreadable, empty, or failed', async () => {
  for (const reason of ['omitted', 'worker', 'task', 'missing', 'empty', 'unreadable', 'failed']) {
    const h = await home(), richer = id(776), child = id(777), base = branchEntries(2, SOURCE, 1)
    await h.write(SOURCE, base)
    await h.record('P', SOURCE, rehomeRecord())
    await h.write(richer, [...fork(base, SOURCE, richer, 'Richer'), entry('user', 3, null, richer)])
    await h.record('T', richer, rehomeRecord())
    if (reason !== 'missing') await h.write(child, reason === 'empty' ? [] : fork(base, SOURCE, child, 'Fork'))
    if (reason === 'unreadable') await appendFile(path.join(h.project, `${child}.jsonl`), '{broken\n')
    const childRecord = rehomeRecord({ isArchived: true, forkedFromSessionId: `local_${SOURCE}`, ...(reason === 'task' ? { scheduledTaskId: 'fixture' } : {}) })
    await h.record('P', child, childRecord)
    const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
    const source = reason === 'omitted' ? { ...from, sessions: from.sessions.filter(row => row.id === SOURCE) } : from
    const inv = await inventory([source], to, h.paths, () => {}, { processes: reason === 'worker' ? desktopFixture(child) : [] })
    if (reason === 'failed') await h.record('P', child, { ...childRecord, title: 'Changed after inventory' })
    const originals = await Promise.all(from.sessions.map(async row => [row.file, await readFile(row.file)]))
    const moved = await move(inv, to, h.paths)
    if (['omitted', 'missing', 'empty'].includes(reason)) assert.equal(moved, null, reason)
    else assert.equal(moved.receipt.superseded.some(row => row.source), false, reason)
    assert.deepEqual((await readdir(h.dir('P'))).sort(), [SOURCE, child].map(sid => `local_${sid}.json`).sort())
    for (const [file, bytes] of originals) assert.deepEqual(await readFile(file), bytes)
  }
})

test('source parent retention follows ancestry within the affected account', async () => {
  for (const location of ['P', 'Q']) {
    const h = await home(), parent = id(776), child = id(777), base = branchEntries(2, SOURCE, 1)
    await h.write(SOURCE, base)
    await h.write(parent, fork(base, SOURCE, parent, 'Parent'))
    for (const account of new Set(['P', 'T', location])) {
      await h.record(account, SOURCE, rehomeRecord())
      await h.record(account, parent, rehomeRecord({ forkedFromSessionId: `local_${SOURCE}` }))
    }
    await h.record(location, child, rehomeRecord({ isArchived: true, forkedFromSessionId: `local_${parent}` }))
    const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
    const inv = await inventory([from], to, h.paths)
    assert.equal(inv.there.length, 2)
    const moved = await move(inv, to, h.paths)
    if (location === 'P') assert.equal(moved, null)
    else {
      assert.equal(moved.ok, true)
      assert.deepEqual(moved.receipt.failed, [])
      assert.equal(moved.receipt.superseded.length, 2)
    }
    assert.deepEqual((await readdir(h.dir(location))).sort(), [SOURCE, parent, child].map(sid => `local_${sid}.json`).sort())
    if (location === 'Q') {
      assert.deepEqual(await readdir(h.dir('P')), [])
      assert.ok((await undo(h.paths)).dest)
    }
  }
})

test('held forks move and retire their parents through Finish, sweep, and Undo', async () => {
  for (const present of [false, true]) for (const continuation of [finishHeld, finishWorkflow, sweep]) {
    const h = await home(), child = id(777), cold = id(778), later = id(779), base = branchEntries(2, SOURCE, 1)
    await h.write(SOURCE, base)
    await h.record('P', SOURCE, rehomeRecord())
    await h.write(child, fork(base, SOURCE, child, 'Fork'))
    await h.record('P', child, rehomeRecord({ forkedFromSessionId: `local_${SOURCE}` }))
    await h.write(cold, branchEntries(2, cold, 300))
    await h.record('P', cold, rehomeRecord())
    if (present) await h.record('T', SOURCE, rehomeRecord())
    const originalParent = present ? await readFile(path.join(h.dir('T'), `local_${SOURCE}.json`)) : null
    const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
    const originals = await Promise.all(from.sessions.map(async row => [row.file, await readFile(row.file)]))
    const moved = await executeMove([from], to, h.paths, { processes: desktopFixture(child), moveOnly: true })
    assert.equal(moved.ok, true)
    assert.equal(moved.complete, false)
    assert.deepEqual(moved.receipt.held.map(row => row.id), [child, SOURCE])
    assert.deepEqual(moved.receipt.sessions.map(row => row.id), [cold])
    assert.deepEqual(moved.receipt.failed, [])
    assert.deepEqual((await readdir(h.dir('P'))).sort(), [SOURCE, child].map(sid => `local_${sid}.json`).sort())
    assert.deepEqual((await readdir(h.dir('T'))).sort(), [cold, ...(present ? [SOURCE] : [])].map(sid => `local_${sid}.json`).sort())
    await h.write(later, branchEntries(2, later, 400))
    await h.record('P', later, rehomeRecord())
    const result = await continuation(h.paths, { processes: [] }), finished = result.result ?? result
    assert.equal(finished.file, moved.file)
    assert.equal(finished.receipt.at, moved.receipt.at)
    assert.equal(finished.ok, true)
    assert.equal(finished.complete, true)
    assert.deepEqual(finished.receipt.held, [])
    assert.deepEqual(finished.receipt.failed, [])
    assert.deepEqual(await readdir(h.dir('P')), [`local_${later}.json`])
    assert.deepEqual((await readdir(h.dir('T'))).sort(), [SOURCE, child, cold].map(sid => `local_${sid}.json`).sort())
    assert.equal((await sweep(h.paths, { processes: [] })).complete, true)
    const undone = await undo(h.paths)
    assert.ok(undone.dest)
    assert.equal(JSON.parse(await readFile(path.join(undone.dest, 'receipt.json'))).at, moved.receipt.at)
    assert.deepEqual(await readdir(h.dir('T')), present ? [`local_${SOURCE}.json`] : [])
    if (present) assert.deepEqual(await readFile(path.join(h.dir('T'), `local_${SOURCE}.json`)), originalParent)
    for (const [file, bytes] of originals) assert.deepEqual(await readFile(file), bytes)
    assert.ok(await readFile(path.join(h.dir('P'), `local_${later}.json`)))
  }
})

test('held fork families include ancestors and siblings only in the same source account and org', async () => {
  for (const sameLogin of [false, true]) {
    const h = await home(), parent = id(776), child = id(777), sibling = id(778), other = id(779), base = branchEntries(2, SOURCE, 1)
    if (sameLogin) { h.acct.Q = h.acct.P; await mkdir(h.dir('Q'), { recursive: true }) }
    const parentEntries = fork(base, SOURCE, parent, 'Parent')
    for (const [sid, entries, forkedFromSessionId] of [
      [SOURCE, base, null],
      [parent, parentEntries, `local_${SOURCE}`],
      [child, fork(parentEntries, parent, child, 'Child'), `local_${parent}`],
      [sibling, fork(parentEntries, parent, sibling, 'Sibling'), `local_${parent}`]
    ]) {
      await h.write(sid, entries)
      await h.record('P', sid, rehomeRecord({ forkedFromSessionId }))
    }
    await h.record('T', SOURCE, rehomeRecord())
    await h.write(other, fork(base, SOURCE, other, 'Other source fork'))
    await h.record('Q', other, rehomeRecord({ forkedFromSessionId: `local_${SOURCE}` }))
    const all = await accounts(h.paths), from = all.filter(row => [h.org.P, h.org.Q].includes(row.org)), to = all.find(row => row.account === h.acct.T)
    const originals = await Promise.all(from.flatMap(row => row.sessions).map(async row => [row.file, await readFile(row.file)]))
    const table = [...desktopFixture(child), { ...desktopFixture(id(888))[1], pid: 502, started: 'collateral' }]
    const plan = await restartPlan(await inventory(from, to, h.paths, () => {}, { processes: table }), h.paths, table)
    assert.deepEqual(new Set(plan.held.map(row => row.id)), new Set([SOURCE, parent, child, sibling]))
    assert.deepEqual(plan.interrupts.map(row => row.pid), [502])
    assert.ok(plan.held.every(row => row.workers.length === 1 && row.workers[0].pid === 501 && row.sources.every(source => source.account === h.acct.P && source.org === h.org.P)))
    const moved = await executeMove(from, to, h.paths, { processes: table, moveOnly: true })
    assert.equal(moved.ok, true)
    assert.deepEqual(moved.receipt.sessions.map(row => row.id), [other])
    assert.deepEqual(await readdir(h.dir('Q')), [])
    const finished = await finishHeld(h.paths, { processes: [] })
    assert.equal(finished.ok, true)
    assert.equal(finished.complete, true)
    assert.deepEqual(await readdir(h.dir('P')), [])
    assert.ok((await undo(h.paths)).dest)
    for (const [file, bytes] of originals) assert.deepEqual(await readFile(file), bytes)
    assert.deepEqual(await readdir(h.dir('T')), [`local_${SOURCE}.json`])
  }
})

test('unreadable Desktop metadata stops retirement and preserves recoverable source and destination records', async () => {
  const h = await home(), child = id(777), corrupt = id(778), base = branchEntries(2, SOURCE, 1)
  await h.write(SOURCE, base)
  await h.record('P', SOURCE, rehomeRecord())
  await h.write(child, fork(base, SOURCE, child, 'Fork'))
  await h.record('P', child, rehomeRecord({ forkedFromSessionId: `local_${SOURCE}` }))
  const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
  const originals = await Promise.all(from.sessions.map(async row => [row.file, await readFile(row.file)]))
  const inv = await inventory([from], to, h.paths)
  const corruptFile = path.join(h.dir('P'), `local_${corrupt}.json`)
  await writeFile(corruptFile, '{broken')
  const moved = await move(inv, to, h.paths)
  assert.equal(moved.ok, false)
  assert.match(moved.receipt.failed.at(-1).error, /unreadable Desktop record:/)
  assert.deepEqual(moved.receipt.superseded, [])
  assert.equal(moved.receipt.retiring, null)
  assert.equal(moved.receipt.sessions.length, 2)
  for (const [file, bytes] of originals) {
    assert.deepEqual(await readFile(file), bytes)
    assert.equal(JSON.parse(await readFile(path.join(h.dir('T'), path.basename(file)))).sessionId, JSON.parse(bytes).sessionId)
  }
  const swept = await sweep(h.paths, { processes: [] })
  assert.equal(swept.complete, true)
  assert.match(swept.verification.notMoved.at(-1).error, /unreadable Desktop record/)
  await unlink(corruptFile)
  assert.ok((await undo(h.paths)).dest)
  for (const [file, bytes] of originals) assert.deepEqual(await readFile(file), bytes)
  assert.deepEqual(await readdir(h.dir('T')), [])
})

test('Undo refuses new destination forks before cloud or local changes and on every recovery entry', async () => {
  for (const staged of [false, true]) for (const unreadable of [false, true]) {
    const h = await home(), child = id(777), cold = id(778), base = branchEntries(2, SOURCE, 1)
    await h.write(SOURCE, base)
    await h.record('P', SOURCE, rehomeRecord({ title: 'Parent' }))
    await h.write(cold, branchEntries(2, cold, 300))
    await h.record('P', cold, rehomeRecord())
    const calls = []
    let status = 'active'
    const cloud = cloudFixture(h, {
      list: async () => [remoteSession({ id: 'cse_undo_parent', title: 'Parent', status })],
      eventRows: async () => remoteRows(base),
      session: async () => { calls.push('session'); return remoteState(status) },
      archive: async () => { calls.push('archive'); status = 'archived' },
      unarchive: async () => { calls.push('unarchive'); status = 'active' }
    })
    const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
    const originals = await Promise.all(from.sessions.map(async row => [row.file, await readFile(row.file)]))
    const moved = await move(await inventory([from], to, h.paths, () => {}, { cloud }), to, h.paths)
    assert.equal(moved.ok, true)
    assert.equal(status, 'archived')
    if (staged) assert.deepEqual((await undo(h.paths, { cloud: { ...cloud, account: h.acct.Q, org: h.org.Q } })).pendingUndo, [from.label])
    const childFile = path.join(h.dir('T'), `local_${child}.json`)
    if (unreadable) await writeFile(childFile, '{broken')
    else await h.record('T', child, rehomeRecord({ isArchived: true, forkedFromSessionId: `local_${SOURCE}` }))
    const receiptBytes = await readFile(moved.file)
    const destination = await Promise.all((await readdir(h.dir('T'))).map(async name => [path.join(h.dir('T'), name), await readFile(path.join(h.dir('T'), name))]))
    calls.length = 0
    for (const operation of staged ? [undo, finishPending, finishWorkflow, sweep] : [undo]) {
      const result = await operation(h.paths, { cloud, processes: [] })
      const problems = result.restoreProblems ?? (result.reconciled ?? result.recovered)?.problems
      assert.match(problems[0], unreadable ? /unreadable Desktop record:/ : /parent Desktop record would be removed by Undo/)
      assert.equal(result.dest, undefined)
      assert.deepEqual(calls, [])
      assert.equal(status, 'archived')
      assert.deepEqual(await readFile(moved.file), receiptBytes)
      assert.deepEqual(await readdir(h.dir('P')), [])
      for (const [file, bytes] of destination) assert.deepEqual(await readFile(file), bytes)
    }
    await unlink(childFile)
    const undone = await undo(h.paths, { cloud })
    assert.ok(undone.dest)
    assert.equal(status, 'active')
    for (const [file, bytes] of originals) assert.deepEqual(await readFile(file), bytes)
    assert.deepEqual(await readdir(h.dir('T')), [])
  }
})

test('Undo rechecks destination forks after cloud restoration before removing any local record', async () => {
  const h = await home(), child = id(777), base = branchEntries(2, SOURCE, 1)
  await h.write(SOURCE, base)
  await h.record('P', SOURCE, rehomeRecord({ title: 'Parent' }))
  let status = 'active'
  const cloud = cloudFixture(h, {
    list: async () => [remoteSession({ id: 'cse_undo_parent', title: 'Parent', status })],
    eventRows: async () => remoteRows(base),
    session: async () => remoteState(status),
    archive: async () => { status = 'archived' },
    unarchive: async () => {
      await h.record('T', child, rehomeRecord({ forkedFromSessionId: `local_${SOURCE}` }))
      status = 'active'
    }
  })
  const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
  const moved = await move(await inventory([from], to, h.paths, () => {}, { cloud }), to, h.paths)
  assert.equal(moved.ok, true)
  const parentFile = path.join(h.dir('T'), `local_${SOURCE}.json`), parentBytes = await readFile(parentFile)
  const refused = await undo(h.paths, { cloud })
  assert.match(refused.restoreProblems[0], /parent Desktop record would be removed by Undo/)
  assert.equal(status, 'active')
  assert.deepEqual(await readFile(parentFile), parentBytes)
  assert.deepEqual((await readdir(h.dir('T'))).sort(), [SOURCE, child].map(sid => `local_${sid}.json`).sort())
  assert.deepEqual(await readdir(h.dir('P')), [])
  assert.ok(JSON.parse(await readFile(moved.file)).undoing)
  await unlink(path.join(h.dir('T'), `local_${child}.json`))
  assert.ok((await undo(h.paths, { cloud })).dest)
  assert.ok(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`)))
  assert.deepEqual(await readdir(h.dir('T')), [])
})

test('Undo restores destination parents when forks arrive during local mutations and remains recoverable', async () => {
  for (const stage of ['restore source', 'park destination']) for (const unreadable of [false, true]) {
    const h = await home(), child = id(777), later = id(778), base = branchEntries(2, SOURCE, 1)
    await h.write(SOURCE, base)
    await h.record('P', SOURCE, rehomeRecord())
    await h.write(child, fork(base, SOURCE, child, 'Moved fork'))
    await h.record('P', child, rehomeRecord({ forkedFromSessionId: `local_${SOURCE}` }))
    const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
    const originals = await Promise.all(from.sessions.map(async row => [row.file, await readFile(row.file)]))
    const moved = await move(await inventory([from], to, h.paths), to, h.paths)
    assert.equal(moved.ok, true)
    const destination = await Promise.all(moved.receipt.sessions.map(async row => [row.record, await readFile(row.record)]))
    const sourceParent = path.join(h.dir('P'), `local_${SOURCE}.json`), targetParent = path.join(h.dir('T'), `local_${SOURCE}.json`)
    const originalRename = fs.rename
    let injected = false, refused
    try {
      fs.rename = async (source, target) => {
        await originalRename(source, target)
        if (injected || !(stage === 'restore source' ? target === sourceParent : source === targetParent)) return
        injected = true
        if (unreadable) await writeFile(path.join(h.dir('T'), `local_${later}.json`), '{broken')
        else await h.record('T', later, rehomeRecord({ isArchived: true, forkedFromSessionId: `local_${SOURCE}` }))
      }
      syncBuiltinESMExports()
      refused = await undo(h.paths)
    } finally {
      fs.rename = originalRename
      syncBuiltinESMExports()
    }
    assert.equal(injected, true)
    assert.equal(refused.dest, undefined)
    assert.match(refused.restoreProblems[0], unreadable ? /unreadable Desktop record:/ : /parent Desktop record would be removed by Undo/)
    for (const [file, bytes] of destination) assert.deepEqual(await readFile(file), bytes)
    if (!unreadable) assert.equal(JSON.parse(await readFile(path.join(h.dir('T'), `local_${later}.json`))).forkedFromSessionId, `local_${SOURCE}`)
    for (const [file, bytes] of originals) assert.deepEqual(await readFile(file), bytes)
    const receipt = JSON.parse(await readFile(moved.file))
    assert.equal(receipt.undoing.length, 2)
    assert.deepEqual(receipt.superseded, moved.receipt.superseded)
    for (const row of receipt.superseded) for (const [, parked] of row.moved) assert.equal(await readFile(parked).catch(() => null), null)
    const retried = await finishPending(h.paths)
    assert.equal(retried.ok, false)
    assert.match(retried.reconciled.problems[0], unreadable ? /unreadable Desktop record:/ : /parent Desktop record would be removed by Undo/)
    for (const [file, bytes] of destination) assert.deepEqual(await readFile(file), bytes)
    await unlink(path.join(h.dir('T'), `local_${later}.json`))
    const undone = await finishWorkflow(h.paths)
    assert.ok(undone.dest)
    assert.equal(undone.complete, true)
    assert.equal(JSON.parse(await readFile(path.join(undone.dest, 'receipt.json'))).at, moved.receipt.at)
    for (const [file, bytes] of originals) assert.deepEqual(await readFile(file), bytes)
    assert.deepEqual(await readdir(h.dir('T')), [])
  }
})

test('Undo rollback preserves foreign records and source forks while restoring every safe destination record', async () => {
  for (const change of ['source record', 'destination parent', 'destination sibling', 'source fork']) {
    const h = await home(), child = id(777), later = id(778), sourceFork = id(779), base = branchEntries(2, SOURCE, 1)
    await h.write(SOURCE, base)
    await h.record('P', SOURCE, rehomeRecord())
    await h.write(child, fork(base, SOURCE, child, 'Moved fork'))
    await h.record('P', child, rehomeRecord({ forkedFromSessionId: `local_${SOURCE}` }))
    const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
    const originals = new Map(await Promise.all(from.sessions.map(async row => [row.file, await readFile(row.file)])))
    const moved = await move(await inventory([from], to, h.paths), to, h.paths)
    assert.equal(moved.ok, true)
    const destination = new Map(await Promise.all(moved.receipt.sessions.map(async row => [row.record, await readFile(row.record)])))
    const sourceParent = path.join(h.dir('P'), `local_${SOURCE}.json`), targetParent = path.join(h.dir('T'), `local_${SOURCE}.json`)
    const targetChild = path.join(h.dir('T'), `local_${child}.json`), parkedParent = path.join(h.paths.state, 'quarantine', moved.receipt.at, path.basename(targetParent))
    const foreignFile = change === 'source record' ? sourceParent : change === 'destination parent' ? targetParent : change === 'destination sibling' ? targetChild : path.join(h.dir('P'), `local_${sourceFork}.json`)
    const originalRename = fs.rename
    let injected = false, refused, foreignBytes
    try {
      fs.rename = async (source, target) => {
        await originalRename(source, target)
        if (injected || source !== targetParent || target !== parkedParent) return
        injected = true
        await h.record('T', later, rehomeRecord({ forkedFromSessionId: `local_${SOURCE}` }))
        if (change === 'source fork') await h.record('P', sourceFork, rehomeRecord({ forkedFromSessionId: `local_${SOURCE}` }))
        else await h.record(change === 'source record' ? 'P' : 'T', change === 'destination sibling' ? child : SOURCE,
          rehomeRecord({ title: 'Independent change', ...(change === 'destination sibling' ? { forkedFromSessionId: `local_${SOURCE}` } : {}) }))
        foreignBytes = await readFile(foreignFile)
      }
      syncBuiltinESMExports()
      refused = await undo(h.paths)
    } finally {
      fs.rename = originalRename
      syncBuiltinESMExports()
    }
    assert.equal(injected, true)
    assert.equal(refused.dest, undefined)
    assert.match(refused.restoreProblems[0], /parent Desktop record would be removed by Undo/)
    if (change !== 'source fork') assert.ok(refused.restoreProblems.some(problem => /restore path occupied|recovery artifact changed/.test(problem)))
    assert.deepEqual(await readFile(foreignFile), foreignBytes)
    for (const [file, bytes] of originals) assert.deepEqual(await readFile(file), file === foreignFile ? foreignBytes : bytes)
    for (const [file, bytes] of destination) assert.deepEqual(await readFile(file), file === foreignFile ? foreignBytes : bytes)
    if (change === 'destination parent') assert.deepEqual(await readFile(parkedParent), destination.get(targetParent))
    const receipt = JSON.parse(await readFile(moved.file))
    assert.equal(receipt.undoing.length, 2)
    assert.deepEqual(receipt.superseded, moved.receipt.superseded)
    if (change !== 'source fork') {
      await rename(foreignFile, `${foreignFile}.foreign`)
      if (change === 'source record') await writeFile(foreignFile, originals.get(foreignFile))
      if (change === 'destination sibling') await writeFile(foreignFile, destination.get(foreignFile))
    }
    await unlink(path.join(h.dir('T'), `local_${later}.json`))
    const undone = await finishWorkflow(h.paths)
    assert.ok(undone.dest)
    assert.equal(undone.complete, true)
    for (const [file, bytes] of originals) assert.deepEqual(await readFile(file), bytes)
    for (const file of destination.keys()) assert.equal(await readFile(file).catch(() => null), null)
    assert.deepEqual(await readFile(change === 'source fork' ? foreignFile : `${foreignFile}.foreign`), foreignBytes)
  }
})

test('destination parents survive forks added after inventory or during final preparation', async () => {
  for (const stage of ['inventory', 'finalize']) {
    const h = await home(), richer = id(776), child = id(777), base = branchEntries(2, SOURCE, 1)
    await h.write(SOURCE, base)
    await h.record('T', SOURCE, rehomeRecord())
    await h.write(richer, [...fork(base, SOURCE, richer, 'Richer'), entry('user', 3, null, richer)])
    await h.record('P', richer, rehomeRecord())
    const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
    const inv = await inventory([from], to, h.paths)
    const addFork = () => writeFileSync(path.join(h.dir('T'), `local_${child}.json`), JSON.stringify({ sessionId: `local_${child}`, cliSessionId: child, isArchived: true, forkedFromSessionId: `local_${SOURCE}` }))
    if (stage === 'inventory') addFork()
    const moved = await move(inv, to, h.paths, current => { if (stage === 'finalize' && current === stage) addFork() })
    assert.equal(moved.ok, true)
    assert.deepEqual(moved.receipt.failed, [])
    assert.equal(moved.receipt.superseded.some(row => !row.source), false)
    assert.ok(await readFile(path.join(h.dir('T'), `local_${SOURCE}.json`)))
    assert.ok((await undo(h.paths)).dest)
    assert.deepEqual((await readdir(h.dir('T'))).sort(), [SOURCE, child].map(sid => `local_${sid}.json`).sort())
  }
})

test('new or changed parent references during retirement roll back the journal', async () => {
  for (const change of ['new', 'changed']) for (const location of ['P', 'T']) {
    const h = await home(), richer = id(776), child = id(777), base = branchEntries(2, SOURCE, 1)
    await h.write(SOURCE, base)
    await h.record(location, SOURCE, rehomeRecord())
    await h.write(richer, [...fork(base, SOURCE, richer, 'Richer'), entry('user', 3, null, richer)])
    await h.record(location === 'P' ? 'T' : 'P', richer, rehomeRecord())
    if (change === 'changed') await h.record(location, child, rehomeRecord({ isArchived: true }))
    const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
    const inv = await inventory([from], to, h.paths)
    let coordinate
    const result = await move(inv, to, h.paths, (stage, text) => {
      if (stage !== 'finalize' || text !== 'preparing') return
      const taskFile = from.taskFile
      assert.equal(spawnSync('/usr/bin/mkfifo', [taskFile]).status, 0)
      coordinate = duringSecondRead(taskFile, JSON.stringify({ scheduledTasks: [] }), () => h.record(location, child, rehomeRecord({ isArchived: true, forkedFromSessionId: `local_${SOURCE}` })))
    })
    await coordinate
    assert.equal(result.ok, false)
    assert.match(result.receipt.failed.at(-1).error, /parent reference changed during retirement/)
    assert.equal(result.receipt.retiring, null)
    assert.deepEqual(result.receipt.superseded, [])
    assert.ok(await readFile(path.join(h.dir(location), `local_${SOURCE}.json`)))
    const kept = JSON.parse(await readFile(path.join(h.dir(location), `local_${child}.json`)))
    assert.equal(kept.forkedFromSessionId, `local_${SOURCE}`)
    assert.equal(kept.isArchived, true)
    if (location === 'T') assert.ok((await undo(h.paths)).dest)
  }
})

test('identical Desktop parent and fork histories are reported as overlapping versions', async () => {
  const h = await home(), child = id(777), base = branchEntries(2, SOURCE, 1)
  await h.write(SOURCE, base)
  await h.write(child, fork(base, SOURCE, child, 'Fork'))
  await h.record('P', SOURCE, rehomeRecord())
  await h.record('P', child, rehomeRecord({ forkedFromSessionId: `local_${SOURCE}` }))
  const result = await cli(h.root, ['--from', 'p@example.com personal', '--to', 'z@example.com personal', '--dry-run'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /2 overlapping versions, kept separate/)
  assert.doesNotMatch(result.stdout, /grew apart/)
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
  const result = await move(inv, to, h.paths, (stage, _text, progress) => {
    if (stage !== 'verify' || progress?.completed !== 0) return
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

test('a thousand source records finish one restart with bounded polling and a linear journal', async () => {
  const h = await home(), amount = 1000
  for (let i = 0; i < amount; i++) {
    const session = id(10000 + i)
    await h.write(session, [entry('user', 20000 + i, null, session)])
    await h.record('P', session, rehomeRecord({ sessionSettings: { fixture: 'x'.repeat(4096) } }))
  }
  const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
  let rows = desktopFixture(id(10000)), inspections = 0, journalBytes = 0, checkpointBytes = 0
  const io = { inspect: () => { inspections++; return rows }, command: async file => {
    rows = file.endsWith('osascript') ? [] : [{ ...desktopFixture()[0], pid: 700, desktopPid: 700, started: 'new' }]
    return { status: 0 }
  } }
  const planned = await executeMove([from], to, h.paths, { io })
  const result = await executeMove([from], to, h.paths, { io, approve: planned.plan.token, report: (stage, _text, progress) => {
    if (stage !== 'move' || progress?.completed !== amount) return
    const log = readdirSync(h.paths.state).find(name => name.endsWith('.journal'))
    journalBytes = readFileSync(path.join(h.paths.state, log)).length
    checkpointBytes = readFileSync(path.join(h.paths.state, log.slice(0, -8))).length
  } })
  assert.equal(result.ok, true)
  assert.equal(result.receipt.sessions.length, amount)
  assert.equal(result.receipt.superseded.length, amount)
  assert.deepEqual(await readdir(h.dir('P')), [])
  assert.equal((await readdir(h.dir('T'))).length, amount)
  assert.ok(inspections < 150, `Unexpected process scans: ${inspections}`)
  assert.ok(checkpointBytes < 5000, `Receipt was rewritten during placement: ${checkpointBytes}`)
  assert.ok(journalBytes < 12_000 * amount, `Journal grew beyond its per-record bound: ${journalBytes}`)
  assert.equal((await readdir(h.paths.state)).some(name => name.endsWith('.journal')), false)
  assert.ok((await undo(h.paths)).dest)
  assert.equal((await readdir(h.dir('P'))).length, amount)
  assert.equal((await readdir(h.dir('T'))).length, 0)
})

test('a thousand records in one task family finish the real restart budget with linear reads', async t => {
  const h = await home(), amount = 1000, first = id(10000)
  const registry = { scheduledTasks: [{ id: 'large_task', notifySessionId: `local_${first}`, enabled: false, fireAt: 123456 }],
    recordedSkips: { large_task: [{ at: '2026-09-02T00:00:00Z', reason: 'app_closed' }] },
    runRetries: { large_task: { slot: '2026-09-02T00:00:00Z', attempts: 2, notBefore: '2026-09-02T00:05:00Z' } } }
  for (let i = 0; i < amount; i++) {
    const sid = id(10000 + i)
    await h.write(sid, [entry('user', 20000 + i, null, sid)])
    await h.record('P', sid, rehomeRecord(i ? { scheduledTaskId: 'large_task', notifySessionId: `local_${first}` } : {}))
  }
  const sourceFile = path.join(h.dir('P'), 'scheduled-tasks.json'), targetFile = path.join(h.dir('T'), 'scheduled-tasks.json')
  await writeFile(sourceFile, JSON.stringify(registry))
  const all = await accounts(h.paths, []), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
  let rows = [desktopFixture()[0]], recordReads = 0, namespaceReads = 0
  const calls = [], io = { inspect: () => rows, command: async file => {
    calls.push(file)
    rows = file.endsWith('osascript') ? [] : [{ ...desktopFixture()[0], pid: 700, desktopPid: 700, started: 'reopened' }]
    return { status: 0 }
  } }
  const planned = await executeMove([from], to, h.paths, { io })
  assert.equal(planned.plan.held.length, amount)
  const read = fs.readFile, list = fs.readdir
  fs.readFile = async (...args) => {
    if (/^local_.*\.json$/.test(path.basename(String(args[0])))) recordReads++
    return read(...args)
  }
  fs.readdir = async (...args) => {
    if ([h.dir('P'), h.dir('T')].includes(args[0])) namespaceReads++
    return list(...args)
  }
  syncBuiltinESMExports()
  const began = performance.now()
  let result
  try { result = await executeMove([from], to, h.paths, { io, approve: planned.plan.token }) }
  finally { fs.readFile = read; fs.readdir = list; syncBuiltinESMExports() }
  const seconds = (performance.now() - began) / 1000
  t.diagnostic(JSON.stringify({ benchmark: 'task-family-1000', root: h.root, seconds, recordReads, namespaceReads,
    moved: result.receipt?.sessions.length ?? 0, ok: result.ok, reason: result.reason ?? null }))
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.restarted, true)
  assert.deepEqual(calls, ['/usr/bin/osascript', '/usr/bin/open'])
  assert.equal(result.receipt.sessions.length, amount)
  assert.equal(result.receipt.superseded.length, amount)
  assert.equal(result.receipt.taskTransfers.length, 1)
  assert.equal(result.receipt.finalizing, false)
  assert.deepEqual(JSON.parse(await readFile(sourceFile)), { scheduledTasks: [], recordedSkips: {}, runRetries: {} })
  assert.deepEqual(JSON.parse(await readFile(targetFile)), registry)
  assert.deepEqual(await readdir(h.dir('P')), ['scheduled-tasks.json'])
  assert.equal((await readdir(h.dir('T'))).filter(name => name.startsWith('local_')).length, amount)
  assert.ok(recordReads < 80 * amount, `Unexpected record reads: ${recordReads}`)
  assert.ok(namespaceReads < 80, `Unexpected namespace scans: ${namespaceReads}`)
  const receipt = JSON.parse(await readFile(result.file))
  assert.equal(receipt.taskTransfers[0].links.length, amount)
  assert.equal(receipt.taskTransfers[0].recordIds.length, amount)
  assert.ok((await undo(h.paths, { processes: [] })).dest)
  assert.deepEqual(JSON.parse(await readFile(sourceFile)), registry)
  assert.equal((await readdir(h.dir('P'))).filter(name => name.startsWith('local_')).length, amount)
  assert.deepEqual(await readdir(h.dir('T')), [])
})

test('interrupted placement replays complete journal entries and ignores only a torn final append', async () => {
  for (const keep of [3, 4]) {
    const h = await home()
    await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
    await h.record('P', SOURCE, rehomeRecord())
    const original = await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`))
    const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
    const reported = []
    await assert.rejects(move(await inventory([from], to, h.paths), to, h.paths, (stage, text, progress) => {
      reported.push({ stage, text, progress })
      if (stage === 'move' && progress?.completed === 1) throw new Error('fixture interrupted publication')
    }), /fixture interrupted publication/)
    const log = (await readdir(h.paths.state)).find(name => name.endsWith('.journal'))
    const file = path.join(h.paths.state, log)
    const patches = (await readFile(file, 'utf8')).trimEnd().split('\n')
    assert.equal(patches.length, 4)
    assert.ok(JSON.parse(patches[2]).pending.created)
    await writeFile(file, patches.slice(0, keep).join('\n') + '\n{"sequence":')
    assert.equal(reported.some(row => row.stage === 'move' && row.text.includes('✓')), false)
    assert.equal(JSON.parse(await readFile(file.slice(0, -8))).sessions.length, 0)
    const recovered = await sweep(h.paths)
    assert.ok(recovered.recovered)
    assert.equal((await readdir(h.dir('T'))).length, 0)
    assert.deepEqual(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`)), original)
    assert.equal((await readdir(h.paths.state)).some(name => name.endsWith('.journal')), false)
    assert.equal((await sweep(h.paths)).recovered, undefined)
  }
})

test('a restart timeout before finalization never reports placed records as completed moves', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE, rehomeRecord())
  const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
  let rows = desktopFixture(), time = 0
  const io = { now: () => time, budget: 1000, reserve: 200, inspect: () => rows, command: async file => {
    rows = file.endsWith('osascript') ? [] : [{ ...desktopFixture()[0], pid: 700, desktopPid: 700, started: 'new' }]
    return { status: 0 }
  } }
  const planned = await executeMove([from], to, h.paths, { io }), reported = []
  const result = await executeMove([from], to, h.paths, { io, approve: planned.plan.token, report: (stage, text, progress) => {
    reported.push({ stage, text, progress })
    if (stage === 'move' && progress?.completed === 1) time = 801
  } })
  assert.equal(result.ok, false)
  assert.match(result.reason, /mutation deadline/)
  assert.equal(result.restarted, true)
  assert.equal(reported.some(row => row.stage === 'move' && row.text.includes('✓')), false)
  assert.ok(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`)))
  await sweep(h.paths, { io })
  assert.equal((await readdir(h.dir('T'))).length, 0)
})

test('a forced boundary detects reopening before retirement even inside the polling interval', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE, rehomeRecord())
  const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
  let rows = desktopFixture(), opens = 0
  const io = { now: () => 0, inspect: () => rows, command: async file => {
    if (!file.endsWith('osascript')) opens++
    rows = []
    return { status: 0 }
  } }
  const planned = await executeMove([from], to, h.paths, { io })
  const result = await executeMove([from], to, h.paths, { io, approve: planned.plan.token, report: (stage, _text, progress) => {
    if (stage === 'verify' && progress?.completed === 1) rows = [{ ...desktopFixture()[0], pid: 700, desktopPid: 700, started: 'new' }]
  } })
  assert.equal(result.ok, false)
  assert.match(result.reason, /reopened before/)
  assert.equal(opens, 0)
  assert.ok(await readFile(path.join(h.dir('P'), `local_${SOURCE}.json`)))
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

test('mixed cloud Finish keeps its first pass preparatory until the restart decision', async () => {
  const h = await home(), other = id(300)
  const histories = { cse_ready: [entry('user', 1, null, SOURCE)], cse_open: [entry('user', 300, null, other)] }
  const connected = { cse_ready: true, cse_open: true }, status = { cse_ready: 'active', cse_open: 'active' }
  for (const [session, remote] of [[SOURCE, 'ready'], [other, 'open']]) {
    await h.write(session, histories[`cse_${remote}`])
    await h.record('P', session, rehomeRecord({ bridgeSessionIds: [`session_${remote}`] }))
  }
  const cloud = cloudFixture(h, {
    list: async () => Object.keys(histories).map(id => remoteSession({ id, title: id, status: status[id] })),
    session: async id => remoteState(status[id], { connection_status: connected[id] ? 'connected' : 'disconnected' }),
    eventRows: async id => remoteRows(histories[id]), archive: async id => { status[id] = 'archived' }
  })
  const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
  const moved = await move(await inventory([from], to, h.paths, () => {}, { cloud, processes: [] }), to, h.paths)
  connected.cse_ready = false
  let rows = desktopFixture(other)
  const io = { inspect: () => rows, command: async file => {
    if (file.endsWith('osascript')) { rows = []; connected.cse_open = false }
    else rows = [{ ...desktopFixture()[0], pid: 700, desktopPid: 700, started: 'new' }]
    return { status: 0 }
  } }
  const before = [], after = []
  const plan = await finishWorkflow(h.paths, { cloud, io, report: (stage, text, extra) => before.push({ stage, text, ...extra }) })
  assert.equal(plan.plan.kind, 'finish')
  assert.equal(status.cse_ready, 'archived')
  assert.equal(status.cse_open, 'active')
  assert.ok(before.some(event => event.stage === 'cloud' && event.completed === 1))
  assert.ok(before.filter(event => event.live).every(event => event.preparatory === true))
  const completed = await finishWorkflow(h.paths, { cloud, io, approve: plan.plan.token, report: (stage, text, extra) => after.push({ stage, text, ...extra }) })
  assert.equal(completed.file, moved.file)
  assert.equal(completed.complete, true)
  assert.equal(completed.receipt.remote.length, 2)
  assert.ok(after.some(event => event.stage === 'reopen'))
  assert.ok(after.filter(event => event.live).every(event => !event.preparatory))
})

test('a local move explicitly reports that no cloud phase remains', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE, rehomeRecord())
  const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T), cloud = []
  const result = await move(await inventory([from], to, h.paths), to, h.paths, (stage, _text, extra) => { if (stage === 'cloud') cloud.push(extra) })
  assert.equal(result.ok, true)
  assert.deepEqual(cloud, [{ live: true, completed: 0, total: 0 }])
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

test('Swift preserves command, progress, metadata, and completion states', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ct-swift-state-'))
  const checkpointAccounts = await checkpointAccountsFixture()
  const h = await taskFamilyFixture(true, 1)
  await interruptTaskFamily(h, 'move', 'target')
  const recoveryAccounts = await cli(h.root, ['accounts', '--json'])
  assert.equal(recoveryAccounts.code, 0)
  let source = (await readFile(path.join(here, 'menubar.swift'), 'utf8')).split('@main\nstruct TransplantApp: App {')[0]
  const start = source.indexOf('    private func run(_ args: [String]')
  const end = source.indexOf('\nstruct RowKey: PreferenceKey', start)
  assert.ok(start > 0 && end > start)
  source = source.slice(0, start) + `    private func run(_ args: [String], line: @escaping (String) -> Void, done: @escaping (Int32, String) -> Void) {
        requests.append((args, line, done))
    }
}
` + source.slice(end)
  source = source.replace('guard canMutate, !sweeping, !snapshot else { return }', 'guard canMutate, !sweeping else { return }')
  source += String.raw`
@MainActor var requests: [([String], (String) -> Void, (Int32, String) -> Void)] = []
extension Model {
    func checkSweep() { sweep() }
    func checkFinish(_ status: Int32) { finish(status, "fixture failure") }
    func checkStarted(_ secondsAgo: TimeInterval) { operationStarted = ProcessInfo.processInfo.systemUptime - secondsAgo }
}
@main
struct StateChecks {
    @MainActor
    static func main() {
        let menuSize = NSImage(systemSymbolName: "arrow.left.arrow.right", accessibilityDescription: nil)!.size
        var textHeight: Int?
        for badge in ["", "0%", "9%", "10%", "47%", "99%", "100%"] {
            let image = MenuLabel(symbol: "arrow.left.arrow.right", badge: badge).image
            precondition(image.size == menuSize && image.isTemplate && image.tiffRepresentation != nil)
            if !badge.isEmpty {
                let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
                let rows = (0..<bitmap.pixelsHigh).filter { y in (0..<bitmap.pixelsWide).contains { x in bitmap.colorAt(x: x, y: y)!.alphaComponent > 0.4 } }.count
                precondition(textHeight == nil || rows == textHeight)
                textHeight = rows
            }
        }
        var progress = MoveProgress(now: 0)
        var previous = 0
        for (stage, completed, total, at) in [("scan", 0, 100, 0.0), ("scan", 50, 100, 2.0), ("scan", 100, 100, 4.0), ("cloud scan", 1, 2, 5.0), ("desktop", 0, 1, 6.0), ("scan", 1, 100, 8.0), ("scan", 100, 100, 8.2), ("move", 1, 100, 8.3), ("move", 100, 100, 8.5), ("verify", 100, 100, 8.6), ("retire", 100, 100, 8.7), ("finalize", 0, 1, 8.8), ("reopen", 0, 1, 9.0), ("cloud", 1, 2, 10.0), ("cloud", 2, 2, 11.0)] {
            progress.update(stage, completed: completed, total: total, now: at)
            precondition(progress.percent >= previous && progress.percent <= 99)
            previous = progress.percent
        }
        progress.refresh(10000)
        precondition(progress.percent == 99)
        for stage in ["", "undo", "keep-local", "unknown"] {
            var idle = MoveProgress(now: 0)
            idle.update(stage, completed: nil, total: nil, now: 1)
            idle.record(120)
            precondition(!idle.hasProgress && idle.observed.isEmpty)
            precondition(idle.costs == MoveProgress.defaults)
        }
        var empty = MoveProgress(now: 0)
        empty.update("scan", completed: 0, total: 0, now: 0)
        empty.update("retire", completed: nil, total: nil, now: 1)
        empty.update("finalize", completed: nil, total: nil, now: 2)
        empty.record(3)
        precondition(empty.observed.isEmpty)
        var reopen = MoveProgress(now: 0)
        reopen.update("reopen", completed: nil, total: nil, now: 10)
        reopen.record(12)
        precondition(reopen.observed["prepare"] == nil && reopen.observed["reopen"] == 2)
        var local = MoveProgress(now: 0)
        local.update("scan", completed: 100, total: 100, now: 1)
        local.record(1)
        precondition(local.observed["prepare"] == 0.01)
        local.update("move", completed: 100, total: 100, now: 2)
        local.update("rescue", completed: 0, total: 0, now: 2)
        precondition(!local.skipped.contains("move"))
        local.update("finalize", completed: nil, total: nil, now: 3)
        local.update("cloud", completed: 0, total: 0, now: 4)
        precondition(local.skipped.contains("cloud") && local.percent > 90)
        var mixed = MoveProgress(now: 0)
        mixed.update("rescue", completed: 1, total: 1, preparatory: true, now: 1)
        mixed.update("cloud", completed: 1, total: 1, preparatory: true, now: 2)
        let checked = mixed.percent
        precondition(checked < 99 && mixed.phase == "cloudScan")
        mixed.update("desktop", completed: nil, total: nil, now: 3)
        precondition(mixed.phase == "close" && mixed.percent >= checked)
        mixed.update("reopen", completed: nil, total: nil, now: 4)
        precondition(mixed.phase == "reopen")
        var paused = MoveProgress(now: 0)
        paused.update("scan", completed: 0, total: 1, now: 0)
        paused.paused = 2
        paused.resume(102)
        paused.record(103)
        precondition(paused.observed["prepare"] == 3)
        let progressModel = Model(demo: Demo.accounts)
        progressModel.begin()
        precondition(progressModel.badge == "0%")
        progressModel.handle("{\"stage\":\"cloud\",\"text\":\"1/1\",\"live\":true,\"completed\":1,\"total\":1,\"preparatory\":true}")
        precondition(progressModel.moveProgress.phase == "cloudScan" && progressModel.moveProgress.percent < 99)
        progressModel.begin()
        progressModel.handle("{\"stage\":\"scan\",\"text\":\"50/100\",\"live\":true,\"completed\":50,\"total\":100}")
        let percentage = progressModel.badge
        precondition(percentage.hasSuffix("%") && !percentage.contains("/"))
        progressModel.handle("{\"stage\":\"inventory\",\"text\":\"100 sessions\"}")
        precondition(progressModel.badge == percentage)
        progressModel.begin(resetProgress: false)
        precondition(progressModel.badge == percentage)
        progressModel.handle("{\"done\":true,\"ok\":false,\"moved\":0,\"reason\":\"fixture rollback\"}")
        progressModel.checkFinish(1)
        precondition(progressModel.badge.isEmpty && !progressModel.running)
        progressModel.begin()
        progressModel.handle("{\"done\":true,\"ok\":true,\"complete\":true,\"moved\":100}")
        progressModel.checkFinish(0)
        precondition(progressModel.badge == "100%" && !progressModel.running)
        let completed = Model(demo: Demo.accounts)
        completed.selectTarget(Demo.accounts[2].id)
        completed.begin()
        completed.checkStarted(8.1)
        completed.handle("{\"done\":true,\"ok\":true,\"complete\":true,\"moved\":167}")
        precondition(completed.visibleCompletion == nil)
        completed.checkFinish(0)
        precondition(completed.visibleCompletion?.summary == "167 sessions moved to Personal")
        precondition(completed.visibleCompletion?.detail == "History verified · 8.1 seconds")
        completed.note = "A moved session has a newer title"
        precondition(completed.visibleCompletion == nil)
        completed.selectTarget(Demo.accounts[3].id)
        precondition(completed.completion == nil)
        for event in [
            "{\"done\":true,\"ok\":true,\"complete\":false,\"moved\":167}",
            "{\"done\":true,\"ok\":true,\"complete\":true,\"moved\":167,\"pendingCloud\":1}",
            "{\"done\":true,\"ok\":false,\"complete\":true,\"moved\":167}",
            "{\"done\":true,\"ok\":true,\"complete\":true,\"moved\":0}",
            "{\"done\":true,\"ok\":true,\"complete\":true,\"moved\":167,\"keptLocal\":1}",
            "{\"undone\":true,\"sessions\":167}"
        ] {
            completed.begin()
            completed.handle(event)
            completed.checkFinish(0)
            precondition(completed.visibleCompletion == nil)
        }
        completed.begin()
        completed.handle("{\"done\":true,\"ok\":true,\"complete\":true,\"moved\":167}")
        completed.checkFinish(1)
        precondition(completed.completion == nil)
        requests = []
        let model = Model(demo: Demo.accounts)
        model.selectTarget(Demo.accounts[2].id)
        let selected = model.to
        model.checkSweep()
        precondition(model.ready && !model.running)
        model.move()
        precondition(model.running && !model.ready && model.displaySummary == "Waiting for background check")
        model.selectTarget(Demo.accounts[3].id)
        precondition(model.to == selected)
        model.to = Demo.accounts[3].id
        model.undo()
        precondition(requests.count == 1)
        requests[0].1("{\"swept\":true,\"ok\":true}")
        requests[0].2(0, "")
        precondition(requests.count == 2)
        let command = requests[1].0
        precondition(command[command.firstIndex(of: "--to")! + 1] == Demo.accounts[2].selector)
        precondition(!command.contains("undo"))
        precondition(!model.sweeping && model.running)
        for field in ["record unavailable", "isStarred", "title", "isArchived"] {
            requests = []
            let item = Model(demo: Demo.accounts)
            item.checkSweep()
            requests[0].1("{\"swept\":true,\"ok\":true,\"changed\":[{\"id\":\"fixture\",\"title\":\"Fixture\",\"fields\":[\"" + field + "\"]}]}")
            requests[0].2(0, "")
            let unavailable = field == "record unavailable"
            precondition(item.symbol == (unavailable ? "exclamationmark.triangle" : "info.circle"))
            precondition(item.note.contains(unavailable ? "cannot be read" : ["isStarred": "starred state", "isArchived": "archive state", "title": "title"][field]!))
            precondition(item.detailLines.contains { $0.1.contains("Fixture") })
        }
        func accountResponse(_ pending: Bool) -> String {
            String(data: try! JSONSerialization.data(withJSONObject: Demo.accounts.enumerated().map { index, account -> [String: Any] in
                var row: [String: Any] = ["account": account.account, "org": account.org, "label": account.label, "active": index == 0]
                if pending && index == 0 { row["pending"] = "cloud"; row["pendingAction"] = "finish"; row["receipt"] = "receipt-one" }
                return row
            }), encoding: .utf8)!
        }
        let corruptedAccounts = String(data: Data(base64Encoded: "CORRUPTED_CHECKPOINT_ACCOUNTS")!, encoding: .utf8)!
        let repairedAccounts = String(data: Data(base64Encoded: "REPAIRED_CHECKPOINT_ACCOUNTS")!, encoding: .utf8)!
        let discoveredAccounts = try! JSONDecoder().decode([Account].self, from: Data(corruptedAccounts.utf8))
        for populated in [false, true] {
            requests = []
            let inventory = Model(demo: populated ? Demo.accounts : [])
            if populated {
                inventory.note = "An earlier result"
                inventory.lines = [("metadata", "An earlier detail")]
                inventory.completion = ("An earlier result", "History verified")
                inventory.symbol = "info.circle"
                inventory.badge = "100%"
                inventory.restartAvailable = true
            }
            let previousNote = inventory.note, previousLines = inventory.lines
            let previousSymbol = inventory.symbol, previousBadge = inventory.badge
            for _ in 0..<2 {
                let index = requests.count
                inventory.refresh()
                precondition(requests[index].0 == ["accounts", "--json"])
                requests[index].1(corruptedAccounts)
                requests[index].2(0, "")
                precondition(inventory.accounts.map(\.id) == discoveredAccounts.map(\.id))
                precondition(inventory.accounts.map(\.stats) == discoveredAccounts.map(\.stats))
                precondition(inventory.displaySummary == "The move receipt needs repair")
                precondition(inventory.visibleCompletion == nil)
                precondition(!inventory.canMutate && !inventory.ready && !inventory.pendingReady && !inventory.canKeepLocal)
                precondition(inventory.recoveryProblem?.receipt == discoveredAccounts[0].recoveryProblem?.receipt)
                precondition(inventory.detailLines.contains { $0.0 == "recovery" && $0.1 == "Invalid append checkpoint" })
                precondition(inventory.detailLines.contains { $0.0 == "receipt" && $0.1 == inventory.recoveryProblem?.receipt })
                precondition(inventory.detailLines.count == previousLines.count + 2)
                inventory.move()
                inventory.finishPending()
                inventory.keepLocal()
                inventory.undo()
                inventory.restartDesktop()
                inventory.checkSweep()
                precondition(requests.count == index + 1 && !inventory.running && !inventory.sweeping)
            }
            let index = requests.count
            inventory.refresh()
            requests[index].1(repairedAccounts)
            requests[index].2(0, "")
            precondition(inventory.recoveryProblem == nil && inventory.canMutate)
            precondition(inventory.pendingReady && !inventory.ready && !inventory.canKeepLocal)
            precondition(inventory.note == previousNote && inventory.lines.elementsEqual(previousLines, by: ==))
            precondition(inventory.symbol == previousSymbol && inventory.badge == previousBadge)
            precondition(inventory.restartAvailable == populated)
            precondition(inventory.detailLines.elementsEqual(previousLines, by: ==))
            precondition(inventory.displaySummary == (populated ? previousNote : "Finish the interrupted move"))
            inventory.finishPending()
            precondition(requests.last!.0 == ["finish", "--json"] && inventory.running)
        }
        requests = []
        let taskRecovery = Model(demo: try! JSONDecoder().decode([Account].self, from: Data(base64Encoded: "TASK_RECOVERY_ACCOUNTS")!))
        precondition(taskRecovery.pendingReady && !taskRecovery.ready && !taskRecovery.canKeepLocal)
        precondition(taskRecovery.pendingButtonTitle == "Finish move")
        precondition(taskRecovery.pendingPrompt == "Finish the interrupted move")
        taskRecovery.skipRestartWarning = true
        taskRecovery.finishPending()
        precondition(requests[0].0 == ["finish", "--json"])
        requests[0].1(#"{"plan":true,"kind":"recover","token":"task-recovery-token","affected":[]}"#)
        requests[0].2(0, "")
        precondition(requests[1].0 == ["finish", "--json", "--restart-approved", "task-recovery-token"])
        requests = []
        let recovering = Model(demo: try! JSONDecoder().decode([Account].self, from: Data(accountResponse(true).utf8)))
        recovering.finishPending()
        precondition(requests[0].0 == ["finish", "--json"])
        requests[0].2(1, "Sign Claude Desktop into Personal")
        requests[1].1(accountResponse(true))
        requests[1].2(0, "")
        precondition(recovering.note == "The move needs attention" && recovering.pendingReady)
        recovering.refresh()
        requests[2].1(accountResponse(false))
        requests[2].2(0, "")
        precondition(recovering.note == "The move needs attention")
        func sweepReply(_ model: Model, _ event: String) {
            let index = requests.count
            model.checkSweep()
            requests[index].1(event)
            requests[index].2(0, "")
        }
        let cleanSweep = #"{"swept":true,"ok":true,"complete":true,"receipt":"receipt-one"}"#
        let repeated = Model(demo: Demo.accounts)
        let repeatError = #"{"swept":true,"ok":false,"error":"Repeated error","receipt":"receipt-one"}"#
        sweepReply(repeated, repeatError)
        sweepReply(repeated, repeatError)
        precondition(repeated.note == "The remaining work needs attention")
        precondition(repeated.lines.filter { $0.0 == "background" }.count == 1)
        sweepReply(repeated, cleanSweep)
        precondition(repeated.note.isEmpty)
        sweepReply(recovering, #"{"swept":true,"ok":false,"error":"Could not check source","receipt":"receipt-one"}"#)
        precondition(recovering.note == "The remaining work needs attention")
        sweepReply(recovering, cleanSweep)
        precondition(recovering.note == "No remaining work" && !recovering.pendingReady)
        precondition(recovering.lines.isEmpty && recovering.to == nil && recovering.from.isEmpty)
        func failedFinishModel() -> Model {
            requests = []
            let model = Model(demo: try! JSONDecoder().decode([Account].self, from: Data(accountResponse(true).utf8)))
            model.finishPending()
            requests[0].2(1, "Sign Claude Desktop into Personal")
            requests[1].1(accountResponse(false))
            requests[1].2(0, "")
            return model
        }
        for event in [
            #"{"swept":true,"ok":false,"receipt":"receipt-one"}"#,
            #"{"swept":true,"ok":true,"complete":true,"receipt":"another-receipt"}"#,
            #"{"swept":true,"ok":true,"complete":true,"receipt":"receipt-one","failed":[{"id":"fixture","error":"Unmoved history"}]}"#,
            #"{"swept":true,"ok":true,"complete":true,"receipt":"receipt-one","changed":[{"id":"fixture","fields":["record unavailable"]}]}"#
        ] {
            let guarded = failedFinishModel()
            sweepReply(guarded, event)
            precondition(guarded.note != "No remaining work")
            sweepReply(guarded, cleanSweep)
            precondition(guarded.note == "No remaining work")
        }
        let corrupt = failedFinishModel()
        sweepReply(corrupt, #"{"swept":true,"ok":false,"error":"Corrupt receipt set aside"}"#)
        sweepReply(corrupt, #"{"swept":true,"ok":true,"complete":true,"receipt":"older-receipt"}"#)
        precondition(corrupt.note == "The remaining work needs attention")
        let restart = failedFinishModel()
        sweepReply(restart, #"{"swept":true,"ok":true,"complete":true,"receipt":"receipt-one","restart":true}"#)
        let hint = restart.note
        sweepReply(restart, cleanSweep)
        precondition(restart.restartAvailable && restart.note == hint)
        for errors in ["[]", #"[{"id":"fixture","title":"Unmoved session","error":"conflicting history"}]"#] {
            requests = []
            let idle = Model(demo: try! JSONDecoder().decode([Account].self, from: Data(accountResponse(true).utf8)))
            idle.finishPending()
            requests[0].1("{\"nothing\":true,\"failed\":" + errors + "}")
            requests[0].2(0, "")
            requests[1].1(accountResponse(false))
            requests[1].2(0, "")
            precondition(idle.badge.isEmpty && idle.visibleCompletion == nil)
            precondition(idle.note == (errors == "[]" ? "No remaining work" : "1 session was not moved"))
            precondition(idle.symbol == (errors == "[]" ? "arrow.left.arrow.right" : "info.circle"))
            precondition(errors == "[]" || idle.lines.contains { $0.1.contains("conflicting history") })
        }
        requests = []
        let failed = Model(demo: try! JSONDecoder().decode([Account].self, from: Data(accountResponse(true).utf8)))
        failed.finishPending()
        requests[0].1("{\"done\":true,\"ok\":false,\"complete\":true,\"failed\":[{\"id\":\"fixture\",\"title\":\"Unmoved session\",\"error\":\"conflicting history\"}]}")
        requests[0].2(1, "")
        requests[1].1(accountResponse(false))
        requests[1].2(0, "")
        precondition(failed.note == "1 need attention")
        precondition(failed.lines.contains { $0.1.contains("conflicting history") })
        requests = []
        let completedCloud = Model(demo: try! JSONDecoder().decode([Account].self, from: Data(accountResponse(true).utf8)))
        completedCloud.finishPending()
        requests[0].1(#"{"done":true,"ok":true,"complete":true,"moved":1,"failed":[],"notMoved":[{"id":"fixture","title":"Earlier refusal","error":"task family missing"}]}"#)
        requests[0].2(0, "")
        requests[1].1(accountResponse(false))
        requests[1].2(0, "")
        precondition(!completedCloud.note.contains("attention"))
        precondition(completedCloud.lines.contains { $0.0 == "not moved" && $0.1.contains("task family missing") })
        let recoveredCloud = failedFinishModel()
        sweepReply(recoveredCloud, #"{"swept":true,"ok":true,"complete":true,"receipt":"receipt-one","failed":[],"notMoved":[{"id":"fixture","error":"task family missing"}]}"#)
        precondition(recoveredCloud.note == "No remaining work")
        print("Swift queue and metadata states passed")
    }
}
`
  source = source.replace('TASK_RECOVERY_ACCOUNTS', Buffer.from(recoveryAccounts.stdout.trim()).toString('base64'))
  source = source.replace('CORRUPTED_CHECKPOINT_ACCOUNTS', Buffer.from(checkpointAccounts.corrupted).toString('base64'))
  source = source.replace('REPAIRED_CHECKPOINT_ACCOUNTS', Buffer.from(checkpointAccounts.repaired).toString('base64'))
  const file = path.join(root, 'checks.swift'), binary = path.join(root, 'checks')
  await writeFile(file, source)
  await promisify(execFile)('/usr/bin/swiftc', ['-parse-as-library', '-o', binary, file], { timeout: 90_000 })
  const { stdout } = await promisify(execFile)(binary, [], { timeout: 15_000 })
  assert.match(stdout, /Swift queue and metadata states passed/)
})

test('missing and unreadable moved records remain distinct from informational field changes', async () => {
  const h = await home()
  await h.write(SOURCE, [entry('user', 1, null, SOURCE)])
  await h.record('P', SOURCE)
  const all = await accounts(h.paths), from = all.find(row => row.account === h.acct.P), to = all.find(row => row.account === h.acct.T)
  const moved = await move(await inventory([from], to, h.paths), to, h.paths)
  const file = moved.receipt.sessions[0].record
  await unlink(file)
  assert.deepEqual((await verifyPlaced(h.paths)).changed[0].fields, ['record unavailable'])
  await writeFile(file, '{')
  assert.deepEqual((await verifyPlaced(h.paths)).changed[0].fields, ['record unavailable'])
})
