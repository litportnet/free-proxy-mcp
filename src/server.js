#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Client, DEFAULT_API_URL } from '@litportnet/free-proxy-sdk'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))

const DISCLAIMER =
  'Free proxies are unaffiliated third-party endpoints for testing only. Never send credentials, cookies, or private data through them.'

const PROTOCOLS = ['http', 'socks4', 'socks5']
const ANONYMITY = ['transparent', 'anonymous', 'elite', 'unknown']

function isAbsoluteHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function resolveApiUrl() {
  const value = process.env.LITPORT_FREE_PROXY_API_URL
  if (value == null || value === '') return DEFAULT_API_URL
  if (!isAbsoluteHttpUrl(value)) {
    console.error(
      `litportnet-free-proxy-mcp: LITPORT_FREE_PROXY_API_URL must be an absolute http(s) URL, got: ${value}`,
    )
    process.exit(1)
  }
  return value
}

function resolveTimeoutMs() {
  const raw = process.env.LITPORT_FREE_PROXY_TIMEOUT_MS
  if (raw == null || raw === '') return 10000
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(
      `litportnet-free-proxy-mcp: LITPORT_FREE_PROXY_TIMEOUT_MS must be a positive integer, got: ${raw}`,
    )
    process.exit(1)
  }
  return parsed
}

// Shared filter inputs. Every proxy-listing tool accepts a subset of these.
const filterShape = {
  protocol: z.enum(PROTOCOLS).optional().describe('Restrict results to this proxy protocol.'),
  country: z
    .string()
    .regex(/^[a-zA-Z]{2}$/, 'country must be a two-letter ISO 3166-1 alpha-2 code')
    .optional()
    .describe('Two-letter ISO 3166-1 alpha-2 country code (case-insensitive).'),
  anonymity: z.enum(ANONYMITY).optional().describe('Restrict results to this anonymity classification.'),
  https: z.boolean().optional().describe('Restrict results to proxies that do (true) or do not (false) support HTTPS.'),
  maxLatencyMs: z.number().int().min(0).optional().describe('Keep only proxies whose latest latency is at most this many milliseconds.'),
  minUptime7d: z.number().int().min(0).max(100).optional().describe('Keep only proxies whose seven-day uptime percentage is at least this value.'),
  minChecks7d: z.number().int().min(0).optional().describe('Keep only proxies with at least this many checks in the last seven days.'),
  checkedWithinMin: z
    .number()
    .int()
    .min(1)
    .max(1440)
    .default(30)
    .describe('Only include proxies last checked within this many minutes (1-1440).'),
}

function buildFilters({ protocol, country, anonymity, https, maxLatencyMs, minUptime7d, minChecks7d, checkedWithinMin }) {
  const filters = { checkedWithinMin }
  if (protocol != null) filters.protocol = protocol
  if (country != null) filters.country = country
  if (anonymity != null) filters.anonymity = anonymity
  if (https != null) filters.https = https
  if (maxLatencyMs != null) filters.maxLatencyMs = maxLatencyMs
  if (minUptime7d != null) filters.minUptime7d = minUptime7d
  if (minChecks7d != null) filters.minChecks7d = minChecks7d
  return filters
}

function errorResult(error) {
  const name = error && error.name ? error.name : 'Error'
  const message = error && error.message ? error.message : String(error)
  return { isError: true, content: [{ type: 'text', text: `${name}: ${message}` }] }
}

function jsonResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  }
}

