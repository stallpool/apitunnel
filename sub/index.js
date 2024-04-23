const i_ws = require('ws');
const i_download = require('./request').download;
const i_config = require('./config');
const i_env = require('./env');

const env = {
   maxWSn: i_env.sub.ws_client_max,
   target: i_env.sub.pub_url,
   token: i_env.sub.pub_token,
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
async function processHttp(method, uri, payload, m) {
   console.log('[D]', new Date().toISOString(), method, uri, payload);
   const parts = uri.split('/');
   parts.shift(); parts.shift(); // e.g. /pub/<region>/<site>/...
   const region = parts.shift();
   const site = parts.shift();
   if (parts.length === 0) return null;
   const remain = parts.join('/');

   const url = i_config.renderUrl('http', region, site, remain);
   if (!url) throw `no such region "${region}"`;

   const httpopt = {};
   if (m.headers) {
      httpopt.headers = Object.assign({}, m.headers);
      Object.keys(httpopt.headers).forEach(x => {
         if (!allowed_headers.includes(x)) delete httpopt.headers[x];
      });
   }

   if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      payload = payload && Buffer.from(payload, 'base64');
      return await i_download(url, { ...httpopt, method, payload });
   } else {
      return await i_download(url, { ...httpopt, method });
   }
}
async function handleHttp(id, tunnel, m) {
   const method = m.method;
   const uri = m.uri;
   const payload = m.data;
   if (!id || !method || !uri) return;
   try {
      const obj = await processHttp(method, uri, payload, m);
      if (!obj || obj.error) throw 'error';
      if (obj.redirect) throw 'not supported';
      const r = { id, headers: obj.headers, data: obj.buf.toString('base64') };
      safeSendJson(tunnel, r);
   } catch (err) {
      safeSendJson(tunnel, { id, code: 500 });
   }
}

function processWs(subws, obj) {
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
async function handleWs(id, tunnel, m) {
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
      const url = i_config.renderUrl('websocket', region, site, remain);
      if (!url) return;
      let isBinary = false;
      switch (region) {
      case 'dmzssh': isBinary = true; break;
      default: isBinary = false;
      }
      const conn = new i_ws.WebSocket(url);
      const newobj = { id, conn, uri, bin: isBinary };
      // also set flag newobj.bin = true / false
      env.wsagent[id] = newobj;
      processWs(tunnel, newobj);
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
   console.log(`[I] ${new Date().toISOString()} connecting to "${env.target}" ...`);
   try {
      const ws = new i_ws.WebSocket(env.target);
      env.ws = ws;
      ws.on('open', () => {
         if (env.token) safeSendJson(ws, { cmd: 'auth', token: env.token });
         console.log(`[I] ${new Date().toISOString()} connected.`);
      });
      ws.on('error', (err) => {
         console.log('[E]', new Date().toISOString(), err);
         env.ws = null;
      });
      ws.on('close', () => {
         console.log(`[I] ${new Date().toISOString()} disconnected`);
         // XXX: disconnect all websocket channel; alternatively,
         //      we keep a timeout threshold and after that close all
         //      so that we can have some tolarence on network failure
         env.ws = null;
      });
      ws.on('message', async (data) => {
         if (!data || data.length > 10*1024 /* 10K */) {
            return;
         }
         try { data = JSON.parse(data); } catch (err) { data = {}; }
         const id = data.id;
         const mode = data.mode;

         if (mode === 'ws') {
            if (!id) return;
            handleWs(id, ws, data);
            return;
         }

         handleHttp(id, ws, data);
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

function main() {
   i_config.startWatchConfigFile();
   watchDog();
}

main();
