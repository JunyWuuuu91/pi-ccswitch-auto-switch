#!/usr/bin/env node
/**
 * Headless Pi runner that keeps one RPC session alive while the CCSwitch
 * extension retries a failed turn on another model.
 */
import { spawn } from 'node:child_process'
import { access, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'

export const EXIT = Object.freeze({ SUCCESS: 0, EXHAUSTED: 1, CONFIG: 2, TIMEOUT: 124, INTERRUPTED: 130, TERMINATED: 143 })
export const DEFAULT_TIMEOUT_MS = 600_000

const usage = `Usage: pi-ccswitch-run [options] [--] [@text-file ...] <prompt>

Options:
  --timeout-ms <ms>       Total runner timeout (default: ${DEFAULT_TIMEOUT_MS})
  --no-tools              Disable Pi tools
  --no-context-files      Disable AGENTS.md / CLAUDE.md discovery
  --provider <name>       Initial Pi provider
  --model <name>          Initial Pi model
  --thinking <level>      Initial Pi thinking level
  --models <patterns>     Limit the failover candidate scope
  -p, --print             Accepted for migration compatibility
  --no-session            Accepted; sessions are always ephemeral
  --no-extensions         Accepted; external discovery is always disabled
  -h, --help              Show this help`

const passthroughWithValue = new Set(['--provider', '--model', '--thinking', '--models'])
const acceptedNoops = new Set(['-p', '--print', '--no-session', '--no-extensions'])

export function parseArgs(argv) {
  const piArgs = []
  const files = []
  const prompt = []
  let timeoutMs = DEFAULT_TIMEOUT_MS
  let positional = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') { positional = true; continue }
    if (!positional && (arg === '-h' || arg === '--help')) return { help: true }
    if (!positional && arg === '--timeout-ms') {
      const raw = argv[++index]
      const value = Number(raw)
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('--timeout-ms must be a positive integer')
      timeoutMs = value
      continue
    }
    if (!positional && (arg === '--no-tools' || arg === '--no-context-files')) { piArgs.push(arg); continue }
    if (!positional && passthroughWithValue.has(arg)) {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      piArgs.push(arg, value)
      continue
    }
    if (!positional && acceptedNoops.has(arg)) continue
    if (!positional && arg.startsWith('-')) throw new Error(`unsupported option: ${arg}`)
    if (!positional && arg.startsWith('@')) {
      if (arg.length === 1) throw new Error('@file requires a path')
      files.push(arg.slice(1))
      continue
    }
    prompt.push(arg)
  }
  if (prompt.length === 0) throw new Error('a prompt is required')
  return { timeoutMs, piArgs, files, prompt: prompt.join(' ') }
}

export async function readTextFiles(fileArgs, cwd = process.cwd()) {
  let text = ''
  for (const raw of fileArgs) {
    const path = resolve(cwd, raw)
    try { await access(path) } catch { throw new Error(`file not found: ${path}`) }
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`not a regular text file: ${path}`)
    if (info.size === 0) continue
    let content
    try { content = await readFile(path, 'utf8') } catch { throw new Error(`not a UTF-8 text file: ${path}`) }
    if (content.includes('\0')) throw new Error(`binary files are not supported: ${path}`)
    text += `<file name="${path}">\n${content.replace(/^\uFEFF/, '')}\n</file>\n`
  }
  return text
}

export function buildMessage(fileText, prompt) {
  return fileText ? `${fileText}\n${prompt}` : prompt
}

const LEGACY_RUNNER_STEMS = new Set(['pi-ccswitch-run', 'ccswitch-run'])

function executableStem(value) {
  return String(value).split(/[\\/]/).pop().toLowerCase().replace(/\.(cmd|exe|bat)$/, '')
}

function validPiBinary(value) {
  return executableStem(value) === 'pi'
}

export function selectPiBinary(configured, warn = () => {}) {
  if (!configured) return 'pi'
  if (validPiBinary(configured)) return configured
  if (LEGACY_RUNNER_STEMS.has(executableStem(configured))) {
    warn("PI_BIN points to a legacy runner wrapper; ignoring it and falling back to 'pi' on PATH")
    return 'pi'
  }
  throw new Error('PI_BIN must name the real pi executable, not an arbitrary command')
}

async function resolveWindowsShim(command) {
  const candidates = []
  if (isAbsolute(command) || command.includes('\\') || command.includes('/')) candidates.push(command)
  else {
    for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
      candidates.push(join(dir, command))
      if (!/\.(cmd|bat)$/i.test(command)) candidates.push(join(dir, `${command}.cmd`))
    }
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate) || !/\.(cmd|bat)$/i.test(candidate)) continue
    const source = await readFile(candidate, 'utf8').catch(() => '')
    const match = source.match(/["']([^"']+\.js)["']/i)
    if (!match) continue
    const target = match[1].replace(/%~dp0/ig, `${dirname(candidate)}\\`)
    const entry = resolve(target.replace(/\\/g, '/'))
    if (existsSync(entry)) return { command: process.execPath, prefix: [entry] }
  }
  return { command, prefix: [] }
}

async function resolvePiCommand() {
  const configured = String(process.env.PI_BIN || '').trim()
  const command = selectPiBinary(configured, message => process.stderr.write(`pi-ccswitch-run: warning: ${message}\n`))
  if (process.platform === 'win32') return resolveWindowsShim(command)
  return { command, prefix: [] }
}

function terminateTree(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    killer.on('error', () => { try { child.kill('SIGKILL') } catch {} })
    return
  }
  try { child.kill(signal) } catch {}
  setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 1_000).unref()
}

function customEntry(event) {
  if (event?.type !== 'entry_appended' || event.entry?.type !== 'custom') return undefined
  return { type: event.entry.customType, data: event.entry.data || {} }
}

