// version 1.0.1

const i_fs = require('fs');
const i_path = require('path');
const i_url = require('url');
const i_crypto = require('crypto');

function hash(text, salt) {
   return i_crypto.createHmac('sha512', salt || '').update(text).digest('hex');
}

const i_env = {
   debug: !!process.env.TINY_DEBUG,
   server: {
      host: process.env.TINY_HOST || '127.0.0.1',
      port: parseInt(process.env.TINY_PORT || '5001'),
      httpsCADir: process.env.TINY_HTTPS_CA_DIR?i_path.resolve(process.env.TINY_HTTPS_CA_DIR):null,
   },
};

function basicRoute (req, res, router) {
   const r = i_url.parse(req.url);
   const originPath = r.pathname.split('/');
   const path = originPath.slice();
   const query = {};
   let f = router;
   if (r.query) r.query.split('&').forEach((one) => {
      let key, val;
      let i = one.indexOf('=');
      if (i < 0) {
         key = one;
         val = '';
      } else {
         key = one.substring(0, i);
         val = one.substring(i+1);
      }
      if (key in query) {
         if(Array.isArray(query[key])) {
            query[key].push(val);
         } else {
            query[key] = [query[key], val];
         }
      } else {
         query[key] = val;
      }
   });
   path.shift();
   if (typeof(f) === 'function') {
      return f(req, res, {
         path: path,
         query: query
      });
   }
   while (path.length > 0) {
      let key = path.shift();
      f = f[key];
      if (!f) break;
      if (typeof(f) === 'function') {
         return f(req, res, {
            path: path,
            query: query
         });
      }
   }
   return serveCode(req, res, 404, 'Not Found');
}

function serveCode(req, res, code, text) {
   res.writeHead(code || 500, text || '');
   res.end();
}

function createServer(router) {
   let server = null;
   if (typeof(router) !== 'function') {
     router = Object.assign({}, router);
   }
   if (i_env.server.httpsCADir) {
      const i_https = require('https');
      const https_config = {
         // openssl req -newkey rsa:2048 -new -nodes -x509 -days 365 -keyout ca.key -out ca.crt
         key: i_fs.readFileSync(i_path.join(i_env.server.httpsCADir, 'ca.key')),
         cert: i_fs.readFileSync(i_path.join(i_env.server.httpsCADir, 'ca.crt')),
      };
      server = i_https.createServer(https_config, (req, res) => {
         basicRoute(req, res, router);
      });
   } else {
      const i_http = require('http');
      server = i_http.createServer((req, res) => {
         basicRoute(req, res, router);
      });
   }
   return server;
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
function safeSendJson(ws, json) {
   safeSend(ws, JSON.stringify(json));
}

function bounce(fn, timeout) {
   let busy = false, timer = 0;
   return () => {
      if (busy) return;
      busy = true;
      timer = setTimeout(() => {
         busy = false;
      }, timeout);
      fn.apply(null, arguments);
   };
}

const i_makeWebsocket = require('./websocket').makeWebsocket;

const pubenv = {
   ws: null,
   id: 0,
   task: {},
   taskc: 0,
   taskgc: bounce(() => {
      const ts = new Date().getTime();
      Object.keys(pubenv.task).forEach(id => {
         const task = pubenv.task[id];
         if (task) {
            if (ts - task.ts <= 1000 * 10 /* 10s */) return;
            task.res.writeHead(504);
            task.res.end();
         }
         delete pubenv.task[id];
         pubenv.taskc --;
      });
   }, 1000),
   salt: process.env.PUB_SALT,
   token: process.env.PUB_TOKEN ? hash(process.env.PUB_TOKEN, process.env.PUB_SALT) : null,
};

const server = createServer({
   ping: (req, res, opt) => res.end('pong'),
   pub: async (req, res, opt) => {
      if (!pubenv.ws) {
         res.writeHead(502); res.end(); return;
      }
      const id = (pubenv.id + 1) % 10000000;
      let data = null;
      pubenv.id = id;
      if (req.method == 'POST') {
         try {
            data = (await readRequest(req, 10240 /*10K*/)).toString('base64');
         } catch(err) {
            res.writeHead(400); res.end(); return;
         }
      }
      pubenv.task[id] = {
         ts: new Date().getTime(),
         id, res, data,
         method: req.method,
         uri: req.url,
      };
      pubenv.taskc ++;
      safeSendJson(pubenv.ws, { id, data, method: req.method, uri: req.url });
   },
});

i_makeWebsocket(server, 'sub', '/sub', (ws, local, m) => {
   if (!local.bind) {
      if (pubenv.token) {
         if (m.cmd === 'auth' && pubenv.token === hash(m.token, pubenv.salt)) {
            local.bind = true;
            pubenv.ws = ws;
            console.log(`[I] ${ws._meta_?.ip} connected with token`);
         } else {
            safeClose(ws);
         }
      }
      return;
   }
   if (!m.id || (!m.data && !m.code)) return;
   const id = m.id;
   const task = pubenv.task[id];
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
   delete pubenv.task[id];
   pubenv.taskc --;
   pubenv.taskgc();
}, {
   onOpen: (ws, local) => {
      if (pubenv.ws) {
         safeClose(ws);
         return;
      }
      if (!pubenv.token) {
         local.bind = true;
         pubenv.ws = ws;
         console.log(`[I] ${ws._meta_?.ip} connected`);
      }
   },
   onClose: (ws, local) => {
      if (local.bind) pubenv.ws = null;
   },
   onError: (err, ws, local) => {},
});

server.listen(i_env.server.port, i_env.server.host, () => {
   console.log(`APITUNNEL-pub is listening at ${i_env.server.host}:${i_env.server.port}`);
});
