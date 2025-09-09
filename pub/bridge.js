const i_crypto = require('crypto');
const i_http2 = require('http2');
const i_env = require('./env');
const i_lb = require('./loadbalance');

function hash(text, salt) {
   return i_crypto.createHmac('sha512', salt || '').update(text).digest('hex');
}

function readStreamData(stream, max) {
   return new Promise((r) => {
      let size = 0;
      let over = false;
      const body = [];
      stream.on('data', (chunk) => {
         if (over) return;
         size += chunk.length;
         if (size > max) {
            over = true;
            r(null);
            return;
         }
         body.push(chunk);
      });
      stream.on('end', () => {
         if (over) return;
         const bodyraw = Buffer.concat(body);
         try {
            const body0 = (bodyraw);
            r(body0);
         } catch(err) {
            r(null);
         }
      });
      stream.on('error', () => {
         over = true;
         r(null);
      });
   });
}

function safeCloseStream(stream) {
   if (!stream) return;
   try {
      if (!stream.destroyed) {
         stream.destroy();
      }
   } catch(err) { }
}

function safeRespond(stream, data) {
   if (!stream || stream.destroyed) return;
   try {
      if (typeof data === 'string') {
         stream.respond({ ':status': 200 });
         stream.end(data);
      } else {
         console.log('[D] safeRespond with headers:', data.headers);
         stream.respond(data.headers || { ':status': 200 });
         stream.end(data.body);
      }
   } catch(err) {
      console.log('[E] safeRespond error:', err);
   }
}

function debounce(fn, timeout) {
   let busy = false, timer = 0;
   return (...args) => {
      if (busy) return;
      busy = true;
      timer = setTimeout(() => {
         busy = false;
      }, timeout);
      fn.apply(null, args);
   };
}

function taskgc(bridge) {
   const ts = new Date().getTime();
   Object.keys(bridge.task).forEach(id => {
      const task = bridge.task[id];
      if (task && task.stream) {
         if (ts - task.ts <= 1000 * 10 /* 10s */) return;
         safeRespond(task.stream, { headers: { ':status': 504 }, body: '' });
      }
      delete bridge.task[id];
      bridge.taskc --;
   });
}

const http_max_id = i_env.pub.http_client_max;
const ws_max_id = http_max_id + 10000 + 1;
const salt = i_env.pub.salt;
const token = i_env.pub.token ? hash(i_env.pub.token, i_env.pub.salt) : null;

class Bridge {
   constructor() {
      this.subConnections = {}; // entry -> load balancer
      this.taskQueue = {}; // entry -> array of pending tasks
      this.activeWebSockets = {}; // id -> WebSocket connection info
      this.hid = 0;
      this.task = {};
      this.taskc = 0;
      this.taskgc = debounce(taskgc, 1000);
   }

   buildLoadBalance(m) {
      let lb = null;
      if (m) {
         if (m.lb === 'roundrobin') {
            lb = new i_lb.RoundRobinLoadBalance();
         } else if (m.lb === 'idbind') {
            lb = new i_lb.IdBindLoadBalance();
         }
         if (lb && m.lb_n) lb.setSlotN(isNaN(m.lb_n) ? 1 : m.lb_n);
      }
      if (!lb) lb = new i_lb.NoLoadBalance();
      return lb;
   }

   registerSub(session, entry, m) {
      // Initialize task queue for this entry if not exists
      if (!this.taskQueue[entry]) {
         this.taskQueue[entry] = [];
      }

      // Store connection info for this entry
      const lb = this.subConnections[entry] || this.buildLoadBalance(m);
      lb.addConn(session);
      this.subConnections[entry] = lb;
      const suffix = token ? ` with token` : ``;
      console.log(`[I] "${entry}" (${lb.countConn()}) HTTP2 sub connected${suffix}`);
   }

   authenticate(session, entry, m) {
      if (token) {
         if (m.cmd === 'auth' && token === hash(m.token, salt)) {
            this.registerSub(session, entry, m);
            return true;
         } else {
            safeCloseStream(session);
            return false;
         }
      } else {
         this.registerSub(session, entry, m);
         return true;
      }
   }

