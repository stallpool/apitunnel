const i_path = require('path');

module.exports = {
   debug: !!process.env.TINY_DEBUG,
   server: {
      host: process.env.TINY_HOST || '127.0.0.1',
      port: parseInt(process.env.TINY_PORT || '5001'),
      http2CertDir: process.env.HTTP2_CERT_DIR || i_path.resolve(__dirname, '../certs'),
   },
   pub: {
      http_client_max: 10000000,
      salt: process.env.PUB_SALT,
      token: process.env.PUB_TOKEN,
      multiple_entries: process.env.PUB_API ? process.env.PUB_API.split(',') : ['pub'],
      ratelimit: process.env.PUB_RATELIMIT ? parseInt(process.env.PUB_RATELIMIT) : Infinity,
   },
};
