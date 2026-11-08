// Page side of the explicitly installed userscript bridge. No opener or server.
const CLIENT = 'perchance-bridge-client-v2';
const COMPANION = 'perchance-bridge-companion-v2';
const sessionPattern = /^[a-f0-9]{32}$/i;
const idFor = win => (win.crypto?.randomUUID?.() || '').replaceAll('-','');
const fail = (code,message) => Object.assign(new Error(message),{code});
const localOrigin = origin => /^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin);

export function connectStorageChannel(options = {}, env = {}) {
    const win=env.window || window;
    if (!localOrigin(win.location.origin)) return Promise.reject(fail('origin','Нужен локальный SillyTavern: localhost или 127.0.0.1.'));
    return new Promise((resolve,reject)=>{
        const sessionId=idFor(win);
        if (!sessionPattern.test(sessionId)) {reject(fail('crypto','Браузер не предоставил безопасный ID канала.'));return;}
        let ended=false,localReady=false,opened=false,timer,companionVersion=null;
        const finish = error => {
            if(ended)return;ended=true;win.clearTimeout(timer);win.removeEventListener('message',receive);
            options.onDiagnostic?.({stage:error?'channel-unavailable':'channel-connected',code:error?.code || 'ok',protocol:'userscript-storage-v2'});
            error?reject(error):resolve({sessionId,protocol:'userscript-storage-v2',companionVersion});
        };
        const receive = e => {
            // Userscript sandboxes may expose a different Window wrapper for same-origin postMessage events.
            if(e.origin!==win.location.origin || e.data?.api!==COMPANION || e.data?.sessionId!==sessionId)return;
            const packet=e.data;
            if(packet.kind==='local-ready' && !opened){
                localReady=true;opened=true;
                const params=new URLSearchParams({pbSession:sessionId,pbReturnOrigin:win.location.origin});
                let popup;
                try {popup=win.open(`https://perchance.org/perchance-ai-api?${params}`,'_blank');} catch{}
                if(!popup)finish(fail('popup-blocked','Браузер заблокировал вкладку подключения Perchance.'));
            }
            if(packet.kind==='ready'){companionVersion=packet.version==='0.5.0'?'0.5.0':null;finish();}
            if(packet.kind==='bridge-error')finish(fail('manager-api','Менеджер userscript не предоставил API обмена между вкладками.'));
        };
        win.addEventListener('message',receive);
        timer=win.setTimeout(()=>finish(fail(localReady?'remote-companion-unavailable':'local-companion-unavailable',localReady
            ?'Companion работает в SillyTavern, но не подтвердил связь со вкладкой Perchance.'
            :'Companion 0.5.0 не запущен на localhost. Обнови установленный userscript и разреши его выполнение на этой странице.')),env.handshakeMs || 15000);
        win.postMessage({api:CLIENT,kind:'init',sessionId},win.location.origin);
    });
}

export function requestStorageImage(prompt,options={},env={}) {
    const win=env.window || window,sessionId=options.channel?.sessionId;
    if(!localOrigin(win.location.origin) || !sessionPattern.test(sessionId || ''))return Promise.reject(fail('channel-not-connected','Нет подключенного userscript-канала.'));
    return new Promise((resolve,reject)=>{
        const id=idFor(win);let ended=false,timer,ackTimer;
        const signal=options.signal;
        const send = (kind,extra={}) => win.postMessage({api:CLIENT,kind,sessionId,id,...extra},win.location.origin);
        const finish = (error,value) => {
            if(ended)return;ended=true;win.clearTimeout(timer);win.clearTimeout(ackTimer);
            win.removeEventListener('message',receive);signal?.removeEventListener('abort',abort);
            options.onDiagnostic?.({stage:error?'failed':'complete',code:error?.code || 'ok',protocol:'userscript-storage-v2'});
            error?reject(error):resolve(value);
        };
        const abort = () => {send('cancel');finish(fail('aborted','Ожидание Perchance отменено.'));};
        const receive = e => {
            const packet=e.data;
            // Tampermonkey may report a sandbox Window wrapper as event.source; origin and both IDs bind the reply.
            if(e.origin!==win.location.origin || packet?.api!==COMPANION || packet.sessionId!==sessionId || packet.id!==id)return;
            if(packet.kind==='accepted'){win.clearTimeout(ackTimer);options.onDiagnostic?.({stage:'generation-accepted',protocol:'userscript-storage-v2'});}
            if(packet.kind==='result')finish(null,packet.result);
            if(packet.kind==='bridge-error')finish(fail('companion-error','Companion сообщил об ошибке канала.'));
        };
        if(signal?.aborted){finish(fail('aborted','Генерация отменена.'));return;}
        win.addEventListener('message',receive);signal?.addEventListener('abort',abort,{once:true});
        timer=win.setTimeout(()=>finish(fail('tab-timeout','Perchance не вернул результат за 180 секунд. Проверь его рабочую вкладку.')),env.timeoutMs || 180000);
        ackTimer=win.setTimeout(()=>finish(fail('remote-companion-unavailable','Рабочая вкладка Perchance не приняла запрос. Генерация не подтверждена.')),env.ackMs || 8000);
        options.onDiagnostic?.({stage:'generation-submit',protocol:'userscript-storage-v2'});
        send('generate',{prompt,options:{resolution:options.resolution,negativePrompt:options.negativePrompt,guidanceScale:options.guidanceScale,seed:options.seed,removeBackground:options.removeBackground}});
    });
}
