import { join } from 'path';
import PuddySql from 'puddysql';
import isDebug from '../../api/isDebug';

const db = new PuddySql.Instance();

export const startDatabase = async (appStorage) => {
  const { config, appDir } = appStorage;
  try {
    // Opening the database
    console.log(`[APP] [${config.database.type}] Starting database...`);

    // Sqlite3
    if (config.database.type === 'sqlite3') await db.initSqlite3(join(appDir(), `./database.db`));
    // Postgre
    else if (config.database.type === 'postgre')
      await db.initPostgre({
        user: config.database.user,
        host: config.database.host,
        database: config.database.database,
        password: config.database.password,
        port: config.database.port,
      });
    // Nothing
    else {
      console.log('[APP] No database detected.');
      return false;
    }

    // Tables time
    console.log(`[APP] [${config.database.type}] Loading tables...`);

    // Start database

    // Stores room configurations, including password, etc.
    console.log(`[APP] [${config.database.type}] [table] Loading rooms...`);
    await db.initTable({ name: 'rooms', id: 'roomId' }, [
      ['roomId', 'TEXT', 'PRIMARY KEY DEFAULT (lower(hex(randomblob(16))))'],
      ['title', 'TEXT'],
      ['password', 'TEXT'],
      ['tags', 'TAGS'],
      ['prompt', 'TEXT'],
      ['model', 'TEXT'],
      ['systemInstruction', 'TEXT'],
      ['firstDialogue', 'TEXT'],
      ['maxOutputTokens', 'REAL'],
      ['temperature', 'REAL'],
      ['topP', 'REAL'],
      ['topK', 'REAL'],
      ['presencePenalty', 'REAL'],
      ['frequencyPenalty', 'REAL'],
      ['maxUsers', 'INTEGER', 'DEFAULT 50'],
      ['ownerId', 'TEXT', 'NOT NULL'],
      ['disabled', 'BOOLEAN', 'DEFAULT 0'],
      ['readOnly', 'BOOLEAN', 'DEFAULT 0'],
      ['chapter', 'INTEGER', 'NOT NULL DEFAULT 1'],
      ['public', 'BOOLEAN', 'DEFAULT 0'],
      ['language', 'TEXT'],
    ]);

    // Stores room tokens data
    console.log(`[APP] [${config.database.type}] [table] Loading room tokens...`);
    await db.initTable({ name: 'roomTokens', id: 'roomId' }, [
      ['roomId', 'TEXT', 'PRIMARY KEY'],
      ['prompt', 'INTEGER'],
      ['systemInstruction', 'INTEGER'],
      ['rpgSchema', 'INTEGER'],
      ['rpgData', 'INTEGER'],
      ['rpgPrivateData', 'INTEGER'],
      ['file', 'INTEGER'],
      ['FOREIGN KEY (roomId) REFERENCES rooms(roomId) ON DELETE CASCADE'],
    ]);

    // Stores room hash data
    console.log(`[APP] [${config.database.type}] [table] Loading room hash...`);
    await db.initTable({ name: 'roomHash', id: 'roomId' }, [
      ['roomId', 'TEXT', 'PRIMARY KEY'],
      ['prompt', 'TEXT'],
      ['systemInstruction', 'TEXT'],
      ['rpgSchema', 'TEXT'],
      ['rpgData', 'TEXT'],
      ['rpgPrivateData', 'TEXT'],
      ['file', 'TEXT'],
      ['FOREIGN KEY (roomId) REFERENCES rooms(roomId) ON DELETE CASCADE'],
    ]);

    // Stores mod users from room
    console.log(`[APP] [${config.database.type}] [table] Loading room moderators...`);
    await db.initTable({ name: 'roomModerators', id: 'roomId', subId: 'userId' }, [
      ['roomId', 'TEXT'],
      ['userId', 'TEXT'],
      ['PRIMARY KEY (roomId, userId)'],
      ['FOREIGN KEY (roomId) REFERENCES rooms(roomId) ON DELETE CASCADE'],
    ]);

    // Stores the rooms an user joined at least once.
    console.log(`[APP] [${config.database.type}] [table] Loading room members...`);
    await db.initTable({ name: 'roomMembers', id: 'roomId', subId: 'userId' }, [
      ['roomId', 'TEXT'],
      ['userId', 'TEXT'],
      ['date', 'INTEGER'],
      ['PRIMARY KEY (roomId, userId)'],
      ['FOREIGN KEY (roomId) REFERENCES rooms(roomId) ON DELETE CASCADE'],
    ]);

    // Stores users banned from room
    console.log(`[APP] [${config.database.type}] [table] Loading room banned users...`);
    await db.initTable({ name: 'roomBannedUsers', id: 'roomId', subId: 'userId' }, [
      ['roomId', 'TEXT'],
      ['userId', 'TEXT'],
      ['PRIMARY KEY (roomId, userId)'],
      ['FOREIGN KEY (roomId) REFERENCES rooms(roomId) ON DELETE CASCADE'],
    ]);

    // Stores the users allowed to speak in a room.
    // Every user that joins a room is a read-only guest until the room owner
    // (or a moderator) grants the permission to send messages.
    console.log(`[APP] [${config.database.type}] [table] Loading room permissions...`);
    await db.initTable({ name: 'roomPermissions', id: 'roomId', subId: 'userId' }, [
      ['roomId', 'TEXT'],
      ['userId', 'TEXT'],
      ['grantedBy', 'TEXT'],
      ['date', 'INTEGER'],
      ['PRIMARY KEY (roomId, userId)'],
      ['FOREIGN KEY (roomId) REFERENCES rooms(roomId) ON DELETE CASCADE'],
    ]);

    const historyTemplate = [
      ['roomId', 'TEXT', 'NOT NULL'],
      ['userId', 'TEXT', 'NOT NULL'],
      ['text', 'TEXT', 'NOT NULL'],
      ['date', 'INTEGER', 'NOT NULL'],
      ['chapter', 'INTEGER', 'NOT NULL'],
      ['model', 'TEXT'],
      ['hash', 'TEXT'],
      ['edited', 'INTEGER'],
      ['tokens', 'INTEGER'],
      ['errorCode', 'TEXT'],
      ['isModel', 'BOOLEAN', 'DEFAULT 0'],
      ['PRIMARY KEY (roomId, historyId)'],
      ['FOREIGN KEY (roomId) REFERENCES rooms(roomId) ON DELETE CASCADE'],
    ];

    // Stores room histories
    console.log(`[APP] [${config.database.type}] [table] Loading history...`);
    await db.initTable(
      {
        name: 'history',
        id: 'roomId',
        subId: 'historyId',
      },
      [['historyId', 'TEXT', 'DEFAULT (lower(hex(randomblob(16))))'], ...historyTemplate],
    );

    // Stores room deleted histories
    console.log(`[APP] [${config.database.type}] [table] Loading deleted history...`);
    await db.initTable(
      {
        name: 'historyDeleted',
        id: 'roomId',
        subId: 'historyId',
      },
      [['historyId', 'TEXT'], ...historyTemplate],
    );

    // Stores dice histories
    await db.initTable(
      {
        name: 'diceHistory',
        id: 'roomId',
        subId: 'id',
      },
      [
        ['id', 'TEXT', 'DEFAULT (lower(hex(randomblob(16))))'],
        ['roomId', 'TEXT', 'NOT NULL'],
        ['userId', 'TEXT', 'NOT NULL'],
        ['date', 'INTEGER', 'NOT NULL'],
        ['canZero', 'BOOLEAN', 'NOT NULL'],
        ['results', 'JSON', 'NOT NULL'],
        ['modifiers', 'JSON', 'NOT NULL'],
        ['PRIMARY KEY (roomId, id)'],
        ['FOREIGN KEY (roomId) REFERENCES rooms(roomId) ON DELETE CASCADE'],
      ],
    );

    // Stores user credentials
    console.log(`[APP] [${config.database.type}] [table] Loading users...`);
    await db.initTable({ name: 'users', id: 'userId' }, [
      ['userId', 'TEXT', 'PRIMARY KEY'],
      ['password', 'TEXT', 'NOT NULL'],
      ['nickname', 'TEXT'],
    ]);

    // Stores users dice
    console.log(`[APP] [${config.database.type}] [table] Loading dices...`);
    await db.initTable({ name: 'usersDice', id: 'userId' }, [
      ['userId', 'TEXT', 'PRIMARY KEY'],
      ['bg', 'TEXT'],
      ['text', 'TEXT'],
      ['border', 'TEXT'],
      ['img', 'TEXT'],
      ['selectionBg', 'TEXT'],
      ['selectionText', 'TEXT'],
      ['FOREIGN KEY (userId) REFERENCES users(userId) ON DELETE CASCADE'],
    ]);

    // Stores the list of server moderators
    console.log(`[APP] [${config.database.type}] [table] Loading moderators...`);
    await db.initTable({ name: 'moderators', id: 'userId' }, [
      ['userId', 'TEXT', 'PRIMARY KEY'],
      ['reason', 'TEXT'],
      ['date', 'INTEGER', 'NOT NULL'],
      ['FOREIGN KEY (userId) REFERENCES users(userId) ON DELETE CASCADE'],
    ]);

    // Stores the list of banned users
    console.log(`[APP] [${config.database.type}] [table] Loading banned accounts...`);
    await db.initTable({ name: 'banned', id: 'userId' }, [
      ['userId', 'TEXT', 'PRIMARY KEY'],
      ['reason', 'TEXT'],
      ['date', 'INTEGER', 'NOT NULL'],
    ]);

    // Stores room private data
    console.log(`[APP] [${config.database.type}] [table] Loading private room data...`);
    await db.initTable({ name: 'privateRoomData', id: 'roomId' }, [
      ['roomId', 'TEXT', 'PRIMARY KEY'],
      ['data', 'JSON', 'NOT NULL'],
      ['FOREIGN KEY (roomId) REFERENCES rooms(roomId) ON DELETE CASCADE'],
    ]);

    // Stores room data
    console.log(`[APP] [${config.database.type}] [table] Loading room data...`);
    await db.initTable({ name: 'roomData', id: 'roomId' }, [
      ['roomId', 'TEXT', 'PRIMARY KEY'],
      ['data', 'JSON', 'NOT NULL'],
      ['FOREIGN KEY (roomId) REFERENCES rooms(roomId) ON DELETE CASCADE'],
    ]);

    // Stores room rpg schema data
    console.log(`[APP] [${config.database.type}] [table] Loading rpg schema...`);
    await db.initTable({ name: 'rpgSchema', id: 'roomId' }, [
      ['roomId', 'TEXT', 'PRIMARY KEY'],
      ['data', 'JSON', 'NOT NULL'],
      ['FOREIGN KEY (roomId) REFERENCES rooms(roomId) ON DELETE CASCADE'],
    ]);

    // Stores the playlists created by a room owner.
    //
    // A playlist is either available on every room the owner has (`scope`
    // `all`) or only on the rooms listed in `roomPlaylistRooms` (`scope`
    // `rooms`). The tracks are stored as JSON so the client is free to evolve
    // the track format without a schema change.
    console.log(`[APP] [${config.database.type}] [table] Loading room playlists...`);
    await db.initTable({ name: 'roomPlaylists', id: 'playlistId' }, [
      ['playlistId', 'TEXT', 'PRIMARY KEY'],
      ['ownerId', 'TEXT', 'NOT NULL'],
      ['name', 'TEXT'],
      ['tracks', 'JSON', 'NOT NULL'],
      ['scope', 'TEXT', 'NOT NULL DEFAULT \'all\''],
      ['date', 'INTEGER', 'NOT NULL'],
      ['updatedAt', 'INTEGER', 'NOT NULL'],
    ]);

    // Binds a `scope = 'rooms'` playlist to the rooms it can be used on.
    console.log(`[APP] [${config.database.type}] [table] Loading room playlist rooms...`);
    await db.initTable({ name: 'roomPlaylistRooms', id: 'playlistId', subId: 'roomId' }, [
      ['playlistId', 'TEXT', 'NOT NULL'],
      ['roomId', 'TEXT', 'NOT NULL'],
      ['PRIMARY KEY (playlistId, roomId)'],
      ['FOREIGN KEY (playlistId) REFERENCES roomPlaylists(playlistId) ON DELETE CASCADE'],
    ]);

    // Stores the music player of a room.
    //
    // Only the last interaction is stored: the clients rebuild the current
    // position from `position` + (`updatedAt` - now) while `playing` is set.
    // This keeps the sync to a single row per room instead of a stream of
    // updates.
    console.log(`[APP] [${config.database.type}] [table] Loading room player...`);
    await db.initTable({ name: 'roomPlayer', id: 'roomId' }, [
      ['roomId', 'TEXT', 'PRIMARY KEY'],
      ['playlistId', 'TEXT'],
      ['trackIndex', 'INTEGER', 'DEFAULT 0'],
      ['position', 'REAL', 'DEFAULT 0'],
      // Duration of the current track, in seconds. A visitor that joins after
      // the playlist is over uses it to tell "the song is still playing" from
      // "the playlist already ended while I was away".
      ['duration', 'REAL', 'DEFAULT 0'],
      ['playing', 'BOOLEAN', 'DEFAULT 0'],
      // Repeats the playlist from the first track instead of stopping.
      ['loopMode', 'BOOLEAN', 'DEFAULT 0'],
      ['volume', 'REAL', 'DEFAULT 1'],
      ['revision', 'INTEGER', 'DEFAULT 0'],
      ['updatedAt', 'INTEGER', 'DEFAULT 0'],
      ['updatedBy', 'TEXT'],
      ['FOREIGN KEY (roomId) REFERENCES rooms(roomId) ON DELETE CASCADE'],
    ]);

    // Stores audit data
    console.log(`[APP] [${config.database.type}] [table] Loading audit...`);
    await db.initTable({ name: 'audit', id: 'auditId' }, [
      ['auditId', 'TEXT', 'PRIMARY KEY DEFAULT (lower(hex(randomblob(16))))'],
      ['userId', 'TEXT', 'NOT NULL'],
      ['target', 'TEXT'],
      ['type', 'TEXT', 'NOT NULL'],
    ]);

    // Debug mode
    db.setIsDebug(isDebug());

    // Schema migrations. Every entry upgrades the database by one version, so
    // servers created before the feature was added are patched on boot.
    db.migrator.addMigration(1, async (database) => {
      // `public` lets the room show up on the public room list.
      await database.run(
        'ALTER TABLE rooms ADD COLUMN public BOOLEAN DEFAULT 0',
        undefined,
        'migration.rooms.public',
      );
    });

    db.migrator.addMigration(2, async (database) => {
      // `language` is the ISO 639-1 code of the language spoken in the room.
      // `NULL` keeps the room visible on every language filter.
      await database.run(
        'ALTER TABLE rooms ADD COLUMN language TEXT',
        undefined,
        'migration.rooms.language',
      );
    });

    db.migrator.addMigration(3, async (database) => {
      // `mode` is how the playlist is walked: `ordered` follows the list,
      // `raffle` draws the next track with the advanced raffle.
      await database.run(
        'ALTER TABLE roomPlaylists ADD COLUMN mode TEXT DEFAULT \'ordered\'',
        undefined,
        'migration.roomPlaylists.mode',
      );

      // `raffle` keeps the draw configuration and the order that was drawn,
      // so every listener plays the very same sequence.
      await database.run(
        'ALTER TABLE roomPlaylists ADD COLUMN raffle TEXT',
        undefined,
        'migration.roomPlaylists.raffle',
      );
    });

    await db.startMigration(3);

    // Complete
    console.log(`[APP] [${config.database.type}] Database connection opened.`);

    // Warn when the database still has uppercase user ids. The migration is
    // not automatic because it rewrites primary keys, which must be done
    // with the server stopped.
    const users = db.getTable('users');
    const all = await users.search({});
    const rows = Array.isArray(all) ? all : all.items || [];
    const pending = rows.filter((user) => user.userId !== user.userId.toLowerCase());

    if (pending.length > 0) {
      console.warn(
        `[APP] [WARNING] ${pending.length} user id(s) are not lowercase. ` +
          'Run "tiny-chat-archive migrate-usernames" to fix them.',
      );
    }

    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
};

export default db;
