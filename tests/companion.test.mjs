import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fixture} from './companion-fixture.mjs';
import {connectStorageChannel,requestStorageImage} from '../companion-channel.mjs';
const source=await readFile(new URL('../perchance-companion.user.js',import.meta.url),'utf8');
test('full cross-tab exchange works with severed opener and a closed-looking WindowProxy',async()=>{
 const h=fixture(),channel=await connectStorageChannel({}, {window:h.local.win});
 assert.equal(channel.protocol,'userscript-storage-v2');
 const pending=requestStorageImage('red apple',{channel,resolution:'512x512'},{window:h.local.win});
 const target=new URL(h.remote.navigation);assert.equal(target.searchParams.get('prompt'),'red apple');
 const requestId=target.searchParams.get('id'),remote=h.navigate();
 remote.emit({origin:'https://a485ca10d45752b37a2b42b5434df493.perchance.org',source:remote.frame,data:{api:'perchance-image-api',result:{id:requestId,ok:true,url:'https://user.uploads.dev/apple.jpg',prompt:'PRIVATE_PROMPT'}}});
 const image=await pending;assert.equal(image.url,'https://user.uploads.dev/apple.jpg');
 assert.equal('prompt' in image,false);assert.equal(h.store.size,0);assert.equal(h.openerReads,0);
});
test('remote relay ignores wrong iframe ownership and only returns the correlated result once',async()=>{
 const h=fixture(),channel=await connectStorageChannel({}, {window:h.local.win});
 const pending=requestStorageImage('apple',{channel},{window:h.local.win});
 const id=new URL(h.remote.navigation).searchParams.get('id'),remote=h.navigate();
 const good={origin:'https://a485ca10d45752b37a2b42b5434df493.perchance.org',source:remote.frame,data:{api:'perchance-image-api',result:{id,ok:true,url:'https://user.uploads.dev/a.jpg'}}};
 const count=()=>h.local.posts.filter(p=>p.kind==='result').length;
 remote.emit({...good,source:{}});assert.equal(count(),0);
 remote.emit({...good,origin:'https://evil.test'});assert.equal(count(),0);
 remote.emit(good);remote.emit(good);await pending;assert.equal(count(),1);
});
test('busy remote page rejects another request instead of starting a second generation',async()=>{
 const h=fixture(),channel=await connectStorageChannel({}, {window:h.local.win});
 const controller=new AbortController();
 const first=requestStorageImage('first',{channel,signal:controller.signal},{window:h.local.win});
 h.navigate();
 await assert.rejects(requestStorageImage('second',{channel},{window:h.local.win}),e=>e.code==='companion-error');
 controller.abort();await assert.rejects(first,e=>e.code==='aborted');
});
test('transport values are deleted immediately even without a receiver',async()=>{
 const h=fixture();h.boot('https://perchance.org/perchance-ai-api?pbSession='+ 'a'.repeat(32)+'&pbReturnOrigin=http%3A%2F%2Flocalhost%3A8000','unpaired');
 assert.equal(h.store.size,0);h.expire();assert.equal(h.store.size,0);
});
test('remote script rejects arbitrary return origins',()=>{
 const h=fixture();const before=h.store.size;
 h.boot('https://perchance.org/perchance-ai-api?pbSession='+ 'a'.repeat(32)+'&pbReturnOrigin=https%3A%2F%2Fevil.test','evil');
 assert.equal(h.store.size,before);
});
const generator='https://a485ca10d45752b37a2b42b5434df493.perchance.org';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('rendered JSON in the cross-origin generator frame reaches the page through asynchronous manager events',async()=>{
 const h=fixture({asyncStorage:true}),channel=await connectStorageChannel({}, {window:h.local.win});
 const pending=requestStorageImage('synthetic apple',{channel},{window:h.local.win,ackMs:1000,timeoutMs:1000});
 await tick();const target=new URL(h.remote.navigation),id=target.searchParams.get('id');h.navigate();
 const framed=h.boot(generator+target.pathname+target.search,'generator',{framed:true});
 framed.setResponse({id:'wrong',ok:true,url:'https://user.uploads.dev/wrong.jpg'});
 framed.setResponse({id,ok:true,url:'https://user.uploads.dev/synthetic.jpg',prompt:'DO_NOT_RELAY'});
 const result=await pending;assert.equal(result.url,'https://user.uploads.dev/synthetic.jpg');
 assert.equal('prompt' in result,false);assert.equal(h.store.size,0);
 assert.equal(framed.observers.some(o=>o.active),false);
 framed.setResponse({id,ok:true,url:'https://user.uploads.dev/duplicate.jpg'});await tick();
 assert.equal(h.local.posts.filter(p=>p.kind==='result').length,1);
});
test('frame parser reads an already rendered response after the document root becomes available',async()=>{
 const h=fixture(),channel=await connectStorageChannel({}, {window:h.local.win});
 const pending=requestStorageImage('apple',{channel},{window:h.local.win,ackMs:1000,timeoutMs:1000});
 const target=new URL(h.remote.navigation),id=target.searchParams.get('id');h.navigate();
 const framed=h.boot(generator+target.pathname+target.search,'generator',{framed:true,hasRoot:false,initialResponse:JSON.stringify({id,ok:true,url:'https://user.uploads.dev/early.jpg'})});
 framed.domReady();assert.equal((await pending).url,'https://user.uploads.dev/early.jpg');
});
test('generator frame refuses a foreign parent and does not run as a standalone page',()=>{
 const h=fixture(),query='?pbSession='+ 'a'.repeat(32)+'&pbReturnOrigin=http%3A%2F%2Flocalhost%3A8000&id='+ 'b'.repeat(32)+'&format=json';
 for(const options of [{framed:true,parentOrigin:'https://evil.test'},{framed:false}]){
  const f=h.boot(generator+'/perchance-ai-api'+query,'untrusted',options);
  f.setResponse({id:'b'.repeat(32),ok:true,url:'https://user.uploads.dev/untrusted.jpg'});
  assert.equal(f.observers.length,0);
 }
});
test('userscript metadata enables only the explicit generator iframe host',()=>{
 assert.match(source,/\/\/ @match https:\/\/a485ca10d45752b37a2b42b5434df493\.perchance\.org\/perchance-ai-api\*/);
 assert.doesNotMatch(source,/\/\/ @noframes/);
});
