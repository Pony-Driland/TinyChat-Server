import { createHash } from 'crypto';
import { isJsonObject } from 'tiny-essentials/basics/objChecker';
import TinyPromiseQueue from 'tiny-essentials/libs/utils/TinyPromiseQueue';
import TinyRateLimiter from 'tiny-essentials/libs/math/TinyRateLimiter';
import db from './sql';
const AsyncFunction = (async () => {}).constructor;
export const roomQueue = new TinyPromiseQueue();

export const userSockets = new Map(); // Socket users

// Rate limit settings
const LIMITS = {
  OWNER_ID: '',
};

export const getIniConfig = (where) => LIMITS[where];
export const _setIniConfig = (where, value) => {
  LIMITS[where] = value ?? 0;
};

// Track the users in rooms
export const roomUsers = new Map(); // Stores room users

// Hashed String
export const getHashString = (text) => createHash('sha256').update(text).digest('hex');

/**
 * Hashes a password with the configured maximum length.
 *
 * Every write and every comparison must go through this function. When the
 * account is created with a truncated password but the login compares the full
 * one (or the other way around), the account can never log in again.
 *
 * @param {unknown} password - Raw password.
 * @returns {string} The hashed password.
 */
export const hashPassword = (password) => {
  const maxSize = Number(getIniConfig('PASSWORD_SIZE'));
  const value = typeof password === 'string' ? password : '';
  return getHashString(
    Number.isFinite(maxSize) && maxSize > 0 ? value.substring(0, maxSize) : value,
  );
};

/**
 * Normalizes an account id into its canonical stored form.
 *
 * The id is the primary key of the account, so every read and every write must
 * go through this function. When the write path normalizes (lowercase, strip
 * spaces, truncate) but the read path does not, a caller can pick an id that
 * does not exist yet and still overwrite an existing account.
 *
 * @param {unknown} userId - Raw account id.
 * @returns {string} The canonical id, or an empty string when invalid.
 */
export const normalizeUserId = (userId) => {
  if (typeof userId !== 'string') return '';

  const maxSize = Number(getIniConfig('USER_ID_SIZE'));
  const limited = Number.isFinite(maxSize) && maxSize > 0 ? userId.substring(0, maxSize) : userId;

  return limited.replace(/\s/g, '').toLowerCase();
};

/**
 * Normalizes a room id into its canonical stored form.
 *
 * @param {unknown} roomId - Raw room id.
 * @returns {string} The canonical id, or an empty string when invalid.
 */
export const normalizeRoomId = (roomId) => {
  if (typeof roomId !== 'string') return '';

  const maxSize = Number(getIniConfig('ROOM_ID_SIZE'));
  return Number.isFinite(maxSize) && maxSize > 0 ? roomId.substring(0, maxSize) : roomId;
};

/**
 * Finds a user by id, ignoring the id casing.
 *
 * Accounts created before the lowercase migration can still be stored with
 * uppercase characters, so looking up only the lowercase id makes the login
 * fail with "User does not exist" even when the credentials are correct.
 *
 * @param {import('puddysql').PuddySqlQuery} users - The users table.
 * @param {string} userId - The id typed by the user.
 * @returns {Promise<Record<string, any> | null>} The stored user or null.
 */
export const findUser = async (users, userId) => {
  // Fast path: the id is already stored exactly as typed.
  const user = await users.get(userId);
  if (user) return user;

  // Slow path: legacy rows may have a different casing.
  const rows = await users.search({
    q: { column: 'userId', operator: 'LOWER', value: userId.toLowerCase() },
    limit: 1,
  });

  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
};

// Map to Array
export function mapToArray(map) {
  return map.size > 0 ? Array.from(map) : [];
}

