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

/** How many rooms a `scope = 'rooms'` playlist may target. */
export const MAX_PLAYLIST_ROOMS = 100;

/** Longest playlist name. */
export const MAX_PLAYLIST_NAME = 80;

/** Longest accepted track id. */
const MAX_TRACK_ID = 256;

/** Track providers accepted by the player. */
export const TRACK_TYPES = ['youtube', 'audio-file'];

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
   * every room (`all`), only on the given room (`room`) or on both (`any`).
   */
  socket.on('list-playlists', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { roomId, filter } = data;

    if (typeof roomId !== 'string' || (typeof filter !== 'string' && filter !== null))
      return sendIncompleteDataInfo(fn);

    const userId = userSession.getUserId(socket);
    if (!userId) return accountNotDetected(fn);
    if (userLoadIsRateLimited(socket, fn)) return;

    const rooms = db.getTable('rooms');
    const room = await rooms.get(roomId);
    if (!room) return fn({ error: true, msg: 'Room not found.', code: 1 });

    // The list belongs to the room owner, so a moderator sees the same
    // playlists the owner configured.
    const table = db.getTable('roomPlaylists');
    const rows = await table.search({
      q: { group: 'AND', conditions: [{ column: 'ownerId', value: room.ownerId }] },
    });

    const list = Array.isArray(rows) ? rows : (rows?.items ?? []);
    const playlists = [];

    for (const row of list) {
      const playlist = serializePlaylist(row, await loadPlaylistRooms(row.playlistId));

      if (filter === 'all' && playlist.scope !== 'all') continue;
      if (filter === 'room' && !playlistCoversRoom(playlist, roomId)) continue;
      if (filter !== 'all' && filter !== 'room' && !playlistCoversRoom(playlist, roomId))
        continue;

      playlists.push(playlist);
    }

    playlists.sort((a, b) => a.name.localeCompare(b.name));

    fn({
      success: true,
      playlists,
      player: await getPlayer(roomId),
      serverTime: Date.now(),
    });
  });

  /** Creates a playlist or updates one owned by the signed-in account. */
  socket.on('save-playlist', async (data, fn) => {
    if (noDataInfo(data, fn)) return;
    const { playlistId, name, tracks, scope, rooms } = data;

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

    const playlistScope = scope === 'rooms' ? 'rooms' : 'all';
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

    const id = randomUUID();
    await table.set(id, {
      ownerId: userId,
      name: cleanName,
      tracks: JSON.stringify(normalizedTracks),
      scope: playlistScope,
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

    if (typeof roomId !== 'string' || typeof action !== 'string')
      return sendIncompleteDataInfo(fn);

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
      case 'pause':
        next.playing = action === 'play';
        next.position = Math.max(0, toNumber(position, currentPosition));
        break;

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

      case 'track':
        next.trackIndex = Math.max(0, Math.floor(toNumber(trackIndex, current.trackIndex)));
        next.position = 0;
        next.duration = 0;
        break;

      case 'playlist': {
        if (typeof playlistId !== 'string')
          return sendIncompleteDataInfo(fn);

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