   handleSubConnection() {
      return (stream, headers, opt) => {
         // Extract entry from path: /sub/{entry}
         const entry = opt.path[0];

         // Handle sub response
         if (entry === 'response') {
            this.handleSubResponse(stream, headers, opt);
            return;
         }

         // Handle task polling
         if (entry === 'poll') {
            this.handleTaskPolling(stream, headers, opt);
            return;
         }

         if (!entry || !i_env.pub.multiple_entries.includes(entry)) {
            safeRespond(stream, { headers: { ':status': 404 }, body: 'Entry not found' });
            return;
         }

         // This is a sub registration request
         if (headers[':method'] === 'POST') {
            this.handleSubRegistration(stream, headers, entry);
         }
      };
   }

   async handleSubRegistration(stream, headers, entry) {
      try {
         const data = await readStreamData(stream, 1024);
         if (!data) {
            safeRespond(stream, { headers: { ':status': 400 }, body: 'Invalid data' });
            return;
         }

         const m = JSON.parse(data.toString());

         // Create a persistent HTTP2 session for this sub
         const session = stream.session;

         if (this.authenticate(session, entry, m)) {
            safeRespond(stream, { headers: { ':status': 200 }, body: 'OK' });

            // Set up session handlers
            session.on('close', () => {
               const lb = this.subConnections[entry];
               if (lb) {
                  lb.delConn(session);
                  if (!lb.hasConn()) this.subConnections[entry] = null;
                  console.log(`[I] "${entry}" (${lb.countConn()}) HTTP2 sub disconnected`);
               }
            });
         }
      } catch (err) {
         safeRespond(stream, { headers: { ':status': 400 }, body: 'Invalid JSON' });
      }
   }

   async handleSubResponse(stream, headers, opt) {
      // Handle response from sub for a pending task
      console.log('[D] handleSubResponse called');
      try {
         const data = await readStreamData(stream, 10240);
         console.log('[D] Response data received:', data ? data.length : 'null');
         if (!data) {
            safeRespond(stream, { headers: { ':status': 400 }, body: 'Invalid data' });
            return;
         }

         const m = JSON.parse(data.toString());
         console.log('[D] Parsed response:', { id: m.id, hasData: !!m.data, code: m.code });
         await this.bridgeHttpRes(stream, m);
      } catch (err) {
         console.log('[E] Error in handleSubResponse:', err);
         safeRespond(stream, { headers: { ':status': 400 }, body: 'Invalid response' });
      }
   }

   async handleTaskPolling(stream, headers, opt) {
      // Handle task polling from sub - extract entry from query or path
      try {
         const data = await readStreamData(stream, 1024);
         let entry = 'pub'; // default entry

         if (data) {
            try {
               const pollData = JSON.parse(data.toString());
               entry = pollData.entry || entry;
            } catch (e) {}
         }

         const queue = this.taskQueue[entry] || [];
         if (queue.length > 0) {
            const task = queue.shift();
            safeRespond(stream, {
               headers: { ':status': 200, 'content-type': 'application/json' },
               body: JSON.stringify(task)
            });
         } else {
            safeRespond(stream, {
               headers: { ':status': 204 },
               body: ''
            });
         }
      } catch (err) {
         safeRespond(stream, { headers: { ':status': 400 }, body: 'Invalid request' });
      }
   }

   bridgeHttpReq(entry) {
      return async (stream, headers, opt) => {
         const lb = this.subConnections[entry];
         if (!lb) {
            safeRespond(stream, { headers: { ':status': 502 }, body: 'Service Unavailable' });
            return;
         }

         if (this.taskc >= i_env.pub.ratelimit) {
            safeRespond(stream, { headers: { ':status': 429 }, body: 'Too Many Requests' });
            return;
         }

         const id = (this.hid + 1) % http_max_id;
         const dst = lb && lb.getOne(id);
         if (!dst) {
            safeRespond(stream, { headers: { ':status': 502 }, body: 'Service Unavailable' });
            return;
         }
         lb.cancelOne(id);
         this.hid = id;
         let data = null;
         this.taskc ++;

         if (headers[':method'] === 'POST' || headers[':method'] === 'PUT' || headers[':method'] === 'PATCH') {
            try {
               const bodyData = await readStreamData(stream, 10240 /*10K*/);
               data = bodyData ? bodyData.toString('base64') : null;
            } catch(err) {
               this.taskc --;
               safeRespond(stream, { headers: { ':status': 400 }, body: 'Bad Request' });
               return;
            }
         }

         // Store task info
         this.task[id] = {
            ts: new Date().getTime(),
            id, stream, data,
            method: headers[':method'],
            uri: headers[':path'],
            headers: Object.assign({}, headers)
         };

         // Queue task for sub to pick up
         const requestData = {
            id,
            data,
            method: headers[':method'],
            uri: headers[':path'],
            headers: headers
         };

         if (!this.taskQueue[entry]) {
            this.taskQueue[entry] = [];
         }
         this.taskQueue[entry].push(requestData);
      };
   }

