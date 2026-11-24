import { randomUUID } from 'crypto';
import { isJsonObject } from 'tiny-essentials/basics/objChecker';
import db from './sql';
import {
  accountNotDetected,
  getIniConfig,
  getRoomRole,
  noDataInfo,
  ownerOnly,
  roomUpdateIsRateLimited,
  sendIncompleteDataInfo,
  userLoadIsRateLimited,
  userSession,
  ROOM_ROLES,
} from './values';

/**
 * Music player of the roleplay rooms.
 *
 * The player is intentionally dumb: the server only stores the *last
 * interaction* (which track, at which position, and when) and every client
 * derives the live position from it. A room with 50 listeners still costs a
 * single row, and a client that joins late is in sync as soon as it reads the
 * state, without a single extra event.
 *
 * @module connection/playerManager
 */

/** How many tracks a playlist may hold. */
export const MAX_PLAYLIST_TRACKS = 500;

/** How many playlists `list-playlists` returns when no page size is given. */
export const MAX_PLAYLIST_PAGE_SIZE = 100;

/** How many rooms a `scope = 'rooms'` playlist may target. */
export const MAX_PLAYLIST_ROOMS = 100;

/** Longest playlist name. */
export const MAX_PLAYLIST_NAME = 80;

/** Longest accepted track id. */
const MAX_TRACK_ID = 256;

/** Longest accepted draw configuration, in characters. */
const MAX_RAFFLE_SIZE = 8192;

/** Track providers accepted by the player. */
export const TRACK_TYPES = ['youtube', 'audio-file'];

/**
 * Shape of a YouTube video id.
 *
 * The client interpolates it into the iframe URL, so the server refuses
 * anything that is not the 11 characters of the URL safe alphabet.
 */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Normalizes a single track sent by the client.
 *
 * Only the two providers the reader already knows are accepted, and the id is
 * length limited, so a playlist can never smuggle an arbitrary URL into the
 * player of the other users.
 *
 * @param {unknown} track - Raw track.
 * @returns {{ type: string, id: string, file: number, title: string|null }|null}
 */
const normalizeTrack = (track) => {
  if (!isJsonObject(track)) return null;

  const { type, id } = track;
  if (typeof type !== 'string' || TRACK_TYPES.indexOf(type) < 0) return null;
  if (typeof id !== 'string') return null;

  const trackId = id.trim();
  if (trackId.length < 1 || trackId.length > MAX_TRACK_ID) return null;

  // `audio-file` folders are paths inside `public/audio`, never a URL.
  if (type === 'audio-file' && (trackId.includes('..') || trackId.startsWith('/'))) return null;

  // A YouTube id is what the client interpolates into the iframe URL, so the
  // shape is enforced here too: the client is not the only way in.
  if (type === 'youtube' && !YOUTUBE_ID.test(trackId)) return null;

  const file = typeof track.file === 'number' && Number.isFinite(track.file) ? track.file : 0;
  const title = typeof track.title === 'string' ? track.title.substring(0, 200) : null;

  return { type, id: trackId, file: Math.max(0, Math.floor(file)), title };
};

/**
 * Normalizes the track list of a playlist.
 *
 * @param {unknown} tracks - Raw track list.
 * @returns {Array<{ type: string, id: string, file: number, title: string|null }>|null}
 */
export const normalizeTracks = (tracks) => {
  if (!Array.isArray(tracks) || tracks.length > MAX_PLAYLIST_TRACKS) return null;

  const list = [];
  for (const track of tracks) {
    const normalized = normalizeTrack(track);
    if (!normalized) return null;
    list.push(normalized);
  }

  return list;
};

/**
 * Parses the `tracks` column, which is stored as JSON.
 *
 * @param {unknown} value - Stored value.
 * @returns {Array<object>}
 */
/**
 * Parses a JSON string, falling back to `null`.
 *
 * @param {string} value - Raw value.
 * @returns {unknown}
 */
const safeJson = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

/**
 * Parses the `raffle` column, which is stored as JSON.
 *
 * The draw configuration is opaque to the server: it is written by the client
 * that owns the playlist and replayed by every listener, so it is only checked
 * for shape here.
 *
 * @param {unknown} value - Stored value.
 * @returns {object|null}
 */
