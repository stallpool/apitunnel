const i_ws = require('ws');
const i_download = require('./request').download;

const env = {
   target: process.env.PUB_URL,
   ws: null,
   connN: 0,
   ticket: {},
};

function safeClose(ws) {
   if (!ws) return;
   try { ws.terminate() } catch(err) { }
}
function safeSend(ws, buf) {
   if (!ws) return;
   if (ws.readyState !== i_ws.WebSocket.OPEN) return;
   try { ws.send(buf); } catch(err) { }
}
function safeSendJson(ws, json) {
   safeSend(ws, JSON.stringify(json));
}

function ping(ws, interval) {
   safeSendJson(ws, { c: 'ping' });
   if (!ws || ws.readyState !== i_ws.WebSocket.OPEN) return;
   setTimeout(ping, interval, ws, interval);
}

async function build(method, uri, payload) {
   console.log('[D]', new Date().toISOString(), method, uri, payload);
   const parts = uri.split('/');
   parts.shift(); parts.shift(); // e.g. /pub/<region>/<site>/...
   const region = parts.shift();
   const site = parts.shift();
   if (parts.length === 0) return null;
   const remain = parts.join('/');

   // region + site --> url, here just an example to map somename + site -> site.somename
   let baseUrl;
   switch (region) {
   case 'somename': baseUrl = 'somesite'; break;
   default: return null;
   }
   const url = `https://${site}.${baseUrl}/${remain}`;

   if (method === 'POST') {
      payload = payload && Buffer.from(payload, 'base64');
      return await i_download(url, { method, payload });
   } else {
      return await i_download(url, { method });
   }
}

function connect() {
   console.log(`[I] connecting to "${env.target}" ...`);
   try {
      const ws = new i_ws.WebSocket(env.target);
      env.ws = ws;
      ws.on('open', () => {
         console.log(`[I] connected.`);
      });
      ws.on('error', (err) => {
         console.log('[E]', err);
         env.ws = null;
      });
      ws.on('close', () => {
         console.log('[I] disconnected');
         env.ws = null;
      });
      ws.on('message', async (data) => {
         if (!data || data.length > 10*1024 /* 10K */) {
            return;
         }
         try { data = JSON.parse(data); } catch (err) { data = {}; }
         const id = data.id;
         const method = data.method;
         const uri = data.uri;
         const payload = data.data;
         if (!id || !method || !uri) return;
         try {
            const obj = await build(method, uri, payload);
            if (!obj || obj.error) throw 'error';
            if (obj.redirect) throw 'not supported';
            const r = { id, headers: obj.headers, data: obj.buf.toString('base64') };
            safeSendJson(ws, r);
         } catch (err) {
            safeSendJson(ws, { id, code: 500 });
         }
      });
      setTimeout(() => ping(env.ws, 30*1000), 30*1000);
   } catch (err) { }
}

function watchDog() {
   try {
      if (!env.ws) connect();
   } catch(err) { }
   setTimeout(watchDog, 10*1000);
}

watchDog();
