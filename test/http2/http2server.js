const i_http = require('http');
const { WebSocketServer } = require('ws');

// Create HTTP server that acts as a local service (for both HTTP and WebSocket)
const server = i_http.createServer();

// Add WebSocket server
const wss = new WebSocketServer({ server });

// Handle HTTP requests
server.on('request', (req, res) => {
   console.log('1 HTTP request received:', req.method, req.url);

   if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('1 test response from HTTP server');
   } else if (req.method === 'POST') {
      let data = '';
      req.on('data', (chunk) => {
         data += chunk;
      });
      req.on('end', () => {
         console.log('2 HTTP POST data received:', data);
         res.writeHead(200, { 'Content-Type': 'text/plain' });
         res.end(`1 echo: ${data}`);
      });
   }
});

// Handle WebSocket connections
wss.on('connection', function connection(ws) {
   console.log('1 WebSocket connection established');

   ws.send('1 test from WebSocket server');

   ws.on('error', (err) => {
      console.log('2 WebSocket error', err);
   });

   ws.on('close', () => {
      console.log('2 WebSocket close');
   });

   ws.on('message', function message(data) {
      console.log('2 WebSocket message', data.toString());
      ws.send(data); // echo
   });
});

server.on('error', (err) => {
   console.log('2 HTTP server error:', err);
});

server.listen(5102, () => {
   console.log('HTTP/WebSocket test server listening on port 5102');
});
