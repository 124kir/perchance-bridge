import test from 'node:test';
import assert from 'node:assert/strict';
import { findImageTag, trustedPerchanceOrigin, validateRemoteImageUrl, unpackImageResult, markdownImage, requestImage } from '../perchance-client.mjs';

test('extracts generated tag', () => {
    assert.deepEqual(findImageTag('Hello [PERCHANCE: blue fox in snow]'), { full: '[PERCHANCE: blue fox in snow]', prompt: 'blue fox in snow', index: 6 });
    assert.equal(findImageTag('nothing here'), null);
});
test('accepts only trusted postMessage origin', () => {
    assert.equal(trustedPerchanceOrigin('https://perchance.org'), false);
    assert.equal(trustedPerchanceOrigin('https://a485ca10d45752b37a2b42b5434df493.perchance.org'), true);
    assert.equal(trustedPerchanceOrigin('https://perchance.org.evil.test'), false);
    assert.equal(trustedPerchanceOrigin('http://perchance.org'), false);
});
test('accepts only expected image URL hosts', () => {
    assert.ok(validateRemoteImageUrl('https://user.uploads.dev/example.jpeg'));
    assert.equal(validateRemoteImageUrl('javascript:alert(1)'), null);
    assert.equal(validateRemoteImageUrl('https://example.com/x.png'), null);
});
test('handles response payloads', () => {
    assert.equal(unpackImageResult({ ok: true, url: 'https://user.uploads.dev/x.png', seed: 3 }).seed, 3);
    assert.equal(unpackImageResult({ ok: true, dataUrl: 'data:image/png;base64,AAAA' }).url, null);
    assert.throws(() => unpackImageResult({ ok: false, error: 'bad' }), /bad/);
});
test('returns safe markdown image', () => {
    assert.equal(markdownImage('https://user.uploads.dev/a(b).png'), '![Perchance image](https://user.uploads.dev/a(b%29.png)');
});
test('validates prompt length without needing a browser', async () => {
    await assert.rejects(requestImage(''), /Промпт/);
    await assert.rejects(requestImage('a'.repeat(2001)), /Промпт/);
});

test('iframe generation matches request id and cleans listeners', async () => {
    const listeners = new Map();
    let removed = false;
    let frameUrl = '';
    const fakeWindow = {
        crypto: { randomUUID: () => '00000000-1111-2222-3333-444444444444' },
        setTimeout,
        clearTimeout,
        addEventListener(name, handler) { listeners.set(name, handler); },
        removeEventListener(name, handler) { if (listeners.get(name) === handler) listeners.delete(name); },
    };
    const fakeDocument = {
        createElement() { return {contentWindow:globalThis,style:{}, setAttribute() {}, remove() {removed = true;}, set src(s) {frameUrl = s;}}; },
        body: {appendChild() {
            queueMicrotask(() => {
                const id = new URL(frameUrl).searchParams.get('id');
                listeners.get('message')?.({ origin: 'https://perchance.org.evil.com', data: {api:'perchance-image-api',result:{id,ok:true,url:'https://user.uploads.dev/evil.png'}} });
                listeners.get('message')?.({ source:globalThis, origin: 'https://a485ca10d45752b37a2b42b5434df493.perchance.org', data: {api:'perchance-image-api',result:{id,ok:true,url:'https://user.uploads.dev/cat.jpeg',seed:42}} });
            });
        }},
    };
    const result = await requestImage('cat on a rug', {resolution:'768x512'}, {document:fakeDocument,window:fakeWindow,timeoutMs:1000});
    assert.equal(result.url, 'https://user.uploads.dev/cat.jpeg');
    assert.equal(result.seed, 42);
    assert.equal(new URL(frameUrl).searchParams.get('resolution'), '768x512');
    assert.equal(new URL(frameUrl).searchParams.get('prompt'), 'cat on a rug');
    assert.equal(removed, true);
    assert.equal(listeners.has('message'), false);
});
