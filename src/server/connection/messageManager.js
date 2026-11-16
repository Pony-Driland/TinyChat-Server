import { countObj, isJsonObject } from 'tiny-essentials/basics/objChecker';
import db from './sql';
import { createStreamBroadcast } from './stream';
import {
  userMsgIsRateLimited,
  userSession,
  accountNotDetected,
  sendIncompleteDataInfo,
  getIniConfig,
  noDataInfo,
  userDiceIsRateLimited,
  roomUsers,
  userUpdateDiceIsRateLimited,
  userMsgEditIsRateLimited,
  userMsgDeleteIsRateLimited,
  userMsgLoadIsRateLimited,
  canSpeakInRoom,
} from './values';

/**
 * Resolves the purge window chosen by the room owner.
 *
 * The client always sends a `mode` plus an optional `amount`. Everything is
 * resolved here so the socket handlers stay small and both the message and
 * the dice purge share the same rules.
 *
 * @param {unknown} mode - One of `none`, `hours`, `days`, `count` or `all`.
 * @param {unknown} amount - Custom value of the `hours`, `days` and `count` modes.
 * @returns {{ mode: string, cutoff: number|null, keep: number|null }}
 */
const parsePurgeWindow = (mode, amount) => {
  const now = Date.now();
  const value =
    typeof amount === 'number' && Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 0;

  switch (mode) {
    case 'all':
      return { mode, cutoff: null, keep: null };
    case 'hours':
      return { mode, cutoff: value > 0 ? now - value * 60 * 60 * 1000 : null, keep: null };
    case 'days':
      return { mode, cutoff: value > 0 ? now - value * 24 * 60 * 60 * 1000 : null, keep: null };
    case 'count':
      return { mode, cutoff: null, keep: value };
    default:
      return { mode: 'none', cutoff: null, keep: null };
  }
};

/**
 * Reads the timestamp of a row.
 *
 * The driver may hand the column back as a number or as a numeric string,
 * depending on the database and on the column metadata, so both are accepted.
 *
 * @param {{ date?: unknown }} row - Row to read.
 * @returns {number|null}
 */
