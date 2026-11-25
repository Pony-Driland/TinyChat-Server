# Music player

Synchronized music player of a roleplay room.

Only the **last interaction** is stored, so a room with any number of listeners costs a single row
and a client that joins late is in sync as soon as it reads the state:

```
live = playing ? position + (Date.now() - updatedAt) / 1000 : position
```

Every interaction bumps `revision`, so a client can tell an out-of-order packet from a new one.

## Tables

| Table               | Contents                                                            |
| ------------------- | ------------------------------------------------------------------- |
| `roomPlaylists`     | Playlists created by a room owner (`tracks` and `raffle` are JSON). |
| `roomPlaylistRooms` | Rooms of a `scope = 'rooms'` playlist.                              |
| `roomPlayer`        | One row per room with the last interaction.                         |

## Permissions

The **DJ** of a room is its owner, the server owner and the room moderators. Everybody else can
read the state, but only the DJ can change it.

## Player state

Every event that returns a player returns the same shape:

| Field        | Type             | Description                                                  |
| ------------ | ---------------- | ------------------------------------------------------------ |
| `roomId`     | `string`         | Room that owns the player.                                   |
| `playlistId` | `string \| null` | Playlist loaded on the room.                                 |
| `trackIndex` | `number`         | Index of the current track inside the playlist.              |
| `position`   | `number`         | Playhead snapshot, in seconds, taken at `updatedAt`.         |
| `duration`   | `number`         | Duration of the loaded media, in seconds (`0` when unknown). |
| `playing`    | `boolean`        | Whether the room is playing.                                 |
| `loop`       | `boolean`        | Repeats the playlist when it ends.                           |
| `volume`     | `number`         | Volume between `0` and `1`.                                  |
| `revision`   | `number`         | Incremented on every interaction.                            |
| `updatedAt`  | `number`         | Timestamp of the last interaction (`0` when never played).   |
| `updatedBy`  | `string \| null` | Account that made the last interaction.                      |

Every response that carries a player also carries `serverTime` (`Date.now()`), so the client can
compensate for the clock skew before applying `livePosition`.

---

### `list-playlists`

Lists the playlists of the room owner.

```json
{ "roomId": "lobby", "filter": "all", "limit": 50 }
```

| Field    | Type             | Description                        |
| -------- | ---------------- | ---------------------------------- |
| `roomId` | `string`         | Room id.                           |
| `filter` | `string \| null` | `global`, `room` or `null` (both). |
| `limit`  | `number \| null` | Optional page size (max `100`).    |

`filter` is applied by the database, so the server never loads the whole table:

| Value    | Keeps                                                                             |
| -------- | --------------------------------------------------------------------------------- |
| `global` | Only the `scope = 'all'` playlists.                                               |
| `room`   | Only the playlists available on `roomId` (`scope = 'all'` or the room is listed). |
| `null`   | Every playlist of the owner.                                                      |

**Response**

```json
{
  "success": true,
  "playlists": [
    {
      "playlistId": "6f1c...",
      "ownerId": "alice",
      "name": "Battle",
      "tracks": [{ "type": "youtube", "id": "VMziMXYkVS0", "file": 0, "title": null }],
      "scope": "all",
      "rooms": [],
      "mode": "ordered",
      "raffle": null,
      "date": 1730419200000,
      "updatedAt": 1730419200000
    }
  ],
  "player": {
    "roomId": "lobby",
    "playlistId": null,
    "trackIndex": 0,
    "position": 0,
    "duration": 0,
    "playing": false,
    "loop": false,
    "volume": 1,
    "revision": 0,
    "updatedAt": 0,
    "updatedBy": null
  },
  "serverTime": 1730419200000
}
```

**Errors**

| Code | Meaning        |
| ---- | -------------- |
| `1`  | Room not found |

---

### `save-playlist`

Creates a playlist, or updates one owned by the caller.

```json
{
  "playlistId": null,
  "name": "Battle",
  "tracks": [{ "type": "youtube", "id": "VMziMXYkVS0" }],
  "scope": "all",
  "rooms": [],
  "mode": "ordered",
  "raffle": null
}
```

