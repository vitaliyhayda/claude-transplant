#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const NAME = 'Claude Transplant Lab'
const LABEL = 'io.github.vitaliyhayda.claude-transplant-lab'
const state = path.join(os.homedir(), 'Library/Application Support/claude-transplant-lab')
const app = path.join(state, `${NAME}.app`)
const binary = path.join(app, 'Contents/MacOS', NAME)
const agent = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`)
const domain = `gui/${process.getuid()}`

const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
const plist = (dict) => {
  const entry = ([key, value]) => {
    const body = value === true ? '<true/>' : Array.isArray(value) ? `<array>${value.map((s) => `<string>${xml(s)}</string>`).join('')}</array>` : `<string>${xml(value)}</string>`
    return `<key>${xml(key)}</key>${body}`
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<plist version="1.0"><dict>${Object.entries(dict).map(entry).join('')}</dict></plist>`,
    ''
  ].join('\n')
}

const stop = () => {
  spawnSync('launchctl', ['bootout', `${domain}/${LABEL}`])
  spawnSync('pkill', ['-x', NAME])
}

const args = process.argv.slice(2)
if (args.includes('--remove')) {
  stop()
  await rm(app, { recursive: true, force: true })
  await rm(agent, { force: true })
  console.log('lab menubar removed')
  process.exit(0)
}

const { version } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
const fresh = `${app}.building`
await rm(fresh, { recursive: true, force: true })
await mkdir(path.join(fresh, 'Contents/MacOS'), { recursive: true })
await mkdir(path.join(fresh, 'Contents/Resources'), { recursive: true })
await writeFile(path.join(fresh, 'Contents/Info.plist'), plist({
  CFBundleIdentifier: LABEL,
  CFBundleName: NAME,
  CFBundleExecutable: NAME,
  CFBundlePackageType: 'APPL',
  CFBundleShortVersionString: `${version}-lab`,
  LSMinimumSystemVersion: '13.0',
  LSUIElement: true,
  NSHighResolutionCapable: true
}))
const build = spawnSync('swiftc', ['-O', '-parse-as-library', '-o', path.join(fresh, 'Contents/MacOS', NAME), path.join(HERE, 'menubar.swift')], { encoding: 'utf8' })
if (build.error) throw new Error('swiftc not found, run xcode-select --install')
if (build.status !== 0) throw new Error(`swiftc failed\n${build.stderr.trim()}`)
stop()
await rm(app, { recursive: true, force: true })
await rename(fresh, app)
const script = path.join(app, 'Contents/Resources/transplant.js')
await copyFile(path.join(ROOT, 'transplant.js'), script)
await writeFile(path.join(state, 'menubar.json'), `${JSON.stringify({ node: process.execPath, script, state })}\n`)

const sample = args.indexOf('--sample')
const extra = sample >= 0 ? ['--sample', String(Number(args[sample + 1]) || 10)] : []
const snapshot = args.indexOf('--snapshot')
if (snapshot >= 0) {
  const out = path.resolve(args[snapshot + 1] ?? 'lab-panel.png')
  const shot = spawnSync(binary, ['--snapshot', out, ...extra], { encoding: 'utf8' })
  if (shot.status !== 0) throw new Error(`snapshot failed\n${shot.stderr.trim()}`)
  console.log(`snapshot written | ${out}`)
  process.exit(0)
}

await mkdir(path.dirname(agent), { recursive: true })
await writeFile(agent, plist({ Label: LABEL, ProgramArguments: [binary, ...extra], RunAtLoad: true }))
const load = spawnSync('launchctl', ['bootstrap', domain, agent], { encoding: 'utf8' })
if (load.status !== 0) throw new Error(`launchctl failed: ${(load.stderr || '').trim()}`)
console.log(`lab menubar installed | starts at login | ${app}`)
