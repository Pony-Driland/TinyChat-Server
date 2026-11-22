# Room Manager — Socket.IO API

This document describes every Socket.IO event handled by
[`roomManager.js`](./roomManager.js): room discovery, membership, moderation and the
read-only permission system.

Every handler follows the same contract:

- the payload is a plain object (`noDataInfo` rejects anything else);
- the last argument is the **acknowledgment callback** (`fn`);
- failures answer `{ error: true, msg: string, code: number }`;
- the caller must be authenticated (`accountNotDetected`).

## Roles

`getRoomRole()` in [`values.js`](./values.js) resolves the role of an account inside a room.

| Role        | How it is granted                       | Can talk       |
| ----------- | --------------------------------------- | -------------- |
| `owner`     | Server owner or `rooms.ownerId`         | ✅             |
| `moderator` | Row in `moderators` or `roomModerators` | ✅             |
| `member`    | Row in `roomPermissions`                | ✅             |
| `guest`     | Default for every account that joins    | ❌ (read-only) |

`canSpeakInRoom()` is just `role !== 'guest'`. Every write path (`send-message`,
`edit-message`, `delete-message`, `roll-dice`, `load-messages`) checks it.

---

## Discovery

### `exists-room`

Checks whether a room exists. Non-intrusive: it never joins the room.

```json
{ "roomId": "lobby" }
```

**Response**

```json
{ "exists": true }
```

---

### `list-rooms`

Lists the rooms the signed-in account is allowed to see, ordered by the last message date.

```json
{
  "search": null,
  "scope": "mine",
  "openOnly": false,
  "ownedOnly": false,
  "language": null,
  "page": 1,
  "perPage": 20
}
```

| Field       | Type             | Description                                          |
| ----------- | ---------------- | ---------------------------------------------------- |
| `search`    | `string \| null` | Case-insensitive match on `roomId` and `title`       |
| `scope`     | `string \| null` | `mine` (default), `visited` or `all`                 |
| `openOnly`  | `boolean`        | Only rooms with `disabled = false`                   |
| `ownedOnly` | `boolean`        | Only rooms owned by the caller                       |
| `language`  | `string \| null` | ISO 639-1 code. `null` lists every language          |
| `page`      | `number`         | Page, starting at `1`                                |
| `perPage`   | `number`         | Page size                                            |

**Response**

```json
{
  "success": true,
  "page": 1,
  "totalPages": 1,
  "rooms": [
    {
      "roomId": "lobby",
      "title": "Main room",
      "ownerId": "alice",
      "ownerNickname": "Alice",
      "chapter": 1,
      "users": 3,
      "maxUsers": 50,
      "disabled": false,
      "readOnly": false,
      "hasPassword": true,
      "public": false,
      "language": "en",
      "visitedAt": 1730419200000,
      "isOwner": false,
      "isModerator": false,
      "lastMessage": 1730419200000
    }
  ]
}
```

**Rules**

- `scope: "all"` requires server staff, unless `server.public_rooms = true` in `config.ini`.
- `language` is optional. When it is omitted (or `null`) the rooms of every language are listed.
  Rooms without a language are only returned by the unfiltered list.
- A non-staff account using `scope: "all"` only sees public rooms, the rooms it owns and the rooms
  it already visited.
- Rate limited by `userLoadIsRateLimited` (`MESSAGES_LOAD`).

**Errors**

| Code | Meaning                                         |
| ---- | ----------------------------------------------- |
| `2`  | `scope: "all"` without permission (`ownerOnly`) |

---

### `list-users`

Lists accounts. **Server staff only.**

```json
{ "search": null, "all": false, "bannedOnly": false, "page": 1, "perPage": 25 }
```

| Field        | Description                                                               |
| ------------ | ------------------------------------------------------------------------- |
| `all`        | `true` searches the whole `users` table, `false` only the online accounts |
| `bannedOnly` | Only accounts in the `banned` table                                       |
| `search`     | Case-insensitive `userId` filter                                          |

**Response**

```json
{
  "success": true,
  "page": 1,
  "totalPages": 1,
  "users": [
    {
      "userId": "alice",
      "nickname": "Alice",
      "online": true,
      "rooms": ["lobby"],
      "banned": false,
      "banReason": null,
      "isMod": false,
      "isOwner": false
    }
  ]
}
```

**Errors**

| Code | Meaning                                  |
| ---- | ---------------------------------------- |
| `2`  | Caller is not server staff (`ownerOnly`) |

---

### `list-room-banned`

Lists the accounts banned from a room. Visible to the room owner, room moderators and server staff.

```json
{ "roomId": "lobby", "page": 1, "perPage": 25 }
```

**Response**

```json
{
  "success": true,
  "page": 1,
  "totalPages": 1,
  "users": [{ "userId": "bob", "reason": null, "date": 1730419200000 }]
}
```

**Errors**

| Code | Meaning                                |
| ---- | -------------------------------------- |
| `1`  | Room not found                         |
| `2`  | Caller is not room staff (`ownerOnly`) |

---

### `forget-room`

