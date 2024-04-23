const i_crypto = require('crypto');
const i_env = require('./env');
const LoadBalance = require('./loadbalance').LoadBalance;

function hash(text, salt) {
   return i_crypto.createHmac('sha512', salt || '').update(text).digest('hex');
}

function readRequest(req, max) {
   return new Promise((r) => {
      let size = 0;
      let over = false;
      const body = [];
      req.on('data', (chunk) => {
         if (over) return;
         size += chunk.length;
         if (size > max) {
            over = true;
            r(null);
            // reject(new Error('payload too large'));
            return;
         }
         body.push(chunk);
      });
      req.on('end', () => {
         if (over) return;
         const bodyraw = Buffer.concat(body);
         try {
            const body0 = (bodyraw);
            r(body0);
         } catch(err) {
            r(null);
         }
      });
      req.on('error', () => {
         over = true;
         r(null);
      });
   });
}


function safeClose(ws) {
   if (!ws) return;
   try { ws.terminate() } catch(err) { }
}
function safeSend(ws, buf) {
   if (!ws) return;
   if (ws.readyState !== ws.OPEN) return;
   try { ws.send(buf); } catch(err) { }
}
function safeSendBin(ws, buf) {
   if (!ws) return;
   if (ws.readyState !== ws.OPEN) return;
   try { ws.send(buf, { isBinary: true }); } catch(err) { }
}
function safeSendJson(ws, json) {
   safeSend(ws, JSON.stringify(json));
}

function debounce(fn, timeout) {
   let busy = false, timer = 0;
   return (...args) => {
      if (busy) return;
      busy = true;
      timer = setTimeout(() => {
         busy = false;
      }, timeout);
      fn.apply(null, args);
   };
}

function taskgc(bridge) {
   const ts = new Date().getTime();
   Object.keys(bridge.task).forEach(id => {
      const task = bridge.task[id];
      if (task && task.res) {
         if (ts - task.ts <= 1000 * 10 /* 10s */) return;
         task.res.writeHead(504);
         task.res.end();
      }
      delete bridge.task[id];
      bridge.taskc --;
   });
}

const http_max_id = 10000000;
const ws_max_id = http_max_id + i_env.pub.ws_client_max + 1;
const salt = i_env.pub.salt;
const token = i_env.pub.token ? hash(i_env.pub.token, i_env.pub.salt) : null;

class Bridge {
   constructor() {
      this.ws = {};
      this.hid = 0;
      this.task = {};
      this.taskc = 0;
      this.taskgc = debounce(taskgc, 1000);
   }

   registerSub(ws, local, m) {
      local.bind = true;
      local.authenticated = true;
      const lb = this.ws[local.entry] || new LoadBalance();
      lb.addConn(ws);
      this.ws[local.entry] = lb;
      const suffix = token ? ` with token` : ``;
      console.log(`[I] "${local.entry}" (${lb.countConn()}) ${ws._meta_?.ip} connected${suffix}`);
   }

   authenticate(ws, local, m) {
      if (!local.bind) {
         if (token) {
            if (m.cmd === 'auth' && token === hash(m.token, salt)) {
               this.registerSub(ws, local, m);
               return true;
            } else {
               safeClose(ws);
            }
         }
         return false;
      }
      return true;
   }

   listenSub() {
      return (async (ws, local, m) => {
         if (!this.authenticate(ws, local, m)) return;
         if (!m.id) return;

         if (m.id > http_max_id && m.id < ws_max_id && m.mode === 'ws') {
            this.bridgeWsRes(ws, local, m);
            return;
         }
         this.bridgeHttpRes(ws, local, m);
      }).bind(this);
   }

   buildSubOptions(entries) {
      return {
         onOpen: ((ws, local) => {
            const entry = ws._meta_.url.substring(1);
            const lb = this.ws[entry];
            if ((lb && !lb.hasEmptySlot()) || !entries.includes(entry)) { safeClose(ws); return; }
            local.entry = entry;
            if (!token) {
               this.registerSub(ws, local, {});
            }
         }).bind(this),
         onClose: ((ws, local) => {
            // XXX: disconnect all websocket channel; alternatively,
            //      we keep a timeout threshold and after that close all
            //      so that we can have some tolarence on network failure
            if (local.bind) {
               const lb = this.ws[local.entry];
               lb.delConn(ws);
               if (!lb.hasConn()) this.ws[local.entry] = null;
               console.log(`[I] "${local.entry}" (${lb.countConn()}) ${ws._meta_?.ip} disconnected`);
            }
         }).bind(this),
         onError: ((err, ws, local) => {}).bind(this),
      };
   }

