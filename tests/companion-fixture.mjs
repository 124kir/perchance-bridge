import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const source=await readFile(new URL('../perchance-companion.user.js',import.meta.url),'utf8');
export function fixture({asyncStorage=false}={}) {
 const store=new Map(), subscriptions=new Map(), expiry=[];let serial=0,remote=null,openerReads=0;
 const bus={
  subscribe(owner,key,callback){const id=++serial;subscriptions.set(id,{owner,key,callback});return id;},
  remove(id){subscriptions.delete(id);},
  write(owner,key,value){const previous=store.get(key);value===undefined?store.delete(key):store.set(key,value);
   for(const listener of [...subscriptions.values()])if(listener.key===key){const notify=()=>listener.callback(key,previous,value,listener.owner!==owner);asyncStorage?queueMicrotask(notify):notify();}},
  drop(owner){for(const [id,s] of subscriptions)if(s.owner===owner)subscriptions.delete(id);},
 };
 function boot(url,owner,{framed=false,parentOrigin='https://perchance.org',initialResponse=null,hasRoot=true}={}) {
  const parsed=new URL(url),listeners=new Map(),posts=[],frame={};let navigation='';
  const location={origin:parsed.origin,pathname:parsed.pathname,search:parsed.search,assign:url=>navigation=url};
  const observers=[],domEvents=new Map();let response=initialResponse;
  const win={location,crypto:{randomUUID},setTimeout:(cb,ms)=>{const timer=setTimeout(cb,ms);timer.unref();return timer;},clearTimeout,
   addEventListener:(name,f)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(f);},
   removeEventListener:(name,f)=>listeners.get(name)?.delete(f),
   postMessage(data,origin){assert.equal(origin,location.origin);posts.push(data);for(const f of [...(listeners.get('message') || [])])f({source:win,origin,data});},
   open(url){remote=boot(url,'remote');return {closed:true};},
  };win.top=framed?{}:win;win.parent=win.top;
  Object.defineProperty(win,'opener',{get(){openerReads++;return null;}});
  const api={window:win,location,URL,URLSearchParams,setTimeout:cb=>{expiry.push(cb);return expiry.length;},
   GM_setValue:(k,v)=>bus.write(owner,k,structuredClone(v)),GM_deleteValue:k=>bus.write(owner,k,undefined),
   GM_addValueChangeListener:(k,cb)=>bus.subscribe(owner,k,cb),GM_removeValueChangeListener:id=>bus.remove(id),
   MutationObserver:class {constructor(cb){this.cb=cb;observers.push(this);}observe(){this.active=true;}disconnect(){this.active=false;}},
   document:{referrer:parentOrigin+'/',documentElement:hasRoot?{}:null,
    addEventListener:(name,cb)=>domEvents.set(name,cb),
    querySelector:()=>response===null?null:{textContent:response},
    querySelectorAll:selector=>selector==='pre'?(response===null?[]:[{textContent:response}]):[{contentWindow:frame,src:'https://a485ca10d45752b37a2b42b5434df493.perchance.org/perchance-ai-api'}]},
  };
  vm.runInNewContext(source,api);
  return {win,posts,frame,observers,setResponse(value){response=JSON.stringify(value);for(const o of observers)if(o.active)o.cb();},domReady(){api.document.documentElement={};domEvents.get('DOMContentLoaded')?.();},emit:data=>{for(const f of [...(listeners.get('message') || [])])f(data);},get navigation(){return navigation;}};
 }
 const local=boot('http://localhost:8000/','local');
 return {local,store,bus,boot,get remote(){return remote;},navigate(){const url=remote.navigation;bus.drop('remote');remote=boot(url,'remote');return remote;},expire(){for(const cb of expiry)cb();},get openerReads(){return openerReads;}};
}
