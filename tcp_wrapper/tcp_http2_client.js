const net = require('net');
const http2 = require('http2');

// HTTP2 TCP Client - native HTTP2 TCP tunneling
// Listens on local port and forwards TCP connections via HTTP2 streams to pub server

class TcpHttp2Client {
   constructor(localPort, remoteHost, remotePort, http2Url) {
      this.localPort = localPort;
      this.remoteHost = remoteHost;
      this.remotePort = remotePort;
      this.http2Url = http2Url;
      this.connections = new Map(); // connId -> {socket, stream}
      this.nextConnId = 1;
      this.session = null;
   }

   start() {
      // Create HTTP2 session to pub server
      this.session = http2.connect(this.http2Url, {
         rejectUnauthorized: false // Allow self-signed certificates
      });

      this.session.on('connect', () => {
         console.log('HTTP2 session connected to', this.http2Url);
      });

      this.session.on('error', (err) => {
         console.log('HTTP2 session error:', err);
      });

      this.session.on('close', () => {
         console.log('HTTP2 session closed');
      });

      // Create TCP server
      const server = net.createServer((socket) => {
         this.handleNewConnection(socket);
      });

      server.listen(this.localPort, '127.0.0.1', () => {
         console.log(`HTTP2 TCP Client listening on 127.0.0.1:${this.localPort}`);
         console.log(`Forwarding to ${this.remoteHost}:${this.remotePort} via ${this.http2Url}`);
      });

      server.on('error', (err) => {
         console.log('TCP server error:', err);
      });
   }

   handleNewConnection(socket) {
      const connId = this.nextConnId++;
      console.log(`[${connId}] New TCP connection from ${socket.remoteAddress}:${socket.remotePort}`);

      // Create HTTP2 stream for this connection
      const stream = this.session.request({
         ':method': 'POST',
         ':path': '/tcp/connect',
         'content-type': 'application/json'
      });

      this.connections.set(connId, { socket, stream });

      // Send connection request
      const connectData = {
         type: 'connect',
         connId: connId,
         host: this.remoteHost,
         port: this.remotePort
      };

      stream.write(JSON.stringify(connectData) + '\n');

      stream.on('response', (headers) => {
         console.log(`[${connId}] HTTP2 stream response:`, headers[':status']);
      });

      let responseBuffer = '';
      stream.on('data', (data) => {
         responseBuffer += data.toString();

         // Process complete JSON messages (one per line)
         const lines = responseBuffer.split('\n');
         responseBuffer = lines.pop(); // Keep incomplete line in buffer

         lines.forEach(line => {
            if (line.trim()) {
               try {
                  const response = JSON.parse(line);
                  this.handleHttp2Response(connId, response);
               } catch (err) {
                  console.log(`[${connId}] Error parsing HTTP2 response:`, err);
               }
            }
         });
      });

      stream.on('close', () => {
         console.log(`[${connId}] HTTP2 stream closed`);
         socket.destroy();
         this.connections.delete(connId);
      });

      stream.on('error', (err) => {
         console.log(`[${connId}] HTTP2 stream error:`, err);
         socket.destroy();
         this.connections.delete(connId);
      });

      // Handle data from local TCP socket
      socket.on('data', (data) => {
         console.log(`[${connId}] Local socket data received, length:`, data.length);
         if (!stream.destroyed) {
            const dataMessage = {
               connId: connId,
               type: 'data',
               data: data.toString('base64')
            };
            stream.write(JSON.stringify(dataMessage) + '\n');
         }
      });

      socket.on('close', () => {
         console.log(`[${connId}] Local TCP connection closed`);
         if (!stream.destroyed) {
            const closeMessage = {
               connId: connId,
               type: 'close'
            };
            stream.write(JSON.stringify(closeMessage) + '\n');
            stream.end();
         }
         this.connections.delete(connId);
      });

      socket.on('error', (err) => {
         console.log(`[${connId}] Local TCP socket error:`, err);
         if (!stream.destroyed) {
            stream.end();
         }
         this.connections.delete(connId);
      });
   }

   handleHttp2Response(connId, response) {
      const conn = this.connections.get(connId);
      if (!conn) return;

      const { socket } = conn;

      if (response.type === 'connected') {
         console.log(`[${connId}] Connection established to ${this.remoteHost}:${this.remotePort}`);
      } else if (response.type === 'data') {
         // Forward data from remote to local TCP socket
         const buffer = Buffer.from(response.data, 'base64');
         console.log(`[${connId}] Forwarding data to local socket, length:`, buffer.length);
         socket.write(buffer);
      } else if (response.type === 'close') {
         console.log(`[${connId}] Remote connection closed`);
         socket.end();
      } else if (response.type === 'error') {
         console.log(`[${connId}] Remote error:`, response.error);
         socket.destroy();
      }
   }

   close() {
      if (this.session) {
         this.session.close();
      }
      this.connections.forEach((conn, connId) => {
         conn.socket.destroy();
         if (!conn.stream.destroyed) {
            conn.stream.end();
         }
      });
      this.connections.clear();
   }
}

// Usage: node tcp_http2_client.js <localPort> <remoteHost> <remotePort> <http2Url>
if (require.main === module) {
   const args = process.argv.slice(2);
   if (args.length !== 4) {
      console.log('Usage: node tcp_http2_client.js <localPort> <remoteHost> <remotePort> <http2Url>');
      console.log('Example: node tcp_http2_client.js 2223 127.0.0.1 2222 https://127.0.0.1:5001');
      process.exit(1);
   }

   const [localPort, remoteHost, remotePort, http2Url] = args;
   const client = new TcpHttp2Client(parseInt(localPort), remoteHost, parseInt(remotePort), http2Url);

   // Handle graceful shutdown
   process.on('SIGINT', () => {
      console.log('Shutting down HTTP2 TCP client...');
      client.close();
      process.exit(0);
   });

   client.start();
}

module.exports = TcpHttp2Client;
