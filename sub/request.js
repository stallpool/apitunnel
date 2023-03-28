const i_url = require('url');
const i_http = require('http');
const i_https = require('https');

async function download(url, options) {
   return new Promise((resolve, reject) => {
      options = Object.assign({}, options);
      if (!options.timeout) options.timeout = 20000 /*ms*/;
      const payload = options.payload;
      if (payload) delete options.payload;

      // rebuild url
      const urlObj = i_url.parse(url);
      const parts = url.split('//');
      const protocol = urlObj.protocol;
      if (!protocol) {
         return reject(url);
      }
      const lib = protocol === 'http:'?i_http:i_https;
      const obj = {};
      obj.url = url;
      const req = lib.request(url, options, (res) => {
         switch (res.statusCode) {
            case 301: case 302: case 304: case 307:
               obj.redirect = res.headers['location'];
               if (!obj.redirect) return reject(obj);
               if (obj.redirect.startsWith('//')) {
                  obj.redirect = `${protocol}${obj.redirect}`;
               } else if (obj.redirect.indexOf('://') < 0) {
                  obj.redirect = i_url.resolve(url, obj.redirect);
               }
               resolve(obj);
               return;
            case 200: case 201: case 204:
               obj.contentType = res.headers['content-type'] || 'application/octet-stream';
               obj.headers = Object.assign({}, res.headers);
               let bufs = [];
               res.on('data', (data) => {
                  // TODO: limit buf size
                  bufs.push(data);
               });
               res.on('end', async () => {
                  obj.buf = Buffer.concat(bufs);
                  resolve(obj);
               });
               res.on('error', (err) => {
                  stream.close();
                  obj.error = true;
                  obj.details = err;
                  reject(obj);
               });
               return;
            case 404:
               if (url.endsWith('/index.html')) {
                  obj.redirect = url.substring(0, url.lastIndexOf('/') + 1);
                  resolve(obj);
                  return;
               }
               break;
         }
         obj.statusCode = res.statusCode;
         obj.error = true;
         reject(obj);
      });
      req.on('error', (err) => {
         obj.error = true;
         obj.details = err;
         reject(obj);
      });
      if (payload) {
         try {
            JSON.parse(payload);
            req.setHeader('content-type', 'application/json');
         } catch (err) {}
         req.write(payload);
      }
      req.end();
   });
}

module.exports = {
   download,
};