function countBy(items, keyFn) {
  const counts = {}
  for (const item of items) {
    const key = keyFn(item)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

// Linear-interpolation percentile over an already-sorted ascending array.
function percentile(sortedValues, p) {
  if (sortedValues.length === 1) return sortedValues[0]
  const index = p * (sortedValues.length - 1)
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sortedValues[lower]
  const weight = index - lower
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight
}

function summarizeProxies(proxies) {
  const totalCount = proxies.length
  const byProtocol = countBy(proxies, (p) => p.protocol)
  const byAnonymity = countBy(proxies, (p) => p.anonymity)
  const byCountry = countBy(proxies, (p) => p.country ?? 'unknown')
  const topCountries = Object.entries(byCountry)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([country, count]) => ({ country, count }))

  const httpsCount = proxies.filter((p) => p.https === true).length
  const httpsShare = totalCount === 0 ? 0 : httpsCount / totalCount

  const latencies = proxies
    .map((p) => p.latencyMs)
    .filter((v) => v != null)
    .sort((a, b) => a - b)
  const latencyMs =
    latencies.length === 0
      ? { sampleSize: 0, min: null, median: null, p90: null, max: null }
      : {
          sampleSize: latencies.length,
          min: latencies[0],
          median: percentile(latencies, 0.5),
          p90: percentile(latencies, 0.9),
          max: latencies[latencies.length - 1],
        }

  const knownUptime7dCount = proxies.filter((p) => p.uptime7d != null).length

  const lastCheckedTimestamps = proxies.map((p) => p.lastChecked).filter(Boolean).sort()
  const oldestLastChecked = lastCheckedTimestamps.length ? lastCheckedTimestamps[0] : null
  const newestLastChecked = lastCheckedTimestamps.length
    ? lastCheckedTimestamps[lastCheckedTimestamps.length - 1]
    : null

  return {
    totalCount,
    byProtocol,
    byAnonymity,
    topCountries,
    httpsShare,
    latencyMs,
    knownUptime7dCount,
    oldestLastChecked,
    newestLastChecked,
  }
}

export function createServer({ client } = {}) {
  const proxyClient =
    client ?? new Client({ apiUrl: resolveApiUrl(), timeoutMs: resolveTimeoutMs() })

  const server = new McpServer({ name: 'litportnet-free-proxy', version: pkg.version })

  server.registerTool(
    'list_proxies',
    {
      description: 'List verified free proxies matching filters.',
      inputSchema: {
        ...filterShape,
        limit: z.number().int().min(1).max(50).default(10).describe('Maximum number of proxies to return (1-50).'),
      },
    },
    async (input) => {
      try {
        const filters = buildFilters(input)
        filters.limit = input.limit
        const proxies = await proxyClient.getProxies(filters)
        return jsonResult({ count: proxies.length, proxies, disclaimer: DISCLAIMER })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'pick_best_proxies',
    {
      description: 'Return the highest-ranked proxies matching filters.',
      inputSchema: {
        ...filterShape,
        count: z.number().int().min(1).max(25).default(5).describe('Number of top-ranked proxies to return (1-25).'),
      },
    },
    async (input) => {
      try {
        const { count, ...rest } = input
        const filters = buildFilters(rest)
        const proxies = await proxyClient.pickBest(count, filters)
        return jsonResult({ count: proxies.length, proxies, disclaimer: DISCLAIMER })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'proxy_snapshot_stats',
    {
      description: 'Summarize the current proxy snapshot.',
      inputSchema: {
        protocol: filterShape.protocol,
        country: filterShape.country,
        checkedWithinMin: filterShape.checkedWithinMin,
      },
    },
    async (input) => {
      try {
        const filters = buildFilters({ ...input, anonymity: undefined, https: undefined })
        const proxies = await proxyClient.getProxies(filters)
        return jsonResult({ ...summarizeProxies(proxies), disclaimer: DISCLAIMER })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  return server
}

// process.argv[1] is the path as invoked, which for an installed package is the
// node_modules/.bin symlink, while import.meta.url is always resolved. Compare real
// paths so the server still starts when launched through its bin entry or npx.
function isEntryPoint() {
  const invoked = process.argv[1]
  if (invoked == null) return false
  const thisFile = fileURLToPath(import.meta.url)
  if (invoked === thisFile) return true
  try {
    return realpathSync(invoked) === realpathSync(thisFile)
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  const server = createServer()
  const transport = new StdioServerTransport()
  server.connect(transport).catch((error) => {
    console.error('litportnet-free-proxy-mcp: fatal error', error)
    process.exit(1)
  })
}
