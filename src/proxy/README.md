# TinyChat Proxy

Socket.IO proxy that lets a TinyChat server running behind NAT (or at home) be reached by
**ponydriland.com** over **HTTPS**.

The website only accepts `https://` connections, so the proxy is the shortcut: it keeps a persistent
outbound connection to the public proxy and forwards the traffic to your local server. No port
forwarding, no certificate to manage.

## How it works

```
Browser  ──HTTPS──▶  ponydriland.com  ──▶  proxy (public)  ◀──outbound──  tiny-chat proxy  ──▶  tiny-chat server
```

The proxy opens an **outbound** connection, so it works behind NAT, CGNAT and dynamic IPs.

## Running

```bash
# From the repository root
yarn dev:proxy

# or through the unified launcher
tiny-chat-all --app proxy
```

On the first run the proxy creates `tiny-chat_proxy/` next to the executable and copies
[`proxy-config.ini`](./proxy-config.ini) into it.

The proxy also answers `-h`/`--help` and `-v`/`--version`.

## Configuration

| Section | Key | Default | Description |
| --- | --- | --- | --- |
| `server` | `port` | `35422` | Port the proxy listens on |
| `server` | `auth` | `test` | Shared secret. Must match the server `proxy.auth` |
| `server` | `timeout` | `30000` | Connection timeout (ms) |
| `server` | `debug` | `false` | Logs every forwarded event |

Every value can be overridden from the command line:

```bash
node src/launcher.js --app proxy --set server.port=8080 --set server.debug=true
```

## Connecting the server to the proxy

In the **server** `config.ini`, point `proxy.address` to the public proxy and use the same `auth`:

```ini
[proxy]
address=https://your-proxy-host
; address=null   ; disables the proxy (default)
auth=test
```

When `address` is `null` the proxy client is not started at all.

## Events

The proxy logs the lifecycle of every connection:

| Log | Meaning |
| --- | --- |
| `Server Online: <port>` | The proxy is listening |
| `Server connected` / `Server disconnected` | A TinyChat server attached/detached |
| `User connected` / `User disconnected` | A browser connected/disconnected |
| `Timeout` | The connection was idle for longer than `server.timeout` |
| `Debug: <event>` | Only when `server.debug = true` |
