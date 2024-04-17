# apitunnel

```
edit `build` function in sub/index.js

node pub/index.js
PUB_URL=ws://pubserver/sub node sub/index.js

curl 'http://pubserver/pub/region/site/helloworld?a=1'

# PUB_WS to enable websocket tunnel
PUB_WS=1 node pub/index.js

# edit config.json for sub; see also sub/config.js for format
PUB_URL=ws://pubserver/sub SUB_CONFIG=./config.json node sub/index.js

# run websocket server for example at ws://wss
# register ws://wss in sub/index.js
# run websocket client to connect to for example ws://pubserver/wspub/wss

# PUB_TOKEN + PUB_SALT to enable token auth
```