const parseRaffle = (value) => {
  const parsed = typeof value === 'string' ? safeJson(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  return parsed;
};

/**
 * Normalizes the draw configuration of a playlist.
 *
 * @param {unknown} raffle - Raw configuration.
 * @returns {string|null} The serialized configuration, or `null`.
 */
const normalizeRaffle = (raffle) => {
  if (raffle === null || typeof raffle === 'undefined') return null;
  if (typeof raffle !== 'object' || Array.isArray(raffle)) return null;

  const serialized = JSON.stringify(raffle);

  // The column is a configuration, not a payload: anything bigger than this is
  // a mistake (or an attack) and would slow every listener down.
  return serialized.length > MAX_RAFFLE_SIZE ? null : serialized;
};

/**
 * Parses the `tracks` column, which is stored as JSON.
 *
 * @param {unknown} value - Stored value.
 * @returns {Array<object>}
 */
const parseTracks = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/**
 * Serializes a playlist row for the client.
 *
 * @param {Record<string, any>} row - Database row.
 * @param {string[]} [rooms] - Rooms of a `scope = 'rooms'` playlist.
 * @returns {Record<string, any>}
 */
const serializePlaylist = (row, rooms = []) => ({
  playlistId: row.playlistId,
  ownerId: row.ownerId,
  name: typeof row.name === 'string' ? row.name : '',
  tracks: parseTracks(row.tracks),
  scope: row.scope === 'rooms' ? 'rooms' : 'all',
  rooms,
  mode: row.mode === 'raffle' ? 'raffle' : 'ordered',
  raffle: parseRaffle(row.raffle),
  date: typeof row.date === 'number' ? row.date : 0,
  updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
});

/**
 * Loads the rooms of a playlist.
 *
 * @param {string} playlistId - Playlist id.
 * @returns {Promise<string[]>}
 */
const loadPlaylistRooms = async (playlistId) => {
  const table = db.getTable('roomPlaylistRooms');
  const rows = await table.search({
    q: { group: 'AND', conditions: [{ column: 'playlistId', value: playlistId }] },
  });

  const list = Array.isArray(rows) ? rows : (rows?.items ?? []);
  return list.map((item) => item.roomId).filter((roomId) => typeof roomId === 'string');
};

/**
 * Loads the rooms of several playlists with a single query.
 *
 * The listing used to read the rooms of one playlist at a time, which turned a
 * page of 50 playlists into 51 round trips. A single `OR` group keeps it at one
 * query, and the database still does all the work.
 *
 * @param {string[]} playlistIds - Playlist ids.
 * @returns {Promise<Map<string, string[]>>}
 */
const loadPlaylistsRooms = async (playlistIds) => {
  /** @type {Map<string, string[]>} */
  const rooms = new Map();
  if (!Array.isArray(playlistIds) || playlistIds.length < 1) return rooms;

  const table = db.getTable('roomPlaylistRooms');
  const rows = await table.search({
    q: {
      group: 'OR',
      conditions: playlistIds.map((playlistId) => ({ column: 'playlistId', value: playlistId })),
    },
  });

  const list = Array.isArray(rows) ? rows : (rows?.items ?? []);

  for (const row of list) {
    if (typeof row?.roomId !== 'string') continue;

    const current = rooms.get(row.playlistId);
    if (current) current.push(row.roomId);
    else rooms.set(row.playlistId, [row.roomId]);
  }

  return rooms;
};

/**
 * Builds the criteria of `list-playlists`.
 *
 * `global` is the "every room" option of the manager and `room` keeps the
 * playlists that can be used on the given room. Both are resolved by the
 * database, so the whole table never has to be sent to the server.
 *
 * @param {string} ownerId - Owner of the playlists.
 * @param {string} roomId - Room used by the `room` filter.
 * @param {string|null} filter - `global`, `room` or `null`.
 * @returns {Record<string, any>}
 */
const playlistCriteria = (ownerId, roomId, filter) => {
  const conditions = [{ column: 't.ownerId', value: ownerId }];

  if (filter === 'global') {
    conditions.push({ column: 't.scope', value: 'all' });
  } else if (filter === 'room') {
    conditions.push({
      group: 'OR',
      conditions: [
        { column: 'j1.roomId', value: roomId },
      ],
    });
  }

  return { group: 'AND', conditions };
};

/**
 * Lists the playlists of an owner, filtered by the database.
 *
 * @param {string} ownerId - Owner of the playlists.
 * @param {object} [options] - Listing options.
 * @param {string} [options.roomId] - Room used by the `room` filter.
 * @param {string|null} [options.filter] - `global`, `room` or `null`.
 * @param {number|null} [options.limit] - Page size, or `null` for every row.
 * @returns {Promise<Record<string, any>[]>}
 */
const listOwnerPlaylists = async (ownerId, options = {}) => {
  const { roomId = '', filter = null, limit = null } = options;
  const table = db.getTable('roomPlaylists');

  const rows = await table.search({
    q: playlistCriteria(ownerId, roomId, filter),
    select: 't.*',
    // The join is only needed to resolve the rooms of a `scope = 'rooms'`
    // playlist, and it is a primary key lookup, so it never duplicates a row.
    join:
      filter === 'room'
        ? [
            {
              type: 'left',
              table: 'roomPlaylistRooms',
              compare: 't.playlistId = j1.playlistId',
            },
          ]
        : undefined,
    order: 't.name ASC, t.playlistId ASC',
    ...(typeof limit === 'number' ? { limit } : {}),
  });

  return Array.isArray(rows) ? rows : (rows?.items ?? []);
};

/**
 * Counts the playlists of an owner, using the same criteria as the listing.
 *
 * @param {string} ownerId - Owner of the playlists.
 * @param {object} [options] - Counting options.
 * @param {string} [options.roomId] - Room used by the `room` filter.
 * @param {string|null} [options.filter] - `global`, `room` or `null`.
 * @returns {Promise<number>}
 */
const countOwnerPlaylists = async (ownerId, options = {}) => {
  const { roomId = '', filter = null } = options;

  const rows = await db.getTable('roomPlaylists').search({
    q: playlistCriteria(ownerId, roomId, filter),
    select: 'COUNT(*) AS total',
    join:
      filter === 'room'
        ? [
            {
              type: 'left',
              table: 'roomPlaylistRooms',
              compare: 't.playlistId = j1.playlistId',
            },
          ]
        : undefined,
  });

  const total = Number((Array.isArray(rows) ? rows[0] : rows?.items?.[0])?.total);
  return Number.isFinite(total) ? total : 0;
};

/**
 * Normalizes the `limit` of `list-playlists`.
 *
 * @param {unknown} limit - Requested page size.
 * @returns {number|null}
 */
const normalizeLimit = (limit) => {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) return null;
  return Math.min(Math.floor(limit), MAX_PLAYLIST_PAGE_SIZE);
};

