const i_http2 = require('http2');
const i_ws = require('ws');
const i_download = require('./request').download;
const i_config = require('./config');
const i_env = require('./env');

const env = {
   target: i_env.sub.pub_url,
   token: i_env.sub.pub_token,
   session: null,
   connN: 0,
   ticket: {},
   wsagent: {},
   tcpagent: {}, // TCP connections storage
};

function safeCloseSession(session) {
   if (!session) return;
   try {
      if (!session.destroyed) {
         session.close();
      }
   } catch(err) { }
}

function ping(session, interval) {
   if (!session || session.destroyed) return;
   try {
      const stream = session.request({ ':method': 'GET', ':path': '/ping' });
      stream.end();
      setTimeout(ping, interval, session, interval);
   } catch (err) {
      console.log('[E] Ping failed:', err);
   }
}

function pollForTasks(session, entry, interval) {
   if (!session || session.destroyed) return;
   try {
      const stream = session.request({
         ':method': 'POST',
         ':path': '/sub/poll',
         'content-type': 'application/json'
      });

      stream.end(JSON.stringify({ entry }));

      stream.on('response', (headers) => {
         if (headers[':status'] === 200) {
            let data = '';
            stream.on('data', (chunk) => {
               data += chunk;
            });
            stream.on('end', async () => {
               try {
                  const task = JSON.parse(data);
                  console.log('[D] Received task:', task.id);
                  if (task.mode === 'ws') {
                     await handleWs(task.id, session, task);
                  } else if (task.mode === 'tcp') {
                     await handleTcp(task.id, session, task);
                  } else {
                     await handleHttp(task.id, session, task);
                  }
               } catch (err) {
                  console.log('[E] Error processing task:', err);
               }
            });
         }
      });

      stream.on('error', (err) => {
         console.log('[E] Polling failed:', err);
      });

      setTimeout(pollForTasks, interval, session, entry, interval);
   } catch (err) {
      console.log('[E] Polling error:', err);
      setTimeout(pollForTasks, interval, session, entry, interval);
   }
}

const allowed_headers = ['content-type', 'user-agent', 'content-length'];
async function processHttp(method, uri, payload, m) {
   console.log('[D]', new Date().toISOString(), method, uri, payload);
   const parts = uri.split('/');
   parts.shift(); parts.shift(); // e.g. /pub/<region>/<site>/...
   const region = parts.shift();
   const site = parts.shift();
   if (parts.length === 0) return null;
   const remain = parts.join('/');

   const url = i_config.renderUrl('http', region, site, remain);
   if (!url) throw `no such region "${region}"`;

   const httpopt = {};
   if (m.headers) {
      httpopt.headers = Object.assign({}, m.headers);
      Object.keys(httpopt.headers).forEach(x => {
         if (!allowed_headers.includes(x)) delete httpopt.headers[x];
      });
   }

   if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      payload = payload && Buffer.from(payload, 'base64');
      return await i_download(url, { ...httpopt, method, payload });
   } else {
      return await i_download(url, { ...httpopt, method });
   }
}

async function handleHttp(id, session, m) {
   const method = m.method;
   const uri = m.uri;
   const payload = m.data;
   console.log('[D] handleHttp called:', { id, method, uri });
   if (!id || !method || !uri) return;
   try {
      const obj = await processHttp(method, uri, payload, m);
      console.log('[D] processHttp result:', obj ? 'success' : 'null', obj?.error);
      if (!obj || obj.error) throw 'error';
      if (obj.redirect) throw 'not supported';
      const r = { id, headers: obj.headers, data: obj.buf.toString('base64') };

      console.log('[D] Sending response for task', id);
      // Send response back to pub via HTTP2
      const responseStream = session.request({
         ':method': 'POST',
         ':path': '/sub/response',
         'content-type': 'application/json'
      });
      responseStream.end(JSON.stringify(r));
      console.log('[D] Response sent for task', id);
   } catch (err) {
      console.log('[E] Error in handleHttp:', err);
      // Send error response
      const errorResponse = { id, code: 500 };
      const responseStream = session.request({
         ':method': 'POST',
         ':path': '/sub/response',
         'content-type': 'application/json'
      });
      responseStream.end(JSON.stringify(errorResponse));
      console.log('[D] Error response sent for task', id);
   }
}

function safeClose(ws) {
   if (!ws) return;
   try { ws.terminate() } catch(err) { }
}

