# apitunnel (Go)

Go port of apitunnel: the `pub` server (`cmd/pub`) and the `sub` subscriber
(`cmd/sub`). The sub<->pub channel uses **SSE + HTTP POST** only — no
websocket.

Build & run:

```
cd apitunnel/apipsub
go build ./...

# pub
go run ./cmd/pub
# or
go build -o bin/pub ./cmd/pub

# sub
go run ./cmd/sub
# or
go build -o bin/sub ./cmd/sub
```

## Endpoints

| Method | Path           | Purpose                                            |
| ------ | -------------- | -------------------------------------------------- |
| GET    | `/ping`        | health check, returns `pong`                       |
| GET    | `/sub/<entry>` | subscriber connects; pub pushes tasks via SSE      |
| POST   | `/sub/<entry>` | subscriber posts bridged responses back            |
| ANY    | `/<entry>/...` | client request; bridged to a registered subscriber |

`<entry>` comes from `PUB_API` (comma separated; default `pub`).

## Environment variables

| Variable          | Default      | Meaning                                                    |
| ----------------- | ------------ | ---------------------------------------------------------- |
| `TINY_DEBUG`      | -            | debug flag (reserved)                                      |
| `TINY_HOST`       | `127.0.0.1`  | listen host                                                |
| `TINY_PORT`       | `5001`       | listen port                                                |
| `TINY_HTTPS_CA_DIR` | -          | directory with `ca.crt` / `ca.key` to serve HTTPS          |
| `PUB_API`         | `pub`        | comma separated api entries                                |
| `PUB_SALT`        | -            | HMAC salt for token auth                                   |
| `PUB_TOKEN`       | -            | pub token; enables subscriber auth when set                |
| `PUB_RATELIMIT`   | unlimited    | max in-flight bridged requests (HTTP 429 above this)       |

Compared to the JS pub: `PUB_WS` and `MAX_WS_N` are removed (no websocket
support anywhere; the tunnel is SSE + HTTP POST only).

## Sub

The sub connects to the pub over SSE and bridges client http requests to the
backends named in its `config.json`, posting the responses back to the pub.
It reconnects automatically (every 10s) if the stream drops.

Environment variables:

| Variable     | Default | Meaning                                                            |
| ------------ | ------- | ------------------------------------------------------------------ |
| `PUB_URL`    | -       | pub subscriber endpoint, e.g. `http://pub:5001/sub/pub` (a legacy `ws://` value is auto-normalized to `http://`) |
| `PUB_TOKEN`  | -       | raw pub token; required when `PUB_TOKEN` is set on the pub         |
| `SUB_CONFIG` | -       | path to `config.json` with url templates                           |
| `SUB_LB`     | -       | `roundrobin` / `idbind`; honored by the first sub of the entry     |
| `SUB_LB_N`   | `1`     | max subscribers for the entry load balancer                        |
| `TINY_DEBUG` | -       | debug flag (reserved)                                              |

`config.json` maps a request path to a backend url. A request to
`/<entry>/<region>/<site>/<remain...>` is rendered from
`tunnel.http[<region>].url`, which may contain `&<region>`, `&<site>` and
`&<remain>`:

```json
{
  "tunnel": {
    "http": {
      "test": { "url": "http://&<site>.&<region>.local/&<remain>" }
    }
  }
}
```

So `GET /pub/test/blog/this-is-a-test` reaches
`http://blog.test.local/this-is-a-test`. The file is reloaded automatically
when its mtime changes.

## Sub protocol (SSE)

### Connect

```
GET /sub/<entry>?lb=roundrobin&lb_n=3&token=<raw-token>
```

- Response is `text/event-stream`; each task arrives as one `data:` event.
- `token` is only required when `PUB_TOKEN` is set; it can also be sent as
  the `X-Pub-Token` header. The query param works with browser `EventSource`,
  which cannot set custom headers.
- `lb` / `lb_n` are honored by the **first** subscriber of an entry, like the
  JS pub: `roundrobin` (one request, one sub) or `idbind` (one request id,
  one sub). Without `lb` only one subscriber is allowed per entry.
- If the entry has no empty slot the connection is rejected with 503.
- Keep-alive: pub sends an SSE comment (`: ping`) every 15s.

### Task message (pub -> sub, SSE `data:` JSON)

```json
{
  "type": "req",
  "id": 1,
  "method": "POST",
  "uri": "/pub/<region>/<site>/<remain>?a=1",
  "data": "<base64 body, null for GET/HEAD/...>",
  "headers": { "content-type": "application/json" }
}
```

The sub renders the target url from the path (see `sub/config.js`) and
executes the request. Bodies larger than 10K are rejected by pub (400).

### Response message (sub -> pub, POST body JSON)

With a response body:

```json
{
  "type": "res",
  "id": 1,
  "headers": { "content-type": "text/plain" },
  "data": "<base64 body>"
}
```

Or just a status code:

```json
{ "type": "res", "id": 1, "code": 500 }
```

`content-length` (if present) is corrected by pub to the actual body length.
Bridged requests unanswered within 10s get `504`.

## Token auth

When `PUB_TOKEN` is set, a sub's raw token is accepted iff

```
hex(HMAC-SHA512(PUB_SALT, rawToken)) == hex(HMAC-SHA512(PUB_SALT, PUB_TOKEN))
```

(same check as the legacy JS pub, so the same `PUB_TOKEN`/`PUB_SALT` pair
works).