   async bridgeHttpRes(responseStream, m) {
      console.log('[D] bridgeHttpRes called for task', m.id);
      if (!m.data && !m.code) {
         console.log('[D] No data and no code, returning');
         return;
      }
      const id = m.id;
      const task = this.task[id];
      if (!task) {
         console.log('[D] No task found for id', id);
         return;
      }

      console.log('[D] Processing response for task', id, 'hasData:', !!m.data, 'code:', m.code);

      try {
         if (id > http_max_id && id < ws_max_id && m.mode === 'ws') {
            this.bridgeWsRes(responseStream, m);
            return;
         }

         const stream = task.stream;
         const responseHeaders = m.headers || {};

         if (m.data) {
            const buf = Buffer.from(m.data, 'base64');
            console.log('[D] Sending response data, length:', buf.length);

            // Filter out HTTP/1 specific headers that are forbidden in HTTP/2
            const filteredHeaders = {};
            const forbiddenHeaders = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade'];

            Object.keys(responseHeaders).forEach(key => {
               const lowerKey = key.toLowerCase();
               if (!forbiddenHeaders.includes(lowerKey)) {
                  filteredHeaders[key] = responseHeaders[key];
               }
            });

            if (filteredHeaders['content-length']) {
               filteredHeaders['content-length'] = buf.length;
            }
            filteredHeaders[':status'] = 200;
            safeRespond(stream, { headers: filteredHeaders, body: buf });
         } else {
            console.log('[D] Sending error response, code:', m.code);
            safeRespond(stream, { headers: { ':status': m.code }, body: '' });
         }

         // Send response back to sub
         safeRespond(responseStream, { headers: { ':status': 200 }, body: 'OK' });
         console.log('[D] Response processing completed for task', id);
      } catch(err) {
         console.log('[E]', new Date().toISOString(), err);
      }

      delete this.task[id];
      this.taskc --;
      this.taskgc(this);
   }

   buildWsOptions(entry) {
      return {
         raw: true,
         onOpen: ((ws, local) => {
            const lb = this.subConnections[entry];
            if (!lb) {
               try { ws.terminate(); } catch(_) { }
               return;
            }
            let id;
            for (id = http_max_id+1; id < ws_max_id && this.task[id]; id++);
            if (id === ws_max_id) {
               try { ws.terminate(); } catch(_) { }
               return;
            } // reach max rate limit
            const dst = lb.getOne(id);
            if (!dst) {
               try { ws.terminate(); } catch(_) { }
               return;
            }
            local.pubid = id;
            const task = {
               ts: new Date().getTime(),
               id, ws,
            };
            task.init = new Promise((r, e) => {
               task.r = r;
               task.e = e;
            });
            this.task[id] = task;

            // Send WebSocket open request via HTTP2
            try {
               const session = dst._http2Session || dst;
               const reqStream = session.request({
                  ':method': 'POST',
                  ':path': `/ws/${id}`,
                  'content-type': 'application/json'
               });
               reqStream.end(JSON.stringify({ id, mode: 'ws', act: 'open', uri: ws._meta_.url }));
            } catch (err) {
               delete this.task[id];
               try { ws.terminate(); } catch(_) { }
            }
         }).bind(this),
         onClose: ((ws, local) => {
            const id = local.pubid;
            if (!id) return;
            const task = this.task[id];
            delete this.task[id];
            const lb = this.subConnections[entry];
            if (lb) {
               const dst = lb.getOne(id);
               lb.cancelOne(id);
               if (dst) {
                  try {
                     const session = dst._http2Session || dst;
                     const reqStream = session.request({
                        ':method': 'POST',
                        ':path': `/ws/${id}`,
                        'content-type': 'application/json'
                     });
                     reqStream.end(JSON.stringify({ id, mode: 'ws', act: 'close' }));
                  } catch (err) {}
               }
            }
         }).bind(this),
         onError: ((err, ws, local) => { }).bind(this),
      };
   }

