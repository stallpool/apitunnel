const i_http2 = require('http2');

// WebSocket over HTTP/2 client using Extended CONNECT (RFC 8441)
const session = i_http2.connect('https://127.0.0.1:5001', {
   rejectUnauthorized: false, // Allow self-signed certificates
});

session.on('connect', () => {
   console.log('2 HTTP2 session connected');

   // Create WebSocket connection using Extended CONNECT
   const wsStream = session.request({
      ':method': 'CONNECT',
      ':protocol': 'websocket',
      ':path': '/wspub/127.0.0.1:5102/-/',
      ':authority': '127.0.0.1:5001',
   });

   wsStream.on('response', (headers) => {
      console.log('2 WebSocket CONNECT response:', headers[':status']);

      if (headers[':status'] === 200) {
         console.log('2 WebSocket connection established');

         // Send test message
         wsStream.write('1 test from HTTP2 WebSocket client');

         // Handle incoming messages
         wsStream.on('data', (data) => {
            console.log('2 WebSocket message received:', data.toString());
         });

         // Close after 5 seconds
         setTimeout(() => {
            console.log('2 Closing WebSocket connection');
            wsStream.end();
         }, 5000);
      } else {
         console.log('2 WebSocket connection failed');
      }
   });

   wsStream.on('close', () => {
      console.log('2 WebSocket connection closed');
      session.close();
   });

   wsStream.on('error', (err) => {
      console.log('2 WebSocket error:', err);
   });
});

session.on('error', (err) => {
   console.log('2 HTTP2 session error:', err);
});

session.on('close', () => {
   console.log('2 HTTP2 session closed');
});
