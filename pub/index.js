// version 2.0.0 - HTTP2 upgrade

const i_fs = require('fs');
const i_path = require('path');
const i_url = require('url');
const i_http2 = require('http2');
const i_env = require('./env');

function basicRoute(stream, headers, router) {
   const r = i_url.parse(headers[':path']);
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
      return f(stream, headers, {
         path: path,
         query: query
      });
   }
   while (path.length > 0) {
      let key = path.shift();
      f = f[key];
      if (!f) break;
      if (typeof(f) === 'function') {
         return f(stream, headers, {
            path: path,
            query: query
         });
      }
   }
   return serveCode(stream, 404, 'Not Found');
}

function serveCode(stream, code, text) {
   stream.respond({ ':status': code || 500 });
   stream.end(text || '');
}

function createHttp2Server(router) {
   if (typeof(router) !== 'function') {
     router = Object.assign({}, router);
   }

   const serverOptions = {
      key: i_fs.readFileSync(i_path.join(i_env.server.http2CertDir, 'server.key')),
      cert: i_fs.readFileSync(i_path.join(i_env.server.http2CertDir, 'server.crt')),
      // Enable Extended CONNECT for WebSocket over HTTP/2 (RFC 8441)
      enableConnectProtocol: true,
   };

   const server = i_http2.createSecureServer(serverOptions);

   server.on('stream', (stream, headers) => {
      // Handle Extended CONNECT for WebSocket (RFC 8441)
      if (headers[':method'] === 'CONNECT' && headers[':protocol'] === 'websocket') {
         handleWebSocketConnect(stream, headers, router);
      } else {
         basicRoute(stream, headers, router);
      }
   });

   return server;
}

function handleWebSocketConnect(stream, headers, router) {
   console.log('[D] WebSocket Extended CONNECT request:', headers[':path']);

   // Extract the path and find the appropriate handler
   const path = headers[':path'] || '/';
   const pathParts = path.split('/');

   // Look for websocket handlers (e.g., /wspub/...)
   if (pathParts[1] && pathParts[1].startsWith('ws')) {
      const entry = pathParts[1].substring(2); // Remove 'ws' prefix
      const bridge = router._bridge;

      if (bridge && bridge.handleWebSocketConnect) {
         bridge.handleWebSocketConnect(stream, headers, entry, path);
      } else {
         stream.respond({ ':status': 404 });
         stream.end();
      }
   } else {
      stream.respond({ ':status': 404 });
      stream.end();
   }
}

function main() {
   const Bridge = require('./bridge').Bridge;
   const bridge = new Bridge();

   const api_router = {
      ping: (stream, headers, opt) => {
         stream.respond({ ':status': 200 });
         stream.end('pong');
      },
      // Test endpoint for server-to-client messaging
      broadcast: bridge.handleTestMessage(),
      // Store bridge reference for WebSocket handling
      _bridge: bridge,
   };

   // Add HTTP endpoints for each entry
   i_env.pub.multiple_entries.forEach(entry => {
      api_router[entry] = bridge.bridgeHttpReq(entry);
   });

   // Add bidirectional stream endpoint
   api_router['stream'] = bridge.handleBidirectionalStream();

   // Add sub registration endpoint for HTTP2
   api_router['sub'] = bridge.handleSubConnection();

   const server = createHttp2Server(api_router);

   server.listen(i_env.server.port, i_env.server.host, () => {
      console.log(`APITUNNEL-pub HTTP2 is listening at ${i_env.server.host}:${i_env.server.port} ...`);
      console.log(`APITUNNEL-pub WebSocket over HTTP2 (RFC 8441) enabled ...`);
   });
}

main();
