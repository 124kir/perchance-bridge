import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_STYLES, normalizeStyles, selectedStyle, composePrompt, composeNegative } from '../presets.mjs';
import { requestImage } from '../perchance-client.mjs';

test('builtin presets include several selectable art styles', () => {
  assert.ok(BUILTIN_STYLES.length >= 8);
  assert.equal(selectedStyle({ styles: BUILTIN_STYLES, styleId: 'oil' }).id, 'oil');
});
test('compose prompt and negatives without mutating base text', () => {
  const p = 'portrait of a fox';
  const st = {positive:'cinematic lighting',negative:'blurry'};
  assert.equal(composePrompt(p, st, 'rain'), 'portrait of a fox, cinematic lighting, rain');
  assert.equal(composeNegative('watermark', st), 'watermark, blurry');
  assert.equal(p, 'portrait of a fox');
});
test('empty prompts and overly long style expansions fail safely', () => {
  assert.throws(() => composePrompt(' ', BUILTIN_STYLES[0]), /пустой/i);
  assert.throws(() => composePrompt('a', {positive:'x'.repeat(2000)}), /2000/);
});
test('style import rejects malformed items and duplicate IDs', () => {
  const styles = normalizeStyles([
    {id:'custom1',name:'Foo',positive:'abc'},
    {id:'custom1',name:'Bar'},
    {id:'',name:'No'},
    null,
  ]);
  assert.equal(styles.length, 1);
  assert.equal(styles[0].name, 'Foo');
});
test('iframe parameters support fixed seed and background removal', async () => {
  const listeners = new Map();
  let url = '';
  const win = {
    crypto: {randomUUID:()=>'aaaa-bbbb-cccc'},
    addEventListener:(name,cb)=>listeners.set(name,cb),
    removeEventListener:(name)=>listeners.delete(name), setTimeout, clearTimeout,
  };
  const doc = {
    createElement:()=>({contentWindow:globalThis,style:{},setAttribute(){},remove(){},set src(u){url=u;}}),
    body:{appendChild(){
      queueMicrotask(()=>{
        const id = new URL(url).searchParams.get('id');
        listeners.get('message')?.({source:globalThis,origin:'https://a485ca10d45752b37a2b42b5434df493.perchance.org',data:{api:'perchance-image-api',result:{id,ok:true,url:'https://user.uploads.dev/ok.png'}}});
      });
    }},
  };
  await requestImage('a cat',{seed:33,removeBackground:true}, {window:win,document:doc,timeoutMs:500});
  assert.equal(new URL(url).searchParams.get('seed'), '33');
  assert.equal(new URL(url).searchParams.get('removeBackground'), 'true');
});
