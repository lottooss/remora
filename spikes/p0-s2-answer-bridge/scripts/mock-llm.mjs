/**
 * Programmatic wrapper for @deepseek-ai/dsh-llm-mock-server (no published bin).
 *
 * Usage:
 *   node scripts/mock-llm.mjs --port 8718 --api-key KEY \
 *     --sequence tool_call_success,success --repeat-last \
 *     [--tool-name p0s2_probe] [--tool-arguments '{"note":"e1"}']
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const installDir = join(here, '..', '.install')
const require = createRequire(join(installDir, 'package.json'))
const { startMockLlmServer } = require('@deepseek-ai/dsh-llm-mock-server')

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  return process.argv[index + 1]
}

const sequence = (arg('sequence', 'success') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const toolName = arg('tool-name', 'mock_tool')
const toolArguments = arg('tool-arguments', '{"value":"mock"}')

try {
  JSON.parse(toolArguments)
} catch {
  console.error(`mock-llm: invalid --tool-arguments JSON: ${toolArguments}`)
  process.exit(2)
}

const server = await startMockLlmServer({
  host: '127.0.0.1',
  port: Number(arg('port', '8718')),
  apiKey: arg('api-key', ''),
  sequence,
  repeatLast: process.argv.includes('--repeat-last'),
  toolName,
  toolArguments,
  onEvent: (event) => {
    console.log(JSON.stringify(event))
  },
})

console.log(JSON.stringify({
  type: 'ready',
  baseURL: server.baseURL,
  port: server.port,
  sequence,
  toolName,
}))

const shutdown = async () => {
  try { await server.close() } catch { /* already closed */ }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
