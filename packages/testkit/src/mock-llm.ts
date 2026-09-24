/**
 * MockLlmServer: lightweight scripted OpenAI-compatible HTTP server
 * providing `/v1/chat/completions` and `/v1/models` for testing dsh
 * without external network access or paid API keys.
 */
import http from 'node:http'

export interface MockLlmOptions {
  port?: number
  apiKey?: string
  modelName?: string
  responseHandler?: ((reqBody: any) => any) | undefined
}

export class MockLlmServer {
  private server: http.Server | null = null
  private requests: any[] = []
  readonly port: number
  readonly apiKey: string
  readonly modelName: string
  private responseHandler?: ((reqBody: any) => any) | undefined

  constructor(options: MockLlmOptions = {}) {
    this.port = options.port ?? 0
    this.apiKey = options.apiKey ?? 'mock-key'
    this.modelName = options.modelName ?? 'deepseek-chat'
    this.responseHandler = options.responseHandler
  }

  get baseURL(): string {
    if (!this.server) throw new Error('MockLlmServer not started')
    const addr = this.server.address()
    if (!addr || typeof addr === 'string') throw new Error('Address unavailable')
    return `http://127.0.0.1:${addr.port}/v1`
  }

  get recordedRequests(): readonly any[] {
    return this.requests
  }

  clearRequests(): void {
    this.requests = []
  }

  setResponseHandler(handler: (reqBody: any) => any): void {
    this.responseHandler = handler
  }

  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1`)

        if (url.pathname === '/v1/models' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            object: 'list',
            data: [
              {
                id: this.modelName,
                object: 'model',
                created: 1700000000,
                owned_by: 'deepseek',
              },
            ],
          }))
          return
        }

        if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
          let bodyStr = ''
          req.on('data', (chunk) => {
            bodyStr += chunk
          })
          req.on('end', () => {
            let parsedBody: any = {}
            try {
              parsedBody = JSON.parse(bodyStr)
            } catch {
              // bad json
            }
            this.requests.push(parsedBody)

            if (this.responseHandler) {
              const customRes = this.responseHandler(parsedBody)
              if (customRes) {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify(customRes))
                return
              }
            }

            // Default simple assistant message completion
            const stream = Boolean(parsedBody.stream)
            if (stream) {
              res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
              })
              const chunk1 = {
                id: 'chatcmpl-mock',
                object: 'chat.completion.chunk',
                created: Date.now(),
                model: this.modelName,
                choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello from mock LLM!' }, finish_reason: null }],
              }
              const chunk2 = {
                id: 'chatcmpl-mock',
                object: 'chat.completion.chunk',
                created: Date.now(),
                model: this.modelName,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              }
              res.write(`data: ${JSON.stringify(chunk1)}\n\n`)
              res.write(`data: ${JSON.stringify(chunk2)}\n\n`)
              res.write('data: [DONE]\n\n')
              res.end()
            } else {
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(JSON.stringify({
                id: 'chatcmpl-mock',
                object: 'chat.completion',
                created: Date.now(),
                model: this.modelName,
                choices: [
                  {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: 'Hello from mock LLM!',
                    },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
              }))
            }
          })
          return
        }

        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not_found' }))
      })

      this.server.listen(this.port, '127.0.0.1', () => {
        resolve()
      })
      this.server.on('error', reject)
    })
  }

  async close(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()))
      this.server = null
    }
  }
}
