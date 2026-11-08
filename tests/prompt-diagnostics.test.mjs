import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeModelProbe} from '../prompt-diagnostics.mjs';
test('summarizes OpenRouter text and reasoning without retaining either',()=>{
 const result=summarizeModelProbe({choices:[{message:{content:'apple',reasoning_content:'secret'},finish_reason:'stop'}],usage:{completion_tokens:15,completion_tokens_details:{reasoning_tokens:12}}});
 assert.deepEqual(result,{textChars:5,reasoningChars:6,finishReason:'stop',completionTokens:15,reasoningTokens:12});
 assert.ok(!JSON.stringify(result).includes('secret'));
});
test('unexpected response values and finish reasons cannot leak into diagnostics',()=>{
 assert.equal(summarizeModelProbe({choices:[{message:{content:null},finish_reason:'private server error'}]}).finishReason,'unknown');
 assert.equal(summarizeModelProbe(null).textChars,0);
 assert.equal(summarizeModelProbe({choices:[{message:{content:[{type:'text',text:'apple'},{type:'image_url',text:'ignore'}]}}]}).textChars,5);
});