   bridgeWsReq(entry) {
      return (async (ws, local, m) => {
         const lb = this.subConnections[entry];
         const dst = lb && lb.getOne(local.pubid);
         if (!dst) {
            try { ws.terminate(); } catch(_) { }
            return;
         }
         const task = this.task[local.pubid];
         if (!task) {
            try { ws.terminate(); } catch(_) { }
            return;
         }
         const data = {
            id: local.pubid,
            mode: 'ws',
            data: m.toString('base64'),
         };
         await task.init;

         try {
            const session = dst._http2Session || dst;
            const reqStream = session.request({
               ':method': 'POST',
               ':path': `/ws/${local.pubid}`,
               'content-type': 'application/json'
            });
            reqStream.end(JSON.stringify(data));
         } catch (err) {
            try { ws.terminate(); } catch(_) { }
         }
      }).bind(this);
   }

   async bridgeWsRes(responseStream, m) {
      const wsobj = this.task[m.id];
      if (!wsobj) return;
      if (m.act === 'close') {
         try {
            if (wsobj.ws) {
               wsobj.ws.terminate();
            } else if (wsobj.stream) {
               wsobj.stream.close();
            }
         } catch(_) { }
      } else if (m.act === 'open') {
         wsobj.bin = !!m.bin;
         if (wsobj.r) wsobj.r();
      } else if (m.data) {
         try {
            const buf = Buffer.from(m.data, 'base64');
            if (wsobj.stream) {
               // HTTP2 WebSocket data
               wsobj.stream.write(buf);
            } else if (wsobj.ws) {
               // Legacy WebSocket data
               if (wsobj.bin) {
                  wsobj.ws.send(buf, { isBinary: true });
               } else {
                  wsobj.ws.send(buf.toString());
               }
            }
         } catch (_) {}
      }

      // Send response back to sub
      try {
         safeRespond(responseStream, { headers: { ':status': 200 }, body: 'OK' });
      } catch (err) {}
      return;
   }

   handleWebSocketConnect(stream, headers, entry, path) {
      console.log('[D] Handling WebSocket Extended CONNECT for entry:', entry, 'path:', path);

      const lb = this.subConnections[entry];
      if (!lb) {
         stream.respond({ ':status': 502 });
         stream.end();
         return;
      }

      let id;
      for (id = http_max_id+1; id < ws_max_id && this.task[id]; id++);
      if (id === ws_max_id) {
         stream.respond({ ':status': 429 });
         stream.end();
         return;
      } // reach max rate limit

      const dst = lb.getOne(id);
      if (!dst) {
         stream.respond({ ':status': 502 });
         stream.end();
         return;
      }

      // Accept the WebSocket connection
      stream.respond({ ':status': 200 });

      const task = {
         ts: new Date().getTime(),
         id,
         stream, // HTTP2 stream for this WebSocket connection
         entry,
         path: path.substring(entry.length + 3), // Remove /ws{entry} prefix
      };

      task.init = new Promise((r, e) => {
         task.r = r;
         task.e = e;
      });

      this.task[id] = task;
      this.activeWebSockets[id] = task; // Track active WebSocket connections

      // Send WebSocket open request to sub via HTTP2
      if (!this.taskQueue[entry]) {
         this.taskQueue[entry] = [];
      }
      this.taskQueue[entry].push({
         id,
         mode: 'ws',
         act: 'open',
         uri: task.path,
         headers: headers
      });

      // Handle incoming WebSocket data from client
      stream.on('data', (data) => {
         console.log('[D] WebSocket data from client:', data.toString());
         if (!this.taskQueue[entry]) {
            this.taskQueue[entry] = [];
         }
         this.taskQueue[entry].push({
            id,
            mode: 'ws',
            data: data.toString('base64'),
         });
      });

      stream.on('close', () => {
         console.log('[D] WebSocket client disconnected:', id);
         delete this.task[id];
         delete this.activeWebSockets[id];
         if (!this.taskQueue[entry]) {
            this.taskQueue[entry] = [];
         }
         this.taskQueue[entry].push({ id, mode: 'ws', act: 'close' });
      });

      stream.on('error', (err) => {
         console.log('[E] WebSocket stream error:', err);
         delete this.task[id];
         delete this.activeWebSockets[id];
      });
   }