/**
 * Creates a new user account.
 *
 * The user id is always stored in lowercase. The database enforces this
 * invariant (see the `migrate-usernames` CLI command), so the conversion
 * here is a defense in depth: it keeps the write path consistent even if
 * the caller forgets to normalize the input.
 *
 * @param {string} userId - The user's unique ID.
 * @param {string} password - The user's password.
 * @param {string} nickname - The user's chosen nickname.
 * @returns {Promise<void>}
 */
export const createAccount = async (userId, password, nickname) => {
  const hashedPassword = hashPassword(password);
  const users = db.getTable('users');
  const normalizedId = normalizeUserId(userId);

  if (normalizedId.length < 1) throw new Error('Invalid user id.');

  await users.set(normalizedId, {
    password: hashedPassword,
    nickname: nickname.substring(0, getIniConfig('NICKNAME_SIZE')),
  });
};

/**
 * Normalizes a room language code.
 *
 * The language is stored as a lowercase ISO 639-1 code (`en`, `pt`, `ja`, ...).
 * An empty string, `null` or an invalid value means "no language", which makes
 * the room visible on every language filter.
 *
 * @param {unknown} language - Raw language value.
 * @returns {string|null} The normalized code, or `null` when there is none.
 */
export const normalizeRoomLanguage = (language) => {
  if (typeof language !== 'string') return null;

  const normalized = language.trim().toLowerCase();
  if (normalized.length < 2 || normalized.length > 8) return null;
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,4})?$/.test(normalized)) return null;

  return normalized;
};

export const createRoom = async (userId, roomId, password, title) => {
  const hashedPassword = hashPassword(password);
  const rooms = db.getTable('rooms');
  const normalizedId = normalizeRoomId(roomId);

  if (normalizedId.length < 1) throw new Error('Invalid room id.');

  await rooms.set(normalizedId, {
    password: hashedPassword,
    title: title.substring(0, getIniConfig('ROOM_TITLE_SIZE')),
    maxUsers: getIniConfig('MAX_USERS_PER_ROOM'),
    ownerId: userId,
    disabled: false,
  });
};

export const userSession = {
  check: (socket) => {
    if (!Array.isArray(socket.data.rooms)) socket.data.rooms = [];
  },
  isInRoom: (socket, roomId) => {
    if (Array.isArray(socket.data.rooms) && socket.data.rooms.indexOf(roomId) > -1) return true;

    return false;
  },
  addRoom: (socket, roomId) => {
    if (typeof roomId === 'string') {
      if (Array.isArray(socket.data.rooms) && socket.data.rooms.indexOf(roomId) < 0)
        socket.data.rooms.push(roomId);
      return true;
    }
    return false;
  },
  eachRooms: (socket, callback) => {
    if (Array.isArray(socket.data.rooms))
      for (const index in socket.data.rooms) callback(socket.data.rooms[index]);
  },
  removeRoom: (socket, roomId) => {
    if (Array.isArray(socket.data.rooms) && typeof roomId === 'string') {
      const index = socket.data.rooms.indexOf(roomId);
      if (index > -1) socket.data.rooms.splice(index, 1);
    }
    return false;
  },
  getUserId: (socket) => (typeof socket.data.userId === 'string' ? socket.data.userId : null),
  getNickname: (socket) => (typeof socket.data.nickname === 'string' ? socket.data.nickname : null),
  setUserId: (socket, userId) => {
    socket.data.userId = userId;
    return true;
  },
  setNickname: (socket, nickname) => {
    socket.data.nickname = nickname;
    return true;
  },
};

/**
 * Roles that can be granted to a user inside a room.
 *
 * - `owner`: the room owner (or the server owner).
 * - `moderator`: a room moderator or a server moderator.
 * - `member`: a regular user that received the permission to talk.
 * - `guest`: read-only visitor. This is the default for every new user.
 */
export const ROOM_ROLES = {
  OWNER: 'owner',
  MODERATOR: 'moderator',
  MEMBER: 'member',
  GUEST: 'guest',
};