/**
 * Replaces the rooms of a playlist.
 *
 * @param {string} playlistId - Playlist id.
 * @param {string[]} rooms - New room list.
 * @returns {Promise<void>}
 */
const replacePlaylistRooms = async (playlistId, rooms) => {
  const table = db.getTable('roomPlaylistRooms');
  const current = await loadPlaylistRooms(playlistId);

  for (const roomId of current) {
    if (rooms.indexOf(roomId) < 0) await table.delete(playlistId, roomId);
  }

  for (const roomId of rooms) {
    if (current.indexOf(roomId) < 0) await table.set(playlistId, { roomId });
  }
};

/**
 * Tells whether a playlist is available on a room.
 *
 * @param {Record<string, any>} playlist - Serialized playlist.
 * @param {string} roomId - Room id.
 * @returns {boolean}
 */
export const playlistCoversRoom = (playlist, roomId) =>
  playlist.scope === 'all' || playlist.rooms.indexOf(roomId) > -1;

/**
 * Loads a playlist by id.
 *
 * @param {string} playlistId - Playlist id.
 * @returns {Promise<Record<string, any>|null>}
 */
export const getPlaylist = async (playlistId) => {
  if (typeof playlistId !== 'string' || playlistId.length < 1) return null;

  const table = db.getTable('roomPlaylists');
  const row = await table.get(playlistId);
  if (!row) return null;

  return serializePlaylist(row, await loadPlaylistRooms(playlistId));
};

