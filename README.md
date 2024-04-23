# apitunnel

### How to use

- create `./config.json`; see also the format at `sub/config.js`
```
#   example config.json
#   the `url` can have common string or expandable vars like &<site>, &<region> and &<remain>
#   it comes from `pubserver/pub/<region>/<site>/<...remain>`
#   {
#      "tunnel": {
#         "http": { "test": { "url": "http://&<site>.&<region>.local/&<remain>" } },
#         "websocket": { "wstest": { "url": "ws://&<region>.local/" } },
#      }
#   }
#
#   for example, if visit `pubserver/pub/test/blog/this-is-a-test/test`,
#   it will be rendered as `http://blog.test.local/this-is-a-test/test`
#                                  ^site^region    ^remain
```

- run pub: `node pub/index.js`
  - `PUB_TOKEN` + `PUB_SALT` can enable token auth for authenticating sub instances
  - `PUB_WS=1` can enable websocket support
  - `PUB_API=name1,name2,...` can register different api entries; by default there is only entry of "pub"; for example, "pub" will have restful entry at "/pub" and websocket entry at "/wspub"

- run sub: `PUB_URL=ws://pubserver/sub/<entry> SUB_CONFIG=./config.json node sub/index.js`
  - `PUB_LB`: how to deal with load balance; `roundrobin` and `idbind`
    - `roundrobin`: one request, one sub instance
    - `idbind`: one request id, one sub instance; all websocket uses idbind no matter `PUB_LB`'s value
    - by default, no load balance; only one sub instance can register for a specific channel
  - `PUB_LB_N`: how many max sub instances can registered for the specific channel

- try `curl 'http://pubserver/pub/region/site/helloworld?a=1'` to visit the target service from pub via http
- try websocket client to connect to `ws://pubserver/wspub/region` to visit the target service from pub via websocket

- `webpack` can pack pub/sub as standalone JS files as `dist/pub.js` and `dist/sub.js` respectively