   bridgeHttpReq(entry) {
      return (async (req, res, opt) => {
         const lb = this.ws[entry];
         if (!lb) { res.writeHead(502); res.end(); return; }
         const id = (this.hid + 1) % http_max_id;
         const dst = lb && lb.getOne(id);
         if (!dst) { res.writeHead(502); res.end(); return; }
         this.hid = id;
         let data = null;
         if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
            try {
               data = (await readRequest(req, 10240 /*10K*/)).toString('base64');
            } catch(err) {
               res.writeHead(400); res.end(); return;
            }
         }
         const headers = Object.assign({}, req.headers);
         this.task[id] = {
            ts: new Date().getTime(),
            id, res, data,
            method: req.method,
            uri: req.url,
            opt: { headers, }
         };
         this.taskc ++;
         safeSendJson(dst, { id, data, method: req.method, uri: req.url, headers });
      }).bind(this);
   }

   async bridgeHttpRes(ws, local, m) {
      if (!m.data && !m.code) return;
      const id = m.id;
      const task = this.task[id];
      if (!task) return;
      const res = task.res;
      const headers = m.headers || {};
      try {
         if (m.data) {
            const buf = Buffer.from(m.data, 'base64');
            if (headers['content-length']) {
               headers['content-length'] = buf.length;
            }
            Object.keys(headers).forEach(k => res.setHeader(k, headers[k]));
            res.end(buf);
         } else {
            res.writeHead(m.code);
            res.end();
         }
      } catch(err) {
         console.log('[E]', new Date().toISOString(), err);
      }
      delete this.task[id];
      this.taskc --;
      this.taskgc(this);
   }

   buildWsOptions(entry) {
      return {
         raw: true,
         onOpen: ((ws, local) => {
            const lb = this.ws[entry];
            if (!lb) { safeClose(ws); return; }
            let id;
            for (id = http_max_id+1; id < ws_max_id && this.task[id]; id++);
            if (id === ws_max_id) { safeClose(ws); return; } // reach max rate limit
            const dst = lb.getOne(id);
            if (!dst) { safeClose(ws); return; }
            local.pubid = id;
            const task = {
               ts: new Date().getTime(),
               id, ws,
            };
            task.init = new Promise((r, e) => {
               task.r = r;
               task.e = e;
            });
            this.task[id] = task;
            safeSendJson(dst, { id, mode: 'ws', act: 'open', uri: ws._meta_.url })
         }).bind(this),
         onClose: ((ws, local) => {
            const id = local.pubid;
            if (!id) return;
            const task = this.task[id];
            delete this.task[id];
            const lb = this.ws[entry];
            const dst = lb && lb.getOne(id);
            if (dst) safeSendJson(dst, { id, mode: 'ws', act: 'close' });
         }).bind(this),
         onError: ((err, ws, local) => { }).bind(this),
      };
   }

   bridgeWsReq(entry) {
      return (async (ws, local, m) => {
         const lb = this.ws[entry];
         const dst = lb && lb.getOne(local.pubid);
         if (!dst) { safeClose(ws); return; }
         const task = this.task[local.pubid];
         if (!task) { safeClose(ws); return; }
         const data = {
            id: local.pubid,
            mode: 'ws',
            data: m.toString('base64'),
         };
         await task.init;
         safeSendJson(dst, data);
      }).bind(this);
   }

   async bridgeWsRes(ws, local, m) {
      const wsobj = this.task[m.id];
      if (!wsobj) return;
      if (m.act === 'close') {
         safeClose(wsobj.ws);
      } else if (m.act === 'open') {
         wsobj.bin = !!m.bin;
         wsobj.r();
      } else if (m.data) {
         try {
            const buf = Buffer.from(m.data, 'base64');
            if (wsobj.bin) {
               safeSendBin(wsobj.ws, buf);
            } else {
               safeSend(wsobj.ws, buf.toString());
            }
         } catch (_) {}
      }
      return;
   }
}

module.exports = {
   Bridge,
};
