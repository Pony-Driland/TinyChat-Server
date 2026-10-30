import { createRequire } from 'module';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const require = createRequire(import.meta.url);

/**
 * Minimal `history` schema, mirroring `src/server/connection/sql.js`.
 * Only the columns touched by the archive CLI are required, but the full table
 * is recreated so the tests fail if the real schema ever drifts.
 */
const SCHEMA = `
CREATE TABLE rooms (
  roomId TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  title TEXT,
  password TEXT,
  tags JSON,
  prompt TEXT,
  model TEXT,
  systemInstruction TEXT,
  firstDialogue TEXT,
  maxOutputTokens REAL,
  temperature REAL,
  topP REAL,
  topK REAL,
  presencePenalty REAL,
  frequencyPenalty REAL,
  maxUsers INTEGER DEFAULT 50,
  ownerId TEXT NOT NULL,
  disabled BOOLEAN DEFAULT 0,
  readOnly BOOLEAN DEFAULT 0,
  chapter INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE history (
  historyId TEXT DEFAULT (lower(hex(randomblob(16)))),
  roomId TEXT NOT NULL,
  userId TEXT NOT NULL,
  text TEXT NOT NULL,
  date INTEGER NOT NULL,
  chapter INTEGER NOT NULL,
  model TEXT,
  hash TEXT,
  edited INTEGER,
  tokens INTEGER,
  errorCode TEXT,
  isModel BOOLEAN DEFAULT 0,
  PRIMARY KEY (roomId, historyId),
  FOREIGN KEY (roomId) REFERENCES rooms(roomId) ON DELETE CASCADE
);
`;

const CONFIG = `[server]
port=35421
registration_open=false
load_all_history= false

[proxy]
address=null
auth=test

[genesis]
owner_id=admin
owner_password=admin

[database]
type='sqlite3'
user='your_user'
host='localhost'
database='your_database'
password='your_password'
port=5432
`;

/** Opens a raw sqlite3 connection to the given file. */ export function openDatabase(file) {
  const sqlite3 = require('sqlite3');
  return new sqlite3.Database(file);
}

/** Promise wrapper around `db.run`. */
export function run(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, function onDone(err) {
      return err ? reject(err) : resolve(this);
    }),
  );
}

/** Promise wrapper around `db.all`. */
export function all(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))),
  );
}

/** Promise wrapper around `db.close`. */
export function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

/**
 * Creates a throwaway data directory containing a `config.ini` and an empty
 * `database.db`.
 *
 * @param {{ rooms?: Array<{ roomId: string, title?: string }> }} [options]
 * @returns {Promise<{ dir: string, file: string, cleanup: () => Promise<void> }>}
 */
export async function createFixture(options = {}) {
  const { rooms = [{ roomId: 'lobby', title: 'Lobby' }] } = options;

  const dir = mkdtempSync(join(tmpdir(), 'tiny-chat-cli-'));
  const file = join(dir, 'database.db');

  writeFileSync(join(dir, 'config.ini'), CONFIG, 'utf-8');

  const db = openDatabase(file);
  await run(db, 'PRAGMA foreign_keys = ON');
  for (const statement of SCHEMA.split(';')
    .map((sql) => sql.trim())
    .filter(Boolean))
    await run(db, statement);

  for (const room of rooms)
    await run(db, 'INSERT INTO rooms (roomId, title, ownerId) VALUES (?, ?, ?)', [
      room.roomId,
      room.title ?? room.roomId,
      'admin',
    ]);

  await close(db);

  return {
    dir,
    file,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Inserts history rows straight into the fixture database.
 *
 * @param {string} file
 * @param {Array<{ roomId?: string, userId?: string, text: string, date: number, chapter?: number }>} rows
 */
export async function seedMessages(file, rows) {
  const db = openDatabase(file);
  try {
    for (const row of rows)
      await run(
        db,
        'INSERT INTO history (roomId, userId, text, date, chapter, isModel, edited) VALUES (?, ?, ?, ?, ?, 0, 0)',
        [row.roomId ?? 'lobby', row.userId ?? 'admin', row.text, row.date, row.chapter ?? 1],
      );
  } finally {
    await close(db);
  }
}

/** Reads every history row of a room, ordered the same way the CLI exports. */
export async function readMessages(file, roomId = 'lobby', chapter = null) {
  const db = openDatabase(file);
  try {
    const params = [roomId];
    let sql = 'SELECT historyId, userId, text, date, chapter FROM history WHERE roomId = ?';
    if (chapter !== null) {
      sql += ' AND chapter = ?';
      params.push(chapter);
    }
    return await all(db, `${sql} ORDER BY date ASC, historyId ASC`, params);
  } finally {
    await close(db);
  }
}
