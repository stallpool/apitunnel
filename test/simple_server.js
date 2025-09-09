const http = require('http');

// Simple HTTP server for testing the tunnel
const server = http.createServer((req, res) => {
   console.log(`[${new Date().toISOString()}] HTTP Request: ${req.method} ${req.url}`);

   res.writeHead(200, { 'Content-Type': 'text/plain' });
   res.end(`HTTP Tunnel Test Successful!\nTime: ${new Date().toISOString()}\nMethod: ${req.method}\nURL: ${req.url}\n`);
});

server.listen(2222, '127.0.0.1', () => {
   console.log('Simple HTTP server listening on port 2222');
});

server.on('connection', (socket) => {
   console.log(`[${new Date().toISOString()}] New connection from ${socket.remoteAddress}:${socket.remotePort}`);
});

server.on('error', (err) => {
   console.log('Server error:', err);
});
