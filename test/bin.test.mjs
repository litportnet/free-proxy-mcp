import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.js')

// An installed package is launched through node_modules/.bin, which is a symlink.
// Regression guard: the entry-point check must resolve real paths, or `npx` starts
// the process and exits silently without ever serving the protocol.
test('starts when launched through a bin symlink', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'litport-mcp-bin-'))
  const linkPath = join(directory, 'litportnet-free-proxy-mcp')
  symlinkSync(serverPath, linkPath)

  try {
    const child = spawn(process.execPath, [linkPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }

    const line = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for an initialize response')), 10000)
      let buffered = ''
      child.stdout.on('data', chunk => {
        buffered += chunk
        const newline = buffered.indexOf('\n')
        if (newline !== -1) {
          clearTimeout(timer)
          resolve(buffered.slice(0, newline))
        }
      })
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`server exited early with code ${code}`)) })
      child.stdin.write(`${JSON.stringify(request)}\n`)
    }).finally(() => child.kill())

    assert.equal(JSON.parse(line).result.serverInfo.name, 'litportnet-free-proxy')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
