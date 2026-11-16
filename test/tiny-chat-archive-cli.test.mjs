import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runCli } from './helpers/cli.mjs';
import {
  createFixture,
  seedMessages,
  readMessages,
  seedTrash,
  readTrash,
  openDatabase,
  run,
  close,
} from './helpers/database.mjs';

/** @type {Awaited<ReturnType<typeof createFixture>>} */
let fixture;
/** @type {string} */
let workDir;

const dataDir = () => fixture.dir;
const jsonFile = (name) => join(workDir, name);

const readJson = (file) => JSON.parse(readFileSync(file, 'utf-8'));

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'tiny-chat-cli-out-'));
  fixture = await createFixture({
    rooms: [
      { roomId: 'lobby', title: 'Lobby' },
      { roomId: 'rpg', title: "Dungeon master's table" },
    ],
  });

  await seedMessages(fixture.file, [
    { text: 'first', date: 1000, chapter: 1 },
    { text: 'second', date: 2000, chapter: 1 },
    { text: 'third', date: 3000, chapter: 2 },
  ]);
});

after(() => {
  fixture?.cleanup();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// Basic interface
// -----------------------------------------------------------------------------

describe('interface', () => {
  test('--version prints the package.json version', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    const { code, stdout } = await runCli(['--version']);

    assert.equal(code, 0);
    assert.equal(stdout.trim(), pkg.version);
  });

  test('--help lists every command', async () => {
    const { code, stdout } = await runCli(['--help']);

    assert.equal(code, 0);
    for (const command of ['export', 'import', 'rooms', 'chapters'])
      assert.match(stdout, new RegExp(command));
  });

  test('no command prints the help', async () => {
    const { code, stdout } = await runCli([]);

    assert.equal(code, 0);
    assert.match(stdout, /USAGE/);
  });

  test('unknown command fails', async () => {
    const { code, stderr } = await runCli(['nao-existe']);

    assert.equal(code, 1);
    assert.match(stderr, /Unknown command/);
  });

  test('unknown option fails', async () => {
    const { code, stderr } = await runCli(['rooms', '--nope']);

    assert.equal(code, 1);
    assert.match(stderr, /Unknown option/);
  });

  test('the file is executable and has a shebang', () => {
    const source = readFileSync(
      new URL('../build/tiny-chat-archive-cli.js', import.meta.url),
      'utf-8',
    );
    assert.ok(source.startsWith('#!/usr/bin/env node'));
  });
});

// -----------------------------------------------------------------------------
// rooms / chapters
// -----------------------------------------------------------------------------

describe('rooms', () => {
  test('lists the rooms', async () => {
    const { code, stdout } = await runCli(['rooms', '-d', dataDir()]);

    assert.equal(code, 0);
    assert.match(stdout, /lobby/);
    assert.match(stdout, /rpg/);
  });

  test('--json returns an array', async () => {
    const { code, stdout } = await runCli(['rooms', '-d', dataDir(), '--json']);

    assert.equal(code, 0);
    const rooms = JSON.parse(stdout);
    assert.ok(Array.isArray(rooms));
    assert.deepEqual(rooms.map((room) => room.roomId).sort(), ['lobby', 'rpg']);
  });
});

describe('chapters', () => {
  test('groups the messages by chapter', async () => {
    const { code, stdout } = await runCli(['chapters', '-d', dataDir(), '-r', 'lobby', '--json']);

    assert.equal(code, 0);
    const { roomId, chapters } = JSON.parse(stdout);
    assert.equal(roomId, 'lobby');
    assert.deepEqual(
      chapters.map((item) => [item.chapter, item.total]),
      [
        [1, 2],
        [2, 1],
      ],
    );
  });

  test('a missing room fails with the list of rooms', async () => {
    const { code, stderr } = await runCli(['chapters', '-d', dataDir(), '-r', 'nao-existe']);

    assert.equal(code, 1);
    assert.match(stderr, /not found/);
    assert.match(stderr, /lobby/);
  });
});

// -----------------------------------------------------------------------------
// export
// -----------------------------------------------------------------------------

describe('export', () => {
  test('exports a chapter in the expected format', async () => {
    const file = jsonFile('cap1.json');
    const { code } = await runCli([
      'export',
      '-d',
      dataDir(),
      '-r',
      'lobby',
      '-c',
      '1',
      '-f',
      file,
      '--minimal',
    ]);

    assert.equal(code, 0);
    const archive = readJson(file);

    assert.equal(archive.length, 2);
    assert.deepEqual(Object.keys(archive[0]).sort(), ['id', 'message', 'time', 'user']);
    assert.deepEqual(
      archive.map((item) => item.message),
      ['first', 'second'],
    );
    assert.equal(archive[0].user, 'admin');
    assert.equal(archive[0].time, 1000);
  });

  test('exports the optional metadata by default', async () => {
    const file = jsonFile('metadata.json');
    await runCli(['export', '-d', dataDir(), '-r', 'lobby', '-c', '1', '-f', file]);

    const [entry] = readJson(file);
    assert.equal(entry.edited, 0);
    assert.equal(entry.isModel, undefined);
  });

  test('--minimal drops every optional column', async () => {
    const file = jsonFile('minimal.json');
    await runCli(['export', '-d', dataDir(), '-r', 'lobby', '-c', '1', '-f', file, '--minimal']);

    const [entry] = readJson(file);
    for (const key of ['model', 'hash', 'edited', 'tokens', 'errorCode', 'isModel'])
      assert.equal(entry[key], undefined);
  });

  test('exports every chapter with -c all', async () => {
    const file = jsonFile('all.json');
    const { code } = await runCli([
      'export',
      '-d',
      dataDir(),
      '-r',
      'lobby',
      '-c',
      'all',
      '-f',
      file,
    ]);

    assert.equal(code, 0);
    assert.equal(readJson(file).length, 3);
  });

  test('sorts the messages by date', async () => {
    const file = jsonFile('sorted.json');
    await runCli(['export', '-d', dataDir(), '-r', 'lobby', '-c', 'all', '-f', file]);

    const times = readJson(file).map((item) => item.time);
    assert.deepEqual(
      times,
      [...times].sort((a, b) => a - b),
    );
  });

  test('--compact produces a single line', async () => {
    const file = jsonFile('compact.json');
    await runCli(['export', '-d', dataDir(), '-r', 'lobby', '-c', '1', '-f', file, '--compact']);

    assert.equal(readFileSync(file, 'utf-8').trim().split('\n').length, 1);
  });

  test('an empty chapter does not create a file', async () => {
    const file = jsonFile('empty.json');
    const { code, stdout } = await runCli([
      'export',
      '-d',
      dataDir(),
      '-r',
      'lobby',
      '-c',
      '99',
      '-f',
      file,
    ]);

    assert.equal(code, 0);
    assert.match(stdout, /No messages found/);
    assert.equal(existsSync(file), false);
  });

  test('--dry-run does not write the file', async () => {
    const file = jsonFile('dry.json');
    const { code, stdout } = await runCli([
      'export',
      '-d',
      dataDir(),
      '-r',
      'lobby',
      '-c',
      '1',
      '-f',
      file,
      '--dry-run',
    ]);

    assert.equal(code, 0);
    assert.match(stdout, /dry-run/);
    assert.equal(existsSync(file), false);
  });
});

// -----------------------------------------------------------------------------
// import
// -----------------------------------------------------------------------------

describe('import', () => {
  /** Creates a valid archive file with the given messages. */
  const archive = (name, messages) => {
    const file = jsonFile(name);
    writeFileSync(file, JSON.stringify(messages), 'utf-8');
    return file;
  };

  /**
   * The `history` primary key is (roomId, historyId), so every test needs its
   * own id namespace even when it targets a different chapter.
   */
  const sample = (prefix) => [
    { message: 'hi', time: 10000, id: `${prefix}-a`, user: 'alice' },
    { message: 'hello', time: 20000, id: `${prefix}-b`, user: 'bob' },
  ];

  test('inserts the messages into the chosen chapter', async () => {
    const file = archive('import-basic.json', sample('basic'));
    const { code } = await runCli([
      'import',
      '-d',
      dataDir(),
      '-r',
      'rpg',
      '-c',
      '5',
      '-f',
      file,
      '-y',
    ]);

    assert.equal(code, 0);
    const rows = await readMessages(fixture.file, 'rpg', 5);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.text),
      ['hi', 'hello'],
    );
    assert.deepEqual(
      rows.map((row) => row.userId),
      ['alice', 'bob'],
    );
  });

  test('merge does not duplicate existing messages', async () => {
    const file = archive('import-merge.json', sample('merge'));
    const args = ['import', '-d', dataDir(), '-r', 'rpg', '-c', '6', '-f', file, '-y'];

    await runCli(args);
    const { stdout } = await runCli(args);

    assert.match(stdout, /0 inserted/);
    assert.match(stdout, /2 skipped/);
    assert.equal((await readMessages(fixture.file, 'rpg', 6)).length, 2);
  });

  test('upsert updates the existing messages', async () => {
    const file = archive('import-upsert.json', sample('upsert'));
    await runCli(['import', '-d', dataDir(), '-r', 'rpg', '-c', '7', '-f', file, '-y']);

    const changed = archive('import-upsert-2.json', [
      { message: 'new text', time: 10000, id: 'upsert-a', user: 'alice' },
    ]);
    const { stdout } = await runCli([
      'import',
      '-d',
      dataDir(),
      '-r',
      'rpg',
      '-c',
      '7',
      '-f',
      changed,
      '-m',
      'upsert',
      '-y',
    ]);

    assert.match(stdout, /1 updated/);
    const rows = await readMessages(fixture.file, 'rpg', 7);
    assert.equal(rows.find((row) => row.historyId === 'upsert-a').text, 'new text');
  });

  test('replace clears the chapter before inserting', async () => {
    const file = archive('import-replace.json', sample('replace'));
    await runCli(['import', '-d', dataDir(), '-r', 'rpg', '-c', '8', '-f', file, '-y']);

    const only = archive('import-replace-2.json', [
      { message: 'only one', time: 30000, id: 'ccc', user: 'carol' },
    ]);
    await runCli([
      'import',
      '-d',
      dataDir(),
      '-r',
      'rpg',
      '-c',
      '8',
      '-f',
      only,
      '-m',
      'replace',
      '-y',
    ]);

    const rows = await readMessages(fixture.file, 'rpg', 8);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, 'only one');
  });

  test('export -> import round-trip preserves the data', async () => {
    const exported = jsonFile('roundtrip.json');
    await runCli(['export', '-d', dataDir(), '-r', 'lobby', '-c', 'all', '-f', exported]);

    const { code } = await runCli([
      'import',
      '-d',
      dataDir(),
      '-r',
      'rpg',
      '-c',
      '9',
      '-f',
      exported,
      '-m',
      'replace',
      '-y',
    ]);
    assert.equal(code, 0);

    const again = jsonFile('roundtrip-2.json');
    await runCli(['export', '-d', dataDir(), '-r', 'rpg', '-c', '9', '-f', again]);

    assert.deepEqual(readJson(again), readJson(exported));
  });

  test('round-trips the optional metadata', async () => {
    const file = archive('metadata.json', [
      {
        message: 'with metadata',
        time: 60000,
        id: 'meta-a',
        user: 'erin',
        model: 'gpt-test',
        hash: 'abc123',
        edited: 1234,
        tokens: 42,
        errorCode: 'E_NONE',
        isModel: true,
      },
    ]);

    await runCli(['import', '-d', dataDir(), '-r', 'rpg', '-c', '16', '-f', file, '-y']);

    const exported = jsonFile('metadata-out.json');
    await runCli(['export', '-d', dataDir(), '-r', 'rpg', '-c', '16', '-f', exported]);

    const [entry] = readJson(exported);
    assert.equal(entry.model, 'gpt-test');
    assert.equal(entry.hash, 'abc123');
    assert.equal(entry.edited, 1234);
    assert.equal(entry.tokens, 42);
    assert.equal(entry.errorCode, 'E_NONE');
    assert.equal(entry.isModel, true);
  });

  test('generates an id when the field is missing', async () => {
    const file = archive('no-id.json', [{ message: 'no id', time: 50000, user: 'dave' }]);
    await runCli(['import', '-d', dataDir(), '-r', 'rpg', '-c', '10', '-f', file, '-y']);

    const rows = await readMessages(fixture.file, 'rpg', 10);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].historyId);
  });

  test('--dry-run writes nothing', async () => {
    const file = archive('dry-import.json', sample('dry'));
    const { code, stdout } = await runCli([
      'import',
      '-d',
      dataDir(),
      '-r',
      'rpg',
      '-c',
      '11',
      '-f',
      file,
      '--dry-run',
    ]);

    assert.equal(code, 0);
    assert.match(stdout, /dry-run/);
    assert.equal((await readMessages(fixture.file, 'rpg', 11)).length, 0);
  });

  test('rejects a file that is not an array', async () => {
    const file = jsonFile('not-array.json');
    writeFileSync(file, '{"a":1}', 'utf-8');

    const { code, stderr } = await runCli([
      'import',
      '-d',
      dataDir(),
      '-r',
      'rpg',
      '-c',
      '12',
      '-f',
      file,
      '-y',
    ]);

    assert.equal(code, 1);
    assert.match(stderr, /must be an array/);
  });

  test('rejects invalid entries without writing anything', async () => {
    const file = jsonFile('invalid.json');
    writeFileSync(file, JSON.stringify([{ message: 1, time: 'x', user: '' }]), 'utf-8');

    const { code, stderr } = await runCli([
      'import',
      '-d',
      dataDir(),
      '-r',
      'rpg',
      '-c',
      '13',
      '-f',
      file,
      '-y',
    ]);

    assert.equal(code, 1);
    assert.match(stderr, /invalid "message"/);
    assert.equal((await readMessages(fixture.file, 'rpg', 13)).length, 0);
  });

  test('rejects an invalid mode', async () => {
    const file = archive('bad-mode.json', sample('badmode'));
    const { code, stderr } = await runCli([
      'import',
      '-d',
      dataDir(),
      '-r',
      'rpg',
      '-c',
      '14',
      '-f',
      file,
      '-m',
      'nope',
      '-y',
    ]);

    assert.equal(code, 1);
    assert.match(stderr, /Invalid mode/);
  });

  test('rejects a missing file', async () => {
    const { code, stderr } = await runCli([
      'import',
      '-d',
      dataDir(),
      '-r',
      'rpg',
      '-c',
      '15',
      '-f',
      '/path/that/does/not/exist.json',
      '-y',
    ]);

    assert.equal(code, 1);
    assert.match(stderr, /File not found/);
  });
});

