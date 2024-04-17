const i_ws = require('ws');
const i_download = require('./request').download;

const env = {
   maxWSn: parseInt(process.env.MAX_WS_N || '10'),
   target: process.env.PUB_URL,
   token: process.env.PUB_TOKEN,
   ws: null,
   connN: 0,
   ticket: {},
   wsagent: {},
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
function safeSendBin(ws, buf) {
   if (!ws) return;
   if (ws.readyState !== i_ws.WebSocket.OPEN) return;
   try { ws.send(buf, { isBinary: true }); } catch(err) { }
}
function safeSendJson(ws, json) {
   safeSend(ws, JSON.stringify(json));
}

function ping(ws, interval) {
   safeSendJson(ws, { c: 'ping' });
   if (!ws || ws.readyState !== i_ws.WebSocket.OPEN) return;
   setTimeout(ping, interval, ws, interval);
}

const allowed_headers = ['content-type', 'user-agent', 'content-length'];
async function build(method, uri, payload, m) {
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

   const httpopt = {};
   if (m.headers) {
      httpopt.headers = Object.assign({}, m.headers);
      Object.keys(httpopt.headers).forEach(x => {
         if (!allowed_headers.includes(x)) delete httpopt.headers[x];
      });
   }

   if (method === 'POST') {
      payload = payload && Buffer.from(payload, 'base64');
      return await i_download(url, { ...httpopt, method, payload });
   } else {
      return await i_download(url, { ...httpopt, method });
   }
}

function handleWsConnection(subws, obj) {
   const id = obj.id;
   obj.conn.on('open', () => {
      safeSendJson(subws, { id, mode: 'ws', act: 'open', bin: obj.bin});
   });
   obj.conn.on('message', (m) => {
      safeSendJson(subws, {
        id, mode: 'ws', data: m.toString('base64'),
      });
   });
   obj.conn.on('close', () => {
      delete env.wsagent[id];
      safeClose(obj.conn);
      safeSendJson(subws, { id, mode: 'ws', act: 'close' });
   });
   obj.conn.on('error', (err) => {});
}

async function buildWs(id, tunnel, m) {
   const act = m.act;
   const uri = m.uri;
   const dat = m.data;
   if (!act && !dat) return;
   const obj = env.wsagent[id];
   if (act === 'close') {
      if (!obj) return;
      console.log('[D]', new Date().toISOString(), 'websocket', 'close', obj.uri, id);
      safeClose(obj.conn);
   } else if (act === 'open' && uri) {
      if (obj) return;
      console.log('[D]', new Date().toISOString(), 'websocket', 'open', uri, id);
      const parts = uri.split('/');
      const region = parts[1];
      const site = parts[2];
      const remain = parts.slice(3).join('/');
      let baseUrl;
      let isBinary = false;
      switch (region) {
      case 'somename': baseUrl = 'somesite'; break;
      default: return null;
      }
      const url = `ws://${site}.${baseUrl}/${remain}`;
      const conn = new i_ws.WebSocket(url);
      const newobj = { id, conn, uri, bin: isBinary };
      // also set flag newobj.bin = true / false
      env.wsagent[id] = newobj;
      handleWsConnection(tunnel, newobj);
   } else if (dat) {
      if (!obj) return;
      try {
         const buf = Buffer.from(dat, 'base64');
         if (obj.bin) {
            obj.conn.send(buf, { isBinary: true });
         } else {
            obj.conn.send(buf.toString());
         }
      } catch(err) {
      }
   }
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
         if (!data || data.length > 10*1024 /* 10K */) {
            return;
         }
         try { data = JSON.parse(data); } catch (err) { data = {}; }
         const mode = data.mode;
         const id = data.id;
         const method = data.method;
         const uri = data.uri;
         const payload = data.data;

         if (mode === 'ws') {
            if (!id) return;
            buildWs(id, ws, data);
            return;
         }

         if (!id || !method || !uri) return;
         try {
            const obj = await build(method, uri, payload, data);
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