/**
 * Resolves the role of an user inside a room.
 *
 * @param {string} roomId - The room id.
 * @param {string} userId - The user id.
 * @param {{ ownerId?: string }} [room] - The room row, when already loaded.
 * @returns {Promise<'owner'|'moderator'|'member'|'guest'>}
 */
export const getRoomRole = async (roomId, userId, room) => {
  if (typeof roomId !== 'string' || typeof userId !== 'string') return ROOM_ROLES.GUEST;

  const roomRow = room ?? (await db.getTable('rooms').get(roomId));
  if (!roomRow) return ROOM_ROLES.GUEST;

  // Server owner and room owner have full control over the room.
  if (userId === getIniConfig('OWNER_ID') || userId === roomRow.ownerId) return ROOM_ROLES.OWNER;

  // Server moderators and room moderators can moderate the room.
  const moderators = db.getTable('moderators');
  if (await moderators.has(userId)) return ROOM_ROLES.MODERATOR;

  const roomModerators = db.getTable('roomModerators');
  if (await roomModerators.has(roomId, userId)) return ROOM_ROLES.MODERATOR;

  // Users explicitly allowed by the room owner.
  const roomPermissions = db.getTable('roomPermissions');
  if (await roomPermissions.has(roomId, userId)) return ROOM_ROLES.MEMBER;

  return ROOM_ROLES.GUEST;
};

/**
 * Checks if an user is allowed to send messages in a room.
 *
 * Every user joins the room as a read-only guest. The room owner needs to
 * grant the permission before the user can talk.
 *
 * @param {string} roomId - The room id.
 * @param {string} userId - The user id.
 * @param {{ ownerId?: string }} [room] - The room row, when already loaded.
 * @returns {Promise<boolean>}
 */
export const canSpeakInRoom = async (roomId, userId, room) => {
  const role = await getRoomRole(roomId, userId, room);
  return role !== ROOM_ROLES.GUEST;
};

/**
 * Grants the permission to speak in a room.
 *
 * @param {string} roomId - The room id.
 * @param {string} userId - The user that received the permission.
 * @param {string} [grantedBy] - The user that granted the permission.
 * @returns {Promise<void>}
 */
export const grantRoomPermission = async (roomId, userId, grantedBy) => {
  const roomPermissions = db.getTable('roomPermissions');
  await roomPermissions.set(roomId, {
    userId,
    grantedBy: typeof grantedBy === 'string' ? grantedBy : null,
    date: Date.now(),
  });
};

/**
 * Revokes the permission to speak in a room.
 *
 * @param {string} roomId - The room id.
 * @param {string} userId - The user that lost the permission.
 * @returns {Promise<void>}
 */
export const revokeRoomPermission = async (roomId, userId) => {
  const roomPermissions = db.getTable('roomPermissions');
  if (await roomPermissions.has(roomId, userId)) await roomPermissions.delete(roomId, userId);
};

/**
 * Lists the users that received the permission to speak in a room.
 *
 * @param {string} roomId - The room id.
 * @returns {Promise<Array<{ userId: string, grantedBy: string|null, date: number }>>}
 */
export const listRoomPermissions = async (roomId) => {
  const roomPermissions = db.getTable('roomPermissions');
  const rows = await roomPermissions.search({
    q: { group: 'AND', conditions: [{ column: 'roomId', value: roomId }] },
  });

  const items = Array.isArray(rows) ? rows : (rows?.items ?? []);
  return items.map((item) => ({
    userId: item.userId,
    grantedBy: typeof item.grantedBy === 'string' ? item.grantedBy : null,
    date: typeof item.date === 'number' ? item.date : 0,
  }));
};

/** Fallback for `limits.MAX_PAGE_SIZE` when the key is missing or invalid. */
export const DEFAULT_MAX_PAGE_SIZE = 1000;

/**
 * Largest page a listing endpoint will ever return.
 *
 * Configured by `limits.MAX_PAGE_SIZE`.
 *
 * @returns {number} The configured page size cap.
 */
