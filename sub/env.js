module.exports = {
   sub: {
      pub_url: process.env.PUB_URL,
      pub_token: process.env.PUB_TOKEN,
      config_path: process.env.SUB_CONFIG,
      lb: process.env.SUB_LB,
      lb_n: parseInt(process.env.SUB_LB_N || '1'),
   },
};
