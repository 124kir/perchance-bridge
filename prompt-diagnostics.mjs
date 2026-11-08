// OpenRouter/OpenAI-compatible response metadata only. Never return content or reasoning.
// Explicit final-text fields only; reasoning, refusals and tool arguments are never prompts.
export function extractFinalResponseText(data) {
    const text = value => typeof value === 'string' ? value : Array.isArray(value)
        ? value.filter(p => ['text','output_text'].includes(p?.type) && typeof p.text === 'string').map(p => p.text).join('\n') : '';
    if (typeof data === 'string') return data;
    for (const value of [data?.choices?.[0]?.message?.content,data?.choices?.[0]?.text,data?.content,data?.text,data?.message?.content]) {
        const result = text(value);
        if (result.trim()) return result;
    }
    return '';
}
export function summarizeModelProbe(data) {
    const choice = data?.choices?.[0];
    const message = choice?.message;
    const textChars = extractFinalResponseText(data).trim().length;
    const reasoning = message?.reasoning ?? message?.reasoning_content ?? choice?.reasoning ?? '';
    const finish = choice?.finish_reason;
    const count = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
    return {
        textChars,
        reasoningChars: typeof reasoning === 'string' ? reasoning.trim().length : 0,
        finishReason: ['stop','length','content_filter','tool_calls','error'].includes(finish) ? finish : 'unknown',
        completionTokens: count(data?.usage?.completion_tokens),
        reasoningTokens: count(data?.usage?.completion_tokens_details?.reasoning_tokens),
    };
}