export const getMaxPageSize = () => {
  const maxSize = Number(getIniConfig('MAX_PAGE_SIZE'));
  return Number.isFinite(maxSize) && maxSize > 0 ? Math.floor(maxSize) : DEFAULT_MAX_PAGE_SIZE;
};

/**
 * Clamps a client supplied page size.
 *
 * Every listing endpoint used to accept any positive number, so a single
 * request could ask the database for the whole table.
 *
 * @param {unknown} perPage - Requested page size.
 * @param {number} [fallback=25] - Value used when the input is invalid.
 * @returns {number} A page size between 1 and `limits.MAX_PAGE_SIZE`.
 */
export const clampPageSize = (perPage, fallback = 25) => {
  const value = Number(perPage);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), getMaxPageSize());
};

/** Fallback for `limits.ROOM_DATA_SIZE` when the key is missing or invalid. */
export const DEFAULT_ROOM_DATA_SIZE = 65536;

/**
 * Largest serialized room data blob accepted by the server.
 *
 * Configured by `limits.ROOM_DATA_SIZE`.
 *
 * @returns {number} The configured limit, in bytes.
 */
export const getRoomDataSizeLimit = () => {
  const maxSize = Number(getIniConfig('ROOM_DATA_SIZE'));
  return Number.isFinite(maxSize) && maxSize > 0 ? Math.floor(maxSize) : DEFAULT_ROOM_DATA_SIZE;
};

/**
 * Rejects a JSON payload that is too large to be stored.
 *
 * The room data and the RPG schema are opaque blobs, so the only defence
 * against a single account filling the database is a size limit.
 *
 * @param {unknown} value - Value sent by the client.
 * @param {number} [maxSize] - Maximum serialized size, in bytes. Defaults to `limits.ROOM_DATA_SIZE`.
 * @returns {boolean} True when the value is a JSON object within the limit.
 */
export const isRoomDataWithinLimit = (value, maxSize) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  const limit = Number.isFinite(maxSize) && maxSize > 0 ? maxSize : getRoomDataSizeLimit();

  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= limit;
  } catch {
    return false;
  }
};

export const getRateLimit = () => ({
  size: {
    history: getIniConfig('HISTORY_SIZE'),
    userId: getIniConfig('USER_ID_SIZE'),
    password: getIniConfig('PASSWORD_SIZE'),
    minPassword: getIniConfig('MIN_PASSWORD_SIZE'),
    nickname: getIniConfig('NICKNAME_SIZE'),
    msg: getIniConfig('MESSAGE_SIZE'),
    roomId: getIniConfig('ROOM_ID_SIZE'),
    roomTitle: getIniConfig('ROOM_TITLE_SIZE'),
    modelId: getIniConfig('MODEL_ID_SIZE'),
    prompt: getIniConfig('ROOM_PROMPT'),
    systemInstruction: getIniConfig('ROOM_SYSTEM_INSTRUCTION'),
    firstDialogue: getIniConfig('ROOM_FIRST_DIALOGUE'),
  },
  limit: {
    msg: getIniConfig('MESSAGES'),
    roomUpdates: getIniConfig('ROOM_UPDATES'),
    diceRolls: getIniConfig('DICE_ROLLS'),
    events: getIniConfig('EVENT'),
    roomUsers: getIniConfig('MAX_USERS_PER_ROOM'),
  },
  dice: {
    amount: getIniConfig('DICE_AMOUNT'),
    sides: getIniConfig('DICE_SIDES'),
    img: getIniConfig('DICE_IMG_SIZE'),
    border: getIniConfig('DICE_BORDER_STYLE'),
    bg: getIniConfig('DICE_BG_STYLE'),
    text: getIniConfig('DICE_TEXT_STYLE'),
    selectionBg: getIniConfig('DICE_SELECTION_BG_STYLE'),
    selectionText: getIniConfig('DICE_SELECTION_TEXT_STYLE'),
  },
  loadAllHistory: getIniConfig('LOAD_ALL_HISTORY'),
  publicRooms: Boolean(getIniConfig('PUBLIC_ROOMS')),
  time: getIniConfig('RATE_LIMIT_TIME'),
  openRegistration: getIniConfig('OPEN_REGISTRATION'),
});