| Field        | Type             | Description                                                        |
| ------------ | ---------------- | ------------------------------------------------------------------ |
| `playlistId` | `string \| null` | Playlist to update. `null` creates a new one.                      |
| `name`       | `string`         | Playlist name (80 characters).                                     |
| `tracks`     | `array`          | Up to 500 tracks. `type` is `youtube` or `audio-file`.             |
| `scope`      | `string`         | `all` (every room of the owner) or `rooms` (only `rooms`).         |
| `rooms`      | `string[]`       | Rooms of a `rooms` playlist (max 100).                             |
| `mode`       | `string`         | `ordered` (default) or `raffle`.                                   |
| `raffle`     | `object \| null` | Opaque draw configuration, used when `mode = 'raffle'` (max 8 KB). |

**Track validation**

- `type` must be `youtube` or `audio-file`.
- `id` is limited to 256 characters. A `youtube` id must match `^[A-Za-z0-9_-]{11}$`; an
  `audio-file` id may not contain `..` nor start with `/`.
- `file` is a non-negative integer (default `0`) and `title` is truncated to 200 characters.

**Response**: `{ "success": true, "playlist": { ... } }`.

When an existing playlist is updated, every room that can use it receives `playlist-updated`.

**Errors**

| Code | Meaning                                                            |
| ---- | ------------------------------------------------------------------ |
| `1`  | Playlist not found                                                 |
| `2`  | The playlist belongs to another account (`ownerOnly`)              |
| `4`  | The playlist has more than `limits.MAX_TRACKS_PER_PLAYLIST` tracks |
| `5`  | The account reached `limits.MAX_PLAYLISTS_PER_USER` playlists      |

---

### `delete-playlist`

```json
{ "playlistId": "6f1c..." }
```

Only the owner of the playlist can delete it. Every room that could use the playlist receives
`playlist-deleted`.

**Errors**

| Code | Meaning                                               |
| ---- | ----------------------------------------------------- |
| `1`  | Playlist not found                                    |
| `2`  | The playlist belongs to another account (`ownerOnly`) |

---

### `get-player`

```json
{ "roomId": "lobby" }
```

**Response**: `{ "success": true, "player": { ... }, "serverTime": 1730419200000 }`.

**Errors**

| Code | Meaning        |
| ---- | -------------- |
| `1`  | Room not found |

---

### `set-player`

Applies an interaction and broadcasts `player-updated` to the room.

```json
{ "roomId": "lobby", "action": "play", "position": 12.5, "expectedRevision": 3 }
```

| `action`   | Extra fields | Description                                        |
| ---------- | ------------ | -------------------------------------------------- |
| `play`     | `position`   | Resumes the playback.                              |
| `pause`    | `position`   | Pauses the playback.                               |
| `seek`     | `position`   | Moves the playhead, in seconds.                    |
| `track`    | `trackIndex` | Jumps to a track of the playlist (clamped, plays). |
| `volume`   | `volume`     | Volume between `0` and `1`.                        |
| `loop`     | `loop`       | Repeats the playlist when it ends.                 |
| `duration` | `duration`   | Reports the duration of the loaded media.          |
| `playlist` | `playlistId` | Loads a playlist. An empty id stops the player.    |

**Optimistic concurrency**

Every client of the room asks for the next track when the current one ends, so the first request
wins and the others are dropped. Send `expectedRevision` with the `revision` you last saw: when it
does not match, nothing is written and the answer is `{ success: true, player, stale: true }`.

**Errors**

| Code | Meaning                                               |
| ---- | ----------------------------------------------------- |
| `1`  | Room not found                                        |
| `2`  | Not the DJ of the room, or the playlist was not found |
| `3`  | The playlist is not available on this room            |

---

### `player-updated` (server → client)

```json
{
  "roomId": "lobby",
  "player": {
    "playlistId": "6f1c...",
    "trackIndex": 0,
    "position": 12.5,
    "playing": true,
    "revision": 4,
    "updatedAt": 1730419200000
  },
  "serverTime": 1730419200000
}
```

---

### `playlist-updated` (server → client)

Sent to every room that can use the playlist after a `save-playlist` on an existing playlist. The
DJ is included on purpose: a stale `tracks` array keeps the room playing the old song forever.

```json
{ "roomId": "lobby", "playlist": { "playlistId": "6f1c...", "tracks": [] } }
```

---

### `playlist-deleted` (server → client)

```json
{ "roomId": "lobby", "playlistId": "6f1c..." }
```
