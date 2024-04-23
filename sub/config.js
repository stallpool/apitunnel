const i_fs = require('fs');
const i_env = require('./env');

/*
   example config.json
   the `url` can have common string or expandable vars like &<site>, &<region> and &<remain>
   it comes from `pubserver/pub/<region>/<site>/<...remain>`
   {
      "tunnel": {
         "http": { "test": { "url": "http://&<site>.&<region>.local/&<remain>" } },
         "websocket": { "wstest": { "url": "ws://&<region>.local/" } },
      }
   }

   for example, if visit `pubserver/pub/test/blog/this-is-a-test/test`,
   it will be rendered as `http://blog.test.local/this-is-a-test/test`
                                  ^site^region    ^remain
*/

const env = {
   subconfig: i_env.sub.config_path,
};

const config = {
   ts: -1,
   data: {},
};

function getRawConfig() {
   return config.data;
}

function renderUrl(mode, region, site, remain) {
   const obj = config.data?.tunnel?.[mode]?.[region];
   if (!obj || !obj.url) return null;
   let expand = false;
   return obj.url.split('&<').map(z => {
      if (expand) {
         const i = z.indexOf('>');
         if (i < 0) return '';
         switch (z.substring(0, i)) {
         case 'region': return region + z.substring(i+1);
         case 'site': return site + z.substring(i+1);
         case 'remain': return remain + z.substring(i+1);
         default: return z.substring(i+1);
         }
      } else {
         expand = true;
         return z;
      }
   }).join('');
}

function readConfig(filename) {
   i_fs.stat(filename, (err, stat) => {
      if (err) return;
      if (config.ts === stat.mtimeMs) return;
      i_fs.readFile(filename, (err, buf) => {
         if (err) return;
         config.ts = stat.mtimeMs;
         console.log(`[I] ${new Date().toISOString()} update config: ${env.subconfig}`);
         try {
            const json = JSON.parse(buf);
            config.data = json;
         } catch(_) { }
      });
   });
}

function startWatchConfigFile() {
   if (!env.subconfig) return;
   readConfig(env.subconfig);
   setTimeout(startWatchConfigFile, 1000);
}

module.exports = {
   startWatchConfigFile,
   readConfig,
   getRawConfig,
   renderUrl,
};
