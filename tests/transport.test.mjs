import test from 'node:test';
import assert from 'node:assert/strict';
import { requestImage, openPerchanceChannel, GENERATOR_ENDPOINT, unpackImageResult, validateRemoteImageUrl } from '../perchance-client.mjs';

function environment() {
 const handlers = new Map(), frameWindow = {};
 const frame = {contentWindow:frameWindow,style:{},setAttribute(){},remove(){this.removed=true;}};
 const popup = {location:{href:''}};
 const win = {crypto:{randomUUID:()=> '12345678-abcd-1234-abcd-123456789012'}, location:{origin:'http://localhost:8000'},setTimeout,clearTimeout,
  addEventListener:(n,f)=>handlers.set(n,f),removeEventListener:n=>handlers.delete(n),postMessage:(packet)=>{win.posted=packet;},open:(url)=>{win.url=url;return popup;}};
 const doc = {createElement:()=>frame,body:{appendChild(){}},addEventListener:(n,f)=>handlers.set(n,f),removeEventListener:n=>handlers.delete(n)};
 const emit = (data, source=frameWindow, origin=new URL(GENERATOR_ENDPOINT).origin) => handlers.get('message')?.({data,source,origin});
 return {window:win,document:doc,frame,popup,handlers,emit,timeoutMs:200,handshakeMs:100};
}
const response = id => ({api:'perchance-image-api',result:{id,ok:true,url:'https://user.uploads.dev/x.jpg'}});
test('rejects sibling windows and wrong IDs even with trusted origin',async()=>{
 const e=environment(); const p=requestImage('apple',{},e); const id=new URL(e.frame.src).searchParams.get('id');
 e.emit(response(id),{}); assert.equal(e.frame.removed,undefined);
 e.emit(response('other')); assert.equal(e.frame.removed,undefined);
 e.emit(response(id)); assert.ok((await p).url); assert.equal(e.handlers.size,0);
});
test('timeout describes uncertainty and releases iframe and listeners',async()=>{
 const e=environment(); e.timeoutMs=5;
 await assert.rejects(requestImage('apple',{},e),err=>err.code==='timeout');
 assert.ok(e.frame.removed); assert.equal(e.handlers.size,0);
});
test('abort before start does not append, mid-flight abort cleans up',async()=>{
 for(const before of [true,false]) {
  const e=environment(), controller=new AbortController(); if(before)controller.abort();
  const p=requestImage('apple',{signal:controller.signal},e); if(!before) controller.abort();
  await assert.rejects(p,err=>err.code==='aborted'); assert.equal(e.handlers.size,0);
 }
});
test('CSP and iframe errors are distinguished',async()=>{
 const e=environment(); const p=requestImage('apple',{},e);
 e.handlers.get('securitypolicyviolation')({effectiveDirective:'frame-src',blockedURI:GENERATOR_ENDPOINT});
 await assert.rejects(p,err=>err.code==='csp');
 const f=environment(); const q=requestImage('apple',{},f); f.frame.onerror();
 await assert.rejects(q,err=>err.code==='iframe');
});
test('diagnostics do not contain prompt or server error content',async()=>{
 const e=environment(), events=[]; const p=requestImage('PRIVATE_PROMPT',{onDiagnostic:d=>events.push(d)},e);
 const id=new URL(e.frame.src).searchParams.get('id'); e.emit(response(id)); await p;
 assert.ok(!JSON.stringify(events).includes('PRIVATE_PROMPT')); assert.ok(events.some(d=>d.stage==='complete'));
});
test('ordinary tab validates opener window, origin and correlation; cleans up',async()=>{
 const e=environment(); const p=requestImage('apple',{transport:'tab',popup:e.popup},e); const id=new URL(e.popup.location.href).searchParams.get('id');
 const data={api:'perchance-bridge-result',id,result:response(id).result};
 e.emit(data,{},'https://perchance.org'); assert.equal(e.handlers.has('message'),true);
 e.emit(data,e.popup,'https://evil.test'); assert.equal(e.handlers.has('message'),true);
 e.emit({api:'perchance-bridge-ready',id},e.popup,'https://perchance.org');
 e.emit(data,e.popup,'https://perchance.org'); assert.ok((await p).url); assert.equal(e.handlers.size,0);
});
test('popup block and missing companion fail explicitly',async()=>{
 const e=environment(); e.window.open=()=>null;
 const connection=openPerchanceChannel({},e);
 e.emit({api:'perchance-bridge-companion-v2',kind:'local-ready',sessionId:e.window.posted.sessionId},e.window,e.window.location.origin);
 await assert.rejects(connection,/заблокировал/);
 const f=environment(); f.handshakeMs=5;
 await assert.rejects(requestImage('apple',{transport:'tab',popup:f.popup},f),err=>err.code==='companion-unavailable');
 assert.equal(f.handlers.size,0);
});
test('unconnected generation cannot open a window',async()=>{
 const e=environment();let opens=0;e.window.open=()=>{opens++;return e.popup;};
 await assert.rejects(requestImage('apple',{transport:'tab'},e),err=>err.code==='channel-not-connected');assert.equal(opens,0);
});
test('explicit connection opens documentation without a prompt and verifies companion',async()=>{
 const e=environment();const p=openPerchanceChannel({},e);const sessionId=e.window.posted.sessionId;
 assert.equal(e.window.url,undefined);
 e.emit({api:'perchance-bridge-companion-v2',kind:'local-ready',sessionId},e.window,e.window.location.origin);
 const url=new URL(e.window.url);
 assert.equal(url.searchParams.has('prompt'),false);
 e.emit({api:'perchance-bridge-companion-v2',kind:'ready',sessionId},e.window,e.window.location.origin);assert.equal((await p).sessionId,sessionId);assert.equal(e.handlers.size,0);
});
test('explicit connection failure cleans listeners and does not request an image',async()=>{
 const e=environment();e.handshakeMs=5;await assert.rejects(openPerchanceChannel({},e),err=>err.code==='local-companion-unavailable');
 assert.equal(e.handlers.size,0);assert.equal(e.window.url,undefined);
});
test('preopened tab is navigated rather than opening a popup after LLM await',async()=>{
 const e=environment();const popup={closed:false,location:{href:'about:blank'}};
 e.window.open=()=>{throw Error('must not open');};
 const p=requestImage('apple',{transport:'tab',popup},e);
 const id=new URL(popup.location.href).searchParams.get('id');
 e.emit({api:'perchance-bridge-result',id,result:response(id).result},popup,'https://perchance.org');
 assert.ok((await p).url);
});
test('rejects oversized data and URLs containing credentials',()=>{
 assert.equal(validateRemoteImageUrl('https://name:pass@user.uploads.dev/x.jpg'),null);
 assert.throws(()=>unpackImageResult({dataUrl:'data:image/png;base64,'+'A'.repeat(22*1024*1024)}));
});
