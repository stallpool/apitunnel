const { Server } = require('ssh2');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Generate a simple host key for SSH server
const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: {
    type: 'pkcs1',
    format: 'pem'
  }
});

// Create a simple SSH server for testing
const server = new Server({
  hostKeys: [privateKey]
}, (client) => {
  console.log('SSH Client connected!');

  client.on('authentication', (ctx) => {
    console.log('Authentication attempt:', ctx.method, 'user:', ctx.username);

    if (ctx.method === 'password') {
      // Accept any password for testing
      if (ctx.username === 'test' && ctx.password === 'test') {
        console.log('Authentication successful');
        ctx.accept();
      } else {
        console.log('Authentication failed');
        ctx.reject();
      }
    } else if (ctx.method === 'none') {
      // Allow no authentication for testing
      console.log('No authentication - accepting');
      ctx.accept();
    } else {
      ctx.reject();
    }
  });

  client.on('ready', () => {
    console.log('SSH Client authenticated!');

    client.on('session', (accept, reject) => {
      const session = accept();
      console.log('SSH Session started');

      session.once('exec', (accept, reject, info) => {
        console.log('SSH Command execution:', info.command);
        const stream = accept();

        // Echo the command and some system info
        stream.write(`Executed command: ${info.command}\n`);
        stream.write(`Server time: ${new Date().toISOString()}\n`);
        stream.write(`SSH Server via HTTP2 tunnel working!\n`);
        stream.exit(0);
        stream.end();
      });

      session.once('shell', (accept, reject) => {
        console.log('SSH Shell requested');
        const stream = accept();

        stream.write('Welcome to HTTP2 SSH Tunnel Test Server!\n');
        stream.write('Type "exit" to close connection.\n');
        stream.write('$ ');

        stream.on('data', (data) => {
          const command = data.toString().trim();
          console.log('Shell command:', command);

          if (command === 'exit') {
            stream.write('Goodbye!\n');
            stream.exit(0);
            stream.end();
          } else if (command === 'date') {
            stream.write(`${new Date().toISOString()}\n$ `);
          } else if (command === 'whoami') {
            stream.write('test\n$ ');
          } else if (command === 'pwd') {
            stream.write('/home/test\n$ ');
          } else if (command === '') {
            stream.write('$ ');
          } else {
            stream.write(`Command not found: ${command}\n$ `);
          }
        });
      });
    });
  });

  client.on('end', () => {
    console.log('SSH Client disconnected');
  });

  client.on('error', (err) => {
    console.log('SSH Client error:', err.message);
  });
});

server.listen(2222, '127.0.0.1', function() {
  console.log('SSH Server listening on port 2222');
});

server.on('error', (err) => {
  console.log('SSH Server error:', err);
});