Removes the `roomMembers` row, so the room disappears from the "visited" list of the account.

```json
{ "roomId": "lobby" }
```

**Response**

```json
{ "success": true }
```

**Errors**

| Code | Meaning                                       |
| ---- | --------------------------------------------- |
| `2`  | The caller owns the room and cannot forget it |

---

## Membership

### `join`

Joins a room.

```json
{ "roomId": "lobby", "password": "" }
```

**Flow**

1. Validates `roomId` and `password` (both strings).
2. Requires an authenticated account and applies `userIsRateLimited`.
3. Loads the room. The server owner, the room owner, server moderators and room moderators skip
   the password, the capacity and the `disabled` checks.
4. Checks the room password (`getHashString(password)`).
5. Checks the capacity (`maxUsers`, `+2` for room moderators).
6. Checks `disabled`.
7. Rejects banned accounts.
8. Emits `room-entered` to the caller.
9. Registers the visit in `roomMembers`.
10. Calls `joinRoom()`, which emits `user-joined` to the room.

**`room-entered` payload**

```json
{
  "roomId": "lobby",
  "users": {},
  "mods": [],
  "rpgSchema": {},
  "roomData": {},
  "roomPrivateData": {},
  "role": "guest",
  "permissions": [],
  "data": {}
}
```

`roomPrivateData` is only filled for the room owner and the server owner.

**Errors**

| Code | Meaning                 |
| ---- | ----------------------- |
| `1`  | Room not found          |
| `2`  | Incorrect room password |
| `3`  | Room is full            |
| `4`  | Room is disabled        |
| `5`  | You're banned           |

---

### `leave`

```json
{ "roomId": "lobby" }
```

**Response**

```json
{ "success": true }
```

**Errors**

| Code | Meaning                |
| ---- | ---------------------- |
| `1`  | No users in the room   |
| `2`  | You're not in the room |
| `3`  | Invalid data           |

---

## Moderation

### `ban-from-room`

Bans an account from a room, revokes its `roomPermissions` row and disconnects it.

```json
{ "roomId": "lobby", "userId": "bob" }
```

**Broadcast — `user-banned`**

```json
{ "roomId": "lobby", "userId": "bob" }
```

**Errors**

| Code | Meaning                                                    |
| ---- | ---------------------------------------------------------- |
| `1`  | Room not found                                             |
| `2`  | Not allowed (includes trying to ban the room/server owner) |
| `3`  | User not found                                             |

---

### `unban-from-room`

```json
{ "roomId": "lobby", "userId": "bob" }
```

**Errors**

| Code | Meaning        |
| ---- | -------------- |
| `1`  | Room not found |
| `2`  | Not allowed    |
| `3`  | User not found |

---

### `kick-from-room`

Accepts a single id or an array of ids. The room owner and the server owner can never be kicked.

```json
{ "roomId": "lobby", "userId": ["bob", "carol"] }
```

**Response**

```json
{ "success": true, "data": [{ "userId": "bob", "success": true }] }
```

**Broadcast — `user-kicked`**

```json
{ "roomId": "lobby", "userId": "bob" }
```

**Errors**

| Code | Meaning        |
| ---- | -------------- |
| `1`  | Room not found |
| `2`  | User not found |
| `3`  | Invalid data   |
| `4`  | Not allowed    |

---

## Room lifecycle

### `create-room`

```json
{ "roomId": "lobby", "password": "", "title": "Main room" }
```

**Errors**

| Code | Meaning                                                    |
| ---- | ---------------------------------------------------------- |
| `1`  | This room already exists                                   |
| `2`  | The room id does not have the minimum number of characters |

---

### `delete-room`

Deletes the room and disconnects everyone. Requires the account password.

```json
{ "roomId": "lobby", "password": "my-password" }
```

**Errors**

| Code | Meaning                        |
| ---- | ------------------------------ |
| `1`  | Room not found                 |
| `2`  | You are not allowed to do this |
| `3`  | Your password is incorrect     |

---

### `disable-room` / `enable-room`

Toggles `rooms.disabled`. Disabling disconnects everyone but the room owner and the server owner.

```json
{ "roomId": "lobby" }
```

**Errors**

| Code | Meaning                        |
| ---- | ------------------------------ |
| `1`  | Room not found                 |
| `2`  | You are not allowed to do this |

---

### `enable-readonly-room` / `disable-readonly-room`

Toggles `rooms.readOnly`. When the room is read-only, only the owner, the staff and the room
+moderators can write. Both emit `room-updated`.

```json
{ "roomId": "lobby" }
```

**Errors**

| Code | Meaning                        |
| ---- | ------------------------------ |
| `1`  | Room not found                 |
| `2`  | You are not allowed to do this |

---

### `room-add-mod` / `room-remove-mod`

Adds or removes room moderators. Only the room owner or the server owner can call it.

```json
{ "roomId": "lobby", "mods": ["bob", "carol"] }
```

**Broadcast — `room-mod-updated`**

```json
{ "roomId": "lobby", "type": "add", "result": ["bob"] }
```

**Errors**

