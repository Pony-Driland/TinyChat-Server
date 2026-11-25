# Hosting TinyChat locally with Jami

This guide shows how to host TinyChat **on your own machine** and let your friends connect to it
**without a public IP, port forwarding or a domain name**, using the [Jami](https://jami.net/)
application and its **Shared services** feature.

It is the easiest option when you just want to play with your friends: no VPS, no DNS and no TLS
certificate.

## How it works

```
Friend's browser ──HTTPS──▶ ponydriland.com
                                   │
                          (asks permission to reach
                           http://localhost:35421)
                                   │
                                   ▼
                    Jami "Shared services" tunnel
                                   │
                                   ▼
                     your machine ──▶ TinyChat :35421
```

1. TinyChat listens on `localhost` on your machine (default port `35421`).
2. Jami exposes that local port through its **Shared services** (a peer-to-peer tunnel).
3. Your friends open the official **Pony Driland** website and connect to your server.
4. The website runs on `https://` and talks to `http://localhost:<port>` on the visitor's machine,
   where Jami is listening and forwarding the traffic to you.

Because the browser is asked to reach a **local address** from an **HTTPS page**, it shows a
permission prompt (local network access). Your friends only need to accept it once.

## 1. Get TinyChat running

You do not need Node.js or any build tooling: download the ready-to-run binary from the
[**Releases**](https://github.com/Pony-Driland/TinyChat-Server/releases) page and start it. The
archive contains the launcher for your platform.

If you prefer to run from source instead:

```bash
# From the repository root
yarn install
yarn dev
```

On the first run the server creates `tiny-chat_data/config.ini`. Keep the default port (`35421`) or
pick another one:

```ini
[server]
port=35421
```

> **Important:** there is no need to expose the server on your network. Jami is the only thing that
> needs to reach it, and it runs on the same machine.

## 2. Install Jami and enable Shared services

1. Install [Jami](https://jami.net/download/) on the machine that runs TinyChat.
2. Open **Settings → Shared services** (in some versions: **Settings → General → Shared services**).
3. Enable **Share local services** / **Enable shared services**.
4. Add a new service pointing to the TinyChat port:

   | Field | Value |
   | --- | --- |
   | Name | `TinyChat` (anything you want) |
   | Local port | `35421` (the `server.port` from `config.ini`) |

5. **Recommended:** enable **“Use local port as preferred ports on peers”**.

### Why “Use local port as preferred ports on peers”?

With this option enabled, Jami tries to reuse the **same port number on the peer side**. That means
your friends do not need to configure anything: the address the browser uses
(`http://localhost:35421`) is the same one Jami listens on for them, so the connection “just works”
on the first try. Without it, Jami may pick a random port on each peer and your friends would have to
discover and type it manually.

## 3. Let your friends in

1. Your friends install Jami and add you as a contact (or you add them) — the tunnel only exists
   between peers that know each other.
2. They open the official **Pony Driland** website.
3. On the server selection screen they choose to connect to a **local server**.
4. The browser asks for permission to access the local network / connect to `localhost` — they must
   **allow** it.
5. TinyChat loads straight from your machine. 🎉

## Why does the browser ask for permission?

The Pony Driland website is served over **HTTPS**, and browsers require an explicit permission before
an `https://` page talks to a local address. This is expected and safe here: the request never leaves
the visitor's computer, it goes to the Jami tunnel running on `localhost`.

Browsers treat `http://localhost` as a **secure context**, which is exactly why this setup works
without any certificate. Just accept the prompt once and the browser remembers it for the site.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| The page cannot reach the server | Check that TinyChat is still running and that the port in Jami matches `server.port` |
| Friends connect but the port differs | Enable **“Use local port as preferred ports on peers”** in Jami |
| The browser blocks the connection | Allow local network access for the site (icon in the address bar) and reload |
| Works for you, not for friends | Make sure the Jami conversation is accepted on both sides — the tunnel only exists between accepted contacts |
| Connection drops when the computer sleeps | Jami keeps the tunnel only while the app is running; disable sleep or use a machine that stays on |

## Alternatives

If you prefer a public address instead of a peer-to-peer tunnel, see the built-in
[Socket.IO proxy](../src/proxy/README.md), which keeps an outbound connection to a public proxy and
does not require Jami at all.
