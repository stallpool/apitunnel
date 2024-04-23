const i_ws = require('ws');

const env = {
   handler: {},
   wss: null,
   pathConfig: {},
};

function delWsPathHandler(path) {
   delete env.pathConfig[path];
}

function handleConnection(ws, req, path, cfg) {
   const config = env.pathConfig[path];
   if (!path || !cfg) {
      try { ws.terminate(); } catch (_) { }
      return;
   }
   const onOpen = cfg.opt.onOpen;
   const onClose = cfg.opt.onClose;
   const onError = cfg.opt.onError;
   const timeout = cfg.opt.timeout;
   const local = { ws };
   let timer = 0;
   onOpen && onOpen(ws, local);
   if (timeout > 0) timer = setTimeout(() => {
      if (local.authenticated) return;
      try { ws.terminate(); } catch(_) { }
   }, timeout);
   ws.on('close', () => {
      local.closed = true;
      if (timer) clearTimeout(timer);
      onClose && onClose(ws, local);
   });
   ws.on('error', (err) => {
      onError && onError(err, ws, local);
   });
   ws.on('message', (m) => {
      try {
         if (!m.length || m.length > 10*1024*1024 /* 10MB */) throw 'invalid message';
         if (!cfg.opt?.raw) m = JSON.parse(m);
         cfg.fn && cfg.fn(ws, local, m);
      } catch(err) {
         try { ws.terminate(); } catch(_) {}
         return;
      }
   });
}

function addWsPathHandler(server, path, fn, opt) {
   if (!env.pathConfig[path]) env.pathConfig[path] = {};
   const config = env.pathConfig[path];
   config.path = path;
   config.fn = fn;
   config.opt = opt;
   if (env.wss) return;
   // lazy init
   env.wss = new i_ws.WebSocketServer({ noServer: true });
   env.wss.on('connection', handleConnection);
   server.on('upgrade', (req, socket, head) => {
      // authenticate: socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy();
      const configs = Object.values(env.pathConfig);
      for (const config of configs) {
         if (!req.url.startsWith(config.path)) continue;
         const rpath = req.url.substring(config.path.length);
         if (rpath && rpath.charAt(0) !== '/') continue;
         env.wss.handleUpgrade(req, socket, head, (ws) => {
            ws._meta_ = {
               ip: `${req.headers['x-forwarded-for'] || req.connection.remoteAddress}`,
               url: rpath || '/',
            };
            env.wss.emit('connection', ws, req, rpath || '/', config);
         });
         return;
      }
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
   });
}

function makeWebsocket(server, name, path, fn, opt) {
   // fn = websocketClient, localEnv, messageJson
   if (env.handler[name]) {
      env.handler[name] = false;
      delWsPathHandler(path);
   }
   env.handler[name] = true;
   addWsPathHandler(server, path, fn, opt);
}

module.exports = {
   makeWebsocket,
};
