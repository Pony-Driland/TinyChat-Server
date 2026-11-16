# User Manager — Socket.IO API

This document describes every Socket.IO event handled by
[`userManager.js`](./userManager.js): authentication, account settings, server staff and the
server-wide moderation tools.

Every handler follows the same contract:

- the payload is a plain object (`noDataInfo` rejects anything else);
- the last argument is the **acknowledgment callback** (`fn`);
- failures answer `{ error: true, msg: string, code: number }`;
- every event is throttled by `userIsRateLimited` (`limits.EVENT`).

## Roles

| Role                           | How it is granted                  |
| ------------------------------ | ---------------------------------- |
| **Server owner**               | `genesis.owner_id` in `config.ini` |
| **Server staff** (`moderator`) | Row in the `moderators` table      |
| **Regular user**               | Any other account                  |

`isServerStaff()` in [`values.js`](./values.js) is the single source of truth and is what the
`isStaff` badge in `user-joined` uses.

---

## Authentication

### `register`

Creates a new account.

```json
{ "userId": "alice", "password": "hunter2hunter2hunter2", "nickname": "Alice" }
```

**Response**

```json
{ "userId": "alice", "nickname": "Alice" }
```

**Rules**

- `userId` must be **lowercase** — otherwise the request fails with code `5`.
- When `server.registration_open = false`, only the server owner can create accounts.
- The password must respect `limits.MIN_PASSWORD_SIZE`.
- The id is truncated to `limits.USER_ID_SIZE` and the nickname to `limits.NICKNAME_SIZE`.

**Errors**

| Code | Meaning                                                 |
| ---- | ------------------------------------------------------- |
| `1`  | User id already exists                                  |
| `2`  | Only the owner can create accounts                      |
| `3`  | Password does not have the minimum number of characters |
| `4`  | User id does not have the minimum number of characters  |
| `5`  | User id must be lowercase                               |

---

### `login`

```json
{ "userId": "alice", "password": "hunter2hunter2hunter2" }
```

**Response**

```json
{
  "userId": "alice",
  "nickname": "Alice",
  "isAdmin": false,
  "isMod": false,
  "ratelimit": {},
  "dice": {}
}
```

`ratelimit` is the payload of `getRateLimit()` (sizes, limits and dice limits), so the client can
validate the forms without an extra request.

**Rules**

- Banned accounts are rejected **before** the password check, and the response carries `reason` and
  `date`.
- The lookup ignores the id casing (`findUser`), so legacy rows still work.
- The server owner and the staff bypass the `limits.MAX_ONLINE_ACCOUNTS` limit.

**Errors**

| Code | Meaning                                                  |
| ---- | -------------------------------------------------------- |
| `1`  | Invalid user credentials                                 |
| `2`  | User does not exist                                      |
| `3`  | The account is already in use                            |
| `4`  | You're already logged in                                 |
| `5`  | You're banned (also returns `reason` and `date`)         |
| `6`  | The server reached the maximum number of online accounts |

---

### `disconnect`

Not emitted by the client. Leaves every room the socket was in and removes the socket from
`userSockets`.

---

## Account settings

### `change-password`

```json
{ "oldPassword": "old-password", "password": "new-password" }
```

**Errors**

| Code | Meaning                                                         |
| ---- | --------------------------------------------------------------- |
| `1`  | The new password does not have the minimum number of characters |
| `2`  | Your current password is incorrect                              |

---

### `change-nickname`

```json
{ "nickname": "Alice" }
```

**Response**

```json
{ "nickname": "Alice" }
```

Broadcasts `user-updated` to every room the account is in:

```json
{ "roomId": "lobby", "userId": "alice", "data": { "nickname": "Alice" } }
```

The nickname is truncated to `limits.NICKNAME_SIZE`.

---

## Lookups

### `user-is-mod`

```json
{ "userId": "bob" }
```

**Response**

```json
{ "result": true, "isOwner": false, "date": 1730419200000, "reason": null }
```

`date` and `reason` are only included when the **caller** is the server owner or a moderator.

---

### `user-is-owner`

```json
{ "userId": "alice" }
```

**Response**

```json
{ "result": false }
```

---

## Server staff

### `add-mod`

Promotes an account to server staff. **Only the server owner** can call it.

```json
{ "userId": "bob" }
```

**Broadcast — `user-staff-updated`** (one per room the account is in)

```json
{ "roomId": "lobby", "userId": "bob", "isStaff": true }
```

**Errors**

| Code | Meaning                                                        |
| ---- | -------------------------------------------------------------- |
| `1`  | Only the owner is allowed to perform this action (`ownerOnly`) |
| `2`  | User not found                                                 |

---

### `remove-mod`

Demotes an account. **Only the server owner** can call it.

```json
{ "userId": "bob" }
```

Broadcasts `user-staff-updated` with `isStaff: false`.

**Errors**

| Code | Meaning                                                        |
| ---- | -------------------------------------------------------------- |
| `1`  | Only the owner is allowed to perform this action (`ownerOnly`) |

---

## Moderation

### `ban`

Bans an account and disconnects it immediately. Available to the server owner and the staff.

```json
{ "userId": "bob", "reason": "spam" }
```

**Rules**

- The server owner can never be banned.
- The row is written to the `banned` table with `date` and `reason`.

**Errors**

| Code | Meaning                           |
| ---- | --------------------------------- |
| `1`  | You are not allowed to do this    |
| `2`  | User not found                    |
| `3`  | The server owner cannot be banned |

---

### `unban`

```json
{ "userId": "bob" }
```

**Errors**

| Code | Meaning                        |
| ---- | ------------------------------ |
| `1`  | You are not allowed to do this |
| `2`  | User not found                 |

---

### `kick`

Accepts a single id or an array of ids.

```json
{ "userId": ["bob", "carol"] }
```

**Response**

```json
{ "success": true, "data": [{ "success": true }] }
```

**Errors**

| Code | Meaning                                   |
| ---- | ----------------------------------------- |
| `1`  | You are not allowed to do this            |
| `2`  | User not found (per entry, inside `data`) |

---

## Events emitted

| Event                | Sent to | Description                      |
| -------------------- | ------- | -------------------------------- |
| `user-updated`       | rooms   | The nickname changed             |
| `user-staff-updated` | rooms   | The account was promoted/demoted |
