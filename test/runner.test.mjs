import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXIT, buildMessage, parseArgs, readTextFiles, run, selectPiBinary } from '../runner.mjs'

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

test('legacy runner PI_BIN values warn and fall back without allowing arbitrary commands', () => {
  const warnings = []
  const warn = message => warnings.push(message)
  for (const configured of [
    'pi-ccswitch-run',
    'ccswitch-run.cmd',
    '/opt/bin/pi-ccswitch-run',
    'C:\\tools\\PI-CCSWITCH-RUN.EXE',
  ]) {
    assert.equal(selectPiBinary(configured, warn), 'pi')
  }
  assert.equal(warnings.length, 4)
  assert.ok(warnings.every(message => /legacy runner wrapper/.test(message)))
  assert.equal(selectPiBinary('', warn), 'pi')
  assert.equal(selectPiBinary('/opt/pi.cmd', warn), '/opt/pi.cmd')
  assert.throws(() => selectPiBinary('node', warn), /real pi executable/)
  assert.throws(() => selectPiBinary('/usr/bin/echo', warn), /real pi executable/)
})

test('image files become RPC image parts rather than binary text', async () => {
  const { readAttachments } = await import('../runner.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-image-'))
  try {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex')
    await writeFile(join(dir, '图.png'), png)
    await writeFile(join(dir, 'note.md'), 'image instructions')
    const attached = await readAttachments([join(dir, 'note.md'), join(dir, '图.png')])
    assert.equal(attached.images.length, 1)
    assert.equal(attached.images[0].mimeType, 'image/png')
    assert.equal(attached.images[0].data, png.toString('base64'))
    assert.match(attached.fileText, /image instructions/)
    assert.ok(!attached.fileText.includes(png.toString('base64')))
    await writeFile(join(dir, 'bad.png'), 'not an image')
    await assert.rejects(readAttachments([join(dir, 'bad.png')]), /invalid|unsupported/i)
    await writeFile(join(dir, 'bad.bin'), Buffer.from([1, 0, 2]))
    await assert.rejects(readAttachments([join(dir, 'bad.bin')]), /binary/i)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('runner sends image parts intact in the prompt RPC request', async () => {
  const child = fakeRpc()
  const requests = []
  const write = child.stdin.write
  child.stdin.write = line => { requests.push(JSON.parse(line)); return write(line) }
  const images = [{ type: 'image', data: 'fixture-base64', mimeType: 'image/png' }]
  const result = await run(
    { piArgs: [], timeoutMs: 2_000, message: 'read this', images },
    { spawn: () => child, resolvePiCommand: async () => ({ command: 'pi', prefix: [] }), log: () => {} },
  )
  assert.equal(result.code, EXIT.SUCCESS)
  assert.deepEqual(requests.find(r => r.type === 'prompt').images, images)
})

test('complexity estimates distinguish short text, structured output, synthesis and images', async () => {
  const { assessComplexity } = await import('../runner.mjs')
  assert.equal(assessComplexity('请改写一句话', '', 0).level, 'low')
  assert.equal(assessComplexity('输出 JSON 结构化摘要', 'body', 0).level, 'medium')
  assert.equal(assessComplexity('跨文章按主题归纳观点', 'body', 0).level, 'high')
  assert.equal(assessComplexity('总结', '字'.repeat(30000), 0).level, 'high')
  assert.equal(assessComplexity('描述图片', '', 1).level, 'medium')
  assert.equal(assessComplexity('比较图片', '', 4).level, 'high')
})

test('complexity config applies thinking before prompt and honors explicit thinking', async () => {
  for (const explicit of [false, true]) {
    const child = fakeRpc()
    const requests = []
    const write = child.stdin.write
    child.stdin.write = line => {
      const req = JSON.parse(line); requests.push(req)
      if (req.type === 'set_thinking_level') {
        child.stdout.write(`${JSON.stringify({ type: 'response', id: req.id, success: true })}\n`)
        return true
      }
      return write(line)
    }
    const result = await run(
      { piArgs: explicit ? ['--thinking', 'low'] : [], complexity: 'high', timeoutMs: 2000, message: 'hello' },
      { spawn: () => child, resolvePiCommand: async () => ({ command: 'pi', prefix: [] }), log: () => {} },
    )
    assert.equal(result.code, EXIT.SUCCESS)
    const thinking = requests.findIndex(r => r.type === 'set_thinking_level')
    if (explicit) assert.equal(thinking, -1)
    else {
      assert.equal(requests[thinking].level, 'high')
      assert.ok(thinking < requests.findIndex(r => r.type === 'prompt'))
    }
  }
})

test('large image payloads use Pi normalization and never silently omit failed images', async () => {
  const { normalizeLargeImages } = await import('../runner.mjs')
  const small = {type: 'image', mimeType: 'image/png', data: 'small'}
  const large = {type: 'image', mimeType: 'image/png', data: 'A'.repeat(2 * 1024 * 1024)}
  let count = 0
  const result = await normalizeLargeImages([small, large], async () => {
    count++
    return {data: 'normalized', mimeType: 'image/jpeg'}
  })
  assert.equal(count, 1)
  assert.equal(result[0], small)
  assert.deepEqual(result[1], {type: 'image', data: 'normalized', mimeType: 'image/jpeg'})
  await assert.rejects(normalizeLargeImages([large], async () => null), /size limit/)
})

test('large image normalizer resolves both standard and bundled Pi CLI layouts', async () => {
  const { prepareImages } = await import('../runner.mjs')
  const { mkdir } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'pi-normalizer-layout-'))
  try {
    await mkdir(join(dir, 'dist', 'bundle'), {recursive: true})
    await mkdir(join(dir, 'dist', 'utils'), {recursive: true})
    await writeFile(join(dir, 'package.json'), '{"type":"module"}')
    await writeFile(join(dir, 'dist', 'utils', 'image-resize.js'), 'export async function resizeImage() { return {data:"normalized",mimeType:"image/jpeg"} }')
    for (const entry of [join(dir, 'dist', 'cli.js'), join(dir, 'dist', 'bundle', 'cli.js')]) {
      await writeFile(entry, '// cli')
      const result = await prepareImages([{type:'image',mimeType:'image/png',data:'A'.repeat(5*1024*1024)}], async () => ({command:entry,prefix:[]}))
      assert.equal(result[0].mimeType,'image/jpeg')
    }
  } finally { await rm(dir,{recursive:true,force:true}) }
})