export async function run(options, runtime = {}) {
  const spawnImpl = runtime.spawn || spawn
  const extensionPath = runtime.extensionPath || fileURLToPath(new URL('./index.ts', import.meta.url))
  const resolvePi = runtime.resolvePiCommand || resolvePiCommand
  const log = runtime.log || ((message) => process.stderr.write(`[ccswitch] ${message}\n`))
  const resolved = await resolvePi()
  const args = [...resolved.prefix, '--mode', 'rpc', '--no-session', '--no-extensions', '--extension', extensionPath, ...options.piArgs]
  const child = spawnImpl(resolved.command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: process.env })
  let buffer = ''
  let closed = false
  let terminal
  let retryPending = false
  let protocolError
  let nextId = 1
  const pending = new Map()
  const closeStdin = () => { try { child.stdin?.end() } catch {} }
  const request = (type, payload = {}) => new Promise((resolveRequest, rejectRequest) => {
    const id = String(nextId++)
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest })
    try { child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`) } catch (error) { pending.delete(id); rejectRequest(error) }
  })
  const failPending = (error) => {
    for (const item of pending.values()) item.reject(error)
    pending.clear()
  }
  const handleEvent = (event) => {
    if (event?.type === 'extension_error') { protocolError = `extension error: ${event.error}`; return }
    if (event?.type === 'turn_start') retryPending = false
    const entry = customEntry(event)
    if (!entry) {
      if (event?.type === 'agent_settled' && !terminal && !retryPending) {
        protocolError = 'Pi settled without a CCSwitch terminal event'
      }
      return
    }
    if (entry.data?.protocolVersion !== 1) return
    if (entry.type === 'ccswitch-switch') {
      retryPending = true
      log(`switch ${entry.data.from || '?'} → ${entry.data.to || '?'} (${entry.data.attempts ?? '?'})`)
    } else if (entry.type === 'ccswitch-complete') {
      terminal = { kind: 'complete', data: entry.data }
    } else if (entry.type === 'ccswitch-exhausted') {
      terminal = { kind: 'exhausted', data: entry.data }
    }
  }
  const processLine = (line) => {
    if (!line.trim()) return
    let event
    try { event = JSON.parse(line) } catch { protocolError = 'Pi RPC emitted malformed JSONL'; return }
    if (event?.type === 'response' && event.id !== undefined) {
      const item = pending.get(String(event.id))
      if (item) {
        pending.delete(String(event.id))
        if (event.success) item.resolve(event.data)
        else item.reject(new Error(event.error || `${event.command || 'RPC'} failed`))
      }
      return
    }
    handleEvent(event)
  }
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      processLine(line)
    }
  })
  child.stderr?.on('data', () => {})
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('close', (code, signal) => { closed = true; resolveExit({ code, signal }) })
  })
  const timeout = setTimeout(() => { protocolError = 'runner timed out'; terminateTree(child) }, options.timeoutMs)
  timeout.unref?.()
  const onSignal = (signal, code) => {
    protocolError = signal
    terminateTree(child, signal)
    process.exitCode = code
  }
  const onSigint = () => onSignal('SIGINT', EXIT.INTERRUPTED)
  const onSigterm = () => onSignal('SIGTERM', EXIT.TERMINATED)
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  try {
    const commands = await request('get_commands')
    if (!Array.isArray(commands?.commands) || !commands.commands.some((entry) => entry.name === 'ccswitch')) {
      throw new Error('CCSwitch extension did not load')
    }
    await request('prompt', { message: options.message })
    while (!terminal && !protocolError && !closed) await new Promise(resolveWait => setTimeout(resolveWait, 10))
    if (protocolError) {
      closeStdin()
      await exit.catch(() => {})
      if (protocolError === 'runner timed out') return { code: EXIT.TIMEOUT, error: protocolError }
      if (protocolError === 'SIGINT') return { code: EXIT.INTERRUPTED, error: protocolError }
      if (protocolError === 'SIGTERM') return { code: EXIT.TERMINATED, error: protocolError }
      return { code: EXIT.CONFIG, error: protocolError }
    }
    if (!terminal) return { code: EXIT.CONFIG, error: 'Pi exited before CCSwitch reached a terminal state' }
    if (terminal.kind === 'exhausted') {
      closeStdin()
      await exit.catch(() => {})
      return { code: EXIT.EXHAUSTED, error: terminal.data.reason || 'all candidate models were exhausted' }
    }
    const last = await request('get_last_assistant_text')
    const text = String(last?.text || '').trim()
    closeStdin()
    await exit.catch(() => {})
    if (!text) return { code: EXIT.CONFIG, error: 'CCSwitch completed but Pi returned no assistant text' }
    return { code: EXIT.SUCCESS, text }
  } catch (error) {
    terminateTree(child)
    closeStdin()
    await exit.catch(() => {})
    return { code: EXIT.CONFIG, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    if (!closed) { failPending(new Error('runner stopped')); terminateTree(child) }
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options
  try { options = parseArgs(argv) } catch (error) { process.stderr.write(`pi-ccswitch-run: ${error.message}\n${usage}\n`); return EXIT.CONFIG }
  if (options.help) { process.stdout.write(`${usage}\n`); return EXIT.SUCCESS }
  try {
    const fileText = await readTextFiles(options.files)
    const result = await run({ ...options, message: buildMessage(fileText, options.prompt) })
    if (result.text) process.stdout.write(`${result.text}\n`)
    if (result.error) process.stderr.write(`pi-ccswitch-run: ${result.error}\n`)
    return result.code
  } catch (error) {
    process.stderr.write(`pi-ccswitch-run: ${error instanceof Error ? error.message : String(error)}\n`)
    return EXIT.CONFIG
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) main().then(code => { process.exitCode = code })