/** @param {import('../proxyOnConnection.mjs').SocketEmit} socketEmit */
export const sendRateLimit = (socketEmit) => {
  return socketEmit('ratelimt-updated', getRateLimit());
};

// Rate limit editor
/** @type {Map<string, TinyRateLimiter>} */
const rateLimits = new Map();
export const createRateLimit = (limitCountName = '', itemName = 'items', code = -1) => {
  // Track the events for rate limiting
  return (socket, fn, isUnknown = false) => {
    const cfg = {
      cleanupInterval: 1000,
      maxIdle: getIniConfig('RATE_LIMIT_TIME'),
      maxHits: getIniConfig(limitCountName) || 5,
    };

    let rateLimit = rateLimits.get(limitCountName);
    if (!rateLimit) {
      rateLimit = new TinyRateLimiter(cfg);
      rateLimits.set(limitCountName, rateLimit);
    }

    /** @type {number} */
    const limitCount = cfg.maxHits;

    // Is a user
    const userId = !isUnknown
      ? userSession.getUserId(socket)
      : socket.handshake
        ? socket.handshake.address
        : '?.?.?.?';
    if (!userId) return false;

    // Check if rate limit is exceeded based on RATE_LIMIT_TIME
    rateLimit.hit(userId);
    if (rateLimit.isRateLimited(userId)) {
      const rateLimitTime = cfg.maxIdle / 1000;
      fn({
        error: true,
        ratelimit: true,
        msg: `Rate limit exceeded. You can send a maximum of ${limitCount} ${itemName} in ${rateLimitTime} seconds.`,
        code,
        numbers: [limitCount, rateLimitTime],
      });
      return true;
    }

    // Free user!
    return false;
  };
};

export const userIsRateLimited = createRateLimit('EVENT', 'events', 1);
// Login is keyed by the connection address, so an unauthenticated attacker
// cannot brute force a password by opening new sockets.
export const loginIsRateLimited = createRateLimit('LOGIN_ATTEMPTS', 'login attempts', 8);
export const roomUpdateIsRateLimited = createRateLimit('ROOM_UPDATES', 'room updates', 1);
export const userMsgLoadIsRateLimited = createRateLimit('MESSAGES_LOAD', 'message loads', 4);
export const userMsgDeleteIsRateLimited = createRateLimit('MESSAGES_DELETE', 'message deletes', 5);
export const userMsgEditIsRateLimited = createRateLimit('MESSAGES_EDIT', 'message edits', 6);
export const userMsgIsRateLimited = createRateLimit('MESSAGES', 'messages', 2);
export const userDiceIsRateLimited = createRateLimit('DICE_ROLLS', 'dice rolls', 3);
export const userUpdateDiceIsRateLimited = createRateLimit('DICE_ROLLS', 'dice changes', 3);
export const userLoadIsRateLimited = createRateLimit('MESSAGES_LOAD', 'listing requests', 7);

// Incomplete data
export const sendIncompleteDataInfo = (fn, code = 0) => {
  fn({
    error: true,
    msg: `Your data does not respect the requirements for this request. Your request has been cancelled.`,
    code,
  });
};

// Incomplete data
export const noDataInfo = (data, fn, code = 0) => {
  if (!isJsonObject(data)) {
    fn({
      error: true,
      msg: `Your data does not respect the requirements for this request. Your request has been cancelled.`,
      code,
    });
    return true;
  }
  return false;
};