const getRowDate = (row) => {
  const value = row?.date;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/**
 * Picks the rows that must be deleted.
 *
 * @param {Array<{ date?: unknown }>} rows - Rows ordered from newest to oldest.
 * @param {{ mode: string, cutoff: number|null, keep: number|null }} window - Resolved window.
 * @returns {Array<{ date?: unknown }>}
 */
const pickPurgeTargets = (rows, window) => {
  if (window.mode === 'all') return rows;

  // `count` deletes the N most recent rows. A missing or invalid amount is a
  // no-op, never "delete everything".
  if (window.mode === 'count') {
    const amount = window.keep ?? 0;
    if (!Number.isFinite(amount) || amount < 1) return [];
    return rows.slice(0, amount);
  }

  if (window.cutoff === null) return [];

  // `hours` and `days` delete everything inside the window, so "6 hours ago"
  // removes the last 6 hours. The comparison must be `>=`: using `<` targets
  // the opposite range and silently deletes nothing on an active room.
  return rows.filter((row) => {
    const date = getRowDate(row);
    return date !== null && date >= window.cutoff;
  });
};

/**
 * Maximum amount of ids sent in a single `advancedDelete` call.
 *
 * The purge used to delete one row per query, which is really slow on big
 * histories. Grouping the ids in buckets keeps the query count low while
 * staying well below the SQLite/PostgreSQL parameter limit.
 */
const PURGE_BUCKET_SIZE = 100;

/**
 * Splits a list into fixed size buckets.
 *
 * @template T
 * @param {T[]} items - Items to split.
 * @param {number} size - Maximum amount of items per bucket.
 * @returns {T[][]}
 */
const chunk = (items, size) => {
  const buckets = [];
  for (let i = 0; i < items.length; i += size) buckets.push(items.slice(i, i + size));
  return buckets;
};

/**
 * Builds a `roomId = ? AND (column = ? OR column = ? ...)` filter.
 *
 * The `IN` operator is not registered by the query builder, so the id list is
 * expanded into an `OR` group instead.
 *
 * @param {string} roomId - Room that owns the rows.
 * @param {string} column - Column holding the row id.
 * @param {Array<string|number>} ids - Ids to match.
 * @returns {{ group: string, conditions: Array<unknown> }}
 */
const buildIdFilter = (roomId, column, ids) => ({
  group: 'AND',
  conditions: [
    { column: 'roomId', value: roomId },
    { group: 'OR', conditions: ids.map((id) => ({ column, value: id })) },
  ],
});

/**
 * Moves the given rows to the trash table (when any) and deletes them in bulk.
 *
 * Instead of one `advancedDelete` per row, the rows are grouped in buckets and
 * every bucket is removed with a single query.
 *
 * @param {object} options - Purge options.
 * @param {string} options.table - Table that owns the rows.
 * @param {string|null} options.trashTable - Table that receives a copy of the rows.
 * @param {string} options.column - Column holding the row id.
 * @param {string} options.roomId - Room that owns the rows.
 * @param {Array<Record<string, unknown>>} options.rows - Rows to delete.
 * @returns {Promise<Array<string|number>>} The deleted ids.
 */
const purgeRows = async ({ table, trashTable, column, roomId, rows }) => {
  const source = db.getTable(table);
  const trash = trashTable ? db.getTable(trashTable) : null;
  const deletedIds = [];

  for (const bucket of chunk(rows, PURGE_BUCKET_SIZE)) {
    const items = bucket.filter((row) => typeof row[column] === 'string');
    if (items.length < 1) continue;

    const ids = items.map((row) => row[column]);

    // Copy the rows to the trash before removing them.
    if (trash)
      await trash.set(
        ids.map(() => roomId),
        items,
      );

    await source.advancedDelete(buildIdFilter(roomId, column, ids));
    deletedIds.push(...ids);
  }

  return deletedIds;
};

/**
 * @param {import('socket.io-client').Socket} socket
 * @param {import('../proxyOnConnection.mjs').EmitTo} socketTo
 * @param {import('../proxyOnConnection.mjs').EmitTo} emitTo
 */
export default function messageManager(socket, socketTo, emitTo) {
  // Large payloads are split so the browser never has to parse a huge packet.
  const streamTo = createStreamBroadcast(emitTo);
  const streamSocketTo = createStreamBroadcast(socketTo);
  socket.on('send-message', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { message, roomId, tokens, model, hash, isModel, errorCode } = data;
    // Validate values
    if (
      typeof message !== 'string' ||
      message.trim() === '' ||
      typeof roomId !== 'string' ||
      typeof isModel !== 'boolean'
    )
      return sendIncompleteDataInfo(fn);

    // Get user
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn);
    if (userMsgIsRateLimited(socket, fn)) return;

    // Check text size
    if (message.length > getIniConfig('MESSAGE_SIZE')) {
      // The text reached the limit size
      return fn({
        error: true,
        msg: `The text reached the limit size of ${getIniConfig('MESSAGE_SIZE')}.`,
        code: 1,
        numbers: [getIniConfig('MESSAGE_SIZE')],
      });
    }

    // Check if the room exist
    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    if (!room) return fn({ error: true, msg: 'Room not found.', code: 2 });

    // Check if the user is in the room
    const rUsers = roomUsers.get(roomId);
    if (!rUsers || !rUsers.get(userId))
      return fn({ error: true, code: 3, msg: 'You are not in this room.' });

    // Every new user joins as a read-only guest. The room owner must grant the
    // permission before the user is allowed to send messages.
    if (!(await canSpeakInRoom(roomId, userId, room)))
      return fn({
        error: true,
        msg: 'You are in read-only mode. Wait for the room owner to allow you to send messages.',
        code: 5,
      });

    const moderators = db.getTable('moderators');
    const roomModerators = db.getTable('roomModerators');
    if (
      !rUsers.get(room.ownerId) ||
      (room.readOnly &&
        userId !== getIniConfig('OWNER_ID') &&
        !(await moderators.has(userId)) &&
        room.ownerId !== userId &&
        !(await roomModerators.has(roomId, userId))) ||
      (isModel && userId !== getIniConfig('OWNER_ID'))
    )
      return fn({
        error: true,
        msg: `You don't have enough permissions.`,
        code: 4,
      });

    const msgDate = Date.now();
    const roomHistories = db.getTable('history');
    const msgData = {
      isModel,
      userId,
      text: message,
      date: msgDate,
      chapter: room.chapter,
      edited: 0,
    };

    if (typeof errorCode === 'string')
      msgData.errorCode = errorCode.substring(0, getIniConfig('MESSAGE_SIZE'));
    if (typeof model === 'string') msgData.model = model.substring(0, getIniConfig('MESSAGE_SIZE'));
    if (typeof tokens === 'number') msgData.tokens = tokens;
    if (typeof hash === 'string') msgData.hash = hash.substring(0, getIniConfig('MESSAGE_SIZE'));

    const msg = await roomHistories.set(roomId, msgData);

    // Emit to the room that the user joined (based on roomId)
    streamSocketTo(roomId, 'new-message', {
      roomId,
      id: msg.historyId,
      userId,
      isModel,
      chapter: room.chapter,
      text: message,
      date: msgDate,
      tokens: typeof tokens === 'number' ? msgData.tokens : null,
      hash: typeof msgData.hash === 'string' ? msgData.hash : null,
      model: typeof model === 'string' ? msgData.model : null,
      errorCode: typeof errorCode === 'string' ? msgData.errorCode : null,
      edited: 0,
    });

    // Complete
    fn({ id: msg.historyId, date: msgDate, chapter: room.chapter });
  });

  socket.on('edit-message', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId, messageId, newText, tokens, model, errorCode } = data;
    // Validate values
    if (typeof newText !== 'string' || typeof roomId !== 'string' || typeof messageId !== 'string')
      return sendIncompleteDataInfo(fn);

    // Get user
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn); // Only logged-in users can edit
    if (userMsgEditIsRateLimited(socket, fn)) return;

    // Get room
    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    if (!room) return fn({ error: true, msg: 'Room not found.', code: 1 });

    // Check if the user is in the room
    const rUsers = roomUsers.get(roomId);
    if (!rUsers || !rUsers.get(userId))
      return fn({ error: true, code: 2, msg: 'You are not in this room.' });

    // Check text size
    if (newText.length > getIniConfig('MESSAGE_SIZE')) {
      // The text reached the limit size
      return fn({
        error: true,
        msg: `The text reached the limit size of ${getIniConfig('MESSAGE_SIZE')}.`,
        code: 3,
        numbers: [getIniConfig('MESSAGE_SIZE')],
      });
    }

    // Get message
    const roomHistories = db.getTable('history');
    const msg = await roomHistories.get(roomId, messageId);
    if (!msg)
      return fn({
        error: true,
        msg: `The original message was not found.`,
        code: 4,
      });

    const moderators = db.getTable('moderators');
    const roomModerators = db.getTable('roomModerators');
    if (
      !rUsers.get(room.ownerId) ||
      ((room.readOnly || msg.userId !== userId) &&
        userId !== getIniConfig('OWNER_ID') &&
        !(await moderators.has(userId)) &&
        room.ownerId !== userId &&
        !(await roomModerators.has(roomId, userId)))
    )
      return fn({
        error: true,
        msg: `You don't have enough permissions.`,
        code: 5,
      });

    // A user that lost the permission to talk also loses the permission to edit.
    if (msg.userId === userId && !(await canSpeakInRoom(roomId, userId, room)))
      return fn({
        error: true,
        msg: 'You are in read-only mode. Wait for the room owner to allow you to send messages.',
        code: 6,
      });

    // Edit message
    const msgDate = Date.now();
    msg.text = newText;
    if (typeof tokens === 'number') msg.tokens = tokens;
    if (typeof model === 'string') msg.model = model.substring(0, getIniConfig('MESSAGE_SIZE'));
    if (typeof errorCode === 'string')
      msg.errorCode = errorCode.substring(0, getIniConfig('MESSAGE_SIZE'));
    msg.edited = msgDate;

    await roomHistories.advancedUpdate(msg, {
      historyId: { value: messageId },
      roomId: { value: roomId },
    });

    const newEvent = {
      roomId,
      id: messageId,
      userId: msg,
      text: newText,
      date: msg.date,
      edited: msgDate,
      tokens: typeof tokens === 'number' ? tokens : null,
      model: typeof model === 'string' ? model : null,
      errorCode: typeof errorCode === 'string' ? errorCode : null,
    };

    // Emit the event only to logged-in users in the room
    streamSocketTo(roomId, 'message-updated', newEvent);

    // Complete
    fn(newEvent);
  });

  socket.on('delete-message', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId, messageId } = data;
    // Validate values
    if (typeof roomId !== 'string' || typeof messageId !== 'string')
      return sendIncompleteDataInfo(fn);

    // Get user
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn); // Only logged-in users can delete
    if (userMsgDeleteIsRateLimited(socket, fn)) return;

    // Get room
    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    if (!room) return fn({ error: true, msg: 'Room not found.', code: 1 });

    // Check if the user is in the room
    const rUsers = roomUsers.get(roomId);
    if (!rUsers || !rUsers.get(userId))
      return fn({ error: true, code: 2, msg: 'You are not in this room.' });

    // Get message
    const roomHistories = db.getTable('history');
    const msg = await roomHistories.get(roomId, messageId);
    if (!msg)
      return fn({
        error: true,
        msg: `The original message was not found.`,
        code: 3,
      });

    const moderators = db.getTable('moderators');
    const roomModerators = db.getTable('roomModerators');
    if (
      msg.userId !== userId &&
      userId !== getIniConfig('OWNER_ID') &&
      !(await moderators.has(userId)) &&
      room.ownerId !== userId &&
      !(await roomModerators.has(roomId, userId))
    )
      return fn({
        error: true,
        msg: `You don't have enough permissions.`,
        code: 4,
      });

    // A read-only guest cannot delete messages, not even their own.
    if (msg.userId === userId && !(await canSpeakInRoom(roomId, userId, room)))
      return fn({
        error: true,
        msg: 'You are in read-only mode. Wait for the room owner to allow you to send messages.',
        code: 5,
      });

    // Delete message
    const roomHistoriesDeleted = db.getTable('historyDeleted');
    await roomHistoriesDeleted.set(roomId, msg);

    await roomHistories.advancedDelete({
      historyId: { value: messageId },
      roomId: { value: roomId },
    });

    // Emit the event only to logged-in users in the room
    socketTo(roomId, 'message-deleted', { roomId, id: messageId });
    fn({ success: true, roomId, id: messageId });
  });

  // Dice data
  const getDiceData = (diceSkin = {}) =>
    isJsonObject(diceSkin)
      ? {
          img:
            typeof diceSkin.img === 'string'
              ? diceSkin.img.substring(0, getIniConfig('DICE_IMG_SIZE')).trim()
              : null,
          border:
            typeof diceSkin.border === 'string'
              ? diceSkin.border.substring(0, getIniConfig('DICE_BORDER_STYLE')).trim()
              : null,
          bg:
            typeof diceSkin.bg === 'string'
              ? diceSkin.bg.substring(0, getIniConfig('DICE_BG_STYLE')).trim()
              : null,
          text:
            typeof diceSkin.text === 'string'
              ? diceSkin.text.substring(0, getIniConfig('DICE_TEXT_STYLE')).trim()
              : null,
          selectionBg:
            typeof diceSkin.selectionBg === 'string'
              ? diceSkin.selectionBg.substring(0, getIniConfig('DICE_SELECTION_BG_STYLE')).trim()
              : null,
          selectionText:
            typeof diceSkin.selectionText === 'string'
              ? diceSkin.selectionText
                  .substring(0, getIniConfig('DICE_SELECTION_TEXT_STYLE'))
                  .trim()
              : null,
        }
      : {};

  socket.on('load-messages', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId, page, perPage, text, chapter, start, end, userId } = data;

    // Validate input
    if (
      (typeof text !== 'string' && text !== null) ||
      ((typeof chapter !== 'number' || Number.isNaN(chapter) || !Number.isFinite(chapter)) &&
        chapter !== null) ||
      ((typeof start !== 'number' || Number.isNaN(start) || !Number.isFinite(start)) &&
        start !== null) ||
      ((typeof end !== 'number' || Number.isNaN(end) || !Number.isFinite(end)) && end !== null) ||
      typeof roomId !== 'string' ||
      typeof page !== 'number' ||
      (typeof userId !== 'string' && userId !== null) ||
      ((typeof perPage !== 'number' || perPage < 1) && perPage !== null) ||
      page < 1
    )
      return sendIncompleteDataInfo(fn);

    // Get user
    const yourId = userSession.getUserId(socket);
    if (!yourId) return accountNotDetected(fn);
    if (userMsgLoadIsRateLimited(socket, fn)) return;

    const loadLimit = getIniConfig('HISTORY_SIZE');
    const canLoadAll = getIniConfig('LOAD_ALL_HISTORY');

    // Check if room exists
    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    if (!room) return fn({ error: true, msg: 'Room not found.', code: 1 });

    // Check if the user is in the room
    const rUsers = roomUsers.get(roomId);
    if (!rUsers || !rUsers.get(yourId))
      return fn({ error: true, code: 2, msg: 'You are not in this room.' });

    // Read-only guests may only load the very last page of the room, so they
    // never enter an empty looking room. Everything else (filters, older pages
    // and the full history) stays restricted to the allowed users.
    const isGuest = !(await canSpeakInRoom(roomId, yourId, room));
    if (
      isGuest &&
      (page !== 1 ||
        perPage === null ||
        text !== null ||
        chapter !== null ||
        start !== null ||
        end !== null ||
        userId !== null)
    )
      return fn({
        error: true,
        msg: 'You are in read-only mode. Wait for the room owner to allow you to read the history.',
        code: 7,
      });

    let allMessages = [];
    const history = db.getTable('history');
    const order = 'date DESC';

    // Query
    const query = {
      group: 'AND',
      conditions: [{ column: 'roomId', value: roomId }],
    };

    // Text
    if (typeof text === 'string') {
      // Check text size
      if (text.length > getIniConfig('MESSAGE_SIZE')) {
        // The text reached the limit size
        return fn({
          error: true,
          msg: `The text reached the limit size of ${getIniConfig('MESSAGE_SIZE')}.`,
          code: 3,
          numbers: [getIniConfig('MESSAGE_SIZE')],
        });
      }
      query.conditions.push({ column: 'text', operator: 'LIKE', value: `%${text}%` });
    }

    // Message owner
    if (typeof userId === 'string') {
      // Check text size
      if (userId.length > getIniConfig('USER_ID_SIZE')) {
        // The userId reached the limit size
        return fn({
          error: true,
          msg: `The userId reached the limit size of ${getIniConfig('USER_ID_SIZE')}.`,
          code: 3,
          numbers: [getIniConfig('USER_ID_SIZE')],
        });
      }

      query.conditions.push({ column: 'userId', value: userId });
    }

    // Chapter
    if (typeof chapter === 'number' && chapter > 0)
      query.conditions.push({ column: 'chapter', value: chapter });

    // Date
    const existsStart = typeof start === 'number' && start > 0;
    const existsEnd = typeof end === 'number' && end > 0;

    if (existsStart || existsEnd) {
      const dateData = [];
      query.conditions.push({ group: 'AND', conditions: dateData });
      if (existsStart) dateData.push({ column: 'date', operator: '>=', value: start });
      if (existsEnd) dateData.push({ column: 'date', operator: '<=', value: end });
    }

    // Load Limit
    if (perPage !== null) {
      if (perPage > loadLimit)
        return fn({
          error: true,
          code: 4,
          msg: `You can\'t load a number bigger than ${loadLimit}!`,
        });

      if (perPage < 1)
        return fn({ error: true, code: 5, msg: `You can\'t load a number smaller than 1!` });
      allMessages = await history.search({ perPage, page, order, q: query });
    } else {
      if (!canLoadAll && room.ownerId !== yourId)
        return fn({ error: true, code: 6, msg: `You can\'t load all messages!` });
      allMessages = await history.search({ order, q: query });
    }

    // Complete
    if (Array.isArray(allMessages)) {
      fn({
        success: true,
        page: 1,
        totalItems: allMessages.length,
        totalPages: 1,
        messages: allMessages.reverse(),
      });
    } else {
      fn({
        success: true,
        page,
        totalItems: allMessages.totalItems,
        totalPages: allMessages.totalPages,
        messages: allMessages.items.reverse(),
      });
    }
  });

  socket.on('load-dice-history', async (data, fn) => {
    if (noDataInfo(data, fn)) return;

    const { roomId, page, perPage, userId, start, end } = data;

    // Validate input
    if (
      typeof roomId !== 'string' ||
      typeof page !== 'number' ||
      page < 1 ||
      (typeof perPage !== 'number' && perPage !== null) ||
      (typeof perPage === 'number' && perPage < 1 && perPage !== null) ||
      (typeof userId !== 'string' && userId !== null) ||
      ((typeof start !== 'number' || Number.isNaN(start) || !Number.isFinite(start)) &&
        start !== null) ||
      ((typeof end !== 'number' || Number.isNaN(end) || !Number.isFinite(end)) && end !== null)
    ) {
      return sendIncompleteDataInfo(fn);
    }

    // User authentication
    const yourId = userSession.getUserId(socket);
    if (!yourId) return accountNotDetected(fn);
    if (userMsgLoadIsRateLimited(socket, fn)) return;

    const loadLimit = getIniConfig('HISTORY_SIZE');

    // Check if room exists
    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    if (!room) return fn({ error: true, msg: 'Room not found.', code: 1 });

    // Check if user is in the room
    const rUsers = roomUsers.get(roomId);
    if (!rUsers || !rUsers.get(yourId))
      return fn({ error: true, code: 2, msg: 'You are not in this room.' });

    // Prepare query
    const order = 'date DESC';
    const diceHistory = db.getTable('diceHistory');

    const query = {
      group: 'AND',
      conditions: [{ column: 'roomId', value: roomId }],
    };

    // Message owner filter
    if (typeof userId === 'string') {
      if (userId.length > getIniConfig('USER_ID_SIZE')) {
        return fn({
          error: true,
          msg: `The userId reached the limit size of ${getIniConfig('USER_ID_SIZE')}.`,
          code: 3,
          numbers: [getIniConfig('USER_ID_SIZE')],
        });
      }

      query.conditions.push({ column: 'userId', value: userId });
    }

    // Date range
    const existsStart = typeof start === 'number' && start > 0;
    const existsEnd = typeof end === 'number' && end > 0;

    if (existsStart || existsEnd) {
      const dateData = [];
      query.conditions.push({ group: 'AND', conditions: dateData });

      if (existsStart) dateData.push({ column: 'date', operator: '>=', value: start });
      if (existsEnd) dateData.push({ column: 'date', operator: '<=', value: end });
    }

    // Run search
    let allData = [];

    if (perPage !== null) {
      if (perPage > loadLimit) {
        return fn({
          error: true,
          code: 4,
          msg: `You can\'t load a number bigger than ${loadLimit}!`,
        });
      }

      if (perPage < 1) {
        return fn({ error: true, code: 5, msg: `You can\'t load a number smaller than 1!` });
      }

      allData = await diceHistory.search({ perPage, page, order, q: query });
    } else return fn({ error: true, code: 6, msg: `You can\'t load all history!` });

    // Output
    if (!Array.isArray(allData)) {
      fn({
        success: true,
        page,
        totalItems: allData.totalItems,
        totalPages: allData.totalPages,
        history: allData.items.reverse(),
      });
    } else return fn({ error: true, code: 6, msg: `You can\'t load all history!` });
  });

  /**
   * Deletes every message of an user, following the window picked by the owner.
   *
   * Only the room owner and the server owner may call it. The deleted rows are
   * copied to `historyDeleted` first, exactly like `delete-message` does, so a
   * wrong purge can still be recovered from the database.
   */
  socket.on('purge-user-messages', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId, userId, mode, amount } = data;
    // Validate values
    if (typeof roomId !== 'string' || typeof userId !== 'string' || userId.length < 1)
      return sendIncompleteDataInfo(fn);

    // Get user
    const yourId = userSession.getUserId(socket);
    if (!yourId) return accountNotDetected(fn);
    if (userMsgDeleteIsRateLimited(socket, fn)) return;

    // Get room
    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    if (!room) return fn({ error: true, msg: 'Room not found.', code: 1 });

    // Only the room owner or the server owner can purge messages.
    if (yourId !== room.ownerId && yourId !== getIniConfig('OWNER_ID'))
      return fn({ error: true, msg: 'You are not allowed to do this.', code: 2 });

    const window = parsePurgeWindow(mode, amount);
    if (window.mode === 'none') return fn({ success: true, deleted: 0 });

    // Load every message of the user, newest first.
    const roomHistories = db.getTable('history');
    const rows = await roomHistories.search({
      order: 'date DESC',
      q: {
        group: 'AND',
        conditions: [
          { column: 'roomId', value: roomId },
          { column: 'userId', value: userId },
        ],
      },
    });

    const messages = Array.isArray(rows) ? rows : (rows?.items ?? []);
    const targets = pickPurgeTargets(messages, window);
    if (targets.length < 1) return fn({ success: true, deleted: 0 });

    // Move the messages to the trash and delete them in bulk.
    const deletedIds = await purgeRows({
      table: 'history',
      trashTable: 'historyDeleted',
      column: 'historyId',
      roomId,
      rows: targets,
    });

    // Emit the event only to logged-in users in the room
    if (deletedIds.length > 0)
      emitTo(roomId, 'messages-purged', { roomId, userId, ids: deletedIds });

    fn({ success: true, deleted: deletedIds.length, ids: deletedIds });
  });

  socket.on('delete-dice-roll', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId, rollId } = data;
    // Validate values
    if (typeof roomId !== 'string' || typeof rollId !== 'string') return sendIncompleteDataInfo(fn);

    // Get user
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn); // Only logged-in users can delete
    if (userMsgDeleteIsRateLimited(socket, fn)) return;

    // Get room
    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    if (!room) return fn({ error: true, msg: 'Room not found.', code: 1 });

    // Check if the user is in the room
    const rUsers = roomUsers.get(roomId);
    if (!rUsers || !rUsers.get(userId))
      return fn({ error: true, code: 2, msg: 'You are not in this room.' });

    // Get the roll
    const diceHistory = db.getTable('diceHistory');
    const roll = await diceHistory.get(roomId, rollId);
    if (!roll)
      return fn({
        error: true,
        msg: `The original dice roll was not found.`,
        code: 3,
      });

    // A dice roll is proof of what was rolled, so the author can never delete
    // it. Only the room staff can, which keeps the history trustworthy.
    const moderators = db.getTable('moderators');
    const roomModerators = db.getTable('roomModerators');
    if (
      userId !== getIniConfig('OWNER_ID') &&
      !(await moderators.has(userId)) &&
      room.ownerId !== userId &&
      !(await roomModerators.has(roomId, userId))
    )
      return fn({
        error: true,
        msg: `You don't have enough permissions.`,
        code: 4,
      });

    // Delete the roll
    await diceHistory.advancedDelete({
      id: { value: rollId },
      roomId: { value: roomId },
    });

    // Emit the event only to logged-in users in the room
    emitTo(roomId, 'dice-roll-deleted', { roomId, id: rollId });
    fn({ success: true, roomId, id: rollId });
  });

  /**
   * Deletes every dice roll of an user, following the window picked by the owner.
   */
  socket.on('purge-user-dice', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId, userId, mode, amount } = data;
    // Validate values
    if (typeof roomId !== 'string' || typeof userId !== 'string' || userId.length < 1)
      return sendIncompleteDataInfo(fn);

    // Get user
    const yourId = userSession.getUserId(socket);
    if (!yourId) return accountNotDetected(fn);
    if (userMsgDeleteIsRateLimited(socket, fn)) return;

    // Get room
    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    if (!room) return fn({ error: true, msg: 'Room not found.', code: 1 });

    // Only the room owner or the server owner can purge the dice history.
    if (yourId !== room.ownerId && yourId !== getIniConfig('OWNER_ID'))
      return fn({ error: true, msg: 'You are not allowed to do this.', code: 2 });

    const window = parsePurgeWindow(mode, amount);
    if (window.mode === 'none') return fn({ success: true, deleted: 0 });

    // Load every dice roll of the user, newest first.
    const diceHistory = db.getTable('diceHistory');
    const rows = await diceHistory.search({
      order: 'date DESC',
      q: {
        group: 'AND',
        conditions: [
          { column: 'roomId', value: roomId },
          { column: 'userId', value: userId },
        ],
      },
    });

    const rolls = Array.isArray(rows) ? rows : (rows?.items ?? []);
    const targets = pickPurgeTargets(rolls, window);
    if (targets.length < 1) return fn({ success: true, deleted: 0 });

    // Delete the rolls in bulk.
    const deletedIds = await purgeRows({
      table: 'diceHistory',
      trashTable: null,
      column: 'id',
      roomId,
      rows: targets,
    });

    // Emit the event only to logged-in users in the room
    if (deletedIds.length > 0)
      emitTo(roomId, 'dice-rolls-purged', { roomId, userId, ids: deletedIds });

    fn({ success: true, deleted: deletedIds.length, ids: deletedIds });
  });

  socket.on('set-dice', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { diceSkin } = data;
    // Validate input data
    if (!isJsonObject(diceSkin)) return sendIncompleteDataInfo(fn);

    // Get user
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn); // Only logged-in users can use dices
    if (userUpdateDiceIsRateLimited(socket, fn)) return;

    // Insert skin
    const skin = getDiceData(diceSkin);
    const usersDice = db.getTable('usersDice');
    await usersDice.set(userId, skin);
    fn({ success: true });
  });

  socket.on('roll-dice', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { canZero, dice, diceSkin, modifiers, roomId } = data;
    // Validate input data
    if (
      !Array.isArray(dice) ||
      dice.length === 0 ||
      typeof roomId !== 'string' ||
      typeof canZero !== 'boolean' ||
      !Array.isArray(modifiers) ||
      !modifiers.every(
        (item) =>
          countObj(item) === 3 &&
          typeof item.index === 'number' &&
          typeof item.original === 'string' &&
          typeof item.expression === 'string',
      )
    )
      return sendIncompleteDataInfo(fn);

    // Get user
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn); // Only logged-in users can use dices
    if (userDiceIsRateLimited(socket, fn)) return;

    // Check if the room exists
    const rUsers = roomUsers.get(roomId);
    if (!rUsers) {
      return fn({
        error: true,
        msg: 'Room not found.',
        code: 1,
      });
    }

    // You need join the room
    if (!rUsers.get(userId)) return fn({ error: true, code: 2, msg: 'You are not in this room.' });

    // Rolling dice is a way of talking, so read-only guests cannot do it.
    if (!(await canSpeakInRoom(roomId, userId)))
      return fn({
        error: true,
        msg: 'You are in read-only mode. Wait for the room owner to allow you to roll the dice.',
        code: 4,
      });

    // Dice skin
    const skin = getDiceData(diceSkin);
    if (!Object.values(skin).every((value) => typeof value === 'string')) {
      const usersDice = db.getTable('usersDice');
      const userDice = getDiceData(await usersDice.get(userId));
      if (userDice) for (const name in userDice) skin[name] = userDice[name];
    }

    // Prepare results

    const finalMods = modifiers.map((item) => ({
      index: item.index,
      expression: item.expression.substring(0, getIniConfig('MESSAGE_SIZE')),
      original: item.original.substring(0, getIniConfig('MESSAGE_SIZE')),
    }));

    /**
     * @param {number} sides
     * @param {number} index
     */
    const rollDice = (sides, index) => {
      let max = sides;
      let tinyFix = 1;
      if (canZero) {
        max++;
        tinyFix--;
      }

      return Math.floor(Math.random() * max) + tinyFix;
    };

    const diceResults = [];

    // Roll dice with different number of sides
    // Iterate over each die and roll with its respective number of sides
    for (const index in dice) {
      const sides = dice[index];
      if (typeof sides !== 'number' || sides < 0)
        return fn({ error: true, code: 3, msg: 'Invalid dice of diff sides configuration' });
      diceResults.push({ value: rollDice(sides, Number(index)), sides });
    }

    // Result
    const diceHistory = db.getTable('diceHistory');

    const result = {
      date: Date.now(),
      results: diceResults,
      modifiers: finalMods,
      skin,
      canZero,
      userId,
      roomId,
    };

    const diceData = await diceHistory.set(roomId, {
      results: diceResults,
      modifiers: finalMods,
      date: result.date,
      canZero,
      userId,
    });

    result.id = diceData.id;

    // Complete
    socketTo(roomId, 'roll-result', result);

    fn({ success: true, results: diceResults, id: diceData.id });
  });
}
