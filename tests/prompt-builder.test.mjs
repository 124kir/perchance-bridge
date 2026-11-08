import test from 'node:test';
import assert from 'node:assert/strict';
import {requestChatPrompt,promptTokenLimit,finalPromptText} from '../prompt-builder.mjs';

function host() {
 const listeners=new Map(), calls=[];
 const c={mainApi:'openai',eventTypes:{GENERATE_AFTER_DATA:'data'},
  eventSource:{on:(n,f)=>listeners.set(n,f),removeListener:n=>listeners.delete(n)},
  generateQuietPrompt:()=>{throw Error('character-response cleanup must not run');},
  generate:async(type,args,dry)=>{
   calls.push({type,args,dry});
   listeners.get('data')({prompt:[{role:'user',content:'unrelated context'}]},true);
   listeners.get('data')({prompt:[{role:'user',content:'synthetic dialogue'},{role:'system',content:args.quiet_prompt}]},dry);
  },
  generateRawData:async args=>{calls.push(args);return {choices:[{message:{content:'portrait, red hair',reasoning_content:'PRIVATE_REASONING'},finish_reason:'stop'}],usage:{completion_tokens:24}};},
  extractMessageFromData:data=>data.choices[0].message.content,
 };
 return {c,calls,listeners};
}
test('uses native dry context builder and exactly one raw request, without reply cleanup',async()=>{
 const h=host(),events=[];const prompt=await requestChatPrompt(h.c,'Describe the scene',{tokens:4096,onDiagnostic:e=>events.push(e)});
 assert.equal(prompt,'portrait, red hair');assert.equal(h.calls.length,2);assert.equal(h.calls[0].dry,true);
 assert.equal(h.calls[1].prompt[0].content,'synthetic dialogue');assert.equal(h.calls[1].responseLength,4096);
 assert.equal(h.listeners.size,0);assert.ok(!JSON.stringify(events).includes('PRIVATE_REASONING'));
 assert.ok(!JSON.stringify(events).includes('synthetic dialogue'));
});
test('missing own native context does not send an LLM request or pick unrelated context',async()=>{
 const h=host();h.c.generate=async()=>h.listeners.get('data')({prompt:[{role:'user',content:'unrelated'}]},true);
 await assert.rejects(requestChatPrompt(h.c,'Describe the scene'),/не собрал контекст/);
 assert.equal(h.calls.length,0);assert.equal(h.listeners.size,0);
});
test('cleans capture on native builder failure and does not request the model',async()=>{
 const h=host();h.c.generate=async()=>{throw Error('build failed');};
 await assert.rejects(requestChatPrompt(h.c,'scene'),/build failed/);assert.equal(h.listeners.size,0);assert.equal(h.calls.length,0);
});
test('native multimodal context becomes text-only before ST raw formatter',async()=>{
 const h=host();h.c.generate=async(type,args,dry)=>h.listeners.get('data')({prompt:[{role:'user',content:[{type:'text',text:'a synthetic scene'},{type:'image_url',image_url:{url:'data:private-media'}}]},{role:'system',content:args.quiet_prompt}]},dry);
 await requestChatPrompt(h.c,'describe');
 assert.equal(h.calls[0].prompt[0].content,'a synthetic scene');assert.ok(!JSON.stringify(h.calls).includes('private-media'));
});
test('raw length exhaustion is explicit and never retried',async()=>{
 const h=host();let requests=0;
 h.c.generateRawData=async()=>{requests++;return {choices:[{message:{content:'',reasoning_content:'thinking'},finish_reason:'length'}],usage:{completion_tokens_details:{reasoning_tokens:4096}}};};
 await assert.rejects(requestChatPrompt(h.c,'scene'),/Достигнут лимит.*reasoningTokens=4096/);assert.equal(requests,1);
});
test('cancellation between native assembly and API prevents any model call',async()=>{
 const h=host();await assert.rejects(requestChatPrompt(h.c,'scene',{assertActive:()=>{throw Error('cancelled');}}),/cancelled/);
 assert.equal(h.calls.length,1);assert.equal(h.listeners.size,0);
});
test('quiet compatibility route receives the dedicated token budget',async()=>{
 let args;const c={mainApi:'textgenerationwebui',generateQuietPrompt:async a=>{args=a;return 'landscape';}};
 assert.equal(await requestChatPrompt(c,'scene',{tokens:8192}),'landscape');assert.equal(args.responseLength,8192);
});
test('token bounds and reasoning separation prevent reasoning-only prompts',()=>{
 assert.equal(promptTokenLimit(8192),8192);assert.equal(promptTokenLimit(-1),4096);assert.equal(promptTokenLimit(100000),4096);
 assert.equal(finalPromptText('<think>secret</think> a red apple'),'a red apple');
 assert.equal(finalPromptText('<think>truncated reasoning'),'');
 assert.equal(finalPromptText('```text\nred apple\n```'),'red apple');
});
test('recovers explicit API final text if the native extractor returns an empty value',async()=>{
 const h=host();h.c.extractMessageFromData=()=>'';
 h.c.generateRawData=async()=>({content:[],choices:[{message:{content:[{type:'text',text:'a red apple'}]},finish_reason:'stop'}]});
 const events=[];assert.equal(await requestChatPrompt(h.c,'scene',{onDiagnostic:e=>events.push(e)}),'a red apple');
 assert.equal(events.at(-1).textSource,'api-final');assert.equal(events.at(-1).finalTextChars,11);
});
test('inline reasoning with stop and zero reported reasoning tokens is distinguished from empty API content',async()=>{
 const h=host(),events=[];
 h.c.generateRawData=async()=>({choices:[{message:{content:'<think>PRIVATE_REASONING</think>'},finish_reason:'stop'}],usage:{completion_tokens:1166,completion_tokens_details:{reasoning_tokens:0}}});
 await assert.rejects(requestChatPrompt(h.c,'scene',{onDiagnostic:e=>events.push(e)}),/служебных блоков/);
 assert.ok(events.at(-1).textChars>0);assert.equal(events.at(-1).finalTextChars,0);
 assert.equal(JSON.stringify(events).includes('PRIVATE_REASONING'),false);
});
test('empty final response, refusal and tool call produce distinct errors without another model request',async()=>{
 for(const [message,expected] of [[{content:''},/пустой финальный текст/],[{content:null,refusal:'PRIVATE_REFUSAL'},/отказ/],[{content:null,tool_calls:[{function:{arguments:'PRIVATE_ARGS'}}]},/вызов инструмента/]]){
  const h=host(),events=[];let requests=0;
  h.c.generateRawData=async()=>{requests++;return {choices:[{message,finish_reason:'stop'}],usage:{completion_tokens:1166,completion_tokens_details:{reasoning_tokens:0}}};};
  await assert.rejects(requestChatPrompt(h.c,'scene',{onDiagnostic:e=>events.push(e)}),expected);
  assert.equal(requests,1);assert.equal(JSON.stringify(events).includes('PRIVATE_'),false);
 }
});
test('captures only own request settings as counts, without stop strings, biases or messages',async()=>{
 const h=host(),events=[];h.c.eventTypes.CHAT_COMPLETION_SETTINGS_READY='settings';
 h.c.generateRawData=async args=>{
  h.listeners.get('settings')({messages:[{role:'user',content:'other request'}],stop:['PRIVATE_STOP']});
  h.listeners.get('settings')({messages:args.prompt,stop:['PRIVATE_STOP'],logit_bias:{PRIVATE_TOKEN:10},max_tokens:4096});
  return {choices:[{message:{content:'apple'},finish_reason:'stop'}]};
 };
 await requestChatPrompt(h.c,'scene',{onDiagnostic:e=>events.push(e)});
 const requests=events.filter(e=>e.stage==='prompt-request-settings');
 assert.equal(requests.length,1);assert.equal(requests[0].stopCount,1);assert.equal(requests[0].logitBiasCount,1);
 assert.equal(JSON.stringify(events).includes('PRIVATE_'),false);assert.equal(h.listeners.size,0);
});
test('the copied native context ends with an explicit user task without modifying the native messages',async()=>{
 const h=host();let nativeMessages,requests=0;
 h.c.generate=async(type,args,dry)=>{
  nativeMessages=[{role:'user',content:'synthetic scene'},{role:'system',content:args.quiet_prompt}];
  h.listeners.get('data')({prompt:nativeMessages},dry);
 };
 h.c.generateRawData=async args=>{
  requests++;assert.equal(args.prompt.at(-1).role,'user');assert.match(args.prompt.at(-1).content,/Describe the scene/);
  assert.equal(args.prompt.length,2);assert.equal(args.responseLength,4096);
  return {choices:[{message:{content:'apple'},finish_reason:'stop'}]};
 };
 assert.equal(await requestChatPrompt(h.c,'Describe the scene'),'apple');
 assert.equal(nativeMessages.at(-1).role,'system');assert.equal(requests,1);
});
test('a merged system tail is preserved and receives a separate user task',async()=>{
 const h=host();h.c.generate=async(type,args,dry)=>h.listeners.get('data')({prompt:[{role:'system',content:'system context\n'+args.quiet_prompt}]},dry);
 h.c.generateRawData=async args=>{
  assert.equal(args.prompt[0].role,'system');assert.equal(args.prompt.at(-1).role,'user');
  return {choices:[{message:{content:'apple'},finish_reason:'stop'}]};
 };
 await requestChatPrompt(h.c,'scene');
});
test('empty stop with one completion token is recoverable without retrying or interpreting it as refusal',async()=>{
 const h=host();let requests=0;
 h.c.generateRawData=async()=>{requests++;return {choices:[{message:{content:''},finish_reason:'stop'}],usage:{completion_tokens:1}};};
 await assert.rejects(requestChatPrompt(h.c,'scene'),e=>e.code==='empty-model-prompt');assert.equal(requests,1);
});
