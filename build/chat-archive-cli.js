#!/usr/bin/env node
'use strict';

/**
 * Tiny Chat - Chat Archive CLI
 * =============================================================================
 * Imports and exports chat history between a Tiny Chat database and a plain
 * JSON file that follows this shape:
 *
 *   [
 *     {
 *       "message": "Hello world",
 *       "time": 1730419200000,
 *       "id": "8f14e45fceea167a5a36dedd4bea2543",
 *       "user": "admin"
 *     }
 *   ]
 *
 * The CLI is interactive: when a value is not provided through the flags it will
 * ask which room and which chapter should be used (including an "all chapters"
 * option on export).
 *
 * Usage:
 *   node build/chat-archive-cli.js export --room lobby --chapter 1 --file chat.json
 *   node build/chat-archive-cli.js import --room lobby --chapter 2 --file chat.json
 *   node build/chat-archive-cli.js rooms
 *   node build/chat-archive-cli.js chapters --room lobby
 *
 * Run with --help for the full list of options.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

const ini = require('ini');

// -----------------------------------------------------------------------------
// Terminal helpers
// -----------------------------------------------------------------------------

const COLOR_ENABLED = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

/** @param {string} code */
const paint = (code) => (text) =>
  COLOR_ENABLED ? `\u001b[${code}m${text}\u001b[0m` : String(text);

const color = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
};

const log = {
  info: (msg) => console.log(`${color.cyan('[info]')} ${msg}`),
  success: (msg) => console.log(`${color.green('[ ok ]')} ${msg}`),
  warn: (msg) => console.log(`${color.yellow('[warn]')} ${msg}`),
  error: (msg) => console.error(`${color.red('[fail]')} ${msg}`),
  step: (msg) => console.log(`${color.blue('  ->')} ${msg}`),
};

const HELP = `
${color.bold('Tiny Chat - Chat Archive CLI')} v1.0.0

${color.bold('USAGE')}
  node build/chat-archive-cli.js <command> [options]

${color.bold('COMMANDS')}
  export        Export a room chapter (or every chapter) to a JSON file
  import        Import a JSON file into a room chapter
  rooms         List every room available in the database
  chapters      List every chapter of a room

${color.bold('OPTIONS')}
  -d, --data-dir <path>   Folder that contains config.ini and database.db
  -r, --room <roomId>     Room id (asked interactively when omitted)
  -c, --chapter <n|all>   Chapter number, or "all" (default: ask / 1)
  -f, --file <path>       JSON file to read (import) or write (export)
  -m, --mode <mode>       Import mode: merge | replace | upsert (default: merge)
  -y, --yes               Skip the confirmation prompt
      --pretty            Pretty-print the exported JSON (default: true)
      --compact           Export the JSON without indentation
      --dry-run           Show what would happen without writing anything
      --json              Machine readable output (no prompts, JSON on stdout)
  -h, --help              Show this help
  -v, --version           Show the CLI version

${color.bold('IMPORT MODES')}
  merge     Insert new messages and skip the ones that already exist (default)
  replace   Delete the target chapter before inserting the file contents
  upsert    Insert new messages and update the ones that already exist

${color.bold('EXAMPLES')}
  # interactive: asks the room and the chapter
  node build/chat-archive-cli.js export

  # export every chapter of a room
  node build/chat-archive-cli.js export --room lobby --chapter all -f lobby.json

  # import into chapter 3, replacing whatever was there
  node build/chat-archive-cli.js import -r lobby -c 3 -f lobby.json -m replace
`;

// -----------------------------------------------------------------------------
// Argument parsing
// -----------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (!arg.startsWith('-')) {
      args._.push(arg);
      continue;
    }

    let key = arg.replace(/^--?/, '');
    let inlineValue;

    const eq = key.indexOf('=');
    if (eq > -1) {
      inlineValue = key.slice(eq + 1);
      key = key.slice(0, eq);
    }

    const nextValue = () => {
      if (typeof inlineValue !== 'undefined') return inlineValue;
      const value = argv[++i];
      if (typeof value === 'undefined' || (value.startsWith('-') && value.length > 1))
        throw new Error(`Missing value for --${key}`);
      return value;
    };

    switch (key) {
      case 'h':
      case 'help':
        args.help = true;
        break;
      case 'v':
      case 'version':
        args.version = true;
        break;
      case 'd':
      case 'data-dir':
        args.dataDir = nextValue();
        break;
      case 'r':
      case 'room':
        args.room = nextValue();
        break;
      case 'c':
      case 'chapter':
        args.chapter = nextValue();
        break;
      case 'f':
      case 'file':
        args.file = nextValue();
        break;
      case 'm':
      case 'mode':
        args.mode = nextValue();
        break;
      case 'y':
      case 'yes':
        args.yes = true;
        break;
      case 'pretty':
        args.pretty = true;
        break;
      case 'compact':
        args.pretty = false;
        break;
      case 'dry-run':
        args.dryRun = true;
        break;
      case 'json':
        args.json = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return args;
}