// -----------------------------------------------------------------------------
// Interactive selection
// -----------------------------------------------------------------------------

describe('interactive mode', () => {
  test('accepts answers through stdin', async () => {
    const file = jsonFile('interactive.json');
    const { code } = await runCli(['export', '-d', dataDir(), '-f', file], { input: '1\nA\n' });

    assert.equal(code, 0);
    assert.ok(existsSync(file));
  });

  test('aborts when stdin closes without an answer', async () => {
    const { code, stderr } = await runCli(['export', '-d', dataDir(), '-f', jsonFile('x.json')], {
      input: '',
    });

    assert.equal(code, 1);
    assert.match(stderr, /Aborting|No option|No more input/);
  });
});

// -----------------------------------------------------------------------------
// restore (historyDeleted -> history)
// -----------------------------------------------------------------------------

const DAY = 86400000;
const NOW = Date.UTC(2026, 0, 10, 12, 0, 0);

/** Creates an isolated room with a seeded safety backup. */
async function trashFixture(roomId) {
  const db = openDatabase(fixture.file);
  try {
    await run(db, 'INSERT INTO rooms (roomId, title, ownerId) VALUES (?, ?, ?)', [
      roomId,
      roomId,
      'admin',
    ]);
  } finally {
    await close(db);
  }

  await seedTrash(
    fixture.file,
    [0, 1, 2, 3].map((index) => ({
      roomId,
      userId: index % 2 === 0 ? 'alice' : 'bob',
      text: `deleted ${index}`,
      date: NOW - index * DAY,
      chapter: 1,
    })),
  );

  return roomId;
}

