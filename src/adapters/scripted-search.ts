import type { ExecutionContext, ModelAdapter, ModelRequest, ModelResponse, ResultEnvelope } from '../contracts.js';

/** Deterministic protocol fixture. Not a language model or a quality evaluation. */
export class ScriptedSearchModel implements ModelAdapter {
  async generate(request: ModelRequest, context: ExecutionContext): Promise<ResultEnvelope<ModelResponse>> {
    if (context.signal?.aborted) return { ok: false, error: { code: 'CANCELLED', message: 'Fixture cancelled' }, evidence: [] };
    const last = request.messages.at(-1);
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    if (last?.role !== 'tool') {
      const query = request.messages.filter(x => x.role === 'user').map(x => x.content).join('\n');
      return { ok: true, evidence: [], usage, data: {
        text: '', finishReason: 'tool_call', usage,
        toolCalls: [{ id: `${context.taskId}:search`, name: 'search', input: { query, top_k: 2, request_id: context.taskId } }],
      } };
    }
    return { ok: true, evidence: [], usage, data: { text: last.content, finishReason: 'stop', usage } };
  }
}