// -----------------------------------------------------------------------------
// Prompt helpers
// -----------------------------------------------------------------------------

/**
 * Line based prompt.
 *
 * `readline.question()` is not reliable when stdin is a pipe (the interface is
 * closed as soon as the buffer is drained), so we keep our own line queue. This
 * makes the CLI work both interactively and with `printf '1\n2\n' | cli ...`.
 *
 * @param {boolean} enabled
 */
function createPrompt(enabled) {
  if (!enabled)
    return {
      ask: async () => {
        throw new Error(
          'Interactive mode is not available. Please provide the options via CLI flags.',
        );
      },
      close: () => {},
    };

  const stdin = process.stdin;
  const isTTY = Boolean(stdin.isTTY);
  const rl = readline.createInterface({ input: stdin, terminal: false });

  /** @type {string[]} */
  const lines = [];
  /** @type {Array<(line: string) => void>} */
  const waiting = [];
  let ended = false;

  rl.on('line', (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else lines.push(line);
  });

  rl.on('close', () => {
    ended = true;
    while (waiting.length > 0) {
      const next = waiting.shift();
      if (next) next('');
    }
  });

  // Keep the process alive while waiting for input on a TTY.
  if (isTTY) stdin.resume();

  return {
    ask(question) {
      process.stdout.write(question);

      if (lines.length > 0) {
        const line = lines.shift();
        if (isTTY) process.stdout.write(`${line}\n`);
        return Promise.resolve(String(line).trim());
      }

      // stdin is exhausted: never resolve with an empty answer, otherwise the
      // callers would loop forever re-asking the same question.
      if (ended) return Promise.reject(new Error('No more input available (stdin closed).'));

      return new Promise((resolve) => {
        waiting.push((line) => {
          if (isTTY) process.stdout.write(`${line}\n`);
          resolve(String(line).trim());
        });
      });
    },
    close() {
      if (!ended) rl.close();
    },
  };
}

/**
 * Asks the user to pick one entry from a list.
 * @template T
 * @param {{ ask: (q: string) => Promise<string> }} prompt
 * @param {string} title
 * @param {T[]} items
 * @param {{ label: (item: T, index: number) => string, allowAll?: boolean, allLabel?: string }} options
 * @returns {Promise<T | 'all'>}
 */
async function selectFromList(prompt, title, items, options) {
  const { label, allowAll = false, allLabel = 'All' } = options;

  console.log(`\n${color.bold(title)}`);
  items.forEach((item, index) => {
    console.log(`  ${color.cyan(String(index + 1).padStart(3, ' '))}) ${label(item, index)}`);
  });
  if (allowAll) console.log(`  ${color.cyan('  A')}) ${allLabel}`);

  for (;;) {
    const answer = await prompt.ask(`\n${color.bold('>')} `);

    // Empty answer means stdin reached EOF, so there is no way to recover.
    if (answer === '') throw new Error('No option selected. Aborting.');

    if (allowAll && (answer.toLowerCase() === 'a' || answer.toLowerCase() === 'all')) return 'all';

    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= items.length) return items[index - 1];

    console.log(color.yellow('  Invalid option, please try again.'));
  }
}

// -----------------------------------------------------------------------------
// Config / database
// -----------------------------------------------------------------------------