| Code | Meaning                                                        |
| ---- | -------------------------------------------------------------- |
| `1`  | Room not found                                                 |
| `2`  | Only the owner is allowed to perform this action (`ownerOnly`) |

---

## Permissions (read-only guests)

Every account that joins a room starts as a **guest** (`role: "guest"`), which means read-only
mode. The room owner must explicitly grant the permission to talk.

### `room-grant-permission`

```json
{ "roomId": "lobby", "userIds": ["bob"] }
```

**Broadcast — `room-permission-updated`**

```json
{
  "roomId": "lobby",
  "type": "grant",
  "users": ["bob"],
  "permissions": [{ "userId": "bob", "grantedBy": "alice", "date": 1730419200000 }]
}
```

**Errors**

| Code | Meaning                                          |
| ---- | ------------------------------------------------ |
| `1`  | Room not found                                   |
| `2`  | Only the owner is allowed to perform this action |

---

### `room-revoke-permission`

Same payload as `room-grant-permission`. Emits `room-permission-updated` with `type: "revoke"`.

---

### `room-permissions`

Returns the caller role plus the list of accounts allowed to talk.

```json
{ "roomId": "lobby" }
```

**Response**

```json
{
  "success": true,
  "role": "guest",
  "permissions": [],
  "roles": {
    "OWNER": "owner",
    "MODERATOR": "moderator",
    "MEMBER": "member",
    "GUEST": "guest"
  }
}
```

---

## Room settings

### `update-room`

Only the room owner or the server owner can call it. Every field is optional and validated
individually — an invalid value is silently ignored instead of failing the whole request.

```json
{
  "roomId": "lobby",
  "newSettings": {
    "title": "New title",
    "password": "new-password",
    "prompt": "...",
    "systemInstruction": "...",
    "firstDialogue": "...",
    "model": "gpt-4o-mini",
    "maxOutputTokens": 512,
    "temperature": 0.8,
    "topP": 0.9,
    "topK": 40,
    "presencePenalty": 0,
    "frequencyPenalty": 0,
    "maxUsers": 50,
    "chapter": 2,
    "public": true
  }
}
```

| Field                                                                                   | Limit                                                |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `title`                                                                                 | `limits.ROOM_TITLE_SIZE`                             |
| `password`                                                                              | `limits.PASSWORD_SIZE` (hashed with `getHashString`) |
| `prompt`                                                                                | `limits.ROOM_PROMPT`                                 |
| `systemInstruction`                                                                     | `limits.ROOM_SYSTEM_INSTRUCTION`                     |
| `firstDialogue`                                                                         | `limits.ROOM_FIRST_DIALOGUE`                         |
| `model`                                                                                 | `limits.MODEL_ID_SIZE`                               |
| `maxOutputTokens`, `temperature`, `topP`, `topK`, `presencePenalty`, `frequencyPenalty` | Finite `REAL` with at most 7 significant digits      |
| `maxUsers`                                                                              | Clamped between `1` and `limits.MAX_USERS_PER_ROOM`  |
| `chapter`                                                                               | Integer `>= 1`                                       |
| `public`                                                                                | `boolean`                                            |

**Broadcast — `room-updated`**

```json
{ "roomId": "lobby", "data": {} }
```

**Errors**

| Code | Meaning                                          |
| ---- | ------------------------------------------------ |
| `1`  | Room not found                                   |
| `2`  | Only the owner is allowed to perform this action |

---

### `update-room-data`

Stores free-form JSON in `roomData` (public) or `privateRoomData` (owner only).

```json
{ "roomId": "lobby", "isPrivate": false, "values": { "topic": "Gaming" } }
```

**Broadcast — `room-data-updated`** (public data only)

```json
{ "roomId": "lobby", "isPrivate": false, "values": { "topic": "Gaming" } }
```

**Errors**

| Code | Meaning                                             |
| ---- | --------------------------------------------------- |
| `1`  | Room not found                                      |
| `2`  | You do not have permission to update this room data |

---

### `update-rpg-schema`

Stores the RPG sheet schema of the room.

```json
{ "roomId": "lobby", "values": { "fields": [] } }
```

**Broadcast — `rpg-schema-updated`**

```json
{ "roomId": "lobby", "values": { "fields": [] } }
```

**Errors**

| Code | Meaning                                               |
| ---- | ----------------------------------------------------- |
| `1`  | Room not found                                        |
| `2`  | You do not have permission to update this room schema |

---

## Events emitted

| Event                     | Description                                        |
| ------------------------- | -------------------------------------------------- |
| `room-entered`            | Sent to the caller after a successful `join`       |
| `room-updated`            | Room settings changed                              |
| `room-data-updated`       | Public room data changed                           |
| `rpg-schema-updated`      | RPG schema changed                                 |
| `room-mod-updated`        | Room moderator list changed                        |
| `room-permission-updated` | Someone was granted/revoked the permission to talk |
| `user-joined`             | An account joined the room                         |
| `user-left`               | An account left the room                           |
| `user-banned`             | An account was banned from the room                |
| `user-kicked`             | An account was kicked from the room                |
