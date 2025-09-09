const i_http2 = require('http2');

// Create HTTP2 client to test the tunnel
const session = i_http2.connect('https://127.0.0.1:5001', {
   rejectUnauthorized: false, // Allow self-signed certificates
});

session.on('connect', () => {
   console.log('2 HTTP2 client connected to tunnel');

   // Test GET request through the tunnel
   const getStream = session.request({
      ':method': 'GET',
      ':path': '/pub/127.0.0.1:5102/-/'
   });

   getStream.on('response', (headers) => {
      console.log('2 GET response status:', headers[':status']);
   });

   getStream.on('data', (data) => {
      console.log('2 GET response data:', data.toString());
   });

   getStream.on('end', () => {
      console.log('2 GET request completed');

      // Test POST request through the tunnel
      const postStream = session.request({
         ':method': 'POST',
         ':path': '/pub/127.0.0.1:5102/-/',
         'content-type': 'text/plain'
      });

      postStream.on('response', (headers) => {
         console.log('2 POST response status:', headers[':status']);
      });

      postStream.on('data', (data) => {
         console.log('2 POST response data:', data.toString());
      });

      postStream.on('end', () => {
         console.log('2 POST request completed');
         session.close();
      });

      postStream.end('1 test data from HTTP2 client');
   });

   getStream.end();
});

session.on('error', (err) => {
   console.log('2 HTTP2 client error:', err);
});

session.on('close', () => {
   console.log('2 HTTP2 client connection closed');
});