function resolveDataDir(cliDir) {
  const candidates = [
    cliDir,
    process.env.TINY_CHAT_DATA,
    path.resolve(process.cwd(), 'src/tiny-chat_data'),
    path.resolve(process.cwd(), 'tiny-chat_data'),
    path.join(path.dirname(process.execPath), 'tiny-chat_data'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved;
  }

  throw new Error(
    `Could not find the data folder. Use --data-dir <path>. Tried:\n  ${candidates.join('\n  ')}`,
  );
}

function loadConfig(dataDir) {
  const configPath = path.join(dataDir, 'config.ini');
  if (fs.existsSync(configPath)) return ini.parse(fs.readFileSync(configPath, 'utf-8'));

  const fallback = path.resolve(__dirname, '../src/server/config.ini');
  if (fs.existsSync(fallback)) {
    log.warn(`config.ini not found in ${dataDir}. Using the default template.`);
    return ini.parse(fs.readFileSync(fallback, 'utf-8'));
  }

  throw new Error(`config.ini not found in ${dataDir}`);
}

const unquote = (value, fallback) => {
  if (typeof value !== 'string') return fallback;
  return value.replace(/^['"]|['"]$/g, '').trim() || fallback;
};

function createSqliteAdapter(file) {
  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(file);

  return {
    dialect: 'sqlite3',
    all: (sql, params = []) =>
      new Promise((resolve, reject) =>
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))),
      ),
    run: (sql, params = []) =>
      new Promise((resolve, reject) =>
        db.run(sql, params, function onDone(err) {
          return err ? reject(err) : resolve(this);
        }),
      ),
    close: () => new Promise((resolve) => db.close(() => resolve())),
  };
}

function createPostgresAdapter(config) {
  const { Pool } = require('pg');
  const pool = new Pool({
    user: unquote(config.user, undefined),
    host: unquote(config.host, undefined),
    database: unquote(config.database, undefined),
    password: unquote(config.password, undefined),
    port: Number(unquote(config.port, '5432')) || 5432,
  });

  // The whole CLI is written using `?` placeholders.
  const toPg = (sql) => {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
  };

  return {
    dialect: 'postgre',
    all: async (sql, params = []) => (await pool.query(toPg(sql), params)).rows,
    run: (sql, params = []) => pool.query(toPg(sql), params),
    close: () => pool.end(),
  };
}

async function connectDatabase(dataDir) {
  const config = loadConfig(dataDir);
  const database = config.database || {};
  const type = unquote(database.type, 'sqlite3');

  if (type === 'sqlite3') {
    const file = path.join(dataDir, 'database.db');
    if (!fs.existsSync(file)) throw new Error(`Database file not found: ${file}`);
    return { adapter: createSqliteAdapter(file), type, file };
  }

  if (type === 'postgre' || type === 'postgres' || type === 'postgresql')
    return { adapter: createPostgresAdapter(database), type: 'postgre', file: null };

  throw new Error(`Unsupported database type: ${type}`);
}

// -----------------------------------------------------------------------------
// Repository
// -----------------------------------------------------------------------------

const createRepository = (adapter) => ({
  async listRooms() {
    return adapter.all('SELECT roomId, title, chapter FROM rooms ORDER BY title ASC', []);
  },

  async listChapters(roomId) {
    return adapter.all(
      'SELECT chapter, COUNT(*) AS total FROM history WHERE roomId = ? GROUP BY chapter ORDER BY chapter ASC',
      [roomId],
    );
  },

  async countMessages(roomId, chapter) {
    const rows = await adapter.all(
      'SELECT COUNT(*) AS total FROM history WHERE roomId = ? AND chapter = ?',
      [roomId, chapter],
    );
    return Number(rows[0] ? rows[0].total : 0) || 0;
  },

  async exportMessages(roomId, chapter) {
    const params = [roomId];
    let sql = 'SELECT historyId, userId, text, date, chapter FROM history WHERE roomId = ?';
    if (typeof chapter === 'number') {
      sql += ' AND chapter = ?';
      params.push(chapter);
    }
    sql += ' ORDER BY date ASC, historyId ASC';
    return adapter.all(sql, params);
  },

  async existingIds(roomId) {
    const rows = await adapter.all('SELECT historyId FROM history WHERE roomId = ?', [roomId]);
    return new Set(rows.map((row) => String(row.historyId)));
  },

  async deleteChapter(roomId, chapter) {
    return adapter.run('DELETE FROM history WHERE roomId = ? AND chapter = ?', [roomId, chapter]);
  },

  async insertMessage(row) {
    return adapter.run(
      'INSERT INTO history (historyId, roomId, userId, text, date, chapter, isModel, edited) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        row.historyId,
        row.roomId,
        row.userId,
        row.text,
        row.date,
        row.chapter,
        row.isModel ? 1 : 0,
        row.edited,
      ],
    );
  },

  async updateMessage(row) {
    return adapter.run(
      'UPDATE history SET userId = ?, text = ?, date = ?, chapter = ?, isModel = ? WHERE roomId = ? AND historyId = ?',
      [row.userId, row.text, row.date, row.chapter, row.isModel ? 1 : 0, row.roomId, row.historyId],
    );
  },
});

