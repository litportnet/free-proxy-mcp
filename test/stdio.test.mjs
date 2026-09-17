import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverEntry = join(__dirname, '..', 'src', 'server.js')
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'api-snapshot.json'), 'utf8'))

// The SDK enforces a two-minute generatedAt window and filters records by a
// checkedWithinMin freshness window, so both must be regenerated relative to
// the real wall clock at test time rather than reused verbatim from the
// static fixture file.
function freshSnapshot() {
  const now = new Date()
  const proxies = fixture.proxies.map((proxy, index) => ({
    ...proxy,
    pingAt: new Date(now.getTime() - (index + 1) * 60000).toISOString(),
  }))
  return {
    ...fixture,
    generatedAt: now.toISOString(),
    count: proxies.length,
    totalCount: proxies.length,
    proxies,
  }
}

test('stdio end-to-end: initialize, tools/list, and tools/call round-trip', async () => {
  const snapshot = freshSnapshot()
  const httpServer = createHttpServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(snapshot))
  })
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const { port } = httpServer.address()
  const apiUrl = `http://127.0.0.1:${port}/snapshot`

  const stderrChunks = []
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, LITPORT_FREE_PROXY_API_URL: apiUrl },
    stderr: 'pipe',
  })
  transport.stderr?.on('data', (chunk) => stderrChunks.push(chunk))

  const client = new McpClient({ name: 'stdio-e2e-test', version: '0.0.0' })
  try {
    // client.connect() performs the initialize handshake and the
    // notifications/initialized follow-up.
    await client.connect(transport)

    const { tools } = await client.listTools()
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ['list_proxies', 'pick_best_proxies', 'proxy_snapshot_stats'],
    )

    const result = await client.callTool({ name: 'list_proxies', arguments: { limit: 3 } })
    assert.equal(result.isError, undefined)
    assert.ok(result.structuredContent.count <= 3)
    assert.equal(result.content[0].type, 'text')
    // The text payload must be valid JSON, proving nothing extra was mixed
    // into a protocol-carried field.
    JSON.parse(result.content[0].text)
  } finally {
    await client.close()
    await new Promise((resolve) => httpServer.close(resolve))
  }
})