function processWs(subSession, obj) {
   const id = obj.id;
   obj.conn.on('open', () => {
      // Send WebSocket open response via HTTP2
      const responseStream = subSession.request({
         ':method': 'POST',
         ':path': '/sub/response',
         'content-type': 'application/json'
      });
      responseStream.end(JSON.stringify({ id, mode: 'ws', act: 'open', bin: obj.bin}));
   });
   obj.conn.on('message', (m) => {
      console.log('[D] WebSocket message received, size:', m.length, 'type:', typeof m);
      // Send WebSocket message response via HTTP2
      const responseStream = subSession.request({
         ':method': 'POST',
         ':path': '/sub/response',
         'content-type': 'application/json'
      });
      // Properly handle Buffer data
      const data = Buffer.isBuffer(m) ? m.toString('base64') : Buffer.from(m).toString('base64');
      console.log('[D] Sending WebSocket data to pub, base64 length:', data.length);
      responseStream.end(JSON.stringify({
        id, mode: 'ws', data: data,
      }));
   });
   obj.conn.on('close', () => {
      delete env.wsagent[id];
      safeClose(obj.conn);
      // Send WebSocket close response via HTTP2
      const responseStream = subSession.request({
         ':method': 'POST',
         ':path': '/sub/response',
         'content-type': 'application/json'
      });
      responseStream.end(JSON.stringify({ id, mode: 'ws', act: 'close' }));
   });
   obj.conn.on('error', (err) => {});
}

async function handleWs(id, session, m) {
   console.log('[D] handleWs called with ID:', id, 'act:', m.act, 'uri:', m.uri, 'hasData:', !!m.data);
   const act = m.act;
   const uri = m.uri;
   const dat = m.data;
   if (!act && !dat) {
      console.log('[D] handleWs: no act and no data, returning');
      return;
   }
   const obj = env.wsagent[id];
   if (act === 'close') {
      if (!obj) return;
      console.log('[D]', new Date().toISOString(), 'websocket', 'close', obj.uri, id);
      safeClose(obj.conn);
   } else if (act === 'open' && uri) {
      if (obj) return;
      console.log('[D]', new Date().toISOString(), 'websocket', 'open', uri, id);
      const parts = uri.split('/');
      const region = parts[1];
      const site = parts[2];
      const remain = parts.slice(3).join('/');
      console.log('[D] WebSocket URL parts:', { region, site, remain });
      const url = i_config.renderUrl('websocket', region, site, remain);
      console.log('[D] Rendered WebSocket URL:', url);
      if (!url) {
         console.log('[E] Failed to render WebSocket URL');
         return;
      }
      const isBinary = i_config.isBinary('websocket', region, site, remain);
      // Add wstunnel protocol support
      const conn = new i_ws.WebSocket(url, ['tunnel-protocol', 'wstunnel']);
      const newobj = { id, conn, uri, bin: isBinary };
      env.wsagent[id] = newobj;
      processWs(session, newobj);
   } else if (dat) {
      console.log('[D] handleWs: processing data, obj exists:', !!obj, 'data length:', dat.length);
      if (!obj) {
         console.log('[D] handleWs: no WebSocket object found for ID:', id);
         return;
      }
      try {
         const buf = Buffer.from(dat, 'base64');
         console.log('[D] handleWs: sending data to WebSocket, binary:', obj.bin, 'buffer length:', buf.length);
         if (obj.bin) {
            obj.conn.send(buf, { isBinary: true });
         } else {
            obj.conn.send(buf.toString());
         }
      } catch(err) {
         console.log('[D] handleWs: error sending data:', err);
      }
   }
}

// TCP handling functions
async function handleTcp(id, session, m) {
   console.log('[D] handleTcp called with ID:', id, 'type:', m.type, 'connId:', m.connId, 'hasData:', !!m.data);

   const type = m.type;
   const connId = m.connId;

   if (type === 'connect') {
      await handleTcpConnect(id, session, m);
   } else if (type === 'data') {
      await handleTcpData(id, session, m);
   } else if (type === 'close') {
      await handleTcpClose(id, session, m);
   }
}

