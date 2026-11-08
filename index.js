import { requestImage, openPerchanceChannel, ALLOWED_RESOLUTIONS, findImageTag, markdownImage } from './perchance-client.mjs';
import { BUILTIN_STYLES, normalizeStyles, selectedStyle, composePrompt, composeNegative } from './presets.mjs';
import professionalCatalogue from './professional-styles.json' with { type: 'json' };
import { summarizeModelProbe } from './prompt-diagnostics.mjs';
import { requestChatPrompt, promptTokenLimit } from './prompt-builder.mjs';
import { translate } from './i18n.mjs';

const KEY = 'perchance_bridge';
const TOOL_NAME = 'GeneratePerchanceImage';
const DEFAULTS = {
    resolution: '768x768', negativePrompt: '', guidanceScale: 7, autoTags: false,
    saveLocally: true, autoTool: false, reviewBeforeSend: true, removeBackground: false,
    seed: -1, prefix: '', styleId: 'none', styles: null, lastNativePrompt: '', lastPrompt: '', nativeMirror: false,
    transport: 'tab',
    promptTokens: 4096,
    imageCount: 1,
    language: 'en',
};
function imageCount(value) { const n=Number(value);return Number.isInteger(n)?Math.max(1,Math.min(8,n)):1; }
const ctx = () => SillyTavern.getContext();
let running = false;
let initialized = false;
let ui = null;
let activeController = null;
let drafting = false;
let channelWindow = null;
let channelReady = false;
let connecting = false;
let chatFlow = null;
const diagnostics = [];
const processedMessages = new WeakSet();

