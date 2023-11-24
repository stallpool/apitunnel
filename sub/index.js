const i_ws = require('ws');
const i_download = require('./request').download;

const env = {
   target: process.env.PUB_URL,
   token: process.env.PUB_TOKEN,
   ws: null,
   connN: 0,
   ticket: {},
   wsc: {},
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

function ping2(ws, interval) {
   if (!ws || ws.readyState !== i_ws.WebSocket.OPEN) return;
   ws.ping();
   setTimeout(ping2, interval, ws, interval);
}

const supported_protocols = [
   'http', 'https', 'ws', 'wss',
];

const allowed_headers = ['content-type', 'user-agent', 'content-length'];
async function bridgeHttp(ws, url, payload, method, id, rawobj) {
   let obj;
   const httpopt = {};
   if (rawobj?.headers) {
      httpopt.headers = Object.assign({}, rawobj.headers);
      Object.keys(httpopt.headers).forEach(x => {
         if (!allowed_headers.includes(x)) delete httpopt.headers[x];
      });
   }
   if (method === 'POST') {
      payload = payload && Buffer.from(payload, 'base64');
      obj = await i_download(url, { ...httpopt, method, payload });
   } else {
      obj = await i_download(url, { ...httpopt, method });
   }
   if (!obj || obj.error) throw 'error';
   if (obj.redirect) throw 'not supported';
   const r = { id, headers: obj.headers, data: obj.buf.toString('base64') };
   safeSendJson(ws, r);
}

async function bridgeWebsocket(ws, url, payload, method, id, rawobj) {
   const obj = env.wsc[id];
   if (obj) {
      await obj.promise;
      if (method === 'close') {
         safeClose(obj.wsc);
      } else {
         safeSend(obj.wsc, payload ? Buffer.from(payload, 'base64') : '');
      }
   } else {
      const wsc = new i_ws.WebSocket(url);
      let initWaitOk;
      const initWaitP = new Promise((r) => { initWaitOk = r; });
      env.wsc[id] = { promise: initWaitP, wsc };
      wsc.on('open', () => {
         console.log('[I] websocket open', id);
         initWaitOk();
      });
      wsc.on('error', (err) => {
         console.log('[E] websocket error', id, err);
         delete env.wsc[id];
      });
      wsc.on('close', () => {
         console.log('[I] websocket close', id);
         safeSendJson(ws, { id, ws: true, code: 0 });
         delete env.wsc[id];
      });
      wsc.on('message', async (data) => {
         try {
            if (!data || data.length > 1*1024*1024 /* 1M */) throw '400: empty or too large';
            safeSendJson(ws, { id, ws: true, data: Buffer.from(data).toString('base64') });
         } catch (err) {
            safeSendJson(ws, { id, ws: true, code: 500 });
         }
      });
      setTimeout(() => ping2(wsc, 30*1000), 30*1000);
   }
}

async function build(ws, method, uri, payload, id, rawobj) {
   console.log('[D]', new Date().toISOString(), method, uri, payload);
   const parts = uri.split('/');
   parts.shift(); parts.shift(); // e.g. /pub/<region>/<site>/...
   const region = parts.shift();
   const site = parts.shift();
   const remain = parts.join('/');

   // region + site --> url, here just an example to map somename + site -> site.somename
   let baseUrl;
   switch (region) {
   case 'somename': baseUrl = `https://${site}.somesite`; break;
   case 'somews': baseUrl = `ws://${site}.somesite`; break;
   default: return null;
   }
   if (!baseUrl) throw `no such region "${region}"`;
   const protocol = baseUrl.split('://')[0];
   if (!supported_protocols.includes(protocol)) throw `not supported protocol "${protocol}"`;
   const url = `${baseUrl}/${remain}`;
   if (protocol === 'http' || protocol === 'https') {
      return await bridgeHttp(ws, url, payload, method, id, rawobj);
   }
   if (protocol === 'ws' || protocol === 'wss') {
      return await bridgeWebsocket(ws, url, payload, method, id, rawobj);
   }
   throw 'should not be here';
}

function connect() {
   console.log(`[I] connecting to "${env.target}" ...`);
   try {
      const ws = new i_ws.WebSocket(env.target);
      env.ws = ws;
      ws.on('open', () => {
         if (env.token) safeSendJson(ws, { cmd: 'auth', token: env.token });
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
         if (!data || data.length > 1*1024*1024 /* 1M */) return;
         try { data = JSON.parse(data); } catch (err) { data = {}; }
         const id = data.id;
         const method = data.method;
         const uri = data.uri;
         const payload = data.data;
         const rawobj = data;
         if (!id || !method || !uri) return;
         try {
            await build(ws, method, uri, payload, id, rawobj);
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
