import { connectStorageChannel, requestStorageImage } from './companion-channel.mjs';
/**
 * Perchance iframe bridge. Based on the public perchance-ai-api postMessage contract.
 * No undocumented Perchance internal endpoints, credentials or challenge bypasses.
 */
export const PERCHANCE_ENDPOINT = 'https://perchance.org/perchance-ai-api';
// Actual generator iframe observed in the public page on 2026-10-26.
// The outer editor page is NOT a postMessage relay: the generator sends to parent only.
export const GENERATOR_ENDPOINT = 'https://a485ca10d45752b37a2b42b5434df493.perchance.org/perchance-ai-api';
export const ALLOWED_RESOLUTIONS = Object.freeze(['512x512', '512x768', '768x512', '768x768']);
export const TAG_REGEX = /\[PERCHANCE:\s*([^\]\r\n]{1,2000})\]/i;

export function findImageTag(text) {
    const match = TAG_REGEX.exec(String(text || ''));
    return match ? { full: match[0], prompt: match[1].trim(), index: match.index } : null;
}

export function trustedPerchanceOrigin(origin) {
    try {
        const u = new URL(origin);
        return u.origin === new URL(GENERATOR_ENDPOINT).origin;
    } catch { return false; }
}

export function validateRemoteImageUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null;
        const host = parsed.hostname.toLowerCase();
        if (!(host === 'user.uploads.dev' || host.endsWith('.uploads.dev') || host === 'perchance.org' || host.endsWith('.perchance.org'))) return null;
        return parsed.href;
    } catch { return null; }
}

export function unpackImageResult(value) {
    if (!value || value.ok === false) {
        throw new Error(String(value?.error || value?.message || 'Perchance вернул ошибку генерации'));
    }
    const dataUrl = typeof value.dataUrl === 'string' && value.dataUrl.length <= 21 * 1024 * 1024 && /^data:image\/(jpeg|jpg|png|webp);base64,[a-z\d+/=\s]+$/i.test(value.dataUrl)
        ? value.dataUrl.replace(/\s/g, '') : '';
    const url = validateRemoteImageUrl(value.url);
    if (!dataUrl && !url) throw new Error('Perchance не вернул допустимый URL или данные изображения');
    return { url, dataUrl, seed: value.seed ?? null };
}

export const openPerchanceChannel = connectStorageChannel;