function settings() {
    const c = ctx();
    const s = c.extensionSettings[KEY] ||= { ...DEFAULTS };
    if (!s.schemaVersion) {
        // Preserve the extension's old values before disabling the unsafe mirror mode.
        s.backupV02 = JSON.parse(JSON.stringify(s));
        s.nativeMirror = false;
        s.schemaVersion = 3;
    }
    for (const [k, v] of Object.entries(DEFAULTS)) if (s[k] === undefined) s[k] = v;
    if (!Array.isArray(s.styles)) s.styles = BUILTIN_STYLES.map(st => ({ ...st }));
    if(s.schemaVersion<4){
        for(const style of BUILTIN_STYLES)if(!s.styles.some(st=>st.id===style.id))s.styles.push({...style});
        s.schemaVersion=4;
    }
    s.imageCount=imageCount(s.imageCount);
    return s;
}
function save() { ctx().saveSettingsDebounced(); }
function tr(text) { return translate(text, settings().language); }
function $(id) { return ui?.panel.querySelector(`#${id}`); }
function status(msg, error = false) {
    if (ui) { ui.status.textContent = tr(msg); ui.status.classList.toggle('error', error); }
}
function notice(msg, error = false) {
    status(msg, error);
    if (window.toastr) window.toastr[error ? 'error' : 'info'](tr(msg), 'Perchance Bridge');
    else console[error ? 'error' : 'info']('[Perchance Bridge]', error ? 'Ошибка; подробности в панели расширения.' : 'Статус обновлен в панели расширения.');
}
function chatId(c = ctx()) { return String(c.getCurrentChatId?.() ?? c.chatId ?? ''); }
function diagnostic(event) {
    diagnostics.push({ time: new Date().toISOString(), ...event });
    if (diagnostics.length > 80) diagnostics.shift();
    if ($('pb_diagnostics')) $('pb_diagnostics').textContent = diagnostics.map(e => JSON.stringify(e)).join('\n');
    if (event.stage === 'complete') $('pb_channel').textContent = tr('Канал подтвердил получение результата');
    if (event.stage === 'failed') $('pb_channel').textContent = `Канал: ${event.code}`;
}
function assertToolExclusive() {
    const sd = ctx().extensionSettings.sd;
    if (sd?.function_tool || sd?.interactive_mode) throw Error('Выключи Use function tool и Interactive mode в штатном Image Generation: параллельные автоматические генераторы запрещены.');
}
function channelAvailable() { return settings().transport !== 'tab' || !!(channelReady && channelWindow && !channelWindow.closed); }
function requireChannel() {
    if (!channelAvailable()) {
        const error = Error('Нет подключенного канала Perchance. Генерация из чата сейчас недоступна; окна автоматически не открываются.');
        notice(error.message,true);throw error;
    }
}
async function connectChannel() {
    if (running || drafting || connecting) return;
    connecting = true; $('pb_connect').disabled = true;
    try {
        channelReady = false;
        channelWindow = await openPerchanceChannel({onDiagnostic:diagnostic});
        channelReady = true;
        $('pb_channel').textContent = tr('Companion подтвердил связь. Работа генератора еще не проверена.');
        status('Канал подключен. Можно вызвать /perchance из диалога.');
    } catch (error) { channelReady = false;notice(error.message,true); }
    finally {connecting = false;$('pb_connect').disabled = false;}
}
function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onerror = () => reject(r.error || Error('Не прочитан файл'));
        r.onload = () => resolve(String(r.result || ''));
        r.readAsDataURL(blob);
    });
}
async function storeImage(result, c, signal) {
    let dataUrl = result.dataUrl;
    if (!dataUrl && result.url) {
        try {
            const response = await fetch(result.url, { mode: 'cors', credentials: 'omit', signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            if (!blob.type.startsWith('image/') || blob.size > 15 * 1024 * 1024) throw new Error('Неподдерживаемый или слишком большой файл');
            dataUrl = await blobToDataURL(blob);
        } catch (err) {
            signal?.throwIfAborted();
            diagnostic({ stage:'download-unavailable', code:'network-or-cors' });
        }
    }
    if (!dataUrl) {
        if (result.url) return { src: result.url, local: false };
        throw new Error('Perchance не отдал файл изображения');
    }
    const match = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
    if (!match) throw new Error('Неподдерживаемый формат изображения');
    if (match[2].length > 20 * 1024 * 1024) throw Error('Изображение превышает 15 МБ');
    // Decode actual image bytes before saving; a MIME label alone is not proof of an image.
    const imageBlob = await (await fetch(dataUrl, { signal })).blob();
    const bitmap = await createImageBitmap(imageBlob);
    bitmap.close();
    const format = match[1].toLowerCase().replace('jpeg', 'jpg');
    const upload = await fetch('/api/images/upload', {
        method: 'POST', headers: c.getRequestHeaders(), signal,
        body: JSON.stringify({ image: match[2], format, ch_name: c.groupId ? 'Perchance' : (c.name2 || 'Perchance'), filename: `perchance_${Date.now()}` }),
    });
    if (!upload.ok) throw new Error(`Ошибка сохранения SillyTavern HTTP ${upload.status}`);
    const payload = await upload.json();
    if (!payload?.path) throw new Error('SillyTavern не вернул путь к файлу');
    return { src: payload.path, local: true };
}
async function verifyExternalImage(src, signal) {
    await new Promise((resolve, reject) => {
        const image = new Image();
        image.referrerPolicy = 'no-referrer';
        const finish = error => {
            clearTimeout(timer); signal?.removeEventListener('abort', aborted);
            image.onload = image.onerror = null;
            error ? reject(error) : resolve();
        };
        const aborted = () => finish(Error('Проверка изображения отменена'));
        const timer = setTimeout(() => finish(Error('Ссылка Perchance не загрузила изображение за 15 секунд')), 15000);
        image.onload = () => image.naturalWidth && image.naturalHeight ? finish() : finish(Error('Пустое изображение Perchance'));
        image.onerror = () => finish(Error('Ссылка Perchance не содержит доступное изображение'));
        signal?.addEventListener('abort', aborted, {once:true});
        if (signal?.aborted) { aborted(); return; }
        image.src = src;
    });
}
async function postImageToChat(src, prompt, startId, options = {}) {
    const c = ctx();
    if (!startId || chatId(c) !== startId || !Array.isArray(c.chat)) {
        status('Чат переключился. Картинка осталась в предпросмотре.');
        return false;
    }
    const message = {
        name: c.groupId ? 'Perchance' : (c.name2 || 'Perchance'),
        is_user: false, is_system: false, send_date: new Date().toISOString(),
        mes: options.messageText || (settings().language === 'ru' ? '[Изображение Perchance]' : '[Perchance image]'),
        extra: {
            media: [{ url: src, type: 'image', title: prompt, source: 'generated', negative: options.negative || '' }],
            media_display: 'gallery', media_index: 0, inline_image: false,
        },
    };
    c.chat.push(message);
    const id = c.chat.length - 1;
    const types = c.eventTypes ?? c.event_types;
    if (types?.MESSAGE_RECEIVED) await c.eventSource.emit(types.MESSAGE_RECEIVED, id, 'extension');
    if (chatId() !== startId || ctx().chat !== c.chat) return false;
    c.addOneMessage(message);
    if (types?.CHARACTER_MESSAGE_RENDERED) await c.eventSource.emit(types.CHARACTER_MESSAGE_RENDERED, id, 'extension');
    if (chatId() !== startId || ctx().chat !== c.chat) return false;
    await c.saveChat();
    c.scrollOnMediaLoad?.();
    return true;
}
async function replaceTag(message, tag, src, startId) {
    const c = ctx();
    if (chatId(c) !== startId || !c.chat.includes(message) || !message.mes.includes(tag.full)) return;
    const idx = c.chat.indexOf(message);
    message.mes = message.mes.replace(tag.full, markdownImage(src));
    if (typeof c.updateMessageBlock === 'function') c.updateMessageBlock(idx, message);
    else await c.reloadCurrentChat?.();
    if (chatId() !== startId || !ctx().chat.includes(message)) return;
    await c.saveChat();
}

async function reviewImagePrompt(c,{prompt,negative,style,prefix,count,resolution,reviewNotice=''},signal){
    const content=document.createElement('div');content.className='pb-prompt-review';
    content.innerHTML='<h3>Промпт перед отправкой в Perchance</h3><p id="pb_review_summary"></p><label for="pb_review_prompt">Описание — можно отредактировать</label><textarea id="pb_review_prompt" class="text_pole" rows="8"></textarea><label for="pb_review_negative">Негативный промпт — можно отредактировать</label><textarea id="pb_review_negative" class="text_pole" rows="2"></textarea><label for="pb_review_final">Итоговый промпт со стилем</label><textarea id="pb_review_final" class="text_pole" rows="4" readonly></textarea><p id="pb_review_error" role="alert"></p>';
    content.innerHTML=tr(content.innerHTML);
    const field=content.querySelector('#pb_review_prompt'),neg=content.querySelector('#pb_review_negative');
    const final=content.querySelector('#pb_review_final'),error=content.querySelector('#pb_review_error');
    field.value=prompt;neg.value=negative;
    content.querySelector('#pb_review_summary').textContent=settings().language==='ru'
        ? `${reviewNotice?reviewNotice+' ':''}Картинок: ${count}. Размер: ${resolution}. Стиль: ${style.name}. Стиль добавляется к описанию автоматически.`
        : `${reviewNotice?tr(reviewNotice)+' ':''}Images: ${count}. Resolution: ${resolution}. Style: ${style.name}. The style is added automatically.`;
    const validate=()=>{
        try{
            final.value=composePrompt(field.value,style,prefix);
            if(neg.value.trim().length>1000)throw Error('Негативный промпт длиннее 1000 символов.');
            error.textContent='';return true;
        }catch(e){final.value='';error.textContent=tr(e.message);return false;}
    };
    field.addEventListener('input',validate);neg.addEventListener('input',validate);validate();
    const yes=c.POPUP_RESULT?.AFFIRMATIVE ?? 1, no=c.POPUP_RESULT?.CANCELLED ?? null;
    const options={wide:true,leftAlign:true,okButton:count>1?(settings().language==='ru'?`Создать картинки (${count})`:`Generate images (${count})`):tr('Создать изображение'),cancelButton:tr('Отмена'),
        onOpen:()=>field.focus(),onClosing:dialog=>dialog.result!==yes || validate()};
    let dialog;
    const abort=()=>{if(dialog)void dialog.complete(no);};
    try{
        let result;
        if(typeof c.Popup==='function'){
            dialog=new c.Popup(content,c.POPUP_TYPE?.CONFIRM ?? 2,'',options);
            signal.addEventListener('abort',abort,{once:true});
            signal.throwIfAborted();result=await dialog.show();
        }else if(typeof c.callGenericPopup==='function')result=await c.callGenericPopup(content,c.POPUP_TYPE?.CONFIRM ?? 2,'',options);
        else throw Error('SillyTavern не предоставил окно проверки промпта.');
        signal.throwIfAborted();
        if(result!==yes)return null;
        if(!validate())throw Error(error.textContent);
        return {prompt:field.value.trim(),negative:neg.value.trim(),composed:final.value};
    }finally{signal.removeEventListener('abort',abort);}
}

/** The same route is used by manual controls, tags, slash commands and the LLM tool. */
async function generate(prompt, target = null, { auto = false, popup = null, count: countOverride = null, forceReview=false, reviewNotice='' } = {}) {
    if (running || drafting) throw new Error('Генерация или подготовка промпта уже выполняется');
    requireChannel();
    let original = String(prompt || '').trim();
    const s = { ...settings() };
    if(forceReview)s.reviewBeforeSend=true;
    const style = selectedStyle(s);
    let composed = s.reviewBeforeSend ? '' : composePrompt(original, style, s.prefix);
    let negative = composeNegative(s.negativePrompt, style);
    const c = ctx();
    const startId = chatId(c);
    const startChat = c.chat;
    const count=target?1:imageCount(countOverride ?? s.imageCount), results=[];
    if(count>1 && s.transport==='tab' && (popup||channelWindow)?.companionVersion!=='0.5.0'){
        const error=Error('Для серии картинок обнови companion до 0.5.0 и подключи канал заново.');notice(error.message,true);throw error;
    }
    running = true;
    activeController = new AbortController();
    const signal = activeController.signal;
    if (ui) { ui.generateBtn.disabled = true; $('pb_draft').disabled = true; }
    $('pb_cancel').disabled = false;
    status('Отправляем промпт в Perchance…');
    try {
        if(s.reviewBeforeSend){
            status('Проверьте промпт перед отправкой в Perchance.');
            const edited=await reviewImagePrompt(c,{prompt:original,negative,style,prefix:s.prefix,count,resolution:s.resolution,reviewNotice},signal);
            signal.throwIfAborted();
            if(!edited){status('Создание изображения отменено до отправки.');return '';}
            if(chatId()!==startId || ctx().chat!==startChat){status('Чат изменился во время проверки промпта. Запрос отменён.');return '';}
            original=edited.prompt;composed=edited.composed;negative=edited.negative;
        }
        settings().lastPrompt = original;
        if (ui) ui.prompt.value = original;
        save();
        for(let index=0;index<count;index++){
            signal.throwIfAborted();
            if(index && (chatId()!==startId || ctx().chat!==startChat))break;
            status(count>1?`Создаём изображение ${index+1} из ${count}…`:'Отправляем промпт в Perchance…');
            const baseSeed=Number(s.seed);
            const result = await requestImage(composed, {
                resolution: s.resolution, negativePrompt: negative,
                guidanceScale: s.guidanceScale, removeBackground: s.removeBackground,
                seed: baseSeed>=0 ? (Number.isSafeInteger(baseSeed+index)?baseSeed+index:index) : undefined,
                signal, mount: $('pb_transport'), onDiagnostic: diagnostic,
                transport: s.transport,
                channel:(popup || channelWindow)?.sessionId ? (popup || channelWindow) : undefined,
                popup:(popup || channelWindow)?.sessionId ? null : popup || (channelWindow && !channelWindow.closed ? channelWindow : null),
            });
            signal.throwIfAborted();
            let stored;
            if (s.saveLocally || !result.url) {
                try { stored = await storeImage(result, c, signal); }
                catch (err) {
                    signal.throwIfAborted();
                    if (!result.url) throw err;
                    diagnostic({ stage:'upload-unavailable', code:'local-save' });
                    stored = { src: result.url, local: false };
                }
            } else stored = { src: result.url, local: false };
            if (!stored.local) await verifyExternalImage(stored.src, signal);
            if (ui) {
                ui.preview.src = stored.src;
                ui.preview.hidden = false;
                ui.link.href = stored.src;
                ui.link.hidden = false;
                ui.lastComposed.textContent = composed;
            }
            signal.throwIfAborted();
            let posted = false;
            if (chatId() === startId && ctx().chat === startChat) {
                if (target) { await replaceTag(target.message, target.tag, stored.src, startId); posted = true; }
                else posted = await postImageToChat(stored.src, original, startId, { negative, messageText: settings().language === 'ru'
                    ? (count>1?`[Изображение Perchance ${index+1}/${count}]`:auto ? '[Персонаж создал изображение]' : '[Изображение Perchance]')
                    : (count>1?`[Perchance image ${index+1}/${count}]`:auto ? '[Character generated an image]' : '[Perchance image]') });
            }
            results.push(stored.src);
            status(!posted ? 'Чат изменился или не открыт. Результат остался в предпросмотре.' : stored.local ? 'Готово. Картинка сохранена в SillyTavern.' : 'Готово. В чате внешняя ссылка; локальное сохранение отключено или недоступно.');
            if(!posted)break;
        }
        if(count>1 && results.length===count)status(`Готово. В чат добавлено изображений: ${results.length}.`);
        return results.at(-1) || '';
    } catch (err) {
        if (['companion-unavailable','remote-companion-unavailable','companion-error','tab-timeout','tab-unavailable','channel-not-connected'].includes(err?.code)) channelReady = false;
        notice((count>1?`Получено ${results.length} из ${count}. `:'')+(err?.message || String(err)), true);
        throw err;
    } finally {
        running = false;
        activeController = null;
        $('pb_cancel').disabled = true;
        if (ui) { ui.generateBtn.disabled = false; $('pb_draft').disabled = false; }
    }
}

function syncAutoTool() {
    const c = ctx();
    // shouldRegister is evaluated per model request, so toggles don't need a restart.
    c.registerFunctionTool({
        name: TOOL_NAME, displayName: 'Perchance: generate an image',
        description: 'Generate an image when the user explicitly asks for a picture, illustration, photo or depiction. Compose a detailed visual prompt from the user request and current scene. Do not call for ordinary chat.',
        parameters: {
            type: 'object', properties: {
                prompt: { type: 'string', description: 'Detailed visual prompt describing subjects, appearance, setting, clothing, pose, lighting and composition.' },
            }, required: ['prompt'],
        },
        shouldRegister: () => !!settings().autoTool && channelAvailable() && !ctx().extensionSettings.sd?.function_tool && !ctx().extensionSettings.sd?.interactive_mode,
        action: async args => {
            assertToolExclusive();
            const prompt = String(args?.prompt || '').trim();
            if (!prompt) throw Error('ИИ не передал промпт');
            const src = await generate(prompt, null, { auto: true });
            return src?`Image created: ${src}`:'Image generation cancelled before sending.';
        },
    });
}
async function draftFromChat(nativeMode = null,{throwEmpty=false}={}) {
    if (running || drafting) { status('Сначала заверши предыдущую генерацию.', true); return; }
    const c = ctx();
    const startId = chatId(c), startChat = c.chat;
    if (!c.chat?.length) { status('Открой диалог с персонажем.', true); return; }
    $('pb_draft').disabled = true;
    drafting = true;
    status('SillyTavern составляет промпт по текущему чату…');
    try {
        let instruction = [
            'Based on the current conversation and the character descriptions, write a single detailed IMAGE GENERATION PROMPT describing the current or most recent visually significant scene.',
            'Preserve the appearance of people or characters established in context, visible objects, clothing, setting, lighting, camera angle, and actions.',
            'Write ONLY visual details in English, in one paragraph, under 1000 characters. No meta commentary, markdown, explanation, quotation marks or technical parameters.',
        ].join(' ');
        if (nativeMode === 'cast') instruction += ' Show all visually relevant characters together in one group composition. Describe each person distinctly and their positions relative to one another.';
        if (typeof nativeMode === 'number' && nativeMode !== 3) {
            const template = c.extensionSettings.sd?.prompts?.[nativeMode];
            if (!template) throw Error('Шаблон Image Generation не загружен. Открой настройки штатного расширения.');
            instruction = c.substituteParams(String(template));
        }
        diagnostic({stage:'prompt-request',mode:nativeMode === null ? 'scene' : nativeMode});
        const answer = nativeMode===3 ? [...c.chat].reverse().find(m=>!m.is_system && typeof m.mes==='string' && m.mes.trim())?.mes : await requestChatPrompt(c,instruction,{
            tokens:settings().promptTokens,onDiagnostic:diagnostic,
            assertActive:() => {
                if (chatFlow?.cancelled) throw Error('Подготовка промпта отменена.');
                if (chatId() !== startId || ctx().chat !== startChat) throw Error('Чат изменился во время составления промпта; результат отброшен.');
            },
        });
        diagnostic({stage:'prompt-response',textChars:String(answer ?? '').trim().length});
        if (chatId() !== startId || ctx().chat !== startChat) throw Error('Чат изменился во время составления промпта; результат отброшен.');
        if(nativeMode===3 && String(answer||'').trim().length>2000)throw Error('Последнее сообщение длиннее 2000 символов. Используй режим с подготовкой промпта.');
        const prompt = nativeMode===3?String(answer||'').trim():String(answer || '').replace(/^```(?:\w+)?\s*|```$/g, '').trim().slice(0, 1700);
        if (!prompt) throw Error('SillyTavern вернул пустой служебный ответ. Нажми «Тест основной модели без диалога» и скопируй диагностику. Это еще не доказывает ошибку instruct-шаблона.');
        ui.prompt.value = prompt;
        settings().lastPrompt = prompt;
        save();
        status('Промпт составлен. Теперь можешь исправить его, выбрать стиль и сгенерировать.');
        return prompt;
    } catch (err) {
        if(throwEmpty && err.code==='empty-model-prompt')throw err;
        notice('Ошибка составления промпта: ' + (err.message || err), true);
    }
    finally { drafting = false; $('pb_draft').disabled = false; }
}

function cancelGeneration() {
    if (chatFlow) {
        chatFlow.cancelled = true;
        if (chatFlow.stage === 'draft') ctx().stopGeneration?.();
    }
    activeController?.abort();
}

/** Chat actions never open windows. Only use a channel explicitly connected by the user. */
async function generateFromChat(mode = null) {
    if (running || drafting || chatFlow) { notice('Perchance уже выполняет запрос.',true); return ''; }
    try { requireChannel(); } catch { return ''; }
    const c = ctx(), startId = chatId(c), startChat = c.chat;
    if (!startId || !c.chat?.length) { notice('Открой диалог с сообщениями.',true); return ''; }
    const reserved = settings().transport === 'tab' ? channelWindow : null;
    const flow = {stage:'draft',cancelled:false};
    chatFlow = flow;
    $('pb_cancel').disabled = false;
    notice('Perchance: SillyTavern составляет промпт из диалога…');
    try {
        let prompt,forceReview=false;
        try{prompt=await draftFromChat(mode,{throwEmpty:true});}
        catch(error){
            if(error.code!=='empty-model-prompt')throw error;
            prompt='';forceReview=true;
        }
        if (flow.cancelled || (!prompt && !forceReview) || chatId() !== startId || ctx().chat !== startChat) {
            if (flow.cancelled) notice('Запрос Perchance отменен.');
            return '';
        }
        flow.stage = 'image';
        const src = await generate(prompt,null,{popup:reserved,forceReview,
            reviewNotice:forceReview?'Текстовая модель вернула пустой ответ. Введите описание вручную или отмените. Повторный запрос к модели не выполнялся.':''});
        notice(ui.status.textContent);
        return src;
    } catch { return ''; /* generate already notified */ }
    finally { chatFlow = null; $('pb_cancel').disabled = true; }
}

function addChatActions() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('pb_chat_actions')) return;
    const container = document.createElement('div');
    container.id = 'pb_chat_actions'; container.className = 'extension_container';
    const controls=document.createElement('div');controls.className='pb-menu-controls';
    controls.innerHTML='<label for="pb_menu_style">Perchance: стиль</label><select id="pb_menu_style" class="text_pole"></select><label for="pb_menu_count">Картинок (1–8)</label><input id="pb_menu_count" class="text_pole" type="number" min="1" max="8" step="1"><label for="pb_menu_review">Предпросмотр промпта</label><input id="pb_menu_review" type="checkbox">';
    controls.innerHTML=tr(controls.innerHTML);
    // ST closes the wand menu on clicks bubbling to html. Keep settings interactive;
    // action buttons outside this controls block still close the menu normally.
    controls.addEventListener('click',event=>event.stopPropagation());
    container.appendChild(controls);
    for (const [label,action] of [
        ['Perchance — изображение из диалога',()=>generateFromChat()],
        ['Perchance — портрет персонажа',()=>generateFromChat(5)],
        ['Perchance — персонаж целиком',()=>generateFromChat(0)],
        ['Perchance — моя фотография',()=>generateFromChat(1)],
        ['Perchance — вся история',()=>generateFromChat(2)],
        ['Perchance — последнее сообщение',()=>generateFromChat(4)],
        ['Perchance — последнее сообщение без обработки',()=>generateFromChat(3)],
        ['Perchance — фон',()=>generateFromChat(7)],
        ['Perchance — все персонажи (The Cast)',()=>generateFromChat('cast')],
        ['Perchance — по готовому промпту',async()=>{try{await generate(ui.prompt.value);}catch{/* notified */}}],
        ['Perchance — отменить запрос',cancelGeneration],
    ]) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'list-group-item flex-container flexGap5';
        button.textContent = tr(label); button.addEventListener('click',action); container.appendChild(button);
    }
    menu.appendChild(container);
    rebuildStyles();
    document.getElementById('pb_menu_style').addEventListener('change',e=>{settings().styleId=e.target.value;rebuildStyles();save();});
    document.getElementById('pb_menu_count').addEventListener('change',e=>setImageCount(e.target.value));
    document.getElementById('pb_menu_count').addEventListener('input',e=>setImageCount(e.target.value));
    setImageCount(settings().imageCount,false);
    document.getElementById('pb_menu_review').addEventListener('change',e=>setPromptReview(e.target.checked));
    setPromptReview(settings().reviewBeforeSend,false);
}
function setPromptReview(value,persist=true){
    settings().reviewBeforeSend=!!value;
    for(const el of [$('pb_review'),document.getElementById('pb_menu_review')])if(el)el.checked=settings().reviewBeforeSend;
    if(persist)save();
}
function setImageCount(value,persist=true){
    settings().imageCount=imageCount(value);
    for(const el of [$('pb_count'),document.getElementById('pb_menu_count')])if(el)el.value=settings().imageCount;
    if(persist)save();
}