describe('restore', () => {
  test('--limit restores the newest messages and clears them from the backup', async () => {
    const room = await trashFixture('restore-limit');

    const { code } = await runCli(['restore', '-d', dataDir(), '-r', room, '--limit', '2'], {
      input: 'restore\n',
    });

    assert.equal(code, 0);
    const restored = await readMessages(fixture.file, room);
    assert.deepEqual(
      restored.map((row) => row.text),
      ['deleted 1', 'deleted 0'],
    );
    assert.equal((await readTrash(fixture.file, room)).length, 2);
  });

  test('--dates restores every message of the N most recent days', async () => {
    const room = await trashFixture('restore-dates');

    const { code } = await runCli(['restore', '-d', dataDir(), '-r', room, '--dates', '2'], {
      input: 'restore\n',
    });

    assert.equal(code, 0);
    assert.equal((await readMessages(fixture.file, room)).length, 2);
    assert.equal((await readTrash(fixture.file, room)).length, 2);
  });

  test('--all restores the whole backup', async () => {
    const room = await trashFixture('restore-all');

    await runCli(['restore', '-d', dataDir(), '-r', room, '--all'], { input: 'restore\n' });

    assert.equal((await readMessages(fixture.file, room)).length, 4);
    assert.equal((await readTrash(fixture.file, room)).length, 0);
  });

  test('a wrong confirmation word changes nothing', async () => {
    const room = await trashFixture('restore-cancel');

    const { stdout } = await runCli(['restore', '-d', dataDir(), '-r', room, '--all'], {
      input: 'yes\n',
    });

    assert.match(stdout, /cancelled/i);
    assert.equal((await readMessages(fixture.file, room)).length, 0);
    assert.equal((await readTrash(fixture.file, room)).length, 4);
  });

  test('--dry-run writes nothing', async () => {
    const room = await trashFixture('restore-dry');

    const { stdout } = await runCli(['restore', '-d', dataDir(), '-r', room, '--all', '--dry-run']);

    assert.match(stdout, /dry-run/);
    assert.equal((await readMessages(fixture.file, room)).length, 0);
    assert.equal((await readTrash(fixture.file, room)).length, 4);
  });

  test('requires a scope flag', async () => {
    const room = await trashFixture('restore-noscope');

    const { code, stderr } = await runCli(['restore', '-d', dataDir(), '-r', room]);

    assert.equal(code, 1);
    assert.match(stderr, /--limit/);
  });

  test('rejects two scopes at once', async () => {
    const room = await trashFixture('restore-both');

    const { code, stderr } = await runCli([
      'restore',
      '-d',
      dataDir(),
      '-r',
      room,
      '--all',
      '--limit',
      '1',
    ]);

    assert.equal(code, 1);
    assert.match(stderr, /only one/i);
  });

  test('--older-than only matches messages older than the window', async () => {
    const room = await trashFixture('restore-older');

    // Every seeded message is in the past, so a 0 day window matches nothing.
    const { stdout } = await runCli(
      ['restore', '-d', dataDir(), '-r', room, '--older-than', '0', '--dry-run'],
      { input: '' },
    );

    assert.match(stdout, /dry-run/);
    assert.equal((await readTrash(fixture.file, room)).length, 4);
  });
});

