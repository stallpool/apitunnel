module.exports = {
   sub: {
      pub_url: process.env.PUB_URL,
      pub_token: process.env.PUB_TOKEN,
      ws_client_max: parseInt(process.env.MAX_WS_N || '10'),
      config_path: process.env.SUB_CONFIG,
   },
};
