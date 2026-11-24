# Music player

Synchronized music player of a roleplay room.

Only the **last interaction** is stored, so a room with any number of listeners costs a single row
and a client that joins late is in sync as soon as it reads the state:

```
live = playing ? position + (Date.now() - updatedAt) / 1000 : position
```

Every interaction bumps `revision`, so a client can tell an out-of-order packet from a new one.

## Tables

| Table                | Contents                                                                 |
| -------------------- | ------------------------------------------------------------------------ |
| `roomPlaylists`      | Playlists created by a room owner (`tracks` is a JSON array).            |
| `roomPlaylistRooms`  | Rooms of a `scope = 'rooms'` playlist.                                   |
| `roomPlayer`         | One row per room with the last interaction.                              |

## Permissions

The **DJ** of a room is its owner, the server owner and the room moderators. Everybody else can
read the state, but only the DJ can change it.

---

### `list-playlists`

Lists the playlists of the room owner.

```json
{ "roomId": "lobby", "filter": "all" }
```

| Field    | Type             | Description                                                     |
| -------- | ---------------- | --------------------------------------------------------------- |
| `roomId` | `string`         | Room id.                                                        |
| `filter` | `string \| null` | `all`, `room` or `null` (both).                                 |

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
      "date": 1730419200000,
      "updatedAt": 1730419200000
    }
  ],
  "player": { "roomId": "lobby", "playlistId": null, "trackIndex": 0, "position": 0, "playing": false, "volume": 1, "revision": 0, "updatedAt": 0, "updatedBy": null }
}
```

---

### `save-playlist`

Creates a playlist, or updates one owned by the caller.

```json
{
  "playlistId": null,
  "name": "Battle",
  "tracks": [{ "type": "youtube", "id": "VMziMXYkVS0" }],
  "scope": "all",
  "rooms": []
}
```

| Field        | Type             | Description                                                     |
| ------------ | ---------------- | --------------------------------------------------------------- |
| `playlistId` | `string \| null` | Playlist to update. `null` creates a new one.                   |
| `name`       | `string`         | Playlist name (80 characters).                                  |
| `tracks`     | `array`          | Up to 500 tracks. `type` is `youtube` or `audio-file`.          |
| `scope`      | `string`         | `all` (every room of the owner) or `rooms` (only `rooms`).      |
| `rooms`      | `string[]`       | Rooms of a `rooms` playlist (max 100).                          |

---

### `delete-playlist`

```json
{ "playlistId": "6f1c..." }
```

Only the owner of the playlist can delete it.

---

### `get-player`

```json
{ "roomId": "lobby" }
```

**Response**: `{ "success": true, "player": { ... } }`.

---

### `set-player`

Applies an interaction and broadcasts `player-updated` to the room.

```json
{ "roomId": "lobby", "action": "play", "position": 12.5 }
```

| `action`   | Extra fields              | Description                                        |
| ---------- | ------------------------- | -------------------------------------------------- |
| `play`     | `position`                | Resumes the playback.                              |
| `pause`    | `position`                | Pauses the playback.                               |
| `seek`     | `position`                | Moves the playhead, in seconds.                    |
| `track`    | `trackIndex`              | Jumps to a track of the playlist (clamped, plays). |
| `volume`   | `volume`                  | Volume between `0` and `1`.                        |
| `loop`     | `loop`                    | Repeats the playlist when it ends.                 |
| `duration` | `duration`                | Reports the duration of the loaded media.          |
| `playlist` | `playlistId`              | Loads a playlist. An empty id stops the player.    |

**Errors**

| Code | Meaning                                              |
| ---- | ---------------------------------------------------- |
| `2`  | Not the DJ of the room, or the playlist was not found. |
| `3`  | The playlist is not available on this room.          |

---

### `player-updated` (server → client)

```json
{ "roomId": "lobby", "player": { "playlistId": "6f1c...", "trackIndex": 0, "position": 12.5, "playing": true, "revision": 4, "updatedAt": 1730419200000 } }
```