// -----------------------------------------------------------------------------
// Archive (JSON) helpers
// -----------------------------------------------------------------------------

const randomId = () => crypto.randomBytes(16).toString('hex');

const toArchiveEntry = (row) => ({
  message: String(row.text ?? ''),
  time: Number(row.date) || 0,
  id: String(row.historyId),
  user: String(row.userId),
});

/**
 * Validates and normalizes the JSON file content.
 * @param {unknown} payload
 * @returns {{ entries: Array<{ message: string, time: number, id: string, user: string, chapter?: number, isModel: boolean }>, errors: string[] }}
 */
function normalizeArchive(payload) {
  const errors = [];

  if (!Array.isArray(payload)) throw new Error('The JSON root must be an array of messages.');

  const entries = [];

  payload.forEach((item, index) => {
    const position = `[${index}]`;

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${position} is not an object.`);
      return;
    }

    const { message, time, id, user, chapter, isModel } = /** @type {any} */ (item);

    if (typeof message !== 'string') {
      errors.push(`${position} has an invalid "message" (string expected).`);
      return;
    }

    if (typeof user !== 'string' || user.trim() === '') {
      errors.push(`${position} has an invalid "user" (non-empty string expected).`);
      return;
    }

    const parsedTime = typeof time === 'number' ? time : Number(time);
    if (!Number.isFinite(parsedTime)) {
      errors.push(`${position} has an invalid "time" (number expected).`);
      return;
    }

    entries.push({
      message,
      time: parsedTime,
      id: typeof id === 'string' && id.trim() !== '' ? id : randomId(),
      user,
      chapter:
        Number.isFinite(Number(chapter)) && Number(chapter) > 0 ? Number(chapter) : undefined,
      isModel: isModel === true || isModel === 1,
    });
  });

  return { entries, errors };
}

// -----------------------------------------------------------------------------
// Resolvers (flags + interactive fallback)
// -----------------------------------------------------------------------------

async function resolveRoom(repository, prompt, roomArg) {
  const rooms = await repository.listRooms();

  if (rooms.length === 0) throw new Error('No rooms were found in the database.');

  if (roomArg) {
    const room = rooms.find((item) => String(item.roomId) === String(roomArg));
    if (!room) {
      const available = rooms.map((item) => `  - ${item.roomId} (${item.title ?? 'untitled'})`);
      throw new Error(`Room "${roomArg}" not found. Available rooms:\n${available.join('\n')}`);
    }
    return room;
  }

  if (rooms.length === 1) {
    log.info(`Using the only room available: ${color.bold(rooms[0].roomId)}`);
    return rooms[0];
  }

  return selectFromList(prompt, 'Select a room:', rooms, {
    label: (room) => `${color.bold(room.roomId)} ${color.dim(`(${room.title || 'untitled'})`)}`,
  });
}

async function resolveChapter(
  repository,
  prompt,
  room,
  chapterArg,
  { allowAll, allowNew = false },
) {
  const chapters = await repository.listChapters(room.roomId);

  if (chapterArg === 'all' || chapterArg === '*') {
    if (!allowAll) throw new Error('The "all" option is not supported for this command.');
    return 'all';
  }

  if (typeof chapterArg !== 'undefined') {
    const chapter = Number(chapterArg);
    if (!Number.isInteger(chapter) || chapter < 1)
      throw new Error(`Invalid chapter: ${chapterArg}`);
    return chapter;
  }

  if (chapters.length === 0) {
    if (!allowNew) {
      log.warn('This room has no messages yet. Using chapter 1.');
      return 1;
    }

    const answer = await prompt.ask(`\n${color.bold('Chapter number:')} `);
    const chapter = Number(answer);
    if (!Number.isInteger(chapter) || chapter < 1) throw new Error(`Invalid chapter: ${answer}`);
    return chapter;
  }

  const options = chapters.map((item) => ({
    chapter: Number(item.chapter),
    total: Number(item.total),
  }));

  console.log(`\n${color.bold('Select a chapter:')}`);
  options.forEach((item, index) => {
    console.log(
      `  ${color.cyan(String(index + 1).padStart(3, ' '))}) Chapter ${color.bold(item.chapter)} ${color.dim(
        `(${item.total} message${item.total === 1 ? '' : 's'})`,
      )}`,
    );
  });
  if (allowAll) console.log(`  ${color.cyan('  A')}) All chapters ${color.dim('(every chapter)')}`);
  if (allowNew)
    console.log(color.dim('  ...or type any other chapter number to create a new one.'));

  for (;;) {
    const answer = await prompt.ask(`\n${color.bold('>')} `);
    if (answer === '') throw new Error('No chapter selected. Aborting.');

    const lowered = answer.toLowerCase();
    if (allowAll && (lowered === 'a' || lowered === 'all')) return 'all';

    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) {
      return options[index - 1].chapter;
    }

    if (allowNew) {
      const chapter = Number(answer);
      if (Number.isInteger(chapter) && chapter >= 1) return chapter;
    }

    console.log(color.yellow('  Invalid option, please try again.'));
  }
}

async function confirm(prompt, question) {
  const answer = await prompt.ask(`${question} ${color.dim('(y/N)')} `);
  return ['y', 'yes'].includes(answer.toLowerCase());
}

// -----------------------------------------------------------------------------
// Commands
// -----------------------------------------------------------------------------

async function commandRooms(repository, args) {
  const rooms = await repository.listRooms();

  if (args.json) {
    console.log(JSON.stringify(rooms, null, 2));
    return;
  }

  if (rooms.length === 0) return log.warn('No rooms found.');

  console.log(`\n${color.bold(`${rooms.length} room(s) found:`)}\n`);
  rooms.forEach((room) => {
    console.log(
      `  ${color.cyan(room.roomId)} ${color.dim(`- ${room.title || 'untitled'}`)} ${color.dim(
        `(chapter ${room.chapter ?? 1})`,
      )}`,
    );
  });
  console.log('');
}

async function commandChapters(repository, prompt, args) {
  const room = await resolveRoom(repository, prompt, args.room);
  const chapters = await repository.listChapters(room.roomId);

  if (args.json) {
    console.log(JSON.stringify({ roomId: room.roomId, chapters }, null, 2));
    return;
  }

  if (chapters.length === 0) return log.warn(`The room "${room.roomId}" has no messages.`);

  console.log(`\n${color.bold(`Chapters of "${room.roomId}":`)}\n`);
  chapters.forEach((item) => {
    console.log(`  ${color.cyan(String(item.chapter).padStart(3, ' '))}) ${item.total} message(s)`);
  });
  console.log('');
}

async function commandExport(repository, prompt, args) {
  const room = await resolveRoom(repository, prompt, args.room);
  const chapter = await resolveChapter(repository, prompt, room, args.chapter, { allowAll: true });

  const rows = await repository.exportMessages(room.roomId, chapter);

  if (rows.length === 0) {
    log.warn('No messages found for the selected filter. Nothing to export.');
    return;
  }

  const archive = rows.map(toArchiveEntry);
  const chapterLabel = chapter === 'all' ? 'all' : `chapter-${chapter}`;
  const defaultFile = `chat-${room.roomId}-${chapterLabel}.json`;
  const outputFile = path.resolve(args.file || defaultFile);
  const pretty = args.pretty !== false;
  const payload = JSON.stringify(archive, null, pretty ? 2 : 0);

  if (args.dryRun) {
    log.warn(`[dry-run] Would write ${archive.length} message(s) to ${outputFile}`);
    return;
  }

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${payload}\n`, 'utf-8');

  if (args.json) {
    console.log(
      JSON.stringify(
        { success: true, file: outputFile, total: archive.length, roomId: room.roomId, chapter },
        null,
        2,
      ),
    );
    return;
  }

  log.success(`Exported ${color.bold(archive.length)} message(s) to ${color.cyan(outputFile)}`);
  log.step(`Room: ${color.bold(room.roomId)}`);
  log.step(`Chapter: ${color.bold(String(chapter))}`);
}