async function probePromptModel() {
    if (running || drafting) { status('Сначала заверши предыдущую операцию.', true); return; }
    const c = ctx();
    if (typeof c.generateRawData !== 'function') { notice('В этой версии SillyTavern нет generateRawData.',true); return; }
    drafting = true;
    $('pb_model_test').disabled = true;
    status('Один тестовый запрос основной модели без истории чата…');
    diagnostic({stage:'model-probe-start',responseTokens:2048});
    try {
        // Supported ST API, no character/persona/history is passed. No automatic retries.
        const data = await c.generateRawData({
            prompt:'Reply with exactly this one line: red apple on a white background',
            systemPrompt:'You are a concise image prompt writer. Return a final answer as plain text.',
            responseLength:2048,
        });
        const summary = summarizeModelProbe(data);
        diagnostic({stage:'model-probe-result',...summary});
        if (summary.textChars) status(`Тест: ответ получен (${summary.textChars} символов). Сравни его с prompt-response в диагностике: параметры контекстного запроса или обработка quiet могут отличаться.`);
        else if (summary.reasoningChars || summary.reasoningTokens) status(`Тест: финального текста нет, reasoning присутствует; finish=${summary.finishReason}. Скопируй диагностику.`,true);
        else status(`Тест: финальный текст и reasoning отсутствуют; finish=${summary.finishReason}. Скопируй диагностику.`,true);
    } catch {
        diagnostic({stage:'model-probe-error',code:'request-failed'});
        notice('Тест основной модели завершился ошибкой. Проверь стандартное уведомление SillyTavern/API; ответ и личные данные в журнал не записаны.',true);
    } finally { drafting = false; $('pb_model_test').disabled = false; }
}

