# TinyChat Server

**TinyChat** is a lightweight roleplay/RPG room server with real-time messaging, dice, room-level
permissions, a synchronized music player and AI support, designed for integration with the
PonyDriland website.
The project is currently in **beta**, but it is **fully available for free download and testing**.

TinyChat aims to provide a simple, modular, and efficient environment for real-time interactions in
roleplay scenarios. Even though it is still under active development, all core features are
functional and ready for community feedback.

## 🔧 Status

- **Version:** Beta
- **Availability:** Free to download, use, and test
- **Stability:** Mostly stable, but some features may still be refined or expanded
- **Node.js:** `>= 20`

## ✨ Features

- **Real-time rooms** over Socket.IO (join, leave, kick, ban, per-room moderators)
- **Read-only guests** — every account joins as a guest and needs an explicit permission to talk
- **Chapters** — a room can be split into multiple chapters of history
- **Dice** with custom skins, modifiers and a full roll history
- **Synchronized music player** — playlists (YouTube / audio file) shared by the whole room
- **AI support** — messages can be flagged as model output, with `model`, `tokens` and `errorCode`
- **Safety backup** — deleted messages go to `historyDeleted` and can be restored
- **SQLite 3 or PostgreSQL** as the database
- **Archive CLI** to export, import, restore and repair the history from the terminal

## 🚀 Quick start

```bash
# 1. Install the dependencies
yarn install

# 2. Start the server (creates tiny-chat_data/ on the first run)
yarn dev

# 3. In another terminal, start the optional HTTPS proxy
yarn dev:proxy
```

The server reads `tiny-chat_data/config.ini` (created from
[`src/server/config.ini`](src/server/config.ini) on the first run). The most important keys are:

| Section | Key | Description |
| --- | --- | --- |
| `server` | `port` | Socket.IO port (default `35421`) |
| `server` | `registration_open` | Allow anyone to register |
| `server` | `public_rooms` | Let every account list every room |
| `server` | `load_all_history` | Allow loading the whole history at once |
| `database` | `type` | `sqlite3` or `postgre` |
| `genesis` | `owner_id` / `owner_password` | Initial server owner |
| `limits` | * | Sizes, rate limits and dice limits |

Every value can be overridden from the command line:

```bash
node src/launcher.js --set server.port=8080 --set database.type=postgre
```

## 🧩 Entry points

| Command | Description |
| --- | --- |
| `yarn dev` | Starts the chat server (Babel, no build step) |
| `yarn dev:proxy` | Starts the Socket.IO proxy |
| `yarn build` | Bundles the standalone binaries with esbuild + nexe |
| `yarn test` | Runs the test suite (`node --test`) |
| `yarn test:watch` | Runs the test suite in watch mode |

A single launcher can also start any mode:

```bash
tiny-chat-all --app server
tiny-chat-all --app proxy
tiny-chat-all --app archive rooms
```

## 📚 Documentation

| Document | Contents |
| --- | --- |
| [`src/server/README.md`](src/server/README.md) | Server overview and configuration |
| [`src/server/connection/userManager.md`](src/server/connection/userManager.md) | `login`, `register`, `ban`, staff, account settings |
| [`src/server/connection/roomManager.md`](src/server/connection/roomManager.md) | Rooms, moderation, permissions, settings |
| [`src/server/connection/messageManager.md`](src/server/connection/messageManager.md) | Messages, history, dice and purge |
| [`src/server/connection/playerManager.md`](src/server/connection/playerManager.md) | Playlists and the synchronized music player |
| [`src/proxy/README.md`](src/proxy/README.md) | Socket.IO proxy |
| [`docs/jami-hosting.md`](docs/jami-hosting.md) | Hosting from home with Jami Shared services |
| [`docs/tiny-chat-archive-cli.md`](docs/tiny-chat-archive-cli.md) | Archive CLI (export, import, restore, trash) |

## 📦 Chat Archive CLI

Backup, migrate and edit your chat history from the terminal — export any room chapter to a plain
JSON file and import it back, with interactive room/chapter selection.

```bash
./build/tiny-chat-archive-cli.js rooms
./build/tiny-chat-archive-cli.js export --room lobby --chapter all --file lobby.json
./build/tiny-chat-archive-cli.js import --room lobby --chapter 2 --file lobby.json
./build/tiny-chat-archive-cli.js restore --room lobby --limit 25
./build/tiny-chat-archive-cli.js trash list --room lobby
./build/tiny-chat-archive-cli.js reset-password --user admin
./build/tiny-chat-archive-cli.js migrate-usernames --dry-run
```

📖 **[Full documentation →](docs/tiny-chat-archive-cli.md)**

## 🌐 Hosting requirements (PonyDriland)

The website **ponydriland.com** will only accept connections from servers hosted using **HTTPS**.
If your TinyChat server is running locally at home, you may use the built-in **proxy** as a
shortcut to securely expose your database through an HTTPS-enabled tunnel.

### Hosting from home with Jami (no port forwarding)

If you just want to play with your friends, you do not need a public IP, a domain or a certificate.
Grab the ready-to-run binary from the [**Releases**](https://github.com/Pony-Driland/TinyChat-Server/releases)
page (no Node.js required), run it on your own machine and share it through
**[Jami](https://jami.net/) Shared services**:

1. Start TinyChat and keep the default port `35421`.
2. In Jami, open **Settings → Shared services** and share the local port `35421`.
3. Enable **“Use local port as preferred ports on peers”** so your friends do not need to configure
   anything on their side.
4. Your friends open the official **PonyDriland** website and connect to your server from there —
   the browser will ask for permission to reach `http://localhost:35421`, which is expected.

📖 **[Full Jami hosting guide →](docs/jami-hosting.md)**

## 🗄️ Database

TinyChat supports two backends, selected with `database.type`:

| Type | Notes |
| --- | --- |
| `sqlite3` | Zero configuration, stored in `tiny-chat_data/database.db` |
| `postgre` | Uses `user`, `host`, `database`, `password` and `port` from the `[database]` section |

The schema is created and migrated automatically on boot. Tables:
`rooms`, `roomTokens`, `roomHash`, `roomModerators`, `roomMembers`, `roomBannedUsers`,
`roomPermissions`, `history`, `historyDeleted`, `diceHistory`, `users`, `usersDice`, `moderators`,
`banned`, `privateRoomData`, `roomData`, `rpgSchema`, `roomPlaylists`, `roomPlaylistRooms`,
`roomPlayer`, `audit`.

## 📥 Download & Usage

You can freely download the project and start testing it right away.
Feedback, bug reports, and suggestions are welcome to help improve TinyChat during the beta cycle.

## 🧩 About the Project

TinyChat was built to support:

- Roleplay/RPG chat rooms
- AI support
- Real-time messaging
- Lightweight server performance

---

## 💡 Credits

> 🧠 **Note**: This documentation was written by [DeepSeek v4.1 Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash), based on the project structure and descriptions provided by the repository author.  
> If you find any inaccuracies or need improvements, feel free to contribute or open an issue!
