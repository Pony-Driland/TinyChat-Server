import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * The room permission layer is the only thing standing between a read-only
 * guest and the chat, so it is exercised against a real sqlite database.
 */
const loadModules = async (dir) => {
  process.env.TINY_CHAT_TEST_DIR = dir;
  const { default: db } = await import('../src/server/connection/sql.js');
  return { db };
};

test('room permissions', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tiny-chat-perm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { db } = await loadModules(dir);
  const { startDatabase } = await import('../src/server/connection/sql.js');
  const { _setIniConfig, getRoomRole, canSpeakInRoom, grantRoomPermission, revokeRoomPermission, listRoomPermissions, ROOM_ROLES } =
    await import('../src/server/connection/values.js');

  _setIniConfig('OWNER_ID', 'admin');
  _setIniConfig('MAX_USERS_PER_ROOM', 50);

  await startDatabase({ config: { database: { type: 'sqlite3' } }, appDir: () => dir });

  const rooms = db.getTable('rooms');
  await rooms.set('lobby', { title: 'Lobby', ownerId: 'alice' });

  await t.test('a new user is a read-only guest', async () => {
    assert.equal(await getRoomRole('lobby', 'bob'), ROOM_ROLES.GUEST);
    assert.equal(await canSpeakInRoom('lobby', 'bob'), false);
  });

  await t.test('the room owner and server owner can always speak', async () => {
    assert.equal(await getRoomRole('lobby', 'alice'), ROOM_ROLES.OWNER);
    assert.equal(await getRoomRole('lobby', 'admin'), ROOM_ROLES.OWNER);
  });

  await t.test('granting the permission allows the user to speak', async () => {
    await grantRoomPermission('lobby', 'bob', 'alice');
    assert.equal(await getRoomRole('lobby', 'bob'), ROOM_ROLES.MEMBER);
    assert.equal(await canSpeakInRoom('lobby', 'bob'), true);

    const permissions = await listRoomPermissions('lobby');
    assert.deepEqual(
      permissions.map((item) => item.userId),
      ['bob'],
    );
    assert.equal(permissions[0].grantedBy, 'alice');
  });

  await t.test('revoking the permission sends the user back to read-only', async () => {
    await revokeRoomPermission('lobby', 'bob');
    assert.equal(await getRoomRole('lobby', 'bob'), ROOM_ROLES.GUEST);
    assert.deepEqual(await listRoomPermissions('lobby'), []);
  });

  await t.test('room moderators can speak', async () => {
    const roomModerators = db.getTable('roomModerators');
    await roomModerators.set('lobby', { userId: 'carol' });
    assert.equal(await getRoomRole('lobby', 'carol'), ROOM_ROLES.MODERATOR);
  });
});
