import db from './sql';
import {
  userIsRateLimited,
  userSession,
  createAccount,
  getHashString,
  findUser,
  roomUsers,
  userSockets,
  sendIncompleteDataInfo,
  accountNotDetected,
  getIniConfig,
  leaveRoom,
  getRateLimit,
  noDataInfo,
} from './values';

/**
 * @param {import('socket.io-client').Socket} socket
 * @param {import('../proxyOnConnection.mjs').EmitTo} emitTo
 */
export default function userManager(socket, emitTo) {
  socket.on('user-is-mod', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { userId } = data;
    // Validate values
    if (typeof userId !== 'string') return sendIncompleteDataInfo(fn);

    // Get user
    const yourId = userSession.getUserId(socket);
    if (!yourId) return accountNotDetected(fn); // Only logged-in users can use it
    if (userIsRateLimited(socket, fn)) return;

    // Check if user exists
    const moderators = db.getTable('moderators');
    const users = await moderators.search({
      q: {
        group: 'OR',
        conditions: [
          { column: 'userId', value: userId },
          { column: 'userId', value: yourId },
        ],
      },
    });

    const userIsOwner = userId === getIniConfig('OWNER_ID');
    const mod = users.find((item) => item.userId === userId);
    if (!mod) return fn({ result: false, isOwner: userIsOwner });
    const result = { result: true, isOwner: userIsOwner };

    // Check if user is server owner or server mod
    if (yourId === getIniConfig('OWNER_ID') || users.find((item) => item.userId === yourId)) {
      result.date = mod.date;
      result.reason = mod.reason;
    }

    // User detected successfully.
    fn(result);
  });

  socket.on('user-is-owner', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { userId } = data;
    // Validate values
    if (typeof userId !== 'string') return sendIncompleteDataInfo(fn);

    // Get user
    const yourId = userSession.getUserId(socket);
    if (!yourId) return accountNotDetected(fn); // Only logged-in users can use it
    if (userIsRateLimited(socket, fn)) return;

    // Check if user is owner
    fn({ result: userId === getIniConfig('OWNER_ID') });
  });

  /**
   * Promotes an account to server staff.
   *
   * Only the server owner can promote or demote the staff.
   */
  socket.on('add-mod', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { userId } = data;
    // Validate values
    if (typeof userId !== 'string') return sendIncompleteDataInfo(fn);

    // Get user
    const yourId = userSession.getUserId(socket);
    if (!yourId) return accountNotDetected(fn);
    if (userIsRateLimited(socket, fn)) return;

    // Only the server owner can promote accounts.
    if (yourId !== getIniConfig('OWNER_ID')) return ownerOnly(fn, 1);

    // Check if user exists
    const users = db.getTable('users');
    if (!(await users.has(userId))) {
      return fn({ error: true, msg: 'User not found.', code: 2 });
    }

    // Add into the staff list
    const moderators = db.getTable('moderators');
    if (!(await moderators.has(userId)))
      await moderators.set(userId, { date: Date.now() });

    fn({ success: true });
  });

  /**
   * Removes the server staff from an account.
   */
  socket.on('remove-mod', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { userId } = data;
    // Validate values
    if (typeof userId !== 'string') return sendIncompleteDataInfo(fn);

    // Get user
    const yourId = userSession.getUserId(socket);
    if (!yourId) return accountNotDetected(fn);
    if (userIsRateLimited(socket, fn)) return;

    // Only the server owner can demote accounts.
    if (yourId !== getIniConfig('OWNER_ID')) return ownerOnly(fn, 1);

    // Remove from the staff list
    const moderators = db.getTable('moderators');
    if (await moderators.has(userId)) await moderators.delete(userId);

    fn({ success: true });
  });

  socket.on('ban', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { userId, reason } = data;
    // Validate values
    if (typeof userId !== 'string' || typeof reason !== 'string') return sendIncompleteDataInfo(fn);

    // Get user
    const yourId = userSession.getUserId(socket);
    if (!yourId) return accountNotDetected(fn); // Only logged-in users can use it
    if (userIsRateLimited(socket, fn)) return;

    // Check if user is server owner or server mod
    const moderators = db.getTable('moderators');
    if (yourId !== getIniConfig('OWNER_ID') && !(await moderators.has(yourId))) {
      return fn({ error: true, msg: 'You are not allowed to do this.', code: 1 });
    }

    // The server owner can never be banned.
    if (userId === getIniConfig('OWNER_ID')) {
      return fn({ error: true, msg: 'The server owner cannot be banned.', code: 3 });
    }

    // Check if user exists
    const users = db.getTable('users');
    if (!(await users.has(userId))) {
      return fn({ error: true, msg: 'User not found.', code: 2 });
    }

    // Disconnect user
    if (userSockets.has(userId)) userSockets.get(userId).disconnect(true);

    // Add into the ban list
    const bannedUsers = db.getTable('banned');
    await bannedUsers.set(userId, { date: Date.now(), reason });

    // User ban successfully.
    fn({ success: true });
  });

  socket.on('unban', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { userId } = data;
    // Validate values
    if (typeof userId !== 'string') return sendIncompleteDataInfo(fn);

    // Get user
    const yourId = userSession.getUserId(socket);
    if (!yourId) return accountNotDetected(fn); // Only logged-in users can use it
    if (userIsRateLimited(socket, fn)) return;

    // Check if user is server owner or server mod
    const moderators = db.getTable('moderators');
    if (yourId !== getIniConfig('OWNER_ID') && !(await moderators.has(yourId))) {
      return fn({ error: true, msg: 'You are not allowed to do this.', code: 1 });
    }

    // Check if user exists
    const users = db.getTable('users');
    if (!(await users.has(userId))) {
      return fn({ error: true, msg: 'User not found.', code: 2 });
    }

    // Remove user from the ban list
    const bannedUsers = db.getTable('banned');
    await bannedUsers.delete(userId);

    // User unban successfully.
    fn({ success: true });
  });

  socket.on('kick', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { userId } = data;
    // Validate values
    if (typeof userId !== 'string' && !Array.isArray(userId)) return sendIncompleteDataInfo(fn);

    // Get user
    const yourId = userSession.getUserId(socket);
    if (!yourId) return accountNotDetected(fn); // Only logged-in users can use it
    if (userIsRateLimited(socket, fn)) return;

    // Check if user is server owner or server mod
    const moderators = db.getTable('moderators');
    if (yourId !== getIniConfig('OWNER_ID') && !(await moderators.has(yourId))) {
      return fn({ error: true, msg: 'You are not allowed to do this.', code: 1 });
    }

    // User list
    const userIds = [];
    if (typeof userId === 'string') userIds.push(userId);
    else
      for (const index in userId)
        if (typeof userId[index] === 'string') userIds.push(userId[index]);

    // Disconnect user
    const kickResults = { success: true, data: [] };
    for (const userId of userIds) {
      const kickResult = {};
      if (userSockets.has(userId)) {
        userSockets.get(userId).disconnect(true);
        kickResult.success = true;
      } else {
        kickResult.error = true;
        kickResult.msg = 'User not found.';
        kickResult.code = 2;
      }
      kickResults.data.push(kickResult);
    }

    // User kick successfully.
    fn(kickResults);
  });

  socket.on('change-password', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { oldPassword, password } = data;
    // Validate values
    if (typeof password !== 'string' || typeof oldPassword !== 'string')
      return sendIncompleteDataInfo(fn);

    // Get user
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn); // Only logged-in users can use it
    if (userIsRateLimited(socket, fn)) return;
    const users = db.getTable('users');
    const user = await users.get(userId);

    // Validate password
    if (user.password !== getHashString(oldPassword))
      return fn({
        error: true,
        code: 2,
        msg: 'Your current password is incorrect.',
      });

    if (password.length < getIniConfig('MIN_PASSWORD_SIZE'))
      return fn({
        error: true,
        code: 1,
        msg: 'Your password does not have the minimum number of characters.',
      });

    // Change password
    await users.update(userId, {
      password: getHashString(password.substring(0, getIniConfig('PASSWORD_SIZE'))),
    });

    // User unban successfully.
    fn({ success: true });
  });

  socket.on('change-nickname', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { nickname } = data;
    // Validate values
    if (typeof nickname !== 'string') return sendIncompleteDataInfo(fn);

    // Get user
    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn); // Only logged-in users can use it
    if (userIsRateLimited(socket, fn)) return;
    const users = db.getTable('users');

    // Change nickname
    await users.update(userId, { nickname: nickname.substring(0, getIniConfig('NICKNAME_SIZE')) });
    const user = await users.get(userId);

    const tinyPromises = [];
    userSession.setNickname(socket, user.nickname);
    userSession.eachRooms(socket, (roomId) =>
      tinyPromises.push(
        emitTo(roomId, 'user-updated', { roomId, userId, data: { nickname: user.nickname } }),
      ),
    );

    await Promise.all(tinyPromises);

    // User unban successfully.
    fn({ nickname: user.nickname });
  });

  socket.on('register', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { userId, password, nickname } = data;
    // Validate values
    if (typeof userId !== 'string' || typeof password !== 'string' || typeof nickname !== 'string')
      return sendIncompleteDataInfo(fn);

    if (userId !== userId.toLowerCase())
      return fn({
        error: true,
        code: 5,
        msg: 'User id must be lowercase.',
      });

    // Check User
    if (userIsRateLimited(socket, fn, true)) return;

    if (
      !getIniConfig('OPEN_REGISTRATION') &&
      userSession.getUserId(socket) !== getIniConfig('OWNER_ID')
    ) {
      return fn({ error: true, code: 2, msg: 'Only the owner can create accounts.' });
    }

    const users = db.getTable('users');
    if (await users.has(userId)) {
      return fn({ error: true, code: 1, msg: 'User Id already exists.' });
    }

    if (password.length < getIniConfig('MIN_PASSWORD_SIZE'))
      return fn({
        error: true,
        code: 3,
        msg: 'Your password does not have the minimum number of characters.',
      });

    if (userId.length < 1)
      return fn({
        error: true,
        code: 4,
        msg: 'Your user id does not have the minimum number of characters.',
      });

    // Create Account
    await createAccount(userId, password, nickname);

    // User registered successfully.
    fn({ userId, nickname });
  });

  socket.on('login', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { userId, password } = data;
    // Validate values
    if (typeof userId !== 'string' || typeof password !== 'string')
      return sendIncompleteDataInfo(fn);

    // Check if user is using account
    const bannedUsers = db.getTable('banned');
    if (await bannedUsers.has(userId)) {
      const banData = await bannedUsers.get(userId);
      return fn({
        error: true,
        reason: banData.reason,
        date: banData.date,
        msg: "You're banned!",
        code: 5,
      });
    }

    if (userSession.getUserId(socket)) {
      return fn({ error: true, msg: "You're already logged in!", code: 4 });
    }

    // Validate user credentials
    const users = db.getTable('users');

    // Accounts created before the lowercase migration may still be stored with
    // uppercase characters, so the lookup must not depend on the id casing.
    const user = await findUser(users, userId);
    if (!user) {
      return fn({ error: true, msg: 'User does not exist.', code: 2 });
    }

    const storedId = user.userId;

    if (userSockets.has(storedId)) {
      return fn({ error: true, msg: 'The account is already in use.', code: 3 });
    }

    const hashedPassword = getHashString(password);
    if (user.password !== hashedPassword) {
      return fn({ error: true, msg: 'Invalid user credentials.', code: 1 });
    }

    // Get the user's nickname from the users map
    const nickname = user.nickname;

    // Set session data
    userSession.check(socket);
    userSession.setUserId(socket, storedId);
    userSession.setNickname(socket, nickname);

    // Add user into userSockets
    userSockets.set(storedId, socket);

    // Success!
    console.log(
      `[APP] [${socket.handshake ? socket.handshake.address : '?.?.?.?'}] User ${userId} logged in: ${socket.id}`,
    );

    // Complete
    const moderators = db.getTable('moderators');
    const usersDice = db.getTable('usersDice');
    fn({
      userId: storedId,
      nickname,
      isAdmin: storedId === getIniConfig('OWNER_ID'),
      isMod: await moderators.has(storedId),
      ratelimit: getRateLimit(),
      dice: await usersDice.get(storedId),
    });
  });

  socket.on('disconnect', async () => {
    // Get user
    const userId = userSession.getUserId(socket);
    const ipAddress = socket.handshake ? socket.handshake.address : '?.?.?.?';

    // Bye
    console.log(
      `[APP] [${ipAddress}] ${userId ? `User ${userId}` : 'Unknown user'} disconnected: ${socket.id}`,
    );

    // Disconnect user from rooms
    if (userId) {
      const tinyPromises = [];
      roomUsers.forEach((users, roomId) => {
        if (users.has(userId)) tinyPromises.push(leaveRoom(socket, emitTo, roomId));
      });
      await Promise.all(tinyPromises);
    }

    // Remove from userSockets
    userSockets.delete(userId);
  });
}
