const net = require('net');
const { WebSocket } = require('ws');

// TCP Client Wrapper - replaces wstunnel client
// Listens on local port and forwards TCP connections over WebSocket to pub server

class TcpClient {
   constructor(localPort, remoteHost, remotePort, wsUrl) {
      this.localPort = localPort;
      this.remoteHost = remoteHost;
      this.remotePort = remotePort;
      this.wsUrl = wsUrl;
      this.connections = new Map(); // connId -> {socket, ws}
      this.nextConnId = 1;
   }

   start() {
      const server = net.createServer((socket) => {
         this.handleNewConnection(socket);
      });

      server.listen(this.localPort, '127.0.0.1', () => {
         console.log(`TCP Client listening on 127.0.0.1:${this.localPort}`);
         console.log(`Forwarding to ${this.remoteHost}:${this.remotePort} via ${this.wsUrl}`);
      });

      server.on('error', (err) => {
         console.log('TCP Client server error:', err);
      });
   }

   handleNewConnection(socket) {
      const connId = this.nextConnId++;
      console.log(`[${connId}] New TCP connection from ${socket.remoteAddress}:${socket.remotePort}`);

      // Buffer for data received before WebSocket is ready
      const dataBuffer = [];
      let wsReady = false;

      // Create WebSocket connection to pub server
      const ws = new WebSocket(this.wsUrl);

      this.connections.set(connId, { socket, ws });

      ws.on('open', () => {
         console.log(`[${connId}] WebSocket connected`);

         // Send connection request
         ws.send(JSON.stringify({
            type: 'connect',
            connId: connId,
            host: this.remoteHost,
            port: this.remotePort
         }));

         wsReady = true;

         // Send any buffered data
         if (dataBuffer.length > 0) {
            console.log(`[${connId}] Sending ${dataBuffer.length} buffered data packets`);
            dataBuffer.forEach(data => {
               ws.send(JSON.stringify({
                  type: 'data',
                  connId: connId,
                  data: data.toString('base64')
               }));
            });
            dataBuffer.length = 0; // Clear buffer
         }
      });

      ws.on('message', (data) => {
         try {
            const msg = JSON.parse(data.toString());

            if (msg.type === 'connected' && msg.connId === connId) {
               console.log(`[${connId}] Connection established to ${this.remoteHost}:${this.remotePort}`);
            } else if (msg.type === 'data' && msg.connId === connId) {
               // Forward data from remote to local TCP socket
               const buffer = Buffer.from(msg.data, 'base64');
               console.log(`[${connId}] Forwarding data to local socket, length:`, buffer.length);
               socket.write(buffer);
            } else if (msg.type === 'close' && msg.connId === connId) {
               console.log(`[${connId}] Remote connection closed`);
               socket.end();
            } else if (msg.type === 'error' && msg.connId === connId) {
               console.log(`[${connId}] Remote error:`, msg.error);
               socket.destroy();
            }
         } catch (err) {
            console.log(`[${connId}] Error parsing WebSocket message:`, err);
         }
      });

      ws.on('close', () => {
         console.log(`[${connId}] WebSocket connection closed`);
         socket.destroy();
         this.connections.delete(connId);
      });

      ws.on('error', (err) => {
         console.log(`[${connId}] WebSocket error:`, err);
         socket.destroy();
         this.connections.delete(connId);
      });

      // Handle data from local TCP socket
      socket.on('data', (data) => {
         console.log(`[${connId}] Local socket data received, length:`, data.length);
         if (wsReady && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
               type: 'data',
               connId: connId,
               data: data.toString('base64')
            }));
         } else {
            console.log(`[${connId}] Buffering data (WebSocket not ready)`);
            dataBuffer.push(data);
         }
      });

      socket.on('close', () => {
         console.log(`[${connId}] Local TCP connection closed`);
         if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
               type: 'close',
               connId: connId
            }));
         }
         ws.close();
         this.connections.delete(connId);
      });

      socket.on('error', (err) => {
         console.log(`[${connId}] Local TCP socket error:`, err);
         if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
               type: 'close',
               connId: connId
            }));
         }
         ws.close();
         this.connections.delete(connId);
      });
   }
}

// Usage: node tcp_client.js <localPort> <remoteHost> <remotePort> <wsUrl>
if (require.main === module) {
   const args = process.argv.slice(2);
   if (args.length !== 4) {
      console.log('Usage: node tcp_client.js <localPort> <remoteHost> <remotePort> <wsUrl>');
      console.log('Example: node tcp_client.js 2223 127.0.0.1 2222 ws://127.0.0.1:5002/wspub/tcp/-/');
      process.exit(1);
   }

   const [localPort, remoteHost, remotePort, wsUrl] = args;
   const client = new TcpClient(parseInt(localPort), remoteHost, parseInt(remotePort), wsUrl);
   client.start();
}

module.exports = TcpClient;
