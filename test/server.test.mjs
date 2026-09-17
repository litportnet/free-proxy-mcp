import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client as FreeProxyClient } from '@litportnet/free-proxy-sdk'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../src/server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'api-snapshot.json'), 'utf8'))

// The fixture's generatedAt is 2026-09-10T00:00:00.000Z and every proxy's
// pingAt falls in the ten minutes before it. This fixed "now" sits inside
// the SDK's two-minute generatedAt freshness window and inside the default
// 30-minute checkedWithinMin window for every fixture record.
const FIXED_NOW = new Date('2026-09-10T00:01:00.000Z')

function freshFixtureTransport() {
  return async () => ({ status: 200, headers: {}, body: fixture })
}

function failingTransport(message) {
  return async () => {
    throw new Error(message)
  }
}

async function connectedClient(freeProxyClient) {
  const server = createServer({ client: freeProxyClient })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const mcpClient = new McpClient({ name: 'test-client', version: '0.0.0' })
  await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)])
  return mcpClient
}

function freshClient() {
  return new FreeProxyClient({ transport: freshFixtureTransport(), now: () => FIXED_NOW })
}

test('tools/list returns exactly the three read-only tools', async () => {
  const mcpClient = await connectedClient(freshClient())
  const { tools } = await mcpClient.listTools()
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['list_proxies', 'pick_best_proxies', 'proxy_snapshot_stats'],
  )
})

test('list_proxies respects limit and protocol', async () => {
  const mcpClient = await connectedClient(freshClient())
  const result = await mcpClient.callTool({
    name: 'list_proxies',
    arguments: { protocol: 'http', limit: 2 },
  })
  assert.equal(result.isError, undefined)
  assert.ok(result.structuredContent)
  assert.ok(result.structuredContent.count <= 2)
  assert.equal(result.structuredContent.proxies.length, result.structuredContent.count)
  for (const proxy of result.structuredContent.proxies) {
    assert.equal(proxy.protocol, 'http')
  }
  assert.match(result.structuredContent.disclaimer, /testing only/)
})

test('pick_best_proxies respects count', async () => {
  const mcpClient = await connectedClient(freshClient())
  const result = await mcpClient.callTool({
    name: 'pick_best_proxies',
    arguments: { count: 3 },
  })
  assert.equal(result.isError, undefined)
  assert.equal(result.structuredContent.count, 3)
  assert.equal(result.structuredContent.proxies.length, 3)
})

test('proxy_snapshot_stats returns coherent totals', async () => {
  const mcpClient = await connectedClient(freshClient())
  const result = await mcpClient.callTool({
    name: 'proxy_snapshot_stats',
    arguments: {},
  })
  assert.equal(result.isError, undefined)
  const stats = result.structuredContent

  // All 8 fixture records are fresh relative to FIXED_NOW under the default
  // 30-minute checkedWithinMin window.
  assert.equal(stats.totalCount, 8)

  const protocolSum = Object.values(stats.byProtocol).reduce((total, n) => total + n, 0)
  assert.equal(protocolSum, stats.totalCount)

  const anonymitySum = Object.values(stats.byAnonymity).reduce((total, n) => total + n, 0)
  assert.equal(anonymitySum, stats.totalCount)

  const topCountriesSum = stats.topCountries.reduce((total, entry) => total + entry.count, 0)
  assert.equal(topCountriesSum, stats.totalCount)
  assert.ok(stats.topCountries.length <= 10)

  assert.ok(stats.httpsShare >= 0 && stats.httpsShare <= 1)

  // Fixture has one record with responseTimeMs: null, so only 7 of 8 report latency.
  assert.equal(stats.latencyMs.sampleSize, 7)
  assert.ok(stats.latencyMs.min <= stats.latencyMs.median)
  assert.ok(stats.latencyMs.median <= stats.latencyMs.p90)
  assert.ok(stats.latencyMs.p90 <= stats.latencyMs.max)

  // Fixture has two records with checks7d < 50 (10 and 45), so uptime7d is
  // nulled for those; the other six keep a known uptime7d.
  assert.equal(stats.knownUptime7dCount, 6)

  assert.ok(stats.oldestLastChecked <= stats.newestLastChecked)
})

test('proxy_snapshot_stats respects a protocol filter', async () => {
  const mcpClient = await connectedClient(freshClient())
  const result = await mcpClient.callTool({
    name: 'proxy_snapshot_stats',
    arguments: { protocol: 'socks5' },
  })
  const stats = result.structuredContent
  assert.deepEqual(Object.keys(stats.byProtocol), ['socks5'])
  assert.equal(stats.totalCount, stats.byProtocol.socks5)
})

test('invalid input is rejected without reaching the SDK', async () => {
  const mcpClient = await connectedClient(freshClient())
  const result = await mcpClient.callTool({
    name: 'list_proxies',
    arguments: { country: 'usa', limit: 999 },
  })
  assert.equal(result.isError, true)
  assert.equal(result.content[0].type, 'text')
  assert.match(result.content[0].text, /Input validation error/)
})

test('a transport failure surfaces as isError: true, not a thrown exception', async () => {
  const failing = new FreeProxyClient({ transport: failingTransport('network down'), now: () => FIXED_NOW })
  const mcpClient = await connectedClient(failing)
  const result = await mcpClient.callTool({ name: 'list_proxies', arguments: {} })
  assert.equal(result.isError, true)
  assert.equal(result.content[0].type, 'text')
  assert.match(result.content[0].text, /^FreeProxyError:/)
  // The error text must not leak a stack trace.
  assert.doesNotMatch(result.content[0].text, /\n\s+at /)
})
