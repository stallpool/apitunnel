module.exports = {
   debug: !!process.env.TINY_DEBUG,
   server: {
      host: process.env.TINY_HOST || '127.0.0.1',
      port: parseInt(process.env.TINY_PORT || '5001'),
      httpsCADir: process.env.TINY_HTTPS_CA_DIR?i_path.resolve(process.env.TINY_HTTPS_CA_DIR):null,
   },
   pub: {
      ws_enable: !!process.env.PUB_WS,
      ws_client_max: parseInt(process.env.MAX_WS_N || '10'),
      salt: process.env.PUB_SALT,
      token: process.env.PUB_TOKEN,
   },
};
