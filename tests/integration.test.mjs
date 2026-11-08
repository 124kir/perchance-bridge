// Synthetic host only: this verifies extension orchestration, NOT the Perchance service.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as presets from '../presets.mjs';
import {ALLOWED_RESOLUTIONS,findImageTag,markdownImage,requestImage} from '../perchance-client.mjs';
import {connectStorageChannel} from '../companion-channel.mjs';
import {fixture} from './companion-fixture.mjs';
import {summarizeModelProbe} from '../prompt-diagnostics.mjs';
import {requestChatPrompt,promptTokenLimit} from '../prompt-builder.mjs';
const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
const professionalCatalogue=JSON.parse(await readFile(new URL('../professional-styles.json',import.meta.url),'utf8'));
function setup() {
 const elements=new Map(), handlers=new Map(), commands=new Map(), calls=[];
 function element(id='') {
  const el={id,value:'',hidden:false,checked:false,children:[],listeners:{},classList:{toggle(){}},style:{},
   appendChild(n){this.children.push(n);},replaceChildren(){this.children=[];},focus(){},click(){return this.listeners.click?.();},
   addEventListener(n,f){this.listeners[n]=f;},querySelector(q){return elements.get(q.slice(1));}};
  Object.defineProperty(el,'innerHTML',{set(html){for(const m of html.matchAll(/id="([^"]+)"/g)) elements.set(m[1],element(m[1]));}});
  return el;
 }
 const mount=element(), menu=element();
 const c={extensionSettings:{perchance_bridge:{transport:'iframe',nativeMirror:true,styles:[{id:'mine',name:'Mine',positive:'cinematic',negative:''}],styleId:'mine'},sd:{prompts:{5:'native portrait of {{char}}'}}},
  chat:[{is_user:false,mes:'Synthetic scene'}],getCurrentChatId:()=>c.currentId,currentId:'synthetic',name2:'Synthetic',
  eventTypes:{SD_PROMPT_PROCESSING:'sd',CHARACTER_MESSAGE_RENDERED:'render'},
  eventSource:{on:(n,f)=>handlers.set(n,f),emit:async()=>{}},saveSettingsDebounced(){},addOneMessage:m=>calls.push(['message',m]),saveChat:async()=>calls.push(['save']),
  registerFunctionTool:t=>c.tool=t,substituteParams:s=>s.replace('{{char}}','Synthetic'),
  POPUP_TYPE:{CONFIRM:2},POPUP_RESULT:{AFFIRMATIVE:1,CANCELLED:null},
  callGenericPopup:async(content,type,value,options)=>{calls.push(['review',content,options]);return 1;},
  generateQuietPrompt:async args=>{calls.push(['draft',args.quietPrompt]);return 'synthetic portrait';},
  getRequestHeaders:()=>({'Content-Type':'application/json'}),
  SlashCommandParser:{addCommandObject:o=>commands.set(o.name,o.callback)},SlashCommand:{fromProps:o=>o},SlashCommandArgument:{fromProps:o=>o},ARGUMENT_TYPE:{STRING:'string'}};
 let transport = async (prompt,opts)=>{calls.push(['request',prompt,opts]);return {dataUrl:'data:image/png;base64,AAAA'};};
 const document={readyState:'loading',getElementById:id=>id==='extensions_settings2'?mount:id==='extensionsMenu'?menu:elements.get(id),createElement:()=>element(),addEventListener(){}};
 const popups=[];
 const open=()=>{calls.push(['open']);const p={closed:false,location:{href:'about:blank'},close(){this.closed=true;}};popups.push(p);return p;};
 const context={...presets,openPerchanceChannel:async()=>open(),requestChatPrompt,promptTokenLimit,summarizeModelProbe,professionalCatalogue,ALLOWED_RESOLUTIONS,findImageTag,markdownImage,requestImage:(...args)=>transport(...args),SillyTavern:{getContext:()=>c},
  document,window:{open,toastr:{info(){},error(){}}},AbortController,console,Blob,URL,setTimeout,
  createImageBitmap:async()=>({close(){}}),
  FileReader:class {readAsDataURL(){this.result='data:image/png;base64,AAAA';queueMicrotask(()=>this.onload());}},
  fetch:async (url,opts)=>{
   if(url.startsWith('data:'))return {blob:async()=>new Blob(['synthetic'],{type:'image/png'})};
   if(url==='https://user.uploads.dev/synthetic.jpg')return {ok:true,blob:async()=>new Blob(['synthetic'],{type:'image/png'})};
   calls.push(['upload',JSON.parse(opts.body)]);return {ok:true,json:async()=>({path:'/synthetic/image.png'})};
  }};
 vm.createContext(context);
 vm.runInContext(source.replace(/^import .*;\r?\n/gm,'')+'\nglobalThis.testAPI={initialize,generate,draftFromChat,captureNativePrompt,settings,onMessageRendered};',context);
 context.testAPI.initialize();
 return {c,calls,elements,commands,menu,popups,api:context.testAPI,setTransport:f=>transport=f,setConnector:f=>context.openPerchanceChannel=f};
}
test('migrates only own settings, backs up old mirror, never mirrors native requests',async()=>{
 const h=setup(); assert.equal(h.api.settings().nativeMirror,false);assert.equal(h.api.settings().backupV02.nativeMirror,true);
 h.api.captureNativePrompt({prompt:'native synthetic'});await Promise.resolve();
 assert.equal(h.calls.filter(x=>x[0]==='request').length,0);assert.equal(h.api.settings().styles[0].name,'Mine');
});
test('UI, slash and tool each use a single common route, chosen style, upload and media attachment',async()=>{
 for(const route of ['ui','slash','tool']) {
  const h=setup();h.elements.get('pb_prompt').value='apple';
  if(route==='ui')await h.elements.get('pb_generate').click();
  if(route==='slash')await h.commands.get('perchance')({},'apple');
  if(route==='tool')await h.c.tool.action({prompt:'apple'});
  assert.equal(h.calls.filter(x=>x[0]==='request').length,1);
  assert.equal(h.calls.find(x=>x[0]==='request')[1],'apple, cinematic');
  assert.equal(h.calls.filter(x=>x[0]==='upload').length,1);
  assert.equal(h.c.chat.at(-1).extra.media[0].url,'/synthetic/image.png');
  assert.equal(h.calls.filter(x=>x[0]==='save').length,1);
 }
});
test('native template drafts via quiet LLM, without any image backend',async()=>{
 const h=setup();await h.api.draftFromChat(5);
 assert.equal(h.calls.find(x=>x[0]==='draft')[1],'native portrait of Synthetic');
 assert.equal(h.calls.filter(x=>x[0]==='request').length,0);
});
test('chat menu uses only a previously explicitly connected tab',async()=>{
 const h=setup();h.api.settings().transport='tab';await h.elements.get('pb_connect').click();await h.menu.children[0].children.find(b=>b.textContent==='Perchance — изображение из диалога').click();
 assert.equal(h.calls[0][0],'open');assert.equal(h.calls[1][0],'draft');
 assert.equal(h.calls.filter(x=>x[0]==='request').length,1);
 assert.equal(h.calls.find(x=>x[0]==='request')[2].popup,h.popups[0]);
 assert.equal(h.c.chat.at(-1).extra.media[0].url,'/synthetic/image.png');
});
test('/perchance without arguments generates from chat and reuses reserved channel',async()=>{
 const h=setup();h.api.settings().transport='tab';await h.elements.get('pb_connect').click();await h.commands.get('perchance')({},'');await h.commands.get('perchance-chat')({},'');
 assert.equal(h.calls.filter(x=>x[0]==='open').length,1);
 assert.equal(h.calls.filter(x=>x[0]==='draft').length,2);
 assert.equal(h.calls.filter(x=>x[0]==='request').length,2);
});
test('new channel token is passed to transport without using an opener window',async()=>{
 const h=setup();h.api.settings().transport='tab';const channel={sessionId:'a'.repeat(32),protocol:'userscript-storage-v2'};
 h.setConnector(async()=>channel);await h.elements.get('pb_connect').click();await h.commands.get('perchance')({},'apple');
 const request=h.calls.find(c=>c[0]==='request');assert.equal(request[2].channel,channel);assert.equal(request[2].popup,null);assert.equal(h.popups.length,0);
});
test('iframe JSON response crosses the real storage transport, downloads, uploads and appends a synthetic chat image',async()=>{
 const bus=fixture({asyncStorage:true}),h=setup();h.api.settings().transport='tab';h.api.settings().imageCount=3;
 h.setConnector(()=>connectStorageChannel({}, {window:bus.local.win}));
 h.setTransport((prompt,opts)=>requestImage(prompt,opts,{window:bus.local.win,ackMs:1000,timeoutMs:1000}));
 await h.elements.get('pb_connect').click();
 const pending=h.api.generate('synthetic apple');
 for(let i=0;i<3;i++){
 await new Promise(resolve=>setImmediate(resolve));
 const target=new URL(bus.remote.navigation),id=target.searchParams.get('id');bus.navigate();
 const frame=bus.boot('https://a485ca10d45752b37a2b42b5434df493.perchance.org'+target.pathname+target.search,'generator',{framed:true});
 frame.setResponse({id,ok:true,url:'https://user.uploads.dev/synthetic.jpg'});
 }
 await pending;
 assert.equal(h.c.chat.at(-1).extra.media[0].url,'/synthetic/image.png');
 assert.equal(h.calls.filter(c=>c[0]==='upload').length,3);
 assert.equal(h.calls.filter(c=>c[0]==='save').length,3);
 assert.match(h.elements.get('pb_status').textContent,/изображений: 3/);
});
test('chat action uses native-built context/raw LLM response and starts exactly one image backend',async()=>{
 const h=setup(), listeners=new Map();h.c.mainApi='openai';h.c.eventTypes.GENERATE_AFTER_DATA='data';
 h.c.eventSource.on=(n,f)=>listeners.set(n,f);h.c.eventSource.removeListener=n=>listeners.delete(n);
 h.c.generate=async(type,args,dry)=>{assert.equal(dry,true);listeners.get('data')({prompt:[{role:'system',content:args.quiet_prompt},{role:'user',content:'synthetic context'}]},true);};
 let rawCalls=0;
 h.c.generateQuietPrompt=()=>{throw Error('old quiet path must not run');};
 h.c.generateRawData=async args=>{rawCalls++;assert.equal(args.responseLength,4096);return {choices:[{message:{content:'red apple'},finish_reason:'stop'}]};};
 h.c.extractMessageFromData=d=>d.choices[0].message.content;
 await h.commands.get('perchance')({},'');
 assert.equal(rawCalls,1);assert.equal(h.calls.filter(x=>x[0]==='request').length,1);
 assert.equal(h.calls.find(x=>x[0]==='request')[1],'red apple, cinematic');
 assert.equal(listeners.size,0);assert.equal(h.c.chat.at(-1).extra.media[0].url,'/synthetic/image.png');
});
test('empty chat draft never generates a stale panel prompt or opens a tab',async()=>{
 const h=setup();h.elements.get('pb_prompt').value='stale prompt';h.c.generateQuietPrompt=async()=>'';
 assert.equal(await h.commands.get('perchance-chat')({},''),'');
 assert.equal(h.calls.filter(x=>x[0]==='request').length,0);assert.equal(h.popups.length,0);
});
test('cancelling while drafting does not start image generation when LLM later responds',async()=>{
 const h=setup();let resolve;h.c.generateQuietPrompt=()=>new Promise(r=>resolve=r);
 const p=h.commands.get('perchance-chat')({},'');h.elements.get('pb_cancel').click();resolve('apple');await p;
 assert.equal(h.calls.filter(x=>x[0]==='request').length,0);assert.equal(h.popups.length,0);
});
test('disconnected chat commands do not open windows, call LLM, request images or advertise the tool',async()=>{
 const h=setup();h.api.settings().transport='tab';h.api.settings().autoTool=true;
 assert.equal(await h.commands.get('perchance')({},''),'');
 assert.equal(await h.commands.get('perchance')({},'apple'),'');
 assert.equal(h.c.tool.shouldRegister(),false);assert.equal(h.calls.length,0);assert.equal(h.popups.length,0);
 assert.match(h.elements.get('pb_status').textContent,/Нет подключенного канала/);
});
test('empty quiet response reports the actual failing boundary without exposing content',async()=>{
 const h=setup();h.c.generateQuietPrompt=async()=>'';
 await h.api.draftFromChat();
 assert.match(h.elements.get('pb_status').textContent,/пустой служебный ответ/);
 assert.match(h.elements.get('pb_diagnostics').textContent,/"textChars":0/);
 assert.equal(h.calls.filter(x=>x[0]==='request').length,0);
});
test('model probe passes no chat history and records counts, never raw API content',async()=>{
 const h=setup();let args;
 h.c.generateRawData=async a=>{args=a;return {choices:[{message:{content:'',reasoning:'PRIVATE_THOUGHT'},finish_reason:'length'}]};};
 await h.elements.get('pb_model_test').click();
 assert.equal(args.responseLength,2048);assert.ok(!JSON.stringify(args).includes('Synthetic scene'));
 const log=h.elements.get('pb_diagnostics').textContent;
 assert.ok(!log.includes('PRIVATE_THOUGHT'));assert.match(log,/"reasoningChars":15/);assert.match(log,/"finishReason":"length"/);
 assert.match(h.elements.get('pb_status').textContent,/reasoning присутствует/);
});
test('native tool conflict blocks Perchance and tags are suppressed in tool mode',async()=>{
 const h=setup();h.api.settings().autoTool=true;h.c.extensionSettings.sd.function_tool=true;
 assert.equal(h.c.tool.shouldRegister(),false);await assert.rejects(h.c.tool.action({prompt:'apple'}),/Use function tool/);
 h.c.chat[0].mes='[PERCHANCE: apple]';h.api.settings().autoTags=true;await h.api.onMessageRendered(0);
 assert.equal(h.calls.filter(x=>x[0]==='request').length,0);
});
test('concurrent requests rejected; switched chat gets no image; original result retained in preview',async()=>{
 const h=setup();let resolve;h.setTransport(()=>new Promise(r=>resolve=r));
 const p=h.api.generate('apple');await assert.rejects(h.api.generate('second'),/уже/);
 h.c.currentId='different';h.c.chat=[];resolve({dataUrl:'data:image/png;base64,AAAA'});await p;
 assert.equal(h.c.chat.length,0);assert.equal(h.elements.get('pb_preview').src,'/synthetic/image.png');
 assert.match(h.elements.get('pb_status').textContent,/Чат изменился/);
});
test('cancel prevents save and posting even if transport later resolves',async()=>{
 const h=setup();let resolve;h.setTransport(()=>new Promise(r=>resolve=r));
 const p=h.api.generate('apple');await new Promise(resolve=>setImmediate(resolve));
 const rejected=assert.rejects(p);h.elements.get('pb_cancel').click();resolve({dataUrl:'data:image/png;base64,AAAA'});
 await rejected;assert.equal(h.calls.filter(x=>x[0]==='upload').length,0);assert.equal(h.c.chat.length,1);
});
test('chat switch during an awaited message event does not render or save to new chat',async()=>{
 const h=setup();h.c.eventTypes.MESSAGE_RECEIVED='received';
 h.c.eventSource.emit=async n=>{if(n==='received'){h.c.currentId='different';h.c.chat=[];}};
 await h.api.generate('apple');
 assert.equal(h.calls.filter(x=>x[0]==='message'||x[0]==='save').length,0);
 assert.equal(h.c.chat.length,0);
});
test('menu exposes all image modes and style/count controls stay synchronized',async()=>{
 const h=setup(),labels=h.menu.children[0].children.map(b=>b.textContent||'');
 for(const label of ['персонаж целиком','моя фотография','вся история','последнее сообщение','последнее сообщение без обработки','фон','все персонажи (The Cast)','по готовому промпту'])assert.ok(labels.includes('Perchance — '+label));
 const menuStyle=h.elements.get('pb_menu_style');menuStyle.value='mine';menuStyle.listeners.change({target:menuStyle});
 assert.equal(h.elements.get('pb_style').value,'mine');
 const count=h.elements.get('pb_menu_count');count.value=3;count.listeners.change({target:count});
 assert.equal(h.elements.get('pb_count').value,3);assert.equal(h.api.settings().imageCount,3);
 await h.commands.get('perchance-count')({},'99');assert.equal(h.api.settings().imageCount,8);
});
test('batch sends sequential requests with distinct fixed seeds and saves every result',async()=>{
 const h=setup();h.api.settings().imageCount=3;h.api.settings().seed=42;
 await h.api.generate('apple');const requests=h.calls.filter(c=>c[0]==='request');
 assert.deepEqual(requests.map(c=>c[2].seed),[42,43,44]);
 assert.equal(h.calls.filter(c=>c[0]==='save').length,3);assert.equal(h.c.chat.length,4);
 assert.match(h.elements.get('pb_status').textContent,/изображений: 3/);
});
test('batch refuses an older companion before sending an image request',async()=>{
 const h=setup();h.api.settings().transport='tab';h.api.settings().imageCount=2;
 h.setConnector(async()=>({sessionId:'a'.repeat(32)}));await h.elements.get('pb_connect').click();
 await assert.rejects(h.api.generate('apple'),/обнови companion/);
 assert.equal(h.calls.filter(c=>c[0]==='request').length,0);
});
test('chosen anime style and batch settings are applied and remain stable during the series',async()=>{
 const h=setup();await h.commands.get('perchance-style')({},'anime');h.api.settings().imageCount=2;h.api.settings().seed=12;
 const requests=[];h.setTransport(async(prompt,opts)=>{
  requests.push({prompt,negative:opts.negativePrompt,seed:opts.seed});
  h.api.settings().styleId='photo';h.api.settings().imageCount=8;h.api.settings().seed=99;
  return {dataUrl:'data:image/png;base64,AAAA'};
 });
 await h.api.generate('apple');assert.equal(requests.length,2);
 for(const r of requests){assert.match(r.prompt,/anime illustration/);assert.match(r.negative,/photograph/);}
 assert.deepEqual(requests.map(r=>r.seed),[12,13]);
 assert.equal(h.api.settings().styles.find(s=>s.id==='mine').name,'Mine');
});
test('batch failure preserves completed images and never retries remaining requests',async()=>{
 const h=setup();h.api.settings().imageCount=3;let requests=0;
 h.setTransport(async()=>{if(++requests===2)throw Error('synthetic failure');return {dataUrl:'data:image/png;base64,AAAA'};});
 await assert.rejects(h.api.generate('apple'),/synthetic failure/);
 assert.equal(requests,2);assert.equal(h.c.chat.length,2);assert.match(h.elements.get('pb_status').textContent,/Получено 1 из 3/);
});
test('batch cancellation and chat switch prevent later image requests',async()=>{
 for(const action of ['cancel','switch']){
  const h=setup();h.api.settings().imageCount=3;let requests=0;
  h.setTransport(async()=>{requests++;return {dataUrl:'data:image/png;base64,AAAA'};});
  h.c.saveChat=async()=>{if(action==='cancel')h.elements.get('pb_cancel').click();else h.c.currentId='changed';};
  const pending=h.api.generate('apple');if(action==='cancel')await assert.rejects(pending);else await pending;
  assert.equal(requests,1);assert.equal(h.c.chat.length,2);
 }
});
test('raw-last mode uses the latest non-system message without calling the model',async()=>{
 const h=setup();h.c.chat.push({is_user:true,mes:'a synthetic garden'},{is_system:true,mes:'skip this'});
 h.c.generateQuietPrompt=()=>{throw Error('must not call model');};
 await h.commands.get('perchance-raw-last')({},'');
 assert.equal(h.calls.find(c=>c[0]==='request')[1],'a synthetic garden, cinematic');
});
test('new native modes use their corresponding templates, and cast asks for a group composition',async()=>{
 for(const [name,mode] of [['you',0],['me',1],['story',2],['last',4],['background',7]]){
  const h=setup();h.c.extensionSettings.sd.prompts[mode]='synthetic template '+mode;
  await h.commands.get('perchance-'+name)({},'');
  assert.equal(h.calls.find(c=>c[0]==='draft')[1],'synthetic template '+mode);
 }
 const h=setup();await h.commands.get('perchance-cast')({},'');
 assert.match(h.calls.find(c=>c[0]==='draft')[1],/group composition/);
});
test('review blocks transmission, applies edits once and confirms the entire batch once',async()=>{
 const h=setup();h.api.settings().imageCount=3;let approve;
 h.c.callGenericPopup=async()=>new Promise(resolve=>approve=resolve);
 const pending=h.api.generate('apple');
 assert.equal(h.calls.filter(c=>c[0]==='request').length,0);
 assert.match(h.elements.get('pb_review_summary').textContent,/Картинок: 3/);
 assert.equal(h.elements.get('pb_review_final').value,'apple, cinematic');
 const prompt=h.elements.get('pb_review_prompt');prompt.value='a blue lake';prompt.listeners.input();
 h.elements.get('pb_review_negative').value='blurry';
 assert.equal(h.elements.get('pb_review_final').value,'a blue lake, cinematic');
 approve(1);await pending;
 const requests=h.calls.filter(c=>c[0]==='request');assert.equal(requests.length,3);
 for(const r of requests){assert.equal(r[1],'a blue lake, cinematic');assert.equal(r[2].negativePrompt,'blurry');}
 assert.equal(h.elements.get('pb_prompt').value,'a blue lake');assert.equal(h.api.settings().lastPrompt,'a blue lake');
});
test('cancel or close in preview sends no image request and saves no chat',async()=>{
 for(const result of [0,null]){
  const h=setup();h.c.callGenericPopup=async()=>result;
  assert.equal(await h.api.generate('apple'),'');
  assert.equal(h.calls.filter(c=>['request','upload','save'].includes(c[0])).length,0);
  assert.equal(h.c.chat.length,1);assert.match(h.elements.get('pb_status').textContent,/отменено до отправки/);
 }
});
test('review validates empty and oversized prompts, allowing correction before submission',async()=>{
 const h=setup();let checked=false;
 h.c.callGenericPopup=async(content,type,value,options)=>{
  assert.match(h.elements.get('pb_review_error').textContent,/Максимум/);
  const prompt=h.elements.get('pb_review_prompt');prompt.value='';
  assert.equal(options.onClosing({result:1}),false);
  assert.match(h.elements.get('pb_review_error').textContent,/пустой/);
  prompt.value='fixed prompt';assert.equal(options.onClosing({result:1}),true);
  checked=true;return 1;
 };
 await h.api.generate('a'.repeat(2100));assert.ok(checked);
 assert.equal(h.calls.find(c=>c[0]==='request')[1],'fixed prompt, cinematic');
});
test('chat switch during prompt review cancels before transmission',async()=>{
 const h=setup();let approve;h.c.callGenericPopup=()=>new Promise(resolve=>approve=resolve);
 const pending=h.api.generate('apple');h.c.currentId='changed';approve(1);await pending;
 assert.equal(h.calls.filter(c=>c[0]==='request').length,0);
 assert.match(h.elements.get('pb_status').textContent,/Чат изменился во время проверки/);
});
test('native popup is closed on cancellation while waiting for approval',async()=>{
 const h=setup();let dismiss,closed=0;
 h.c.Popup=class{show(){return new Promise(resolve=>dismiss=resolve);}async complete(result){closed++;dismiss(result);}};
 const pending=h.api.generate('apple');const rejected=assert.rejects(pending);
 h.elements.get('pb_cancel').click();await rejected;
 assert.equal(closed,1);assert.equal(h.calls.filter(c=>c[0]==='request').length,0);
});
test('disabled review sends directly, and cancelled tool review does not claim an image was created',async()=>{
 const h=setup();h.api.settings().reviewBeforeSend=false;await h.api.generate('apple');
 assert.equal(h.calls.filter(c=>c[0]==='review').length,0);
 const k=setup();k.c.callGenericPopup=async()=>null;
 assert.match(await k.c.tool.action({prompt:'apple'}),/cancelled/);
 assert.equal(k.calls.filter(c=>c[0]==='request').length,0);
});
test('menu preview toggle synchronizes with the panel and controls the confirmation step',async()=>{
 const h=setup(),menu=h.elements.get('pb_menu_review'),panel=h.elements.get('pb_review');
 assert.equal(menu.checked,true);assert.equal(panel.checked,true);
 menu.checked=false;menu.listeners.change({target:menu});
 assert.equal(panel.checked,false);assert.equal(h.api.settings().reviewBeforeSend,false);
 await h.api.generate('apple');assert.equal(h.calls.filter(c=>c[0]==='review').length,0);
 panel.checked=true;panel.listeners.change({target:panel});
 assert.equal(menu.checked,true);assert.equal(h.api.settings().reviewBeforeSend,true);
 await h.api.generate('apple');assert.equal(h.calls.filter(c=>c[0]==='review').length,1);
});
test('empty model reply opens a blank manual editor and sends only the user correction, with no model retry',async()=>{
 const h=setup();h.api.settings().reviewBeforeSend=false;h.elements.get('pb_prompt').value='STALE_PROMPT';let requests=0;
 h.c.generateQuietPrompt=async()=>{requests++;throw Object.assign(Error('empty final'),{code:'empty-model-prompt'});};
 h.c.callGenericPopup=async()=>{
  assert.equal(h.elements.get('pb_review_prompt').value,'');
  assert.match(h.elements.get('pb_review_summary').textContent,/Введите описание вручную/);
  h.elements.get('pb_review_prompt').value='manual landscape';return 1;
 };
 await h.commands.get('perchance-chat')({},'');
 assert.equal(requests,1);assert.equal(h.calls.find(c=>c[0]==='request')[1],'manual landscape, cinematic');
 assert.equal(h.api.settings().reviewBeforeSend,false);
});
test('cancelling manual recovery sends nothing and preserves the previous saved prompt',async()=>{
 const h=setup();h.api.settings().lastPrompt='previous saved prompt';h.elements.get('pb_prompt').value='previous saved prompt';
 h.c.generateQuietPrompt=async()=>{throw Object.assign(Error('empty final'),{code:'empty-model-prompt'});};
 h.c.callGenericPopup=async()=>null;await h.commands.get('perchance-chat')({},'');
 assert.equal(h.calls.filter(c=>c[0]==='request').length,0);assert.equal(h.api.settings().lastPrompt,'previous saved prompt');
});
test('other model errors do not trigger manual recovery or send an image',async()=>{
 const h=setup();h.c.generateQuietPrompt=async()=>{throw Error('model refusal or API failure');};
 await h.commands.get('perchance-chat')({},'');
 assert.equal(h.calls.filter(c=>['review','request'].includes(c[0])).length,0);
});