/**
 * Builds the initial state of a room player.
 *
 * @param {string} roomId - Room id.
 * @returns {Record<string, any>}
 */
const emptyPlayer = (roomId) => ({
  roomId,
  playlistId: null,
  trackIndex: 0,
  position: 0,
  duration: 0,
  playing: false,
  loop: false,
  volume: 1,
  revision: 0,
  updatedAt: 0,
  updatedBy: null,
});

/**
 * Reads the player of a room, falling back to a stopped player.
 *
 * @param {string} roomId - Room id.
 * @returns {Promise<Record<string, any>>}
 */
export const getPlayer = async (roomId) => {
  const table = db.getTable('roomPlayer');
  const row = await table.get(roomId);
  if (!row) return emptyPlayer(roomId);

  return {
    roomId,
    playlistId: typeof row.playlistId === 'string' ? row.playlistId : null,
    trackIndex: typeof row.trackIndex === 'number' ? row.trackIndex : 0,
    position: typeof row.position === 'number' ? row.position : 0,
    duration: typeof row.duration === 'number' ? row.duration : 0,
    playing: Boolean(row.playing),
    loop: Boolean(row.loopMode),
    volume: typeof row.volume === 'number' ? row.volume : 1,
    revision: typeof row.revision === 'number' ? row.revision : 0,
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
    updatedBy: typeof row.updatedBy === 'string' ? row.updatedBy : null,
  };
};

/**
 * Position the room is listening to right now, in seconds.
 *
 * The stored `position` is only a snapshot taken at `updatedAt`, so using it
 * directly after a pause would rewind the room to the beginning of the song.
 *
 * @param {Record<string, any>} player - Player state.
 * @returns {number}
 */
export const livePosition = (player) => {
  const base = Math.max(0, toNumber(player?.position, 0));
  if (!player?.playing) return base;

  const updatedAt = toNumber(player.updatedAt, 0);
  if (updatedAt <= 0) return base;

  const elapsed = (Date.now() - updatedAt) / 1000;
  return base + (Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0);
};

/**
 * Persists the player of a room.
 *
 * @param {string} roomId - Room id.
 * @param {Record<string, any>} state - New state.
 * @returns {Promise<Record<string, any>>}
 */
const savePlayer = async (roomId, state) => {
  const table = db.getTable('roomPlayer');
  const row = {
    playlistId: state.playlistId,
    trackIndex: state.trackIndex,
    position: state.position,
    duration: state.duration,
    playing: state.playing,
    loopMode: state.loop,
    volume: state.volume,
    revision: state.revision,
    updatedAt: state.updatedAt,
    updatedBy: state.updatedBy,
  };

  if (await table.has(roomId)) await table.update(roomId, row);
  else await table.set(roomId, row);

  return getPlayer(roomId);
};

/**
 * Tells whether an account can control the player of a room.
 *
 * The room owner, the server owner and the room moderators are the DJs.
 *
 * @param {string} roomId - Room id.
 * @param {string} userId - Account id.
 * @param {Record<string, any>} room - Room row.
 * @returns {Promise<boolean>}
 */
const canControl = async (roomId, userId, room) => {
  if (room.ownerId === userId) return true;
  if (userId === getIniConfig('OWNER_ID')) return true;

  const role = await getRoomRole(roomId, userId, room);
  return role === ROOM_ROLES.OWNER || role === ROOM_ROLES.MODERATOR;
};

/**
 * Reads a finite number, falling back to a default.
 *
 * @param {unknown} value - Raw value.
 * @param {number} fallback - Value used when the input is not a number.
 * @returns {number}
 */
const toNumber = (value, fallback) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/**
 * Lists the rooms a playlist is available on.
 *
 * A `scope = 'all'` playlist lives on every room of its owner, so the rooms
 * have to be resolved before an update can be broadcast.
 *
 * @param {Record<string, any>} playlist - Serialized playlist.
 * @returns {Promise<string[]>}
 */
