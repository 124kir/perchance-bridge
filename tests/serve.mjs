// Loopback-only static server for the extension's synthetic test page. No user paths.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
const files = new Map([
 ['/tests/live.html', new URL('./live.html', import.meta.url)],
 ['/perchance-client.mjs', new URL('../perchance-client.mjs', import.meta.url)],
 ['/companion-channel.mjs', new URL('../companion-channel.mjs', import.meta.url)],
 ['/tests/host.html', new URL('./host.html', import.meta.url)],
 ...['index.js','style.css','presets.mjs','professional-styles.json','prompt-builder.mjs','prompt-diagnostics.mjs'].map(name=>['/'+name,new URL('../'+name,import.meta.url)]),
]);
http.createServer(async (req,res) => {
 const file = files.get(req.url?.split('?')[0]);
 if(!file) {res.writeHead(404);res.end();return;}
 try {const ext=file.pathname.split('.').at(-1);res.setHeader('Content-Type',({mjs:'text/javascript',js:'text/javascript',css:'text/css',json:'application/json'})[ext]||'text/html');res.end(await readFile(file));}
 catch {res.writeHead(500);res.end();}
}).listen(Number(process.argv[2])||8766,'127.0.0.1',()=>console.log('Synthetic static server ready'));
