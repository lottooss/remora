import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { createTestAgent } from '../notify/dsh-test-events.ts'
import { loadApprovalRequest, loadFollowEvents } from './fixtures.ts'

/**
 * Replays the recorded tool call into the real pinned dsh Session. Its
 * snapshotEvents method reads instance state, exactly as it does inside dsh.
 * Only arguments/name are varied for the policy boundary cases.
 */
export function createApprovalJournalAgent(rawArguments?: string, toolName = 'bash') {
  const recorded = loadApprovalRequest()
  const event = loadFollowEvents('follow-tool-approval.jsonl').find((item) => item.type === 'tool/call')
  const data = event?.data
  if (typeof data !== 'object' || data === null || !('arguments' in data) || typeof data.arguments !== 'string') {
    throw new Error('recorded tool/call arguments are missing')
  }
  const agent = createTestAgent(recorded.request.agent.id)
  agent.session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: ToolCallId(recorded.request.callId ?? 'mock-call-1'),
    name: toolName,
    arguments: rawArguments ?? data.arguments,
  })
  return agent
}