function captureNativePrompt(data) {
    if (!data || typeof data.prompt !== 'string' || !data.prompt.trim()) return;
    const s = settings();
    s.lastNativePrompt = data.prompt;
    save();
    if (ui) { $('pb_native_text').textContent = data.prompt; $('pb_from_native').disabled = false; }
    // Observation only. Never start a second backend from SD_PROMPT_PROCESSING.
}
async function onMessageRendered(id) {
    if (!settings().autoTags || settings().autoTool || running || ctx().extensionSettings.sd?.function_tool || ctx().extensionSettings.sd?.interactive_mode) return;
    const c = ctx();
    const message = c.chat?.[id];
    if (!message || message.is_user || message.is_system || processedMessages.has(message)) return;
    const tag = findImageTag(message.mes);
    if (!tag?.prompt) return;
    processedMessages.add(message);
    try { await generate(tag.prompt, { message, tag }, { auto: true }); }
    catch (err) { console.warn('[Perchance Bridge] Не удалось обработать тег:', err?.code || 'generation'); }
}

function makeOption(select, id, title) {
    const option = document.createElement('option');
    option.value = id; option.textContent = title; select.appendChild(option);
}
function showStyleEditor() {
    const s = settings();
    const style = selectedStyle(s);
    $('pb_style_name').value = style.name;
    $('pb_style_pos').value = style.positive;
    $('pb_style_neg').value = style.negative;
}
function rebuildStyles() {
    const select = $('pb_style');
    select.replaceChildren();
    const s = settings();
    const label = style => BUILTIN_STYLES.some(b => b.id === style.id && b.name === style.name) ? tr(style.name) : style.name;
    for (const style of normalizeStyles(s.styles)) makeOption(select, style.id, label(style));
    if (!s.styles.some(style => style.id === s.styleId)) s.styleId = s.styles[0].id;
    select.value = s.styleId;
    const quick=document.getElementById('pb_menu_style');
    if(quick){quick.replaceChildren();for(const style of normalizeStyles(s.styles))makeOption(quick,style.id,label(style));quick.value=s.styleId;}
    showStyleEditor();
}
function addPanel() {
    const mount = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!mount) throw Error('Не найден контейнер настроек расширений');
    const panel = document.createElement('section');
    panel.id = 'perchance_bridge_panel';
    panel.innerHTML = `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header"><b>Perchance Bridge 0.7.0</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
      <div class="inline-drawer-content pb-root">
        <label for="pb_language">Language / Язык</label><select id="pb_language" class="text_pole"><option value="en">English</option><option value="ru">Русский</option></select>
        <div class="pb-intro">SillyTavern → промпт → Perchance → картинка в чат</div>
        <div id="pb_channel">Канал еще не проверен реальной генерацией в этой сессии</div>
        <button id="pb_connect" class="menu_button">Подключить канал — открыть вкладку Perchance</button>
        <div class="pb-small">Только эта кнопка открывает вкладку. Команды, меню чата и инструмент ИИ не открывают окна; без подтвержденного канала они не запускают генерацию.</div>
        <label for="pb_transport_mode">Транспорт</label><select id="pb_transport_mode" class="text_pole"><option value="tab">Рабочая вкладка + companion 0.5.0</option><option value="iframe">iframe — экспериментальная диагностика</option></select>
        <p class="pb-warning">Нужен обновленный companion 0.5.0 на localhost, perchance.org и во вложенном iframe генератора. Он использует обмен данными менеджера userscript между вкладками; window.opener не требуется. Транспортные значения удаляются сразу после отправки. Переписку, cookies и ключи companion не читает.</p>
        <div class="pb-actions"><a class="menu_button" href="https://perchance.org/perchance-ai-api" target="_blank" rel="noopener noreferrer">Проверить доступ в обычной вкладке</a><button id="pb_test" class="menu_button">Тест: красное яблоко</button></div>
        <div class="pb-small">Серия создаётся последовательно, по одной картинке за запрос. Отмена останавливает оставшиеся. Повторов после ошибок нет.</div>
        <div class="pb-section-title">Промпт изображения</div>
        <label for="pb_prompt">Отредактируй описание перед генерацией</label>
        <textarea id="pb_prompt" class="text_pole" rows="6" placeholder="Describe the picture..."></textarea>
        <div class="pb-actions">
          <button id="pb_draft" class="menu_button"><i class="fa-solid fa-wand-magic-sparkles"></i> Промпт по диалогу (ИИ)</button>
          <button id="pb_from_native" class="menu_button">Взять из Image Generation</button>
          <button id="pb_last" class="menu_button">Последний ответ</button>
        </div>
        <details><summary>Диагностика подготовки промпта</summary><div class="pb-small">Тест отправляет один короткий нейтральный запрос выбранной текстовой модели без истории чата (лимит 2048 токена). Возможна обычная тарификация вашего провайдера. В журнал попадают только длины ответа/reasoning, finish reason и счетчики токенов.</div><button id="pb_model_test" class="menu_button">Тест основной модели без диалога</button><button id="pb_copy_diagnostics" class="menu_button">Копировать диагностику</button></details>
        <label for="pb_prompt_tokens">Лимит ответа основной модели для промпта (включая reasoning)</label><input id="pb_prompt_tokens" class="text_pole" type="number" min="512" max="16384" step="512"><div class="pb-small">По умолчанию 4096 токенов. Применяется только к подготовке промпта; обычный пресет переписки не изменяется. Короткий тест без диалога по-прежнему использует 2048.</div>
        <label for="pb_native_mode">Штатный шаблон Image Generation</label>
        <select id="pb_native_mode" class="text_pole"><option value="0">You — персонаж целиком</option><option value="5">Your Face — портрет</option><option value="1">Me — пользователь</option><option value="2">Whole Story — вся сцена</option><option value="4">Last Message — последнее сообщение</option><option value="3">Raw Last — без обработки</option><option value="7">Background — фон</option><option value="cast">The Cast — все персонажи</option></select>
        <button id="pb_native_draft" class="menu_button">Составить по штатному шаблону</button>
        <div class="pb-small">Использует шаблон установленного Image Generation и основную модель SillyTavern. Другой image backend не вызывается. Это отдельное действие, а не замена /sd.</div>
        <details class="pb-nativedetails"><summary>Последний промпт штатного Image Generation</summary><div class="pb-small" id="pb_native_text"></div></details>
        <div class="pb-section-title">Стиль и качество</div>
        <label for="pb_style">Стиль изображения</label>
        <select id="pb_style" class="text_pole"></select>
        <div class="pb-small">Фотореализм, аниме, кино, живопись и ваши стили: текстовые дополнения, которые применяются ко всем картинкам серии.</div>
        <details id="pb_style_editor">
          <summary>Редактировать стили и пресеты</summary>
          <label for="pb_style_name">Название</label><input id="pb_style_name" type="text" class="text_pole" maxlength="80">
          <label for="pb_style_pos">Позитивный стиль (дополнение к промпту)</label><textarea id="pb_style_pos" class="text_pole" rows="3"></textarea>
          <label for="pb_style_neg">Негативный стиль</label><textarea id="pb_style_neg" class="text_pole" rows="2"></textarea>
          <div class="pb-actions"><button id="pb_style_save" class="menu_button">Сохранить</button><button id="pb_style_new" class="menu_button">Новый стиль</button><button id="pb_style_delete" class="menu_button">Удалить</button></div>
          <div class="pb-actions"><button id="pb_export" class="menu_button">Экспорт стилей</button><label class="menu_button pb-import">Импорт JSON<input type="file" id="pb_import" accept="application/json,.json" hidden></label></div>
        </details>
        <label for="pb_prefix">Дополнительные указания для всех стилей</label>
        <textarea id="pb_prefix" class="text_pole" rows="2" placeholder="sharp focus, detailed background..."></textarea>
        <label for="pb_neg">Дополнительный негативный промпт</label>
        <textarea id="pb_neg" class="text_pole" rows="2"></textarea>
        <div class="pb-fields">
            <label>Количество картинок (1–8)<input id="pb_count" type="number" class="text_pole" min="1" max="8" step="1"></label>
            <label>Разрешение<select id="pb_resolution" class="text_pole"></select></label>
            <label>Guidance (1–30)<input id="pb_guidance" type="number" class="text_pole" min="1" max="30" step="0.5"></label>
            <label>Seed (-1 случайный)<input id="pb_seed" type="number" class="text_pole" min="-1" step="1"></label>
        </div>
        <div class="pb-small">При случайном seed каждая картинка получает новый вариант. При заданном seed следующие используют seed + 1, + 2 и т. д. Каждая готовая картинка добавляется в чат сразу.</div>
        <label class="pb-check"><input type="checkbox" id="pb_remove_bg"> Удалять фон (если поддерживается Perchance)</label>
        <label class="pb-check"><input type="checkbox" id="pb_review"> Показывать промпт перед отправкой и разрешать редактирование</label>
        <div class="pb-actions"><button id="pb_generate" class="menu_button pb-primary"><i class="fa-solid fa-image"></i> Создать изображение</button><button id="pb_cancel" class="menu_button" disabled>Отмена</button></div>
        <details open><summary>Реальный канал Perchance (iframe)</summary><div id="pb_transport"></div></details>
        <details><summary>Диагностика без текста промпта</summary><pre id="pb_diagnostics" class="pb-small"></pre></details>
        <details><summary>Professional: настоящие стили и ручной импорт</summary>
          <p class="pb-small">У Professional есть реальные стили (Casual Photo, Cinematic, Painted Anime и другие), но публичный style ID API для этой страницы не подтвержден. Выбери стиль в обычной вкладке, вставь итоговый промпт, задай Number of images = 1, создай и скачай изображение. Здесь можно сохранить его и прикрепить к текущему чату. Импорт не запускает генерацию.</p>
          <label for="pb_professional_style">Реальные стили Professional: справочник от 26.10.2026 (выбрать на сайте вручную)</label><select id="pb_professional_style" class="text_pole"></select>
          <div class="pb-small">Сохраненный выбор — памятка для обычной вкладки. Эти идентификаторы принадлежат UI Professional; в Image API они не передаются.</div>
          <a class="menu_button" href="https://perchance.org/image-generator-professional" target="_blank" rel="noopener noreferrer">Открыть Professional</a>
          <button id="pb_copy" class="menu_button">Копировать итоговый промпт</button>
          <label class="menu_button pb-import">Прикрепить результат Professional<input type="file" id="pb_image_import" accept="image/png,image/jpeg,image/webp" hidden></label>
        </details>
        <div class="pb-section-title">Автоматическая генерация</div>
        <label class="pb-check"><input type="checkbox" id="pb_tool"> Разрешить ИИ вызывать Perchance как инструмент</label>
        <div class="pb-small">Нужна модель с поддержкой function calling, включенной в SillyTavern. Отключи штатные Use function tool и Interactive mode. При их включении автоматические tool/теги Perchance заблокированы.</div>
        <div class="pb-warning">Штатный /sd продолжает использовать свой backend. Для Perchance используй кнопки этой панели или /perchance. При включенном штатном Use function tool инструмент Perchance не регистрируется. Режим дублирования удален.</div>
        <label class="pb-check"><input type="checkbox" id="pb_auto"> Обрабатывать теги [PERCHANCE: промпт] в сообщениях</label>
        <label class="pb-check"><input type="checkbox" id="pb_local"> Сохранять картинки локально, когда это возможно</label>
        <div class="pb-section-title">Результат</div>
        <div id="pb_status" role="status" aria-live="polite"></div>
        <img id="pb_preview" alt="Сгенерированное изображение" hidden>
        <a id="pb_link" target="_blank" rel="noopener noreferrer" hidden>Открыть изображение</a>
        <details><summary>Итоговый промпт с добавленным стилем</summary><div class="pb-small" id="pb_composed"></div></details>
        <p class="pb-small">Интерфейс генерации: <a href="https://perchance.org/perchance-ai-api" rel="noopener noreferrer" target="_blank">Perchance Image API</a>. Стили здесь — текстовые пресеты, не встроенные переключатели Professional. Команды: <code>/perchance ...</code> и <code>/perchance-scene</code>.</p>
      </div>
    </div>`;
    panel.innerHTML = tr(panel.innerHTML);
    mount.appendChild(panel);
    ui = { panel, prompt: panel.querySelector('#pb_prompt'), preview: panel.querySelector('#pb_preview'), link: panel.querySelector('#pb_link'), status: panel.querySelector('#pb_status'), generateBtn: panel.querySelector('#pb_generate'), lastComposed: panel.querySelector('#pb_composed') };
    const s = settings();
    $('pb_language').value = s.language;
    $('pb_language').addEventListener('change', e => {
        s.language = e.target.value === 'ru' ? 'ru' : 'en';
        save();
        status(s.language === 'ru' ? 'Язык сохранён. Обновите страницу SillyTavern, чтобы применить его.' : 'Language saved. Refresh SillyTavern to apply it.');
    });
    ui.prompt.value = s.lastPrompt;
    $('pb_native_text').textContent = s.lastNativePrompt || tr('Промпт пока не получен.');
    $('pb_from_native').disabled = !s.lastNativePrompt;
    for (const size of ALLOWED_RESOLUTIONS) makeOption($('pb_resolution'), size, size);
    rebuildStyles();
    setImageCount(s.imageCount,false);
    $('pb_count').addEventListener('change',e=>setImageCount(e.target.value));
    $('pb_count').addEventListener('input',e=>setImageCount(e.target.value));
    setPromptReview(s.reviewBeforeSend,false);
    $('pb_review').addEventListener('change',e=>setPromptReview(e.target.checked));
    $('pb_prompt_tokens').value = promptTokenLimit(s.promptTokens);
    $('pb_prompt_tokens').addEventListener('change',()=>{s.promptTokens=promptTokenLimit($('pb_prompt_tokens').value);$('pb_prompt_tokens').value=s.promptTokens;save();});
    for (const style of professionalCatalogue.styles) makeOption($('pb_professional_style'), style.id, style.name);
    $('pb_professional_style').value = s.professionalStyle || professionalCatalogue.styles[0].id;
    $('pb_professional_style').addEventListener('change', () => { s.professionalStyle = $('pb_professional_style').value; save(); });
    for (const [id, prop] of [['pb_transport_mode','transport'], ['pb_neg','negativePrompt'], ['pb_prefix','prefix'], ['pb_resolution','resolution'], ['pb_guidance','guidanceScale'], ['pb_seed','seed'], ['pb_auto','autoTags'], ['pb_local','saveLocally'], ['pb_tool','autoTool'], ['pb_remove_bg','removeBackground']]) {
        const el = $(id);
        el[prop === 'autoTags' || prop === 'saveLocally' || prop === 'autoTool' || prop === 'nativeMirror' || prop === 'reviewBeforeSend' || prop === 'removeBackground' ? 'checked' : 'value'] = s[prop];
        el.addEventListener('change', () => {
            const raw = el.type === 'checkbox' ? el.checked : el.value;
            s[prop] = prop === 'guidanceScale' ? Math.max(1, Math.min(30, Number(raw) || 7)) : prop === 'seed' ? (Number.isSafeInteger(Number(raw)) ? Math.max(-1, Number(raw)) : -1) : raw;
            save();
            if (prop === 'autoTool' && s.autoTool && (ctx().extensionSettings.sd?.function_tool || ctx().extensionSettings.sd?.interactive_mode)) notice('Инструмент Perchance заблокирован: сначала выключи штатные Use function tool и Interactive mode.', true);
        });
    }
    $('pb_prompt').addEventListener('change', () => { s.lastPrompt = ui.prompt.value; save(); });
    $('pb_style').addEventListener('change', () => { s.styleId = $('pb_style').value; rebuildStyles(); save(); });
    $('pb_style_save').addEventListener('click', () => {
        const name = $('pb_style_name').value.trim();
        if (!name) { status('Укажи название стиля.', true); return; }
        const style = s.styles.find(st => st.id === s.styleId);
        if (!style) return;
        Object.assign(style, { name: name.slice(0,80), positive: $('pb_style_pos').value.slice(0,1200), negative: $('pb_style_neg').value.slice(0,1000) });
        rebuildStyles(); save(); status('Стиль сохранен.');
    });
    $('pb_style_new').addEventListener('click', () => {
        const id = 'custom_' + (globalThis.crypto?.randomUUID?.() || Date.now());
        s.styles.push({ id, name: 'Мой стиль', positive: '', negative: '' });
        s.styleId = id; rebuildStyles(); save(); $('pb_style_name').focus();
        status('Новый стиль добавлен. Заполни поля и нажми «Сохранить».');
    });
    $('pb_style_delete').addEventListener('click', () => {
        if (s.styles.length <= 1) { status('Нельзя удалить последний стиль.', true); return; }
        s.styles = s.styles.filter(st => st.id !== s.styleId);
        s.styleId = s.styles[0].id; rebuildStyles(); save();
        status('Стиль удален.');
    });
    $('pb_export').addEventListener('click', () => {
        const blob = new Blob([JSON.stringify({ version:1, styles: s.styles }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = 'perchance-bridge-styles.json'; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    });
    $('pb_import').addEventListener('change', async e => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            if (file.size > 150000) throw Error('Файл слишком большой');
            const data = JSON.parse(await file.text());
            if (!data || !Array.isArray(data.styles) || !data.styles.length) throw Error('Файл должен содержать массив styles');
            s.styles = normalizeStyles(data.styles); s.styleId = s.styles[0].id;
            rebuildStyles(); save(); status(`Импортировано стилей: ${s.styles.length}.`);
        } catch (err) { notice('Ошибка импорта стилей: ' + err.message, true); }
        e.target.value = '';
    });
    $('pb_draft').addEventListener('click', () => draftFromChat());
    $('pb_connect').addEventListener('click',connectChannel);
    $('pb_model_test').addEventListener('click', probePromptModel);
    $('pb_copy_diagnostics').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(diagnostics.map(e=>JSON.stringify(e)).join('\n')); status('Диагностика скопирована без текстов диалога и промпта.'); }
        catch { notice('Буфер обмена недоступен. Скопируй текст раздела диагностики вручную.',true); }
    });
    $('pb_native_draft').addEventListener('click', () => draftFromChat($('pb_native_mode').value==='cast'?'cast':Number($('pb_native_mode').value)));
    $('pb_cancel').addEventListener('click', cancelGeneration);
    $('pb_test').addEventListener('click', async () => {
        // Same transport, no chat access and no image backend other than Perchance.
        if (running || drafting) return;
        ui.prompt.value = 'red apple on a white background';
        try { await generate(ui.prompt.value,null,{count:1}); } catch { /* notified */ }
    });
    $('pb_copy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(composePrompt(ui.prompt.value, selectedStyle(s), s.prefix)); status('Итоговый промпт скопирован. Вставь его в Professional.'); }
        catch (err) { notice(err.message, true); }
    });
    $('pb_image_import').addEventListener('change', async e => {
        const file = e.target.files?.[0];
        if (!file || running || drafting) return;
        const c = ctx(), startId = chatId(c), startChat = c.chat;
        running = true; activeController = new AbortController(); $('pb_cancel').disabled = false;
        try {
            if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 15*1024*1024) throw Error('Нужен PNG, JPEG или WebP до 15 МБ');
            const result = { dataUrl: await blobToDataURL(file) };
            const stored = await storeImage(result, c, activeController.signal);
            activeController.signal.throwIfAborted();
            ui.preview.src = stored.src; ui.preview.hidden = false; ui.link.href = stored.src; ui.link.hidden = false;
            const posted = ctx().chat === startChat && await postImageToChat(stored.src, ui.prompt.value, startId);
            status(posted ? 'Импортированное изображение сохранено и прикреплено.' : 'Чат изменился. Изображение осталось в предпросмотре.');
        } catch (err) { notice(err.message, true); }
        finally { running = false; activeController = null; $('pb_cancel').disabled = true; e.target.value = ''; }
    });
    $('pb_from_native').addEventListener('click', () => {
        ui.prompt.value = s.lastNativePrompt;
        s.lastPrompt = ui.prompt.value; save(); status('Промпт Image Generation вставлен. Можно редактировать.');
    });
    $('pb_last').addEventListener('click', () => {
        const last = [...(ctx().chat || [])].reverse().find(m => !m.is_user && !m.is_system && m.mes);
        if (!last) { status('Не найден ответ персонажа.', true); return; }
        ui.prompt.value = last.mes; s.lastPrompt = ui.prompt.value; save();
        status('Текст последнего ответа вставлен.');
    });
    $('pb_generate').addEventListener('click', async () => {
        try { await generate(ui.prompt.value); } catch { /* notified */ }
    });
}