async function commandImport(repository, prompt, args) {
  if (!args.file) throw new Error('You must provide the JSON file with --file <path>.');

  const inputFile = path.resolve(args.file);
  if (!fs.existsSync(inputFile)) throw new Error(`File not found: ${inputFile}`);

  const mode = String(args.mode || 'merge').toLowerCase();
  if (!['merge', 'replace', 'upsert'].includes(mode))
    throw new Error(`Invalid mode: ${mode}. Use merge, replace or upsert.`);

  const raw = fs.readFileSync(inputFile, 'utf-8');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`The file is not a valid JSON: ${err.message}`);
  }

  const { entries, errors } = normalizeArchive(parsed);

  if (errors.length > 0) {
    errors.slice(0, 20).forEach((message) => log.error(message));
    if (errors.length > 20) log.error(`... and ${errors.length - 20} more error(s).`);
    throw new Error('The file contains invalid entries. Nothing was imported.');
  }

  if (entries.length === 0) {
    log.warn('The file does not contain any message. Nothing to import.');
    return;
  }

  const room = await resolveRoom(repository, prompt, args.room);
  const chapter = await resolveChapter(repository, prompt, room, args.chapter, {
    allowAll: true,
    allowNew: true,
  });

  if (chapter === 'all' && entries.every((entry) => typeof entry.chapter !== 'number'))
    log.warn('Chapter "all" selected, but the file has no "chapter" field. Using chapter 1.');

  const existing = await repository.existingIds(room.roomId);

  const rows = entries.map((entry) => ({
    historyId: entry.id,
    roomId: room.roomId,
    userId: entry.user,
    text: entry.message,
    date: entry.time,
    chapter: chapter === 'all' ? entry.chapter || 1 : chapter,
    isModel: entry.isModel,
    edited: 0,
  }));

  const toInsert = [];
  const toUpdate = [];
  let skipped = 0;

  for (const row of rows) {
    // In "replace" mode the target chapter is wiped first, so every row is inserted again.
    const exists = mode !== 'replace' && existing.has(String(row.historyId));
    if (!exists) toInsert.push(row);
    else if (mode === 'upsert') toUpdate.push(row);
    else skipped++;
  }

  if (!args.json) {
    console.log('');
    log.step(`File: ${color.cyan(inputFile)}`);
    log.step(`Room: ${color.bold(room.roomId)}`);
    log.step(`Chapter: ${color.bold(String(chapter))}`);
    log.step(`Mode: ${color.bold(mode)}`);
    log.step(`To insert: ${color.bold(toInsert.length)}`);
    log.step(`To update: ${color.bold(toUpdate.length)}`);
    log.step(`To skip: ${color.bold(skipped)}`);
    console.log('');
  }

  if (args.dryRun) {
    log.warn('[dry-run] Nothing was written to the database.');
    return;
  }

  if (!args.yes && !args.json) {
    const confirmed = await confirm(prompt, 'Do you want to continue?');
    if (!confirmed) return log.warn('Import cancelled.');
  }

  if (mode === 'replace') {
    const chapters = [...new Set(rows.map((row) => row.chapter))];
    for (const value of chapters) await repository.deleteChapter(room.roomId, value);
    log.info(`Chapter(es) ${chapters.join(', ')} cleared.`);
  }

  let inserted = 0;
  let updated = 0;

  for (const row of toInsert) {
    await repository.insertMessage(row);
    inserted++;
  }

  for (const row of toUpdate) {
    await repository.updateMessage(row);
    updated++;
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        { success: true, roomId: room.roomId, chapter, inserted, updated, skipped },
        null,
        2,
      ),
    );
    return;
  }

  log.success(`Import finished: ${inserted} inserted, ${updated} updated, ${skipped} skipped.`);
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) return console.log(HELP);
  if (args.version) return console.log('1.0.0');

  const command = args._[0];
  if (!command) return console.log(HELP);

  if (!['export', 'import', 'rooms', 'chapters'].includes(command))
    throw new Error(`Unknown command: ${command}`);

  const dataDir = resolveDataDir(args.dataDir);
  const { adapter, type, file } = await connectDatabase(dataDir);
  const repository = createRepository(adapter);
  // Piped stdin is valid too (e.g. `printf '1\n2\n' | cli export`), so only
  // disable the prompts when the output has to stay machine readable.
  const prompt = createPrompt(!args.json);

  try {
    if (!args.json) {
      console.log(color.bold('\nTiny Chat - Chat Archive CLI'));
      console.log(color.dim(`  database: ${type}${file ? ` (${file})` : ''}`));
    }

    if (command === 'rooms') await commandRooms(repository, args);
    else if (command === 'chapters') await commandChapters(repository, prompt, args);
    else if (command === 'export') await commandExport(repository, prompt, args);
    else if (command === 'import') await commandImport(repository, prompt, args);
  } finally {
    prompt.close();
    await adapter.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log.error(err && err.message ? err.message : String(err));
    if (process.env.DEBUG) console.error(err);
    process.exit(1);
  });