export function requestImage(prompt, options = {}, env = {}) {
    const text = String(prompt || '').trim();
    if (!text || text.length > 2000) return Promise.reject(new Error('Промпт должен содержать 1–2000 символов'));
    if (options.transport === 'tab' && options.channel?.sessionId) return requestStorageImage(text,options,env).then(unpackImageResult);
    const doc = env.document || document;
    const win = env.window || window;
    const timeoutMs = env.timeoutMs || 180000;
    const id = (win.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).replaceAll('-', '');
    const params = new URLSearchParams({ prompt: text, format: 'json', id });
    const resolution = ALLOWED_RESOLUTIONS.includes(options.resolution) ? options.resolution : '768x768';
    params.set('resolution', resolution);
    if (options.negativePrompt) params.set('negativePrompt', String(options.negativePrompt).slice(0, 1000));
    const guidance = Number(options.guidanceScale);
    if (Number.isFinite(guidance)) params.set('guidanceScale', String(Math.max(1, Math.min(30, guidance))));
    const seed = Number(options.seed);
    if (Number.isSafeInteger(seed) && seed >= 0) params.set('seed', String(seed));
    if (options.removeBackground === true) params.set('removeBackground', 'true');

    if (options.transport === 'tab') {
        if (!options.popup) return Promise.reject(Object.assign(new Error('Канал Perchance не подключен. Команда не открывает окна автоматически.'),{code:'channel-not-connected'}));
        if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(win.location.origin)) return Promise.reject(new Error('Companion возвращает результат только в локальный SillyTavern. Используй ручной импорт.'));
        params.set('pbReturnOrigin', win.location.origin);
        return new Promise((resolve, reject) => {
            let popup, timer, handshakeTimer, ended = false;
            const signal = options.signal;
            const finish = (err, value) => {
                if (ended) return;
                ended = true; win.clearTimeout(timer); win.clearTimeout(handshakeTimer); win.removeEventListener('message', onMessage);
                signal?.removeEventListener('abort', onAbort);
                options.onDiagnostic?.({stage:err ? 'failed' : 'complete',code:err?.code || 'ok'});
                // Keep the ordinary tab open for manual checks/download, including after timeout.
                err ? reject(err) : resolve(value);
            };
            const onAbort = () => finish(Object.assign(new Error('Ожидание отменено. Открытая вкладка Perchance может продолжить работу; останови ее вручную.'), {code:'aborted'}));
            const onMessage = e => {
                if (e.source !== popup || e.origin !== 'https://perchance.org' || e.data?.id !== id) return;
                if (e.data?.api === 'perchance-bridge-ready') { win.clearTimeout(handshakeTimer); options.onDiagnostic?.({stage:'companion-ready'}); return; }
                if (e.data?.api !== 'perchance-bridge-result') return;
                try { finish(null, unpackImageResult(e.data.result)); } catch (err) { finish(err); }
            };
            if (signal?.aborted) { onAbort(); return; }
            win.addEventListener('message', onMessage);
            signal?.addEventListener('abort', onAbort, {once:true});
            try {
                popup = options.popup;
                if (popup.closed) throw new Error('closed');
                popup.location.href = `${PERCHANCE_ENDPOINT}?${params}`;
            }
            catch { popup = null; /* blocked popup or navigation */ }
            if (!popup) { finish(Object.assign(new Error('Подключенная вкладка закрыта или недоступна. Канал нужно подключить заново.'), {code:'tab-unavailable'})); return; }
            options.onDiagnostic?.({stage:'tab-open',companionRequired:true});
            timer = win.setTimeout(() => finish(Object.assign(new Error('Нет результата из вкладки Perchance. Проверь доступ, companion userscript и COOP. Вкладка оставлена открытой; можно скачать и импортировать результат вручную.'), {code:'tab-timeout'})), timeoutMs);
            handshakeTimer = win.setTimeout(() => finish(Object.assign(new Error('Companion не ответил за 15 секунд. Проверь установку userscript и доступ к Perchance. COOP может разрывать связь вкладок. Результат из открытой вкладки можно импортировать вручную.'), {code:'companion-unavailable'})), env.handshakeMs || 15000);
        });
    }

    return new Promise((resolve, reject) => {
        const frame = doc.createElement('iframe');
        frame.setAttribute('title', 'Perchance image generation');
        frame.referrerPolicy = 'no-referrer';
        frame.style.cssText = 'width:100%;height:400px;border:0;';
        frame.src = `${GENERATOR_ENDPOINT}?${params.toString()}`;
        const diagnose = (stage, details = {}) => {
            // Deliberately never include URLs with query strings, prompts or server error text.
            try { options.onDiagnostic?.({ stage, ...details }); } catch { /* observer only */ }
        };
        let loaded = false;
        let ended = false;
        let timer;
        const abortSignal = options.signal;
        const finish = (err, result) => {
            if (ended) return;
            ended = true;
            win.clearTimeout(timer);
            win.removeEventListener('message', onMessage);
            abortSignal?.removeEventListener('abort', onAbort);
            frame.remove();
            doc.removeEventListener?.('securitypolicyviolation', onPolicy);
            diagnose(err ? 'failed' : 'complete', { code: err?.code || (err ? 'generation' : 'ok') });
            if (err) reject(err); else resolve(result);
        };
        const fail = (code, message) => Object.assign(new Error(message), { code });
        const onAbort = () => finish(fail('aborted', 'Генерация отменена'));
        const onPolicy = event => {
            if (/^(frame-src|child-src|default-src)$/.test(event.effectiveDirective) && String(event.blockedURI).startsWith(new URL(GENERATOR_ENDPOINT).origin)) {
                finish(fail('csp', 'CSP SillyTavern запрещает iframe Perchance. Проверь политику frame-src.'));
            }
        };
        frame.onload = () => { loaded = true; diagnose('iframe-load'); };
        frame.onerror = () => finish(fail('iframe', 'Ошибка загрузки iframe Perchance: проверь сеть и доступ к сайту.'));
        const onMessage = (event) => {
            if (event.source !== frame.contentWindow || !trustedPerchanceOrigin(event.origin)) return;
            const message = event.data;
            diagnose('message', { origin: event.origin, shape: typeof message, api: message?.api === 'perchance-image-api', matched: message?.result?.id === id });
            if (message?.api !== 'perchance-image-api' || message?.result?.id !== id) return;
            try { finish(null, unpackImageResult(message.result)); }
            catch (error) { finish(error); }
        };
        win.addEventListener('message', onMessage);
        doc.addEventListener?.('securitypolicyviolation', onPolicy);
        abortSignal?.addEventListener('abort', onAbort, { once: true });
        timer = win.setTimeout(() => finish(fail('timeout', `Тайм-аут Perchance (${loaded ? 'iframe загружен, ответа нет' : 'загрузка не подтверждена'}). Проверь видимый iframe: проверку доступа нужно пройти вручную. Браузер не позволяет отличить Cloudflare от сетевого сбоя внутри чужого iframe.`)), timeoutMs);
        if (abortSignal?.aborted) { onAbort(); return; }
        try { diagnose('iframe-create'); (options.mount || doc.body).appendChild(frame); }
        catch (err) { finish(err); }
    });
}

export function markdownImage(url) {
    if (!url || /[\r\n]/.test(url)) throw new Error('Некорректная ссылка изображения');
    return `![Perchance image](${url.replaceAll(')', '%29')})`;
}
