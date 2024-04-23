// version 1.0.1

const i_fs = require('fs');
const i_path = require('path');
const i_url = require('url');
const i_env = require('./env');

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

function main() {
   const Bridge = require('./bridge').Bridge;
   const bridge = new Bridge();

   const i_makeWebsocket = require('./websocket').makeWebsocket;

   const api_router = { ping: (req, res, opt) => res.end('pong'), };
   i_env.pub.multiple_entries.forEach(entry => {
      api_router[entry] = bridge.bridgeHttpReq(entry);
   });
   const server = createServer(api_router);

   i_makeWebsocket(server, 'sub', '/sub', bridge.listenSub(), bridge.buildSubOptions(i_env.pub.multiple_entries));

   if (i_env.pub.ws_enable) {
      i_env.pub.multiple_entries.forEach(entry => {
         i_makeWebsocket(server, `ws${entry}`, `/ws${entry}`, bridge.bridgeWsReq(entry), bridge.buildWsOptions(entry));
      });
   } // if.ws_enable

   server.listen(i_env.server.port, i_env.server.host, () => {
      console.log(`APITUNNEL-pub is listening at ${i_env.server.host}:${i_env.server.port} ...`);
      if (i_env.pub.ws_enable) console.log(`APITUNNEL-pub websocket enabled ...`);
   });
}

main();
