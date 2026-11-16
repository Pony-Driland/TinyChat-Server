# TinyChat Server

**TinyChat** is a lightweight roleplay/RPG room server designed for integration with the website.
The project is currently in **beta**, but it is **fully available for free download and testing**.

TinyChat aims to provide a simple, modular, and efficient environment for real-time interactions in
roleplay scenarios. Even though it is still under active development, all core features are
functional and ready for community feedback.

## 🔧 Status

- **Version:** Beta
- **Availability:** Free to download, use, and test
- **Stability:** Mostly stable, but some features may still be refined or expanded
- **Runtime:** Node.js `>= 20`

## 📥 Running the server

```bash
# From the repository root
yarn start
```

On the first run the server creates `tiny-chat_data/` next to the executable and copies
[`config.ini`](./config.ini) into it. The folder holds `config.ini` and `database.db` (SQLite).

```
tiny-chat_data/
├── config.ini
└── database.db
```

Every `config.ini` value can be overridden from the command line, which is handy for containers:

```bash
node src/launcher.js --set server.port=8080 --set database.type=postgre
```

## ⚙️ Configuration

| Section | Key | Default | Description |
| --- | --- | --- | --- |
| `server` | `port` | `35421` | Socket.IO port |
| `server` | `registration_open` | `false` | Allow anyone to register |
| `server` | `public_rooms` | `false` | Let every account list every room |
| `server` | `load_all_history` | `false` | Allow loading the whole history at once |
| `proxy` | `address` / `auth` | `null` / `test` | Optional proxy tunnel |
| `genesis` | `owner_id` / `owner_password` | `admin` | Initial server owner |
| `database` | `type` | `sqlite3` | `sqlite3` or `postgre` |
| `limits` | * | — | Sizes, rate limits and dice limits |

### `[limits]`

The `limits` section drives every validation and rate limit. The most relevant keys:

| Key | Description |
| --- | --- |
| `MESSAGE_SIZE` | Maximum message length |
| `USER_ID_SIZE` / `NICKNAME_SIZE` | Account field sizes |
| `PASSWORD_SIZE` / `MIN_PASSWORD_SIZE` | Password hashing window and minimum length |
| `ROOM_ID_SIZE` / `ROOM_TITLE_SIZE` | Room field sizes |
| `ROOM_PROMPT` / `ROOM_SYSTEM_INSTRUCTION` / `ROOM_FIRST_DIALOGUE` | AI room fields |
| `MODEL_ID_SIZE` | Model identifier size |
| `HISTORY_SIZE` | Page size of `load-messages` |
| `MAX_USERS_PER_ROOM` / `MAX_ONLINE_ACCOUNTS` | Capacity |
| `MESSAGES`, `MESSAGES_EDIT`, `MESSAGES_DELETE`, `MESSAGES_LOAD`, `ROOM_UPDATES`, `DICE_ROLLS`, `EVENT` | Rate limits |
| `RATE_LIMIT_TIME` | Rate limit window (ms) |
| `DICE_*` | Dice amount, sides and skin sizes |

## 🗄️ Database

| Type | Notes |
| --- | --- |
| `sqlite3` | Zero configuration, `tiny-chat_data/database.db` |
| `postgre` | Uses `user`, `host`, `database`, `password` and `port` |

The schema is created and migrated automatically on boot. Tables:

`rooms`, `roomTokens`, `roomHash`, `roomModerators`, `roomMembers`, `roomBannedUsers`,
`roomPermissions`, `history`, `historyDeleted`, `diceHistory`, `users`, `usersDice`, `moderators`,
`banned`, `privateRoomData`, `roomData`, `rpgSchema`, `audit`.

## 🧱 Source layout

| File | Responsibility |
| --- | --- |
| [`index.js`](./index.js) | Bootstraps the database, the Socket.IO server and the optional proxy |
| [`appStorage.js`](./appStorage.js) | Creates the data folder and loads `config.ini` |
| [`connection/sql.js`](./connection/sql.js) | Schema, migrations and the `puddySQL` instance |
| [`connection/values.js`](./connection/values.js) | Sessions, roles, rate limits and shared helpers |
| [`connection/userManager.js`](./connection/userManager.js) | Authentication, accounts, staff and moderation |
| [`connection/roomManager.js`](./connection/roomManager.js) | Rooms, membership, permissions and settings |
| [`connection/messageManager.js`](./connection/messageManager.js) | Messages, history, dice and purge |
| [`connection/stream.js`](./connection/stream.js) | Splits large payloads before broadcasting |

## 🔐 Roles

| Role | How it is granted | Can talk |
| --- | --- | --- |
| `owner` | Server owner or `rooms.ownerId` | ✅ |
| `moderator` | Row in `moderators` or `roomModerators` | ✅ |
| `member` | Row in `roomPermissions` | ✅ |
| `guest` | Default for every account that joins | ❌ |

Every account joins a room as a **read-only guest**. The room owner must call
`room-grant-permission` before the account can send messages or roll dice.

## 📚 API documentation

- [`connection/userManager.md`](./connection/userManager.md) — `login`, `register`, `ban`, staff, account settings
- [`connection/roomManager.md`](./connection/roomManager.md) — rooms, moderation, permissions, settings
- [`connection/messageManager.md`](./connection/messageManager.md) — messages, history, dice, purge
- [`../../docs/tiny-chat-archive-cli.md`](../../docs/tiny-chat-archive-cli.md) — archive CLI

## 🧩 About the Project

TinyChat was built to support:

- Roleplay/RPG chat rooms
- AI support
- Real-time messaging
- Lightweight server performance
