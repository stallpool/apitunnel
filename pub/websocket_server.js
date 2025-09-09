const i_http = require('http');
const i_fs = require('fs');
const i_path = require('path');
const i_env = require('./env');

// Create a separate HTTP/1.1 server for WebSocket connections
function createWebSocketServer(bridge) {
   const i_makeWebsocket = require('./websocket').makeWebsocket;

   // Simple HTTP server for WebSocket upgrades
   const server = i_http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('WebSocket server for wstunnel compatibility');
   });

   // Add WebSocket support for each entry
   i_env.pub.multiple_entries.forEach(entry => {
      i_makeWebsocket(server, `ws${entry}`, `/ws${entry}`, bridge.bridgeWsReq(entry), bridge.buildWsOptions(entry));
   });

   return server;
}

module.exports = {
   createWebSocketServer
};
