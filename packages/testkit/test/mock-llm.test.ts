import { describe, expect, it, afterEach } from 'vitest'
import { MockLlmServer } from '../src/mock-llm.ts'

describe('MockLlmServer', () => {
  let server: MockLlmServer | null = null

  afterEach(async () => {
    if (server) {
      await server.close()
      server = null
    }
  })

  it('serves model catalog and chat completions', async () => {
    server = new MockLlmServer()
    await server.start()

    const modelsRes = await fetch(`${server.baseURL}/models`)
    expect(modelsRes.status).toBe(200)
    const modelsData = (await modelsRes.json()) as any
    expect(modelsData.data[0].id).toBe('deepseek-chat')

    const chatRes = await fetch(`${server.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(chatRes.status).toBe(200)
    const chatData = (await chatRes.json()) as any
    expect(chatData.choices[0].message.content).toBe('Hello from mock LLM!')
    expect(server.recordedRequests.length).toBe(1)
  })

  it('handles streaming SSE completions', async () => {
    server = new MockLlmServer()
    await server.start()

    const chatRes = await fetch(`${server.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'stream me' }],
        stream: true,
      }),
    })
    expect(chatRes.status).toBe(200)
    expect(chatRes.headers.get('content-type')).toContain('text/event-stream')
    const body = await chatRes.text()
    expect(body).toContain('data: [DONE]')
  })
})
