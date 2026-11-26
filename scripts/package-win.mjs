// Builds the Windows x64 NSIS installer. Run after `electron-vite build` (see `npm run package:win`).
//
// On Windows, macOS or plain Linux this just runs electron-builder. Under WSL it doesn't
// work in place: building the NSIS installer means running the generated uninstaller, which
// electron-builder does through Wine on Linux. So under WSL the built app is copied to the
// Windows host's temp dir, electron-builder runs there with the host's Node, and the
// installer is copied back into release/<version>/.
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const builderArgs = ['--win', '--x64']

function isWsl() {
  if (process.platform !== 'linux') return false
  if (process.env.WSL_DISTRO_NAME) return true
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'))
  } catch {
    return false
  }
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function versionOf(pkg) {
  return JSON.parse(readFileSync(join(root, 'node_modules', pkg, 'package.json'), 'utf8')).version
}

if (!isWsl()) {
  run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron-builder', ...builderArgs], {
    cwd: root,
    shell: process.platform === 'win32'
  })
  process.exit(0)
}

if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('out/ is missing; run `npm run build` first.')
  process.exit(1)
}

// cmd.exe complains when started from a \\wsl.localhost cwd, so run it from the Windows temp dir.
const winTemp = execFileSync('cmd.exe', ['/d', '/c', 'echo %TEMP%'], { cwd: '/mnt/c', encoding: 'utf8' }).trim()
const stage = join(execFileSync('wslpath', ['-u', winTemp], { encoding: 'utf8' }).trim(), 'photoearth-package')

console.log(`Staging the app on the Windows host: ${stage}`)
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
for (const entry of ['out', 'build', 'electron-builder.yml', 'package.json']) {
  cpSync(join(root, entry), join(stage, entry), {
    recursive: true,
    filter: (src) => !src.endsWith('.map')
  })
}

// No node_modules on the host: pin electron-builder and Electron to the versions installed here.
run(
  'cmd.exe',
  [
    '/d',
    '/c',
    'npx.cmd',
    '-y',
    `electron-builder@${versionOf('electron-builder')}`,
    ...builderArgs,
    `-c.electronVersion=${versionOf('electron')}`
  ],
  { cwd: stage }
)

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const from = join(stage, 'release', version)
const to = join(root, 'release', version)
mkdirSync(to, { recursive: true })
// A failed Linux build leaves a stub installer plus a loose .7z payload; drop them.
for (const name of readdirSync(to)) {
  if (name.endsWith('.nsis.7z') || /^PhotoEarth Setup .*\.exe(\.blockmap)?$/.test(name)) rmSync(join(to, name))
}
for (const name of readdirSync(from)) {
  if (name.endsWith('.exe') || name.endsWith('.blockmap')) {
    cpSync(join(from, name), join(to, name))
    console.log(`Copied ${join('release', version, name)}`)
  }
}
rmSync(stage, { recursive: true, force: true })
