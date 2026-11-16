# 📦 Chat Archive CLI

Command line tool to **export** and **import** the TinyChat conversation history using a simple, readable JSON file.

Use it when you need to:

- **Back up** a room or chapter
- **Migrate** conversations between servers/databases
- **Edit** messages in bulk in your favorite editor
- **Import** an already written script/roleplay

---

## 📑 Table of Contents

- [Installation](#-installation)
- [Quick start](#-quick-start)
- [File format](#-file-format)
- [Commands](#-commands)
  - [rooms](#rooms)
  - [chapters](#chapters)
  - [export](#export)
  - [import](#import)
  - [restore](#restore)
  - [trash](#trash)
- [Interactive selection](#-interactive-selection)
- [Import modes](#-import-modes)
- [Global options](#-global-options)
- [Recipes](#-recipes)
- [Troubleshooting](#-troubleshooting)

---

## 🚀 Installation

The CLI is a single file at [`build/tiny-chat-archive-cli.js`](../build/tiny-chat-archive-cli.js) and **requires no build step**.

### Option 1 — Straight from the repository

```bash
node build/tiny-chat-archive-cli.js --help
```

### Option 2 — Executable (recommended)

The file already has the *shebang* and the execution permission:

```bash
./build/tiny-chat-archive-cli.js --help
```

### Option 3 — Global command (`tiny-rpg-chat-archive`)

`package.json` already declares the binary, so just link it:

```bash
npm link

tiny-rpg-chat-archive --help
```

### Option 4 — npm shortcuts

```bash
yarn chat:rooms
yarn chat:chapters --room lobby
yarn chat:export --room lobby --chapter all --file lobby.json
yarn chat:import --room lobby --chapter 2 --file lobby.json
```

> **Requirements:** Node.js 20+ and the dependencies installed (`yarn install`).

---

## ⚡ Quick start

```bash
# 1. See which rooms exist
tiny-rpg-chat-archive rooms

# 2. See the chapters of a room
tiny-rpg-chat-archive chapters --room lobby

# 3. Export everything to a file
tiny-rpg-chat-archive export --room lobby --chapter all --file lobby.json

# 4. Import it into another server, in chapter 2
tiny-rpg-chat-archive import --room lobby --chapter 2 --file lobby.json
```

---

## 📄 File format

The JSON is an **array of messages**:

```json
[
  {
    "message": "Hello, world!",
    "time": 1730419200000,
    "id": "8f14e45fceea167a5a36dedd4bea2543",
    "user": "admin"
  }
]
```

| Field | Type | Required | Description |
|---|---|---|---|
| `message` | `string` | ✅ | Message text |
| `time` | `number` | ✅ | Timestamp in **milliseconds** (`Date.now()`) |
| `id` | `string` | ➖ | Message ID. If missing, a random one is generated |
| `user` | `string` | ✅ | Author ID |
| `chapter` | `number` | ➖ | Only used on import with `--chapter all` |
| `isModel` | `boolean` | ➖ | Marks the message as AI generated |
| `model` | `string` | ➖ | Model that produced the message |
| `hash` | `string` | ➖ | Content hash stored by the server |
| `edited` | `number` | ➖ | Last edit timestamp (`0` when never edited) |
| `tokens` | `number` | ➖ | Token count reported by the model |
| `errorCode` | `string` | ➖ | Error code when the generation failed |

> **Tip:** the `id` field is what prevents duplicates. Keep it when editing the file by hand.

### Optional metadata

Every column of the `history` table that is not part of the core format (`model`, `hash`,
`edited`, `tokens`, `errorCode` and `isModel`) is handled as **optional metadata**:

- **Export** writes them whenever the database has a value for the row.
- **Import** restores them when present and falls back to `NULL` otherwise.
- **`--minimal`** disables both sides, producing/consuming only `message`, `time`, `id` and
  `user` (plus `chapter` on import).

```bash
# Only the four core fields, both on export and on import
tiny-rpg-chat-archive export -r lobby -c 1 -f lobby.json --minimal
tiny-rpg-chat-archive import -r lobby -c 1 -f lobby.json --minimal
```

---

## 🛠️ Commands

### `rooms`

Lists every room in the database.

```bash
tiny-rpg-chat-archive rooms
tiny-rpg-chat-archive rooms --json   # script-friendly output
```

```
2 room(s) found:

  lobby - Main room (chapter 1)
  rpg   - Dungeon master's table (chapter 3)
```

---

### `chapters`

Lists the chapters of a room and how many messages each one has.

```bash
tiny-rpg-chat-archive chapters --room lobby
tiny-rpg-chat-archive chapters --room lobby --json
```

```
Chapters of "lobby":

    1) 73 message(s)
    2) 12 message(s)
```

---

### `export`

Exports one chapter (or all of them) to JSON.

```bash
tiny-rpg-chat-archive export [options]
```

| Option | Description |
|---|---|
| `-r, --room <id>` | Source room (asks if omitted) |
| `-c, --chapter <n\|all>` | Chapter or `all` (asks if omitted) |
| `-f, --file <path>` | Output file (default: `chat-<room>-<chapter>.json`) |
| `--compact` | JSON without indentation |
| `--minimal` | Exports only `message`, `time`, `id` and `user` |
| `--dry-run` | Only shows what would be done |

```bash
# Specific chapter
tiny-rpg-chat-archive export -r lobby -c 2 -f chapter2.json

# Everything in a single file
tiny-rpg-chat-archive export -r lobby -c all -f lobby-full.json
```

---

### `import`

Imports a JSON into a chapter.

```bash
tiny-rpg-chat-archive import [options]
```

| Option | Description |
|---|---|
| `-f, --file <path>` | **Required.** Input JSON file |
| `-r, --room <id>` | Target room (asks if omitted) |
| `-c, --chapter <n\|all>` | Target chapter. Accepts a new number |
| `-m, --mode <mode>` | `merge` (default), `replace` or `upsert` |
| `-y, --yes` | Do not ask for confirmation |
| `--minimal` | Ignores the optional metadata columns in the file |
| `--dry-run` | Validates and prints the summary without writing |

```bash
# Safe import: only adds what is missing
tiny-rpg-chat-archive import -r lobby -c 2 -f chapter2.json

# Replace the whole chapter
tiny-rpg-chat-archive import -r lobby -c 2 -f chapter2.json -m replace -y

# Simulate without writing
tiny-rpg-chat-archive import -r lobby -c 2 -f chapter2.json --dry-run
```

The file is **fully validated before** any write. If a single entry is invalid, nothing is imported and the CLI prints the index of the problem:

```
[fail] [3] has an invalid "user" (non-empty string expected).
[fail] The file contains invalid entries. Nothing was imported.
```

---

### `restore`

Brings messages back from the **`historyDeleted` safety backup** into the `history` table.

Every deletion in TinyChat copies the row to `historyDeleted` first, so this is the command you
want after an accidental delete, a bad moderation action or a failed purge.

```bash
tiny-rpg-chat-archive restore [options]
```

| Option | Description |
|---|---|
| `-r, --room <id>` | Room to restore into (asks if omitted) |
| `-n, --limit <n>` | Restore the **n newest** messages |
| `--dates <n>` | Restore every message from the **n most recent days** |
| `--all` | Restore the whole backup of the room |
| `--overwrite` | Replace rows that already exist in `history` |
| `--dry-run` | Print the report without writing |
| `-y, --yes` | Skip the confirmation (for scripts) |

```bash
# The 25 most recent deleted messages
 tiny-rpg-chat-archive restore -r lobby --limit 25

# Everything deleted in the last 7 days
 tiny-rpg-chat-archive restore -r lobby --dates 7

# The whole backup, replacing duplicated ids
 tiny-rpg-chat-archive restore -r lobby --all --overwrite
```

Before touching anything the CLI prints a **full report** of the consequences and asks you to type
`restore`:

```
───────────────────────────────────────────────────────────────────────────────
 RESTORE FROM SAFETY BACKUP
───────────────────────────────────────────────────────────────────────────────
  Room ................: lobby
  Messages affected ...: 2 of 6 in the backup
  Distinct dates ......: 2
  Date range ..........: 2026-11-15 → 2026-11-16
  Chapters ...........: 1 (2)
  Authors ............: 2
          1x alice
          1x bob
  Preview:
      2026-11-16  alice          deleted message number 0
      2026-11-15  bob            deleted message number 1
───────────────────────────────────────────────────────────────────────────────
  This action will:
    • Copy 2 message(s) from "historyDeleted" back to "history".
    • Remove the restored rows from the safety backup.
    • No id conflicts were found.
    • This is a write operation on the live database. Back it up first.
────────────────────────────────────────────────────────────────────────────────

Restore these messages?
  Type "restore" to continue:
```

The whole move runs inside a **single transaction**: either every selected message goes back to
`history` and leaves the backup, or nothing changes at all.

> 💡 Rows whose id already exists in `history` are **skipped** by default. Add `--overwrite` to
> replace them (useful after a partial import).

---

### `trash`

Manages the `historyDeleted` table itself. Use it to inspect the backup and to keep it from growing
forever.

```bash
tiny-rpg-chat-archive trash <list|purge|empty> [options]
```

| Action | Description |
|---|---|
| `list` | Read-only report of what the backup holds (default) |
| `purge` | **Permanently delete** the selected rows |
| `empty` | **Permanently delete** every row (of a room, or of every room) |

Selection flags are the same as `restore`: `--limit <n>`, `--dates <n>` and `--all`.

```bash
# What is in the backup?
tiny-rpg-chat-archive trash list -r lobby

# Drop everything older than the 30 most recent days
tiny-rpg-chat-archive trash purge -r lobby --dates 30

# Wipe the backup of a single room
tiny-rpg-chat-archive trash empty -r lobby

# Wipe the backup of EVERY room
tiny-rpg-chat-archive trash empty
```

`purge` asks you to type `delete` and `empty` asks you to type `DELETE EVERYTHING` (or the room id
when `--room` is used). There is **no undo**: the rows are gone from the database.

---

---

## 🎯 Interactive selection

Any omitted option becomes a question. This also works with piped input:

```bash
$ tiny-rpg-chat-archive export

Select a room:
    1) lobby (Main room)
    2) rpg (Dungeon master's table)

> 1

Select a chapter:
    1) Chapter 1 (73 messages)
    2) Chapter 2 (12 messages)
    A) All chapters (every chapter)

> A

[ ok ] Exported 85 message(s) to ./chat-lobby-all.json
```

```bash
# Same thing, no interaction
printf '1\nA\n' | tiny-rpg-chat-archive export
```

---

## 🔀 Import modes

| Mode | What it does | Use it when |
|---|---|---|
| **`merge`** | Inserts only what does not exist yet. Existing rows are ignored. | Restoring a backup without duplicates |
| **`replace`** | **Deletes** the target chapter before inserting. | The file is the source of truth |
| **`upsert`** | Inserts what is missing and **updates** what already exists. | You fixed the text of several messages |

> ⚠️ `replace` is destructive for the chosen chapter. Use `--dry-run` first in production.

---

## ⚙️ Global options

| Option | Description |
|---|---|
| `-d, --data-dir <path>` | Folder containing `config.ini` and `database.db` |
| `--json` | Machine-readable output, no prompts |
| `--minimal` | Only the four core fields (`message`, `time`, `id`, `user`) |
| `--dry-run` | Writes nothing |
| `-h, --help` | Help |
| `-v, --version` | Version |

### Where the database is looked up

Without `--data-dir`, the CLI tries, in order:

1. `$TINY_CHAT_DATA`
2. `./src/tiny-chat_data`
3. `./tiny-chat_data`
4. `tiny-chat_data` next to the executable

The database type comes from `database.type` in `config.ini` — **SQLite** and **PostgreSQL** are supported.

---

## 🍳 Recipes

### Daily backup of every room

```bash
#!/bin/bash
set -e
DATA=$(date +%Y-%m-%d)
mkdir -p backups

for ROOM in $(tiny-rpg-chat-archive rooms --json | node -pe 'JSON.parse(require("fs").readFileSync(0)).map(r=>r.roomId).join("\n")'); do
  tiny-rpg-chat-archive export -r "$ROOM" -c all -f "backups/$ROOM-$DATA.json"
 done
```

### Migrate a chapter between servers

```bash
# On the old server
tiny-rpg-chat-archive export -r lobby -c 3 -f migrate.json
scp migrate.json user@new-host:/srv/tinychat/

# On the new server
tiny-rpg-chat-archive import -r lobby -c 3 -f migrate.json -m merge
```

### Fix several messages at once

```bash
# 1. Export
tiny-rpg-chat-archive export -r lobby -c 2 -f chapter2.json

# 2. Edit it in your editor (the "id" field must be preserved)

# 3. Apply the changes
tiny-rpg-chat-archive import -r lobby -c 2 -f chapter2.json -m upsert
```

### Use it in CI

```bash
tiny-rpg-chat-archive import \
  --data-dir ./fixtures \
  --room lobby \
  --chapter 1 \
  --file ./fixtures/seed.json \
  --mode replace \
  --yes \
  --json
```

---

## 🔧 Troubleshooting

**`Could not find the data folder`**
The CLI could not find `config.ini`. Pass the path explicitly:

```bash
tiny-rpg-chat-archive rooms --data-dir /path/to/tiny-chat_data
```

**`Room "x" not found`**
The ID is case-sensitive. Run `tiny-rpg-chat-archive rooms` to see the exact IDs.

**`The file contains invalid entries`**
The file has entries that do not match the format. The CLI lists the index and the field with the problem; nothing is written until everything is valid.

**`No more input available (stdin closed)`**
A question was left unanswered. Pass the options as flags (`--room`, `--chapter`) or use `--json`.

**Strange accents on Windows**
Run `chcp 65001` first, or run with `NO_COLOR=1` to get output without color codes.

---

## 📚 See also

- [`README.md`](../README.md) — project overview
- [`src/server/connection/sql.js`](../src/server/connection/sql.js) — database schema