function registerCommands() {
    const c = ctx();
    const add = (name, callback, required, help) => c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
        name, callback, returns: tr('URL изображения или текст промпта'),
        unnamedArgumentList: [c.SlashCommandArgument.fromProps({
            description: tr('Текст визуального промпта'), typeList: [c.ARGUMENT_TYPE.STRING], isRequired: required,
        })],
        helpString: tr(help),
    }));
    add('perchance', async (_named, prompt) => {
        const text = String(prompt || '').trim();
        if (!text) return generateFromChat();
        try { return await generate(text); } catch { return ''; }
    }, false, 'Без аргумента — составить промпт из диалога и создать изображение. С аргументом — использовать готовый промпт: <code>/perchance a red fox in the forest</code>');
    add('perchance-scene', async () => {
        return await draftFromChat() || '';
    }, false, 'Создать промпт изображения из истории чата без немедленной генерации');
    add('perchance-chat', () => generateFromChat(), false, 'Составить промпт из текущего диалога и сразу создать изображение Perchance');
    add('perchance-face', () => generateFromChat(5), false, 'Составить портрет персонажа и сразу создать изображение Perchance');
    for(const [name,mode] of [['you',0],['me',1],['story',2],['last',4],['raw-last',3],['background',7],['cast','cast']])
        add(`perchance-${name}`,()=>generateFromChat(mode),false,'Создать изображение выбранного типа с текущим стилем и количеством');
    add('perchance-count',(_named,value)=>{setImageCount(value);return String(settings().imageCount);},true,'Количество изображений в серии: от 1 до 8');
    add('perchance-style',(_named,value)=>{
        const text=String(value||'').trim().toLowerCase();
        const style=normalizeStyles(settings().styles).find(s=>s.id.toLowerCase()===text || s.name.toLowerCase()===text);
        if(!style){notice('Стиль не найден. Выбери его в меню Perchance.',true);return '';}
        settings().styleId=style.id;rebuildStyles();save();return style.name;
    },true,'Выбрать стиль по имени или ID, например /perchance-style anime');
}
function initialize() {
    if (initialized || (!document.getElementById('extensions_settings2') && !document.getElementById('extensions_settings'))) return;
    initialized = true;
    try {
        addPanel(); addChatActions(); registerCommands(); syncAutoTool();
        const c = ctx(), t = c.eventTypes ?? c.event_types;
        if (t?.CHARACTER_MESSAGE_RENDERED) c.eventSource.on(t.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
        if (t?.SD_PROMPT_PROCESSING) c.eventSource.on(t.SD_PROMPT_PROCESSING, captureNativePrompt);
        console.info('[Perchance Bridge] v0.7.0 loaded');
    } catch (err) { initialized = false; console.error('[Perchance Bridge] Ошибка инициализации:', err); }
}
const c = ctx(), eventTypes = c.eventTypes ?? c.event_types;
if (eventTypes?.APP_READY) c.eventSource.on(eventTypes.APP_READY, initialize);
if (document.readyState === 'complete') initialize();
else document.addEventListener('DOMContentLoaded', initialize, { once:true });
