// ==UserScript==
// @name Perchance Bridge — return result to local SillyTavern
// @namespace perchance-bridge-local
// @version 0.5.0
// @description Explicit cross-tab channel for Perchance and local SillyTavern. Does not read chat DOM, cookies or keys.
// @match https://perchance.org/perchance-ai-api*
// @match https://a485ca10d45752b37a2b42b5434df493.perchance.org/perchance-ai-api*
// @match http://localhost/*
// @match https://localhost/*
// @match http://127.0.0.1/*
// @match https://127.0.0.1/*
// @run-at document-start
// @grant GM_setValue
// @grant GM_deleteValue
// @grant GM_addValueChangeListener
// @grant GM_removeValueChangeListener
// ==/UserScript==
(() => {
    'use strict';
    const generatorOrigin='https://a485ca10d45752b37a2b42b5434df493.perchance.org';
    const resultFrame=location.origin===generatorOrigin && location.pathname==='/perchance-ai-api';
    if(resultFrame){
        let parentOrigin;
        try{parentOrigin=location.ancestorOrigins?.[0] || new URL(document.referrer).origin;}catch{return;}
        if(window.parent===window || parentOrigin!=='https://perchance.org')return;
    }else if(window.top!==window)return;
    const CLIENT='perchance-bridge-client-v2',COMPANION='perchance-bridge-companion-v2';
    const validId=id=>typeof id==='string' && /^[a-f0-9]{32}$/i.test(id);
    const localOrigin=origin=>/^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin);
    const key=(session,direction)=>`perchance-bridge-v2:${session}:${direction}`;
    const supported=()=>typeof GM_setValue==='function' && typeof GM_deleteValue==='function' && typeof GM_addValueChangeListener==='function' && typeof GM_removeValueChangeListener==='function';
    const fresh=p=>p && Number.isFinite(p.sentAt) && Math.abs(Date.now()-p.sentAt)<15000;
    function write(session,direction,packet){
        const storageKey=key(session,direction);
        try { GM_setValue(storageKey,{...packet,sentAt:Date.now()}); }
        finally { GM_deleteValue(storageKey); }
    }
    function post(sessionId,packet){window.postMessage({api:COMPANION,sessionId,...packet},location.origin);}

    if(localOrigin(location.origin)){
        // No listeners on login pages or unrelated local apps' non-root paths.
        if(location.pathname!=='/' && !location.pathname.startsWith('/scripts/extensions/third-party/perchance-bridge/tests/'))return;
        let session=null,listener=null;
        window.addEventListener('message',event=>{
            const p=event.data;
            // Tampermonkey may wrap Window differently across worlds; origin + session ID validate the local handshake.
            if(event.origin!==location.origin || p?.api!==CLIENT || !validId(p.sessionId))return;
            if(!supported()){post(p.sessionId,{kind:'bridge-error'});return;}
            if(p.kind==='init'){
                if(listener!==null)GM_removeValueChangeListener(listener);
                if(session){GM_deleteValue(key(session,'request'));GM_deleteValue(key(session,'status'));}
                session=p.sessionId;
                const paired=session;
                listener=GM_addValueChangeListener(key(paired,'status'),(_name,_old,value,remote)=>{
                    if(!remote || !fresh(value) || !['ready','accepted','result','bridge-error'].includes(value.kind))return;
                    if(value.kind!=='ready' && !validId(value.id))return;
                    GM_deleteValue(key(paired,'status'));
                    post(paired,value);
                });
                post(session,{kind:'local-ready',version:'0.5.0'});
                return;
            }
            if(p.sessionId!==session || !validId(p.id))return;
            if(p.kind==='generate'){
                if(typeof p.prompt!=='string' || !p.prompt.trim() || p.prompt.length>2000)return;
                write(session,'request',{kind:'generate',id:p.id,prompt:p.prompt,options:p.options || {}});
            } else if(p.kind==='cancel')write(session,'request',{kind:'cancel',id:p.id});
        });
        return;
    }
    if((!resultFrame && location.origin!=='https://perchance.org') || location.pathname!=='/perchance-ai-api' || !supported())return;
    const params=new URLSearchParams(location.search),session=params.get('pbSession'),returnOrigin=params.get('pbReturnOrigin');
    if(!validId(session) || !localOrigin(returnOrigin))return;
    const currentId=params.get('id');let done=false,responseObserver=null;
    const status=p=>write(session,'status',p);
    const sendResult=r=>{
        if(done)return;
        done=true;
        responseObserver?.disconnect();
        const result={ok:r.ok===true,seed:Number.isSafeInteger(r.seed)?r.seed:null};
        if(typeof r.url==='string' && r.url.length<4096)result.url=r.url;
        if(typeof r.dataUrl==='string' && r.dataUrl.length<21*1024*1024)result.dataUrl=r.dataUrl;
        if(!result.ok)result.error='Perchance сообщил об ошибке генерации';
        status({kind:'result',id:currentId,result});
    };
    function watchJsonResponse(){
        if(!validId(currentId) || params.get('format')!=='json')return;
        const readJsonResponse=()=>{
            if(done)return;
            for(const pre of document.querySelectorAll('pre')){
                let response;
                try{response=JSON.parse(pre.textContent.trim());}catch{continue;}
                if(response?.id!==currentId || typeof response.ok!=='boolean')continue;
                sendResult(response);
                return;
            }
        };
        responseObserver=new MutationObserver(readJsonResponse);
        const observeDocument=()=>{
            if(done)return;
            if(document.documentElement)responseObserver.observe(document.documentElement,{childList:true,subtree:true,characterData:true});
            readJsonResponse();
        };
        if(document.documentElement)observeDocument();
        else document.addEventListener('DOMContentLoaded',observeDocument,{once:true});
        window.addEventListener('pagehide',()=>responseObserver.disconnect(),{once:true});
    }
    // The JSON belongs to the cross-origin generator iframe. The frame reads its own
    // response and relays only image fields through the manager, without DOM access to SillyTavern.
    if(resultFrame){watchJsonResponse();return;}
    // A JSON result is published directly by the child frame. Mark this outer page
    // idle too, so that it can accept the next image in a sequential batch.
    if(currentId)GM_addValueChangeListener(key(session,'status'),(_key,_old,p)=>{
        if(fresh(p) && p.kind==='result' && p.id===currentId){done=true;responseObserver?.disconnect();}
    });
    GM_addValueChangeListener(key(session,'request'),(_name,_old,p,remote)=>{
        if(!remote || !fresh(p) || !validId(p.id))return;
        GM_deleteValue(key(session,'request'));
        if(p.kind==='cancel'){
            if(p.id===currentId && !done){done=true;location.assign(`https://perchance.org/perchance-ai-api?${new URLSearchParams({pbSession:session,pbReturnOrigin:returnOrigin})}`);}
            return;
        }
        if(p.kind!=='generate' || typeof p.prompt!=='string' || !p.prompt.trim() || p.prompt.length>2000)return;
        if(currentId && !done){status({kind:'bridge-error',id:p.id});return;}
        const o=p.options || {};
        const query=new URLSearchParams({pbSession:session,pbReturnOrigin:returnOrigin,id:p.id,prompt:p.prompt,format:'json'});
        query.set('resolution',['512x512','512x768','768x512','768x768'].includes(o.resolution)?o.resolution:'768x768');
        if(typeof o.negativePrompt==='string')query.set('negativePrompt',o.negativePrompt.slice(0,1000));
        if(Number.isFinite(Number(o.guidanceScale)))query.set('guidanceScale',String(Math.max(1,Math.min(30,Number(o.guidanceScale)))));
        if(Number.isSafeInteger(o.seed) && o.seed>=0)query.set('seed',String(o.seed));
        if(o.removeBackground===true)query.set('removeBackground','true');
        status({kind:'accepted',id:p.id});
        location.assign(`https://perchance.org/perchance-ai-api?${query}`);
    });
    window.addEventListener('message',event=>{
        if(done || !currentId || event.origin!==generatorOrigin || event.data?.api!=='perchance-image-api' || event.data?.result?.id!==currentId)return;
        const owned=[...document.querySelectorAll('iframe')].some(f=>f.contentWindow===event.source && f.src.startsWith(generatorOrigin+'/perchance-ai-api'));
        if(!owned)return;
        sendResult(event.data.result);
    });
    // Keep compatibility with an API deployment that renders JSON in the outer document.
    watchJsonResponse();
    status({kind:'ready',version:'0.5.0'});
})();