// -----------------------------------------------------------------------------
// trash
// -----------------------------------------------------------------------------

describe('trash', () => {
  test('list is read-only', async () => {
    const room = await trashFixture('trash-list');

    const { code, stdout } = await runCli(['trash', 'list', '-d', dataDir(), '-r', room]);

    assert.equal(code, 0);
    assert.match(stdout, /SAFETY BACKUP/);
    assert.equal((await readTrash(fixture.file, room)).length, 4);
  });

  test('purge --limit deletes only the selection', async () => {
    const room = await trashFixture('trash-purge');

    const { code } = await runCli(['trash', 'purge', '-d', dataDir(), '-r', room, '--limit', '3'], {
      input: 'delete\n',
    });

    assert.equal(code, 0);
    assert.equal((await readTrash(fixture.file, room)).length, 1);
  });

  test('purge --dry-run keeps everything', async () => {
    const room = await trashFixture('trash-dry');

    const { stdout } = await runCli([
      'trash',
      'purge',
      '-d',
      dataDir(),
      '-r',
      room,
      '--all',
      '--dry-run',
    ]);

    assert.match(stdout, /dry-run/);
    assert.equal((await readTrash(fixture.file, room)).length, 4);
  });

  test('empty --room wipes a single room', async () => {
    const room = await trashFixture('trash-empty-room');

    const { code } = await runCli(['trash', 'empty', '-d', dataDir(), '-r', room], {
      input: `${room}\n`,
    });

    assert.equal(code, 0);
    assert.equal((await readTrash(fixture.file, room)).length, 0);
  });

  test('empty without --room wipes every room', async () => {
    const room = await trashFixture('trash-empty-all');

    const { code } = await runCli(['trash', 'empty', '-d', dataDir()], {
      input: 'DELETE EVERYTHING\n',
    });

    assert.equal(code, 0);
    assert.equal((await readTrash(fixture.file, room)).length, 0);
  });

  test('an unknown action fails', async () => {
    const room = await trashFixture('trash-bad');

    const { code, stderr } = await runCli(['trash', 'nope', '-d', dataDir(), '-r', room]);

    assert.equal(code, 1);
    assert.match(stderr, /Unknown trash action/);
  });
});

// -----------------------------------------------------------------------------
// Database discovery
// -----------------------------------------------------------------------------

describe('database discovery', () => {
  test('fails when the folder has no database.db', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'tiny-chat-empty-'));

    try {
      const { code, stderr } = await runCli(['rooms', '-d', emptyDir]);

      assert.equal(code, 1);
      assert.match(stderr, /Database file not found/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
