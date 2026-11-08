import { summarizeModelProbe, extractFinalResponseText } from './prompt-diagnostics.mjs';

export function promptTokenLimit(value) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 512 && n <= 16384 ? n : 4096;
}

export function finalPromptText(value) {
    let text = String(value ?? '').trim();
    // Never treat a reasoning block as the visual prompt, including a truncated block.
    text = text.replace(/<(think|analysis)>[\s\S]*?<\/\1>/gi, '').trim();
    if (/<(?:think|analysis)>/i.test(text)) return '';
    return text.replace(/^```(?:\w+)?\s*|```$/g, '').trim();
}

/** Build context through ST; send exactly one text request, without character-reply cleanup. */
export async function requestChatPrompt(c, instruction, { tokens, onDiagnostic = () => {}, assertActive = () => {} } = {}) {
    const budget = promptTokenLimit(tokens);
    const event = (c.eventTypes ?? c.event_types)?.GENERATE_AFTER_DATA;
    const canBuildRaw = c.mainApi === 'openai' && !c.groupId && event &&
        typeof c.generate === 'function' && typeof c.generateRawData === 'function' &&
        typeof c.extractMessageFromData === 'function' && typeof c.eventSource?.removeListener === 'function';
    if (!canBuildRaw) {
        onDiagnostic({stage:'prompt-route',route:'native-quiet',responseTokens:budget});
        const text = await c.generateQuietPrompt({quietPrompt:instruction,responseLength:budget});
        assertActive();
        return finalPromptText(text);
    }
    onDiagnostic({stage:'prompt-route',route:'native-context-raw',responseTokens:budget});
    const marker = `PB_IMAGE_TASK_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const marked = `${instruction}\nTask reference: ${marker}. Do not include the reference in your answer.`;
    let messages = null;
    const capture = (data, dryRun) => {
        if (dryRun !== true || !Array.isArray(data?.prompt)) return;
        const belongs = data.prompt.some(m => typeof m?.content === 'string' ? m.content.includes(marker)
            : Array.isArray(m?.content) && m.content.some(p => p?.type === 'text' && p.text?.includes(marker)));
        if (belongs) messages = structuredClone(data.prompt).map(m => ({...m,
            // generateRawData formats strings, unlike the native multimodal sender.
            // Preparing a visual prompt needs text context, not private media payloads.
            content:Array.isArray(m.content) ? m.content.filter(p=>p?.type==='text' && typeof p.text==='string').map(p=>p.text).join('\n') : m.content,
        }));
    };
    c.eventSource.on(event,capture);
    try {
        // Generate(..., true) is the installed ST's documented dryRun: assembles only.
        await c.generate('quiet',{quiet_prompt:marked,force_name2:true},true);
    } finally { c.eventSource.removeListener(event,capture); }
    assertActive();
    if (!messages?.length) throw Error('SillyTavern не собрал контекст со служебной инструкцией. Запрос к модели не отправлен.');
    // Quiet instructions are normally a final system message. End this standalone
    // request with an explicit user task instead of asking the provider to continue
    // after a system-only tail. Preserve the native context and use one API call.
    const tail=messages.at(-1);
    if(tail?.role==='system' && tail.content?.trim()===marked.trim()){
        messages[messages.length-1]={role:'user',content:tail.content};
    }else messages.push({role:'user',content:marked});
    const settingsEvent = (c.eventTypes ?? c.event_types)?.CHAT_COMPLETION_SETTINGS_READY;
    const captureSettings = data => {
        if (!Array.isArray(data?.messages) || !data.messages.some(m => typeof m?.content === 'string' && m.content.includes(marker))) return;
        const lastRole = data.messages.at(-1)?.role;
        const limit = data.max_completion_tokens ?? data.max_tokens;
        onDiagnostic({stage:'prompt-request-settings',messageCount:data.messages.length,
            lastRole:['system','user','assistant','tool'].includes(lastRole)?lastRole:'unknown',
            stopCount:Array.isArray(data.stop)?data.stop.length:typeof data.stop==='string'?1:0,
            logitBiasCount:data.logit_bias && typeof data.logit_bias==='object'?Object.keys(data.logit_bias).length:0,
            tokenLimit:Number.isSafeInteger(limit)&&limit>0?limit:null});
    };
    try {
        if (settingsEvent) c.eventSource.on(settingsEvent,captureSettings);
        const data = await c.generateRawData({prompt:messages,responseLength:budget});
        assertActive();
        const summary = summarizeModelProbe(data);
        const native = c.extractMessageFromData(data,c.mainApi);
        const nativeText = typeof native === 'string' ? native : '';
        const text = nativeText.trim() ? nativeText : extractFinalResponseText(data);
        const prompt = finalPromptText(text);
        const message = data?.choices?.[0]?.message;
        const refusalChars = typeof message?.refusal === 'string' ? message.refusal.trim().length : 0;
        const toolCallCount = Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0;
        onDiagnostic({stage:'prompt-model-result',...summary,nativeTextChars:nativeText.trim().length,
            finalTextChars:prompt.length,textSource:nativeText.trim()?'native':'api-final',refusalChars,toolCallCount});
        if (!prompt) {
            const reason = summary.finishReason === 'length'
                ? 'Достигнут лимит ответа. Увеличь лимит токенов промпта.'
                : refusalChars ? 'Модель вернула отказ вместо визуального промпта.'
                : toolCallCount ? 'Модель вернула вызов инструмента вместо визуального промпта.'
                : text.trim() ? 'После удаления служебных блоков в ответе не осталось визуального промпта.'
                : 'API вернул пустой финальный текст.';
            const error=Error(`${reason} textChars=${summary.textChars}, finalChars=${prompt.length}, finish=${summary.finishReason}, reasoningTokens=${summary.reasoningTokens ?? 'unknown'}.`);
            if(!refusalChars && !toolCallCount && !text.trim() && summary.finishReason==='stop')error.code='empty-model-prompt';
            throw error;
        }
        return prompt;
    } finally {
        if (settingsEvent) c.eventSource.removeListener(settingsEvent,captureSettings);
        messages = null;
    }
}