   // Server-to-client messaging capability
   broadcastToWebSockets(message, entry = null) {
      console.log('[D] Broadcasting message to WebSockets:', message);
      Object.values(this.activeWebSockets).forEach(wsTask => {
         if (!entry || wsTask.entry === entry) {
            try {
               if (wsTask.stream && !wsTask.stream.destroyed) {
                  wsTask.stream.write(Buffer.from(message));
               }
            } catch (err) {
               console.log('[E] Error broadcasting to WebSocket:', err);
            }
         }
      });
   }

   sendToWebSocket(id, message) {
      const wsTask = this.activeWebSockets[id];
      if (wsTask && wsTask.stream && !wsTask.stream.destroyed) {
         try {
            wsTask.stream.write(Buffer.from(message));
            return true;
         } catch (err) {
            console.log('[E] Error sending to WebSocket:', err);
            return false;
         }
      }
      return false;
   }

   getActiveWebSocketIds(entry = null) {
      return Object.keys(this.activeWebSockets).filter(id => {
         const wsTask = this.activeWebSockets[id];
         return !entry || wsTask.entry === entry;
      });
   }

   // Test endpoint for server-to-client messaging
   handleTestMessage() {
      return (stream, headers, opt) => {
         const message = opt.query.message || 'Test message from server';
         const entry = opt.query.entry || null;

         this.broadcastToWebSockets(message, entry);

         const activeConnections = this.getActiveWebSocketIds(entry);
         stream.respond({ ':status': 200, 'content-type': 'application/json' });
         stream.end(JSON.stringify({
            message: 'Broadcast sent',
            activeConnections: activeConnections.length,
            ids: activeConnections
         }));
      };
   }

   // HTTP2 bidirectional stream handler (alternative to WebSocket)
   handleBidirectionalStream() {
      return (stream, headers, opt) => {
         const entry = opt.path[0];
         if (!entry || !i_env.pub.multiple_entries.includes(entry)) {
            safeRespond(stream, { headers: { ':status': 404 }, body: 'Entry not found' });
            return;
         }

         console.log('[D] Bidirectional stream request for entry:', entry);

         // Accept the stream connection
         stream.respond({ ':status': 200, 'content-type': 'text/plain' });

         let id;
         for (id = http_max_id+1; id < ws_max_id && this.task[id]; id++);
         if (id === ws_max_id) {
            stream.end('Rate limit exceeded');
            return;
         }

         const task = {
            ts: new Date().getTime(),
            id,
            stream,
            entry,
            path: '/' + opt.path.slice(1).join('/'), // Reconstruct path
            type: 'bidirectional'
         };

         this.task[id] = task;
         this.activeWebSockets[id] = task; // Track for broadcasting

         console.log('[D] Bidirectional stream established, ID:', id);

         // Send welcome message
         stream.write('1 Bidirectional stream connected. Server can send messages too!\n');

         // Handle incoming data from client
         stream.on('data', (data) => {
            const message = data.toString().trim();
            console.log('[D] Received from client:', message);

            // Echo the message back with server prefix
            stream.write(`1 Server received: ${message}\n`);

            // Optionally forward to backend service via sub
            if (!this.taskQueue[entry]) {
               this.taskQueue[entry] = [];
            }
            this.taskQueue[entry].push({
               id,
               mode: 'stream',
               data: data.toString('base64'),
               path: task.path
            });
         });

         stream.on('close', () => {
            console.log('[D] Bidirectional stream closed:', id);
            delete this.task[id];
            delete this.activeWebSockets[id];
         });

         stream.on('error', (err) => {
            console.log('[E] Bidirectional stream error:', err);
            delete this.task[id];
            delete this.activeWebSockets[id];
         });

         // Send periodic server messages to demonstrate server-to-client capability
         const messageInterval = setInterval(() => {
            if (!stream.destroyed) {
               const timestamp = new Date().toISOString();
               stream.write(`1 Server heartbeat at ${timestamp}\n`);
            } else {
               clearInterval(messageInterval);
            }
         }, 5000);
      };
   }
}

module.exports = {
   Bridge,
};