export const accountNotDetected = (fn, code = 0) => {
  fn({
    error: true,
    noAccount: true,
    msg: `No account has been detected to complete this request. Your request has been cancelled.`,
    code,
  });
};

export const roomNotDetected = (fn, code = 0) => {
  fn({
    error: true,
    msg: `Room hasn't been detected.`,
    code,
  });
};

export const ownerOnly = (fn, code = 0) => {
  fn({
    error: true,
    msg: `Only the owner is allowed to perform this action.`,
    code,
  });
};

// Join Room
export const getJoinData = async (socket) => {
  const nickname = userSession.getNickname(socket);
  const pingNow = Date.now();
  const userId = userSession.getUserId(socket);

  // The server staff badge is public inside the room, so every client can
  // render the icon without an extra request.
  const isStaff = await isServerStaff(userId);

  return { nickname, ping: pingNow, isStaff };
};

/**
 * Tells whether an account belongs to the server staff.
 *
 * The server owner always counts as staff. The moderator table is the single
 * source of truth, so a promotion is reflected on the next join.
 *
 * @param {string} userId - Account id.
 * @returns {Promise<boolean>}
 */
export const isServerStaff = async (userId) => {
  if (typeof userId !== 'string' || userId.length < 1) return false;
  if (userId === getIniConfig('OWNER_ID')) return true;

  const moderators = db.getTable('moderators');
  return moderators.has(userId);
};

export const joinRoom = async (socket, emitTo, roomId, fn) => {
  if (socket) {
    // Get data
    const userId = userSession.getUserId(socket);
    if (userId && roomId) {
      // Add user to the room's user map with their nickname and initial ping value (e.g., 0 for now)
      const joinData = await getJoinData(socket);
      if (!roomUsers.has(roomId)) {
        roomUsers.set(roomId, new Map());
      }
      roomUsers.get(roomId).set(userId, joinData);

      // Notify room members about the new user (excluding the user who just joined)
      await roomQueue.enqueue(() =>
        socket.join instanceof AsyncFunction
          ? socket.join(roomId)
          : new Promise((resolve) => resolve(socket.join(roomId))),
      );

      userSession.addRoom(socket, roomId);
      const socketData = {
        roomId,
        userId,
        nickname: joinData.nickname,
        ping: joinData.ping,
        isStaff: joinData.isStaff,
      };
      emitTo(roomId, 'user-joined', socketData);
      if (fn) fn(socketData);
      return true;
    }
  }
  if (fn) fn({ error: true, msg: 'Invalid data!' });
  return false;
};

// Leave room
export const leaveRoom = async (socket, emitTo, roomId, fn) => {
  if (socket) {
    // Get data
    const userId = userSession.getUserId(socket);
    const nickname = userSession.getNickname(socket);
    if (userId && roomId) {
      // Get room
      const room = roomUsers.get(roomId);
      // Room not found
      if (!room) return { success: false, code: 1 };

      // Disconnect user from room
      if (room.has(userId)) {
        // Remove the user from their room
        room.delete(userId);
        emitTo(roomId, 'user-left', { roomId, nickname, userId });
        await roomQueue.enqueue(() =>
          socket.leave instanceof AsyncFunction
            ? socket.leave(roomId)
            : new Promise((resolve) => resolve(socket.leave(roomId))),
        );
        userSession.removeRoom(socket, roomId);
        // Complete
        if (fn) fn({ success: true });
        return { success: true };
      }
      // User not found
      if (fn) fn({ success: false, code: 2, msg: 'User not found.' });
      return { success: false, code: 2 };
    }
    // Invalid data
    else if (!roomId) {
      if (fn) fn({ success: false, code: 3, msg: 'Invalid data.' });
      return { success: false, code: 3 };
    }
  }
  // No data
  else {
    if (fn) fn({ success: false, code: 0, msg: 'No data.' });
    return { success: false, code: 0 };
  }
};
