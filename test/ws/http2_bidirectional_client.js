const i_http2 = require('http2');

// HTTP2 bidirectional messaging client (alternative to WebSocket)
const session = i_http2.connect('https://127.0.0.1:5001', {
   rejectUnauthorized: false, // Allow self-signed certificates
});

session.on('connect', () => {
   console.log('2 HTTP2 session connected for bidirectional messaging');

   // Create a long-lived stream for bidirectional communication
   const stream = session.request({
      ':method': 'POST',
      ':path': '/stream/pub/127.0.0.1:5102/-/',
      'content-type': 'text/plain',
   });

   stream.on('response', (headers) => {
      console.log('2 Bidirectional stream response:', headers[':status']);

      if (headers[':status'] === 200) {
         console.log('2 Bidirectional stream established');

         // Send test message
         stream.write('1 test message from client\n');

         // Send another message after 2 seconds
         setTimeout(() => {
            stream.write('1 second message from client\n');
         }, 2000);

         // Handle incoming messages from server
         stream.on('data', (data) => {
            console.log('2 Message from server:', data.toString().trim());
         });

         // Close after 10 seconds
         setTimeout(() => {
            console.log('2 Closing bidirectional stream');
            stream.end();
         }, 10000);
      } else {
         console.log('2 Bidirectional stream connection failed');
      }
   });

   stream.on('close', () => {
      console.log('2 Bidirectional stream closed');
      session.close();
   });

   stream.on('error', (err) => {
      console.log('2 Bidirectional stream error:', err);
   });
});

session.on('error', (err) => {
   console.log('2 HTTP2 session error:', err);
});

session.on('close', () => {
   console.log('2 HTTP2 session closed');
});