async function handleTcpConnect(id, session, m) {
   const connId = m.connId;
   const host = m.host;
   const port = m.port;

   console.log('[D] TCP connect request:', connId, 'to', host + ':' + port);

   // Parse the URI to get target host/port from config
   // URI comes from WebSocket path like /ssh/-/ which should map to TCP config
   const uri = m.uri || '/ssh/-/';
   const parts = uri.split('/').filter(p => p); // Remove empty parts
   const region = parts[0] || 'ssh'; // First part is the region (ssh, tcp, etc.)
   const site = parts[1] || '-';
   const remain = parts[2] || '';

   console.log('[D] TCP URL parts:', { region, site, remain, originalUri: uri });

   const target = i_config.renderUrl('tcp', region, site, remain);
   console.log('[D] Rendered TCP target:', target);

   if (!target) {
      console.log('[E] Failed to render TCP target');
      sendTcpResponse(session, id, connId, 'error', 'Invalid target configuration');
      return;
   }

   const net = require('net');
   const socket = net.createConnection(target.port, target.host);

   const tcpObj = {
      id,
      connId,
      socket,
      host: target.host,
      port: target.port
   };

   env.tcpagent[connId] = tcpObj;

   socket.on('connect', () => {
      console.log('[D] TCP connected to', target.host + ':' + target.port, 'for connId:', connId);
      sendTcpResponse(session, id, connId, 'connected');
   });

   socket.on('data', (data) => {
      console.log('[D] TCP data from server, connId:', connId, 'length:', data.length);
      sendTcpResponse(session, id, connId, 'data', null, data.toString('base64'));
   });

   socket.on('close', () => {
      console.log('[D] TCP connection closed, connId:', connId);
      delete env.tcpagent[connId];
      sendTcpResponse(session, id, connId, 'close');
   });

   socket.on('error', (err) => {
      console.log('[D] TCP connection error, connId:', connId, 'error:', err.message);
      delete env.tcpagent[connId];
      sendTcpResponse(session, id, connId, 'error', err.message);
   });
}

async function handleTcpData(id, session, m) {
   const connId = m.connId;
   const data = m.data;

   if (!data) return;

   const tcpObj = env.tcpagent[connId];
   if (!tcpObj) {
      console.log('[D] TCP data for unknown connId:', connId);
      return;
   }

   try {
      const buffer = Buffer.from(data, 'base64');
      console.log('[D] TCP sending data to server, connId:', connId, 'length:', buffer.length);
      tcpObj.socket.write(buffer);
   } catch (err) {
      console.log('[E] TCP data write error:', err);
   }
}

async function handleTcpClose(id, session, m) {
   const connId = m.connId;

   const tcpObj = env.tcpagent[connId];
   if (!tcpObj) return;

   console.log('[D] TCP closing connection, connId:', connId);
   tcpObj.socket.end();
   delete env.tcpagent[connId];
}

function sendTcpResponse(session, id, connId, type, error = null, data = null) {
   const response = {
      id,
      mode: 'tcp',
      type,
      connId
   };

   if (error) response.error = error;
   if (data) response.data = data;

   const responseStream = session.request({
      ':method': 'POST',
      ':path': '/sub/response',
      'content-type': 'application/json'
   });

   responseStream.end(JSON.stringify(response));
}

function connect() {
   console.log(`[I] ${new Date().toISOString()} connecting to "${env.target}" ...`);
   try {
      // Parse the target URL to get host and port
      const url = new URL(env.target.replace('ws://', 'https://').replace('wss://', 'https://'));
      const host = url.hostname;
      const port = url.port || 443;
      const path = url.pathname;

      // Extract entry from path (e.g., /sub/pub -> entry is "pub")
      const pathParts = path.split('/').filter(p => p);
      const entry = pathParts[pathParts.length - 1]; // Get last part as entry

      const session = i_http2.connect(`https://${host}:${port}`, {
         rejectUnauthorized: false, // Allow self-signed certificates
      });

      env.session = session;

      session.on('connect', () => {
         console.log(`[I] ${new Date().toISOString()} HTTP2 connected.`);

         // Register this sub instance
         const authData = { cmd: 'auth' };
         if (env.token) {
            authData.token = env.token;
         }
         if (i_env.sub.lb) {
            authData.lb = i_env.sub.lb;
            authData.lb_n = i_env.sub.lb_n;
            console.log(`[I] ${new Date().toISOString()} loadbalancer: ${authData.lb} (${authData.lb_n || 1})`);
         }

         const regStream = session.request({
            ':method': 'POST',
            ':path': `/sub/${entry}`,
            'content-type': 'application/json'
         });
         regStream.end(JSON.stringify(authData));

         regStream.on('response', (headers) => {
            if (headers[':status'] === 200) {
               console.log(`[I] ${new Date().toISOString()} registered successfully`);
               // Start polling for tasks
               setTimeout(() => pollForTasks(session, entry, 1000), 1000);
            } else {
               console.log(`[E] ${new Date().toISOString()} registration failed:`, headers[':status']);
            }
         });
      });

      session.on('error', (err) => {
         console.log('[E]', new Date().toISOString(), err);
         env.session = null;
      });

      session.on('close', () => {
         console.log(`[I] ${new Date().toISOString()} HTTP2 disconnected`);
         env.session = null;
      });

      // No longer need stream handling since we use polling

      setTimeout(() => ping(env.session, 30*1000), 30*1000);
   } catch (err) {
      console.log('[E] Connection error:', err);
   }
}

function watchDog() {
   try {
      if (!env.session || env.session.destroyed) connect();
   } catch(err) { }
   setTimeout(watchDog, 10*1000);
}

function main() {
   i_config.startWatchConfigFile();
   watchDog();
}

main();
