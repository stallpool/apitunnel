const WebSocket = require('ws');

const ws = new WebSocket('ws://127.0.0.1:5001/pubws/127.0.0.1:5102/-/');

ws.on('error', (err) => {
  console.log('2 error', err);
});

ws.on('close', function () {
  console.log('2 close');
});

ws.on('open', function open() {
  ws.send('1 test from client');
});

ws.on('message', function message(data) {
  console.log('2 message', data.toString());
});
