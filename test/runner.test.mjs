import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXIT, buildMessage, parseArgs, readTextFiles, run } from '../runner.mjs'

function fakeRpc({ terminal = 'complete', commands = true } = {}) {
  const child = new EventEmitter()
  child.exitCode = null
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new EventEmitter()
  child.stdin.write = (line) => {
    const request = JSON.parse(String(line))
    const respond = (data) => child.stdout.write(`${JSON.stringify({ id: request.id, type: 'response', command: request.type, success: true, ...(data === undefined ? {} : { data }) })}\n`)
    if (request.type === 'get_commands') respond({ commands: commands ? [{ name: 'ccswitch' }] : [] })
    if (request.type === 'prompt') {
      respond()
      child.stdout.write(`${JSON.stringify({ type: 'entry_appended', entry: { type: 'custom', customType: 'ccswitch-switch', data: { protocolVersion: 1, from: 'a/m', to: 'b/m', attempts: 1 } } })}\n`)
      child.stdout.write(`${JSON.stringify({ type: 'agent_settled' })}\n`)
      child.stdout.write(`${JSON.stringify({ type: 'turn_start' })}\n`)
      child.stdout.write(`${JSON.stringify({ type: 'entry_appended', entry: { type: 'custom', customType: terminal === 'complete' ? 'ccswitch-complete' : 'ccswitch-exhausted', data: { protocolVersion: 1, ...(terminal === 'complete' ? {} : { reason: 'no candidates' }) } } })}\n`)
    }
    if (request.type === 'get_last_assistant_text') respond({ text: 'final answer' })
    return true
  }
  child.stdin.end = () => {
    child.exitCode = 0
    queueMicrotask(() => child.emit('close', 0, null))
  }
  return child
}

test('runner returns only the final answer after an intermediate switch', async () => {
  const child = fakeRpc()
  const result = await run(
    { piArgs: ['--no-tools'], timeoutMs: 2_000, message: 'hello' },
    { spawn: () => child, resolvePiCommand: async () => ({ command: 'pi', prefix: [] }), extensionPath: '/extension/index.ts', log: () => {} },
  )
  assert.equal(result.code, EXIT.SUCCESS)
  assert.equal(result.text, 'final answer')
})

test('runner reports candidate exhaustion as a terminal non-retryable result', async () => {
  const child = fakeRpc({ terminal: 'exhausted' })
  const result = await run(
    { piArgs: [], timeoutMs: 2_000, message: 'hello' },
    { spawn: () => child, resolvePiCommand: async () => ({ command: 'pi', prefix: [] }), extensionPath: '/extension/index.ts', log: () => {} },
  )
  assert.equal(result.code, EXIT.EXHAUSTED)
  assert.match(result.error, /no candidates/)
})

test('runner rejects a Pi process that did not load CCSwitch', async () => {
  const child = fakeRpc({ commands: false })
  const result = await run(
    { piArgs: [], timeoutMs: 2_000, message: 'hello' },
    { spawn: () => child, resolvePiCommand: async () => ({ command: 'pi', prefix: [] }), extensionPath: '/extension/index.ts', log: () => {} },
  )
  assert.equal(result.code, EXIT.CONFIG)
  assert.match(result.error, /did not load/)
})

test('runner parses supported arguments and wraps text attachments like Pi', async () => {
  assert.deepEqual(parseArgs(['--timeout-ms', '42', '--no-tools', '@input.md', 'summarize']), {
    timeoutMs: 42, piArgs: ['--no-tools'], files: ['input.md'], prompt: 'summarize',
  })
  assert.throws(() => parseArgs(['--bad', 'prompt']), /unsupported option/)
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-runner-'))
  try {
    const path = join(dir, 'input.md')
    await writeFile(path, '\ufeffbody', 'utf8')
    const attached = await readTextFiles([path])
    assert.equal(buildMessage(attached, 'summarize'), `<file name="${path}">\nbody\n</file>\n\nsummarize`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
