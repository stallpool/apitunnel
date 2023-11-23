const { WebSocketServer } = require('ws');

const wss = new WebSocketServer({ port: 5102 });

wss.on('connection', function connection(ws) {
  console.log('1 one connection');

  ws.send('1 test from server');

  ws.on('error', (err) => {
     console.log('2 error', err);
  });

  ws.on('close', () => {
    console.log('2 close');
  });

  ws.on('message', function message(data) {
    console.log('2 message', data.toString());
    ws.send(data); // echo
  });
});