const playlistRooms = async (playlist) => {
  if (playlist.scope !== 'all') return playlist.rooms;

  const table = db.getTable('rooms');
  const rows = await table.search({
    q: { group: 'AND', conditions: [{ column: 'ownerId', value: playlist.ownerId }] },
  });

  const list = Array.isArray(rows) ? rows : (rows?.items ?? []);
  return list.map((room) => room.roomId).filter((roomId) => typeof roomId === 'string');
};

/**
 * Registers the music player events.
 *
 * @param {import('socket.io').Socket} socket - Client socket.
 * @param {import('../proxyOnConnection.mjs').EmitTo} emitTo - Room broadcaster.
 * @param {import('../proxyOnConnection.mjs').EmitTo} socketTo - Socket room broadcaster.
 */
export default function playerManager(socket, emitTo, socketTo) {
  /**
   * Lists the playlists the signed-in account can use on a room.
   *
   * `filter` narrows the result down to the playlists that are available on
   * every room (`global`), only on the given room (`room`) or on both (`any`).
   * The filter, the ordering and the limit are all resolved by the database, so
   * a room with hundreds of playlists never transfers the whole table.
   */
  socket.on('list-playlists', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId, filter, limit } = data;

    if (typeof roomId !== 'string' || (typeof filter !== 'string' && filter !== null))
      return sendIncompleteDataInfo(fn);

    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn);
    if (userLoadIsRateLimited(socket, fn)) return;

    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    if (!room) return fn({ error: true, msg: 'Room not found.', code: 1 });

    // `global` and `room` are the only filters the database knows about;
    // anything else (including the `all` of the manager) means "no filter".
    const scope = filter === 'global' || filter === 'room' ? filter : null;
    const options = { roomId, filter: scope, limit: normalizeLimit(limit) };

    // The list belongs to the room owner, so a moderator sees the same
    // playlists the owner configured.
    const rows = await listOwnerPlaylists(room.ownerId, options);

    // The rooms of the whole page are loaded at once instead of one query per
    // playlist.
    const roomsByPlaylist = await loadPlaylistsRooms(rows.map((row) => row.playlistId));
    const playlists = rows.map((row) =>
      serializePlaylist(row, roomsByPlaylist.get(row.playlistId) ?? []),
    );

    fn({
      success: true,
      playlists,
      total: await countOwnerPlaylists(room.ownerId, options),
      player: await getPlayer(roomId),
      serverTime: Date.now(),
    });
  });

  /** Creates a playlist or updates one owned by the signed-in account. */
  socket.on('save-playlist', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { playlistId, name, tracks, scope, rooms, mode, raffle } = data;

    if (
      (typeof playlistId !== 'string' && playlistId !== null) ||
      (typeof name !== 'string' && name !== null) ||
      (typeof scope !== 'string' && scope !== null) ||
      (rooms !== null && !Array.isArray(rooms))
    )
      return sendIncompleteDataInfo(fn);

    const normalizedTracks = normalizeTracks(tracks);
    if (!normalizedTracks) return sendIncompleteDataInfo(fn);

    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn);
    if (roomUpdateIsRateLimited(socket, fn)) return;

    // The owner configures the server, so the limits do not apply.
    const isOwner = userId === getIniConfig('OWNER_ID');

    if (!isOwner) {
      const maxTracks = getIniConfig('MAX_TRACKS_PER_PLAYLIST');
      if (maxTracks > 0 && normalizedTracks.length > maxTracks)
        return fn({
          error: true,
          code: 4,
          msg: `A playlist may hold at most ${maxTracks} track(s).`,
        });
    }

    const playlistScope = scope === 'rooms' ? 'rooms' : 'all';
    const playlistMode = mode === 'raffle' ? 'raffle' : 'ordered';
    const playlistRaffle = normalizeRaffle(raffle);
    const roomList = playlistScope === 'rooms' ? [...new Set(rooms ?? [])] : [];

    if (roomList.length > MAX_PLAYLIST_ROOMS) return sendIncompleteDataInfo(fn);
    if (roomList.some((roomId) => typeof roomId !== 'string')) return sendIncompleteDataInfo(fn);

    const table = db.getTable('roomPlaylists');
    const now = Date.now();
    const cleanName = typeof name === 'string' ? name.substring(0, MAX_PLAYLIST_NAME) : '';

    // Editing an existing playlist.
    if (typeof playlistId === 'string' && playlistId.length > 0) {
      const current = await table.get(playlistId);
      if (!current) return fn({ error: true, msg: 'Playlist not found.', code: 1 });
      if (current.ownerId !== userId) return ownerOnly(fn, 2);

      await table.update(playlistId, {
        name: cleanName,
        tracks: JSON.stringify(normalizedTracks),
        scope: playlistScope,
        mode: playlistMode,
        raffle: playlistRaffle,
        updatedAt: now,
      });
      await replacePlaylistRooms(playlistId, roomList);

      const playlist = await getPlaylist(playlistId);

      // Every listener has to follow the new version, including the DJ that
      // saved it: the tracks are what turn a `trackIndex` into something
      // playable, so a stale copy keeps playing the old song forever.
      //
      // `emitTo` is used on purpose: `socketTo` is `socket.to(room)`, which
      // skips the sender, so the DJ would never see their own change.
      for (const roomId of await playlistRooms(playlist)) {
        emitTo(roomId, 'playlist-updated', { roomId, playlist });
      }

      return fn({ success: true, playlist });
    }

    // A new playlist is being created: the account may have hit its quota.
    if (!isOwner) {
      const maxPlaylists = getIniConfig('MAX_PLAYLISTS_PER_USER');

      if (maxPlaylists > 0) {
        const owned = await table.search({
          q: { group: 'AND', conditions: [{ column: 'ownerId', value: userId }] },
        });

        const total = (Array.isArray(owned) ? owned : (owned?.items ?? [])).length;

        if (total >= maxPlaylists)
          return fn({
            error: true,
            code: 5,
            msg: `You have reached the limit of ${maxPlaylists} playlist(s).`,
          });
      }
    }

    const id = randomUUID();
    await table.set(id, {
      ownerId: userId,
      name: cleanName,
      tracks: JSON.stringify(normalizedTracks),
      scope: playlistScope,
      mode: playlistMode,
      raffle: playlistRaffle,
      date: now,
      updatedAt: now,
    });
    await replacePlaylistRooms(id, roomList);

    fn({ success: true, playlist: await getPlaylist(id) });
  });

  /** Deletes a playlist owned by the signed-in account. */
  socket.on('delete-playlist', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { playlistId } = data;
    if (typeof playlistId !== 'string') return sendIncompleteDataInfo(fn);

    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn);
    if (roomUpdateIsRateLimited(socket, fn)) return;

    const table = db.getTable('roomPlaylists');
    const current = await table.get(playlistId);
    if (!current) return fn({ error: true, msg: 'Playlist not found.', code: 1 });
    if (current.ownerId !== userId) return ownerOnly(fn, 2);

    const playlist = await getPlaylist(playlistId);

    await replacePlaylistRooms(playlistId, []);
    await table.delete(playlistId);

    // A deleted playlist can no longer be resolved, so the rooms are told to
    // drop it instead of keeping a ghost entry in the list.
    if (playlist) {
      for (const roomId of await playlistRooms(playlist)) {
        emitTo(roomId, 'playlist-deleted', { roomId, playlistId });
      }
    }

    fn({ success: true });
  });

  /** Reads the current state of the room player. */
  socket.on('get-player', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId } = data;
    if (typeof roomId !== 'string') return sendIncompleteDataInfo(fn);

    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn);

    const rooms = db.getTable('rooms');
    if (!(await rooms.has(roomId))) return fn({ error: true, msg: 'Room not found.', code: 1 });

    fn({ success: true, player: await getPlayer(roomId), serverTime: Date.now() });
  });

  /**
   * Applies an interaction to the room player.
   *
   * Only the DJ (room owner, server owner or a room moderator) can call it. The
   * new state is broadcast to the whole room, so a client never has to poll.
   */
  socket.on('set-player', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId, action, playlistId, trackIndex, position, duration, volume, loop } = data;
    const { expectedRevision } = data;

    if (typeof roomId !== 'string' || typeof action !== 'string') return sendIncompleteDataInfo(fn);

    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn);
    if (roomUpdateIsRateLimited(socket, fn)) return;

    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    if (!room) return fn({ error: true, msg: 'Room not found.', code: 1 });

    if (!(await canControl(roomId, userId, room))) return ownerOnly(fn, 2);

    const current = await getPlayer(roomId);

    // Optimistic concurrency. Every client of the room asks for the next track
    // when the current one ends, so the first request wins and the others are
    // dropped instead of skipping a track.
    if (typeof expectedRevision === 'number' && expectedRevision !== current.revision)
      return fn({ success: true, player: current, stale: true });

    const next = { ...current, updatedAt: Date.now(), updatedBy: userId };

    // The stored position is a snapshot, so every action that keeps the
    // playhead has to move it forward first. Without this a pause would rewind
    // the room to the last interaction (usually the beginning of the song).
    const currentPosition = livePosition(current);

    switch (action) {
      case 'play':
      case 'pause': {
        next.playing = action === 'play';
        let nextPosition = Math.max(0, toNumber(position, currentPosition));

        // Resuming a playlist that already reached the end has to start it
        // over, otherwise the room would stay stuck on the last second of the
        // last track forever.
        if (next.playing && current.duration > 0 && nextPosition >= current.duration)
          nextPosition = 0;

        next.position = nextPosition;
        break;
      }

      case 'seek':
        next.position = Math.max(0, toNumber(position, currentPosition));
        break;

      case 'volume':
        next.volume = Math.min(1, Math.max(0, toNumber(volume, current.volume)));
        next.position = currentPosition;
        break;

      // The DJ turned the repeat on or off. It is a room setting, so it is
      // kept even when the playlist is not playing.
      case 'loop':
        next.loop = Boolean(loop);
        next.position = currentPosition;
        break;

      // Every client reports the duration of the media it loaded, so a visitor
      // that joins later knows whether the playlist already ended.
      case 'duration': {
        const value = toNumber(duration, 0);
        next.duration = value > 0 ? value : 0;
        next.position = currentPosition;
        break;
      }

      // The DJ pressed "next" (or a client reached the end of the track). The
      // index is clamped against the real playlist: an out of range index used
      // to be stored as is, which left the whole room with a track that does
      // not exist and no way to recover but picking the playlist again.
      case 'track': {
        const playlist = current.playlistId ? await getPlaylist(current.playlistId) : null;
        const total = Array.isArray(playlist?.tracks) ? playlist.tracks.length : 0;
        const wanted = Math.floor(toNumber(trackIndex, current.trackIndex));
        const lastIndex = total > 0 ? total - 1 : 0;

        next.trackIndex = Math.min(Math.max(0, wanted), lastIndex);
        next.position = 0;
        next.duration = 0;

        // Skipping a track is an explicit interaction: the room expects to
        // hear the new track even when the player was paused.
        next.playing = true;
        break;
      }

      case 'playlist': {
        if (typeof playlistId !== 'string') return sendIncompleteDataInfo(fn);

        // An empty id stops the player and clears the playlist.
        if (playlistId.length < 1) {
          next.playlistId = null;
          next.trackIndex = 0;
          next.position = 0;
          next.duration = 0;
          next.playing = false;
          break;
        }

        const playlist = await getPlaylist(playlistId);
        if (!playlist) return fn({ error: true, msg: 'Playlist not found.', code: 2 });
        if (playlist.ownerId !== room.ownerId)
          return fn({ error: true, msg: 'Playlist not found.', code: 2 });
        if (!playlistCoversRoom(playlist, roomId))
          return fn({ error: true, msg: 'This playlist is not available here.', code: 3 });

        next.playlistId = playlistId;
        next.trackIndex = 0;
        next.position = 0;
        next.duration = 0;
        next.playing = true;
        break;
      }

      default:
        return sendIncompleteDataInfo(fn);
    }

    next.revision = current.revision + 1;
    const player = await savePlayer(roomId, next);

    // Every client of the room, including the DJ's other tabs, follows the
    // same event, so the state can never drift between them.
    const serverTime = Date.now();
    emitTo(roomId, 'player-updated', { roomId, player, serverTime });

    fn({ success: true, player, serverTime });
  });
}
