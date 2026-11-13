import { isJsonObject } from 'tiny-essentials/basics/objChecker';
import db from './sql';

import {
  userIsRateLimited,
  userSession,
  roomUsers,
  userSockets,
  createRoom,
  joinRoom,
  leaveRoom,
  ownerOnly,
  accountNotDetected,
  sendIncompleteDataInfo,
  getIniConfig,
  getHashString,
  noDataInfo,
  getJoinData,
  roomUpdateIsRateLimited,
  userLoadIsRateLimited,
  getRoomRole,
  grantRoomPermission,
  revokeRoomPermission,
  listRoomPermissions,
  ROOM_ROLES,
} from './values';

/**
 * @param {import('socket.io-client').Socket} socket
 * @param {import('../proxyOnConnection.mjs').EmitTo} emitTo
 * @param {import('../proxyOnConnection.mjs').EmitTo} socketTo
 * @param {import('../proxyOnConnection.mjs').SocketEmit} socketEmit
 */
export default function roomManager(socket, emitTo, socketTo, socketEmit) {
  socket.on('exists-room', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId } = data;
    // Validate values
    if (typeof roomId !== 'string') return sendIncompleteDataInfo(fn);

    // Get user
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn);

    // Check room
    const rooms = db.getTable('rooms');
    const result = await rooms.has(roomId);
    fn({ exists: result });
  });

  /**
   * Lists the rooms the signed-in account is allowed to see.
   *
   * `scope` accepts:
   * - `mine`: rooms owned by the account (default).
   * - `visited`: rooms the account joined before.
   * - `all`: every room of the server. Staff only.
   *
   * The list is ordered by the last message date, so the rooms with recent
   * activity always come first.
   */
  socket.on('list-rooms', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { search, scope, openOnly, page, perPage } = data;

    // Validate values
    if (
      (typeof search !== 'string' && search !== null) ||
      (typeof scope !== 'string' && scope !== null) ||
      typeof openOnly !== 'boolean' ||
      typeof page !== 'number' ||
      page < 1 ||
      typeof perPage !== 'number' ||
      perPage < 1
    )
      return sendIncompleteDataInfo(fn);

    // Get user
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn);
    if (userLoadIsRateLimited(socket, fn)) return;

    // Only the server staff can list every room of the server.
    const moderators = db.getTable('moderators');
    const isStaff = userId === getIniConfig('OWNER_ID') || (await moderators.has(userId));
    if (scope === 'all' && !isStaff) return ownerOnly(fn, 2);

    // Every room the account already joined before.
    const members = db.getTable('roomMembers');
    const memberRows = await members.search({
      q: { group: 'AND', conditions: [{ column: 'userId', value: userId }] },
    });
    const memberList = Array.isArray(memberRows) ? memberRows : (memberRows?.items ?? []);
    const visitedIds = new Set(
      memberList.map((item) => item.roomId).filter((item) => typeof item === 'string'),
    );

    // The room list is small enough to be filtered in memory, and doing it here
    // keeps the nested OR/AND conditions out of the query builder.
    const rooms = db.getTable('rooms');
    const allRooms = await rooms.getAll();
    const needle = typeof search === 'string' ? search.trim().toLowerCase() : '';
    const canSeeAll = scope === 'all';

    const roomsList = [];
    for (const item of allRooms) {
      if (typeof item?.roomId !== 'string') continue;

      // A regular account only sees the rooms it owns or already joined.
      if (!canSeeAll && item.ownerId !== userId && !visitedIds.has(item.roomId)) continue;

      // The open/closed filter is applied here so the pagination stays correct.
      if (openOnly && item.disabled) continue;

      // Search
      if (needle.length > 0) {
        const roomId = item.roomId.toLowerCase();
        const title = typeof item.title === 'string' ? item.title.toLowerCase() : '';
        if (roomId.indexOf(needle) < 0 && title.indexOf(needle) < 0) continue;
      }

      roomsList.push({
        roomId: item.roomId,
        title: typeof item.title === 'string' ? item.title : '',
        ownerId: item.ownerId,
        ownerNickname: null,
        chapter: typeof item.chapter === 'number' ? item.chapter : 1,
        users: roomUsers.get(item.roomId)?.size ?? 0,
        maxUsers: typeof item.maxUsers === 'number' ? item.maxUsers : 0,
        disabled: Boolean(item.disabled),
        readOnly: Boolean(item.readOnly),
        hasPassword: typeof item.password === 'string' && item.password.length > 0,
        isOwner: item.ownerId === userId,
        isModerator: false,
        lastMessage: null,
      });
    }

    // The last message date and the owner nickname are resolved only for the
    // rooms that are actually returned.
    const history = db.getTable('history');
    const users = db.getTable('users');
    const roomModerators = db.getTable('roomModerators');
    for (const room of roomsList) {
      const last = await history.search({
        q: { group: 'AND', conditions: [{ column: 'roomId', value: room.roomId }] },
        order: 'date DESC',
        limit: 1,
      });
      const lastItem = Array.isArray(last) ? last[0] : last?.items?.[0];
      if (typeof lastItem?.date === 'number') room.lastMessage = lastItem.date;

      const owner = await users.get(room.ownerId);
      if (owner && typeof owner.nickname === 'string') room.ownerNickname = owner.nickname;

      room.isModerator = await roomModerators.has(room.roomId, userId);
    }

    // Newest activity first, empty rooms at the end.
    roomsList.sort((a, b) => (b.lastMessage ?? 0) - (a.lastMessage ?? 0));

    // Pagination is applied after the filter, so the client always gets a full
    // page of visible rooms.
    const totalPages = Math.max(1, Math.ceil(roomsList.length / perPage));
    const start = (page - 1) * perPage;

    fn({
      success: true,
      rooms: roomsList.slice(start, start + perPage),
      page,
      totalPages,
    });
  });

  /**
   * Lists the accounts of the server.
   *
   * By default only the online users are returned. The staff can search every
   * account and/or only the banned ones.
   */
  socket.on('list-users', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { search, all, bannedOnly, page, perPage } = data;

    // Validate values
    if (
      (typeof search !== 'string' && search !== null) ||
      typeof all !== 'boolean' ||
      typeof bannedOnly !== 'boolean' ||
      typeof page !== 'number' ||
      page < 1 ||
      typeof perPage !== 'number' ||
      perPage < 1
    )
      return sendIncompleteDataInfo(fn);

    // Get user
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn);
    if (userLoadIsRateLimited(socket, fn)) return;

    // Only the server staff can list the accounts.
    const moderators = db.getTable('moderators');
    const isStaff = userId === getIniConfig('OWNER_ID') || (await moderators.has(userId));
    if (!isStaff) return ownerOnly(fn, 2);

    const users = db.getTable('users');
    const banned = db.getTable('banned');
    const query = typeof search === 'string' ? search.trim().toLowerCase() : '';

    // Source of the account list: every account or only the online ones.
    let accounts;
    if (all) {
      const rows = await users.getAll();
      accounts = (Array.isArray(rows) ? rows : []).map((row) => ({
        userId: row.userId,
        nickname: typeof row.nickname === 'string' ? row.nickname : null,
      }));
    } else {
      accounts = [];
      for (const [onlineId, onlineSocket] of userSockets) {
        const user = await users.get(onlineId);
        accounts.push({
          userId: onlineId,
          nickname: typeof user?.nickname === 'string' ? user.nickname : null,
          rooms: Array.isArray(onlineSocket?.data?.rooms) ? [...onlineSocket.data.rooms] : [],
        });
      }
    }

    const list = [];
    for (const account of accounts) {
      if (query.length > 0 && account.userId.toLowerCase().indexOf(query) < 0) continue;

      const banData = await banned.get(account.userId);
      const isBanned = Boolean(banData);
      if (bannedOnly && !isBanned) continue;

      const onlineSocket = userSockets.get(account.userId);
      list.push({
        userId: account.userId,
        nickname: account.nickname,
        online: Boolean(onlineSocket),
        rooms: account.rooms ?? (onlineSocket?.data?.rooms ? [...onlineSocket.data.rooms] : []),
        banned: isBanned,
        banReason: typeof banData?.reason === 'string' ? banData.reason : null,
        isMod: await moderators.has(account.userId),
        isOwner: account.userId === getIniConfig('OWNER_ID'),
      });
    }

    list.sort((a, b) => a.userId.localeCompare(b.userId));

    const totalPages = Math.max(1, Math.ceil(list.length / perPage));
    const start = (page - 1) * perPage;

    fn({
      success: true,
      users: list.slice(start, start + perPage),
      page,
      totalPages,
    });
  });

  socket.on('join', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId, password } = data;
    // Validate values
    if (typeof roomId !== 'string' || typeof password !== 'string')
      return sendIncompleteDataInfo(fn);

    // Get user
    const moderators = db.getTable('moderators');
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn);
    if (userIsRateLimited(socket, fn)) return;
    const isMod = await moderators.has(userId);

    // Check if the room exists
    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    if (!room) {
      //
      return fn({ error: true, msg: 'Room not found.', code: 1 });
    }
    room.maxUsers = room.maxUsers || getIniConfig('MAX_USERS_PER_ROOM');

    // The owner, the server staff and the room moderators can always enter.
    const roomModeratorsTable = db.getTable('roomModerators');
    const isRoomModerator = await roomModeratorsTable.has(roomId, userId);
    const canBypassPassword =
      userId === getIniConfig('OWNER_ID') || room.ownerId === userId || isMod || isRoomModerator;

    if (!canBypassPassword) {
      // Check if the room has a password and validate it
      if (room.password && room.password !== getHashString(password))
        return fn({ error: true, msg: 'Incorrect room password.', code: 2 });

      // Check if the room is full
      const roomUserList = roomUsers.get(roomId);
      const roomModerators = db.getTable('roomModerators');
      if (roomUserList) {
        if (!(await roomModerators.has(roomId, userId))) {
          if (roomUserList.size >= room.maxUsers)
            return fn({ error: true, msg: 'Room is full.', code: 3 });
        } else {
          const modMaxUser = Number(room.maxUsers + 2);
          if (roomUserList.size >= modMaxUser)
            return fn({ error: true, msg: 'Room is full.', code: 3 });
        }
      }

      // Check if the room is disabled
      if (room.disabled) return fn({ error: true, msg: 'Room is disabled.', code: 4 });
    }

    // Check if the user is banned
    const roomBannedUsers = db.getTable('roomBannedUsers');
    if (await roomBannedUsers.has(roomId, userId)) {
      return fn({ error: true, msg: "You're banned.", code: 5 });
    }

    // Emit chat history and settings to the user
    if (typeof room.password !== 'undefined') delete room.password;
    const usersList = roomUsers.get(roomId);
    const users = usersList ? Object.fromEntries(usersList) : {};
    if (!users[userId]) users[userId] = getJoinData(socket);

    const roomModerators = db.getTable('roomModerators');
    const privateRoomData = db.getTable('privateRoomData');
    const roomData = db.getTable('roomData');
    const rpgSchema = db.getTable('rpgSchema');

    socketEmit('room-entered', {
      roomId,
      users,
      mods: (await roomModerators.getAll()) ?? [],
      rpgSchema: (await rpgSchema.get(roomId))?.data ?? {},
      roomData: (await roomData.get(roomId))?.data ?? {},
      roomPrivateData:
        userId === room.ownerId || userId === getIniConfig('OWNER_ID')
          ? (await privateRoomData.get(roomId))?.data || {}
          : {},
      // The role decides if the client renders the message box or a
      // read-only warning. New users always start as `guest`.
      role: await getRoomRole(roomId, userId, room),
      permissions: await listRoomPermissions(roomId),
      data: room ?? {},
    });

    // Remember the room, so it shows up in the "visited" list later.
    const roomMembers = db.getTable('roomMembers');
    if (!(await roomMembers.has(roomId, userId)))
      await roomMembers.set(roomId, { userId, date: Date.now() });

    // Complete
    await joinRoom(socket, emitTo, roomId, fn);
  });

  socket.on('leave', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId } = data;
    // Validate values
    if (typeof roomId !== 'string') return sendIncompleteDataInfo(fn);

    // Get user
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn);

    // Execute leave
    const leaveStatus = await leaveRoom(socket, emitTo, roomId);
    if (!leaveStatus.success) {
      if (leaveStatus.code === 1) {
        fn({ error: true, msg: 'No Room users.', roomId, code: 1 });
      } else if (leaveStatus.code === 2)
        fn({ error: true, msg: "You're not in the room.", roomId, code: 2 });
      else if (leaveStatus.code === 3) fn({ error: true, msg: 'Invalid data.', roomId, code: 3 });
    } else fn({ success: true });
  });

  socket.on('ban-from-room', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { userId, roomId } = data;
    // Validate values
    if (typeof userId !== 'string' || typeof roomId !== 'string') return sendIncompleteDataInfo(fn);

    // Get user
    const yourId = userSession.getUserId(socket);
    if (!yourId) return accountNotDetected(fn); // Only logged-in users can use it
    if (userIsRateLimited(socket, fn)) return;

    // Check if the room exists
    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    if (!room) {
      return fn({
        error: true,
        msg: 'Room not found.',
        code: 1,
      });
    }

    // Check if user is server owner or server mod
    const moderators = db.getTable('moderators');
    const roomModerators = db.getTable('roomModerators');
    if (
      (yourId !== getIniConfig('OWNER_ID') &&
        !(await moderators.has(yourId)) &&
        room.ownerId !== yourId &&
        !(await roomModerators.has(roomId, yourId))) ||
      userId === room.ownerId ||
      userId === getIniConfig('OWNER_ID')
    ) {
      return fn({
        msg: 'You are not allowed to do this.',
        error: true,
        code: 2,
      });
    }

    // Check if user exists
    const users = db.getTable('users');
    if (!(await users.has(userId))) {
      return fn({
        error: true,
        msg: 'User not found.',
        code: 3,
      });
    }

    // Add into the ban list
    const roomBannedUsers = db.getTable('roomBannedUsers');
    await roomBannedUsers.set(roomId, { userId });

    // A banned user must lose the permission to talk in the room.
    await revokeRoomPermission(roomId, userId);

    // Remove the user from their room
    emitTo(roomId, 'user-banned', { roomId, userId });
    await leaveRoom(userSockets.get(userId), emitTo, roomId);

    // User ban successfully.
    fn({ success: true });
  });

  socket.on('unban-from-room', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { userId, roomId } = data;
    // Validate values
    if (typeof userId !== 'string' || typeof roomId !== 'string') return sendIncompleteDataInfo(fn);

    // Get user
    const yourId = userSession.getUserId(socket);
    if (!yourId) return accountNotDetected(fn); // Only logged-in users can use it
    if (userIsRateLimited(socket, fn)) return;

    // Check if the room exists
    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    if (!room) {
      return fn({
        error: true,
        msg: 'Room not found.',
        code: 1,
      });
    }

    // Check if user is server owner or server mod
    const moderators = db.getTable('moderators');
    const roomModerators = db.getTable('roomModerators');
    if (
      yourId !== getIniConfig('OWNER_ID') &&
      !(await moderators.has(yourId)) &&
      room.ownerId !== yourId &&
      !(await roomModerators.has(roomId, yourId))
    ) {
      return fn({
        error: true,
        msg: 'You are not allowed to do this.',
        code: 2,
      });
    }

    // Check if user exists
    const users = db.getTable('users');
    if (!(await users.has(userId))) {
      return fn({ error: true, msg: 'User not found.', code: 3 });
    }

    // Remove user from the ban list
    const roomBannedUsers = db.getTable('roomBannedUsers');
    await roomBannedUsers.delete(roomId, userId);

    // User unban successfully.
    fn({ success: true });
  });

  socket.on('kick-from-room', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { userId, roomId } = data;
    // Validate values
    if ((typeof userId !== 'string' && !Array.isArray(userId)) || typeof roomId !== 'string')
      return sendIncompleteDataInfo(fn);

    // Get user
    const yourId = userSession.getUserId(socket);
    if (!yourId) return accountNotDetected(fn); // Only logged-in users can use it
    if (userIsRateLimited(socket, fn)) return;

    // Check if the room exists
    const room = roomUsers.get(roomId);
    if (!room) {
      return fn({ error: true, msg: 'Room not found.', code: 1 });
    }

    // Check if user is server owner or server mod
    const moderators = db.getTable('moderators');
    const roomModerators = db.getTable('roomModerators');
    if (
      yourId !== getIniConfig('OWNER_ID') &&
      !(await moderators.has(yourId)) &&
      room.ownerId !== yourId &&
      !(await roomModerators.has(roomId, yourId))
    ) {
      return fn({
        error: true,
        msg: 'You are not allowed to do this.',
        code: 4,
      });
    }

    // User list
    const userIds = [];
    if (typeof userId === 'string') userIds.push(userId);
    else
      for (const index in userId)
        if (typeof userId[index] === 'string') userIds.push(userId[index]);

    // Remove the user from their room
    const kickResults = { success: true, data: [] };
    const kickPromises = [];
    for (const userId of userIds) {
      const kickResult = { userId };
      if (userId !== room.ownerId && userId !== getIniConfig('OWNER_ID')) {
        const theKick = leaveRoom(userSockets.get(userId), emitTo, roomId);
        theKick.then((kickStatus) => {
          if (!kickStatus.success) {
            if (kickStatus.code === 2) {
              kickResult.code = 2;
              kickResult.error = true;
              kickResult.msg = 'User not found.';
            } else if (kickStatus.code === 3) {
              kickResult.code = 3;
              kickResult.error = true;
              kickResult.msg = 'Invalid data.';
            }
          } else {
            kickResult.success = true;
            emitTo(roomId, 'user-kicked', { roomId, userId });
          }
          kickResults.data.push(kickResult);
        });
        kickPromises.push(theKick);
      } else {
        kickResult.code = 4;
        kickResult.error = true;
        kickResult.msg = 'You are not allowed to do this.';
        kickResults.data.push(kickResult);
      }
    }
    await Promise.all(kickPromises);

    // Complete
    fn(kickResults);
  });

  socket.on('create-room', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId, password, title } = data;
    // Validate values
    if (typeof roomId !== 'string' || typeof password !== 'string' || typeof title !== 'string')
      return sendIncompleteDataInfo(fn);

    // Get user
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn); // Only logged-in users can use it
    if (userIsRateLimited(socket, fn)) return;

    if (roomId.length < 1)
      return fn({
        error: true,
        code: 2,
        msg: 'Your room id does not have the minimum number of characters.',
      });

    // Check if the room exists
    const rooms = db.getTable('rooms');
    let room = await rooms.get(roomId);
    if (!room) {
      await createRoom(userId, roomId, password, title);
      return fn({ success: true });
    }

    // Room exists
    fn({
      error: true,
      msg: 'This room already exists.',
      code: 1,
    });
  });

  socket.on('delete-room', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId, password } = data;
    // Validate values
    if (typeof roomId !== 'string' || typeof password !== 'string')
      return sendIncompleteDataInfo(fn);

    // Get user
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn); // Only logged-in users can use it
    if (userIsRateLimited(socket, fn)) return;

    // Check if the room exists
    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    const rUsers = roomUsers.get(roomId);
    if (!room) {
      return fn({
        error: true,
        msg: 'Room not found.',
        code: 1,
      });
    }

    // Check if user is server owner or server mod
    const moderators = db.getTable('moderators');
    if (
      userId !== getIniConfig('OWNER_ID') &&
      !(await moderators.has(userId)) &&
      room.ownerId !== userId
    ) {
      return fn({
        error: true,
        msg: 'You are not allowed to do this.',
        code: 2,
      });
    }

    // Validate password
    const users = db.getTable('users');
    const user = await users.get(userId);
    if (user.password !== getHashString(password))
      return fn({
        error: true,
        code: 3,
        msg: 'Your password is incorrect.',
      });

    // Disconnect user from rooms
    if (rUsers) {
      const leaves = [];
      rUsers.forEach((userData, tUser) => {
        leaves.push(leaveRoom(userSockets.get(tUser), emitTo, roomId));
      });
      await Promise.all(leaves);
      roomUsers.delete(roomId);
    }

    if (await rooms.has(roomId)) await rooms.delete(roomId);

    // Room delete successfully.
    fn({ success: true });
  });

  socket.on('disable-readonly-room', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId } = data;
    // Validate values
    if (typeof roomId !== 'string') return sendIncompleteDataInfo(fn);

    // Get user
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn); // Only logged-in users can use it
    if (userIsRateLimited(socket, fn)) return;

    // Check if the room exists
    const rooms = db.getTable('rooms');
    const rUsers = roomUsers.get(roomId);
    const room = await rooms.get(roomId);
    if (!rUsers || !room) {
      return fn({
        error: true,
        msg: 'Room not found.',
        code: 1,
      });
    }

    // Check if user is server owner or server mod
    const moderators = db.getTable('moderators');
    if (
      userId !== getIniConfig('OWNER_ID') &&
      !(await moderators.has(userId)) &&
      room.ownerId !== userId
    ) {
      return fn({
        error: true,
        msg: 'You are not allowed to do this.',
        code: 2,
      });
    }

    // Change room status
    await rooms.update(roomId, { readOnly: false });

    // Notify all users in the room about the updated settings
    const newRoom = await rooms.get(roomId);
    if (typeof newRoom.password !== 'undefined') delete newRoom.password;
    emitTo(roomId, 'room-updated', { data: newRoom, roomId });

    // Room disabled successfully.
    fn({ success: true });
  });

  socket.on('enable-readonly-room', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId } = data;
    // Validate values
    if (typeof roomId !== 'string') return sendIncompleteDataInfo(fn);

    // Get user
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn); // Only logged-in users can use it
    if (userIsRateLimited(socket, fn)) return;

    // Check if the room exists
    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    if (!room) {
      return fn({
        error: true,
        msg: 'Room not found.',
        code: 1,
      });
    }

    // Check if user is server owner or server mod
    const moderators = db.getTable('moderators');
    if (
      userId !== getIniConfig('OWNER_ID') &&
      !(await moderators.has(userId)) &&
      room.ownerId !== userId
    ) {
      return fn({
        error: true,
        msg: 'You are not allowed to do this.',
        code: 2,
      });
    }

    // Enable room back
    await rooms.update(roomId, { readOnly: true });

    // Notify all users in the room about the updated settings
    const newRoom = await rooms.get(roomId);
    if (typeof newRoom.password !== 'undefined') delete newRoom.password;
    emitTo(roomId, 'room-updated', { data: newRoom, roomId });

    // Room enabled successfully.
    fn({ success: true });
  });

  socket.on('disable-room', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId } = data;
    // Validate values
    if (typeof roomId !== 'string') return sendIncompleteDataInfo(fn);

    // Get user
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn); // Only logged-in users can use it
    if (userIsRateLimited(socket, fn)) return;

    // Check if the room exists
    const rooms = db.getTable('rooms');
    const rUsers = roomUsers.get(roomId);
    const room = await rooms.get(roomId);
    if (!rUsers || !room) {
      return fn({
        error: true,
        msg: 'Room not found.',
        code: 1,
      });
    }

    // Check if user is server owner or server mod
    const moderators = db.getTable('moderators');
    if (
      userId !== getIniConfig('OWNER_ID') &&
      !(await moderators.has(userId)) &&
      room.ownerId !== userId
    ) {
      return fn({
        error: true,
        msg: 'You are not allowed to do this.',
        code: 2,
      });
    }

    // Change room status
    await rooms.update(roomId, { disabled: true });

    // Disconnect user from rooms
    const leaves = [];
    rUsers.forEach((userData, tUser) => {
      if (tUser !== getIniConfig('OWNER_ID') && tUser !== room.ownerId)
        leaves.push(leaveRoom(userSockets.get(tUser), emitTo, roomId));
    });
    await Promise.all(leaves);

    // Room disabled successfully.
    fn({ success: true });
  });

  socket.on('enable-room', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId } = data;
    // Validate values
    if (typeof roomId !== 'string') return sendIncompleteDataInfo(fn);

    // Get user
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn); // Only logged-in users can use it
    if (userIsRateLimited(socket, fn)) return;

    // Check if the room exists
    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    if (!room) {
      return fn({
        error: true,
        msg: 'Room not found.',
        code: 1,
      });
    }

    // Check if user is server owner or server mod
    const moderators = db.getTable('moderators');
    if (
      userId !== getIniConfig('OWNER_ID') &&
      !(await moderators.has(userId)) &&
      room.ownerId !== userId
    ) {
      return fn({
        error: true,
        msg: 'You are not allowed to do this.',
        code: 2,
      });
    }

    // Enable room back
    await rooms.update(roomId, { disabled: false });

    // Room enabled successfully.
    fn({ success: true });
  });

  socket.on('room-add-mod', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId, mods } = data;
    // Validate values
    if (typeof roomId !== 'string' || !Array.isArray(mods)) return sendIncompleteDataInfo(fn);

    // Get user
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn); // Only logged-in users can update settings
    if (userIsRateLimited(socket, fn)) return;

    // Get room
    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    if (!room) return fn({ error: true, msg: 'Room not found.', code: 1 }); // Room does not exist

    // Check if the user is the room owner or the server owner
    const isRoomOwner = userId === room.ownerId;
    const isServerOwner = userId === getIniConfig('OWNER_ID'); // 'getIniConfig('OWNER_ID')' refers to the server owner

    if (!isRoomOwner && !isServerOwner) return ownerOnly(fn, 2); // Only room owner or server owner can update settings

    const result = [];
    const roomModerators = db.getTable('roomModerators');
    if (roomUsers.get(roomId)) {
      for (const index in mods) {
        if (typeof mods[index] === 'string') {
          await roomModerators.set(roomId, { userId: mods[index] });
          result.push(mods[index]);
        }
      }
    }

    // Notify all users in the room about the updated settings
    emitTo(roomId, 'room-mod-updated', { result, type: 'add', roomId });

    // Complete
    fn({ success: true });
  });

  socket.on('room-remove-mod', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId, mods } = data;
    // Validate values
    if (typeof roomId !== 'string' || !Array.isArray(mods)) return sendIncompleteDataInfo(fn);

    // Get user
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn); // Only logged-in users can update settings
    if (userIsRateLimited(socket, fn)) return;

    // Get room
    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    if (!room) return fn({ error: true, msg: 'Room not found.', code: 1 }); // Room does not exist

    // Check if the user is the room owner or the server owner
    const isRoomOwner = userId === room.ownerId;
    const isServerOwner = userId === getIniConfig('OWNER_ID'); // 'getIniConfig('OWNER_ID')' refers to the server owner

    if (!isRoomOwner && !isServerOwner) return ownerOnly(fn, 2); // Only room owner or server owner can update settings

    const result = [];
    const roomModerators = db.getTable('roomModerators');
    for (const index in mods) {
      if (typeof mods[index] === 'string') {
        await roomModerators.delete(roomId, mods[index]);
        result.push(mods[index]);
      }
    }

    // Notify all users in the room about the updated settings
    emitTo(roomId, 'room-mod-updated', { result, type: 'remove', roomId });

    // Complete
    fn({ success: true });
  });

  socket.on('room-grant-permission', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId, userIds } = data;
    // Validate values
    if (typeof roomId !== 'string' || !Array.isArray(userIds)) return sendIncompleteDataInfo(fn);

    // Get user
    const yourId = userSession.getUserId(socket);
    if (!yourId) return accountNotDetected(fn); // Only logged-in users can update settings
    if (roomUpdateIsRateLimited(socket, fn)) return;

    // Get room
    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    if (!room) return fn({ error: true, msg: 'Room not found.', code: 1 });

    // Only the room owner or the server owner can grant permissions.
    if (yourId !== room.ownerId && yourId !== getIniConfig('OWNER_ID')) return ownerOnly(fn, 2);

    // Grant the permission to every valid user.
    const result = [];
    for (const index in userIds) {
      const userId = userIds[index];
      if (typeof userId !== 'string' || userId.length < 1) continue;
      await grantRoomPermission(roomId, userId, yourId);
      result.push(userId);
    }

    // Notify all users in the room about the updated permissions.
    if (result.length > 0)
      emitTo(roomId, 'room-permission-updated', {
        roomId,
        type: 'grant',
        users: result,
        permissions: await listRoomPermissions(roomId),
      });

    // Complete
    fn({ success: true, users: result });
  });

  socket.on('room-revoke-permission', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId, userIds } = data;
    // Validate values
    if (typeof roomId !== 'string' || !Array.isArray(userIds)) return sendIncompleteDataInfo(fn);

    // Get user
    const yourId = userSession.getUserId(socket);
    if (!yourId) return accountNotDetected(fn); // Only logged-in users can update settings
    if (roomUpdateIsRateLimited(socket, fn)) return;

    // Get room
    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    if (!room) return fn({ error: true, msg: 'Room not found.', code: 1 });

    // Only the room owner or the server owner can revoke permissions.
    if (yourId !== room.ownerId && yourId !== getIniConfig('OWNER_ID')) return ownerOnly(fn, 2);

    // Revoke the permission from every valid user.
    const result = [];
    for (const index in userIds) {
      const userId = userIds[index];
      if (typeof userId !== 'string' || userId.length < 1) continue;
      await revokeRoomPermission(roomId, userId);
      result.push(userId);
    }

    // Notify all users in the room about the updated permissions.
    if (result.length > 0)
      emitTo(roomId, 'room-permission-updated', {
        roomId,
        type: 'revoke',
        users: result,
        permissions: await listRoomPermissions(roomId),
      });

    // Complete
    fn({ success: true, users: result });
  });

  socket.on('room-permissions', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId } = data;
    // Validate values
    if (typeof roomId !== 'string') return sendIncompleteDataInfo(fn);

    // Get user
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn);

    // Get room
    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    if (!room) return fn({ error: true, msg: 'Room not found.', code: 1 });

    // Complete
    fn({
      success: true,
      role: await getRoomRole(roomId, userId, room),
      permissions: await listRoomPermissions(roomId),
      roles: ROOM_ROLES,
    });
  });

  socket.on('update-room', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId, newSettings } = data;
    // Validate values
    if (typeof roomId !== 'string' || !isJsonObject(newSettings)) return sendIncompleteDataInfo(fn);

    // Get user
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn); // Only logged-in users can update settings
    if (roomUpdateIsRateLimited(socket, fn)) return;

    // Get room
    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    if (!room) return fn({ error: true, msg: 'Room not found.', code: 1 }); // Room does not exist

    // Check if the user is the room owner or the server owner
    const isRoomOwner = userId === room.ownerId;
    const isServerOwner = userId === getIniConfig('OWNER_ID'); // 'getIniConfig('OWNER_ID')' refers to the server owner

    if (!isRoomOwner && !isServerOwner) return ownerOnly(fn, 2); // Only room owner or server owner can update settings

    // Allowed updates
    const allowedUpdates = {};

    const checkRealValues = (where, value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return;
      const MIN_REAL = -3.4e38;
      const MAX_REAL = 3.4e38;

      // Check interval
      if (value < MIN_REAL || value > MAX_REAL) return;

      // Check accuracy: maximum ~7 significant digits
      const significantDigits = parseFloat(value.toPrecision(7));

      // Insert config
      if (value === significantDigits) allowedUpdates[where] = value;
    };

    if ('firstDialogue' in newSettings) {
      if (typeof newSettings.firstDialogue === 'string')
        allowedUpdates.firstDialogue = newSettings.firstDialogue.substring(
          0,
          getIniConfig('MESSAGE_SIZE'),
        );
    }

    if ('prompt' in newSettings) {
      if (typeof newSettings.prompt === 'string')
        allowedUpdates.prompt = newSettings.prompt.substring(0, getIniConfig('ROOM_PROMPT'));
    }

    if ('systemInstruction' in newSettings) {
      if (typeof newSettings.systemInstruction === 'string')
        allowedUpdates.systemInstruction = newSettings.systemInstruction.substring(
          0,
          getIniConfig('ROOM_SYSTEM_INSTRUCTION'),
        );
    }

    if ('firstDialogue' in newSettings) {
      if (typeof newSettings.firstDialogue === 'string')
        allowedUpdates.firstDialogue = newSettings.firstDialogue.substring(
          0,
          getIniConfig('ROOM_FIRST_DIALOGUE'),
        );
    }

    if ('title' in newSettings) {
      if (typeof newSettings.title === 'string')
        allowedUpdates.title = newSettings.title.substring(0, getIniConfig('ROOM_TITLE_SIZE'));
    }

    if ('password' in newSettings) {
      if (typeof newSettings.password === 'string')
        allowedUpdates.password = getHashString(
          newSettings.password.substring(0, getIniConfig('PASSWORD_SIZE')),
        );
    }

    if ('model' in newSettings) {
      if (typeof newSettings.model === 'string')
        allowedUpdates.model = newSettings.model.substring(0, getIniConfig('MODEL_ID_SIZE'));
    }

    if ('maxOutputTokens' in newSettings)
      checkRealValues('maxOutputTokens', newSettings.maxOutputTokens);
    if ('temperature' in newSettings) checkRealValues('temperature', newSettings.temperature);
    if ('topP' in newSettings) checkRealValues('topP', newSettings.topP);
    if ('topK' in newSettings) checkRealValues('topK', newSettings.topK);
    if ('presencePenalty' in newSettings)
      checkRealValues('presencePenalty', newSettings.presencePenalty);
    if ('frequencyPenalty' in newSettings)
      checkRealValues('frequencyPenalty', newSettings.frequencyPenalty);

    if ('maxUsers' in newSettings) {
      if (
        typeof newSettings.maxUsers === 'number' &&
        !Number.isNaN(newSettings.maxUsers) &&
        Number.isFinite(newSettings.maxUsers)
      ) {
        allowedUpdates.maxUsers = newSettings.maxUsers;
        if (allowedUpdates.maxUsers > getIniConfig('MAX_USERS_PER_ROOM'))
          allowedUpdates.maxUsers = getIniConfig('MAX_USERS_PER_ROOM');
        else if (allowedUpdates.maxUsers < 1) allowedUpdates.maxUsers = 1;
      }
    }

    if ('chapter' in newSettings) {
      if (
        typeof newSettings.chapter === 'number' &&
        !Number.isNaN(newSettings.chapter) &&
        Number.isFinite(newSettings.chapter) &&
        newSettings.chapter >= 1
      ) {
        allowedUpdates.chapter = newSettings.chapter;
      }
    }

    // Apply updates if there are valid changes
    if (Object.keys(allowedUpdates).length > 0) {
      await rooms.update(roomId, allowedUpdates);

      // Notify all users in the room about the updated settings
      const newRoom = await rooms.get(roomId);
      if (typeof newRoom.password !== 'undefined') delete newRoom.password;
      emitTo(roomId, 'room-updated', { data: newRoom, roomId });
    }

    // Complete
    fn({ success: true });
  });

  socket.on('update-room-data', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId, isPrivate, values } = data;
    // Validate values
    if (typeof roomId !== 'string' || !isJsonObject(values) || typeof isPrivate !== 'boolean')
      return sendIncompleteDataInfo(fn);

    // Get user
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn); // Only logged-in users can update settings
    if (roomUpdateIsRateLimited(socket, fn)) return;

    // Get room
    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    if (!room) return fn({ error: true, msg: 'Room not found.', code: 1 });

    // Check if the user is the owner of the room or the server owner
    if (userId !== room.ownerId && userId !== getIniConfig('OWNER_ID')) {
      return fn({
        error: true,
        msg: `You do not have permission to update this room${isPrivate ? ' private' : ''} data.`,
        code: 2,
      });
    }

    // Update the room data
    if (isPrivate) {
      const privateRoomData = db.getTable('privateRoomData');
      await privateRoomData.set(roomId, { data: values });
    }
    // Nope
    else {
      const roomData = db.getTable('roomData');
      await roomData.set(roomId, { data: values });
      // Notify all users in the room about the updated data
      const result = await roomData.get(roomId);
      socketTo(roomId, 'room-data-updated', {
        roomId,
        isPrivate: false,
        values: result?.data ?? {},
      });
    }

    // Complete
    fn({ success: true });
  });

  socket.on('update-rpg-schema', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId, values } = data;
    // Validate values
    if (typeof roomId !== 'string' || !isJsonObject(values)) return sendIncompleteDataInfo(fn);

    // Get user
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn); // Only logged-in users can update settings
    if (roomUpdateIsRateLimited(socket, fn)) return;

    // Get room
    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    if (!room) return fn({ error: true, msg: 'Room not found.', code: 1 });

    // Check if the user is the owner of the room or the server owner
    if (userId !== room.ownerId && userId !== getIniConfig('OWNER_ID')) {
      return fn({
        error: true,
        msg: `You do not have permission to update this room schema.`,
        code: 2,
      });
    }

    const rpgSchema = db.getTable('rpgSchema');
    await rpgSchema.set(roomId, { data: values });
    // Notify all users in the room about the updated data
    const result = await rpgSchema.get(roomId);
    socketTo(roomId, 'rpg-schema-updated', {
      roomId,
      values: result?.data ?? {},
    });

    // Complete
    fn({ success: true });
  });
}
