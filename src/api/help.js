/**
 * Shared help text and version helpers for every Tiny Chat binary.
 *
 * @module help
 */

import { readFileSync } from 'fs';
import { join } from 'path';

/* global __APP_VERSION__ */

/**
 * Reads the current version.
 *
 * The build script injects `__APP_VERSION__` with esbuild's `define` option.
 * When the module is loaded directly by Node (development), it falls back to
 * reading `package.json` from disk.
 *
 * @returns {string} The current version.
 */
const readVersion = () => {
  if (typeof __APP_VERSION__ === 'string') return __APP_VERSION__;

  try {
    return JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8')).version;
  } catch {
    return '0.0.0';
  }
};

export const VERSION = readVersion();

/**
 * Help text of the standalone server binary.
 *
 * @param {string} [bin='tiny-chat'] Binary name shown in the usage line.
 * @returns {string} The formatted help text.
 */
export const getServerHelp = (bin = 'tiny-chat') =>
  `
Tiny Chat Server v${VERSION}

USAGE
  ${bin} [options]

DESCRIPTION
  Starts the Tiny Chat server. The server reads its configuration from
  config.ini next to the executable (or from the current directory when
  running from source).

OPTIONS
  -h, --help       Show this help
  -v, --version    Show the version

FILES
  config.ini         Server configuration (port, database, limits)
  tiny-chat_data/    Data folder (database, uploads)

ENVIRONMENT
  NODE_ENV           Set to "production" to disable debug mode

EXAMPLES
  ${bin}
  ${bin} --help
  ${bin} --version
`.trimStart();

/**
 * Help text of the unified launcher.
 *
 * It is a superset of {@link getServerHelp}: the server is the default mode,
 * so its options are inlined instead of hidden behind `--app server --help`.
 *
 * @param {string} [bin='tiny-chat-all'] Binary name shown in the usage line.
 * @returns {string} The formatted help text.
 */
export const getLauncherHelp = (bin = 'tiny-chat-all') =>
  `
Tiny Chat v${VERSION}

USAGE
  ${bin} [--app <mode>] [options]

MODES
  server     Start the chat server (default)
  proxy      Start the Socket.IO proxy
  archive    Import and export chat history

OPTIONS
  -a, --app <mode>   Application to run (default: server)
  -h, --help         Show this help
  -v, --version      Show the version

SERVER MODE (--app server)
  Starts the Tiny Chat server. The server reads its configuration from
  config.ini next to the executable.

  Files:
    config.ini         Server configuration (port, database, limits)
    tiny-chat_data/    Data folder (database, uploads)

  Environment:
    NODE_ENV           Set to "production" to disable debug mode

PROXY MODE (--app proxy)
  Starts the Socket.IO proxy. The proxy reads its configuration from
  proxy-config.ini next to the executable.

ARCHIVE MODE (--app archive)
  Imports and exports chat history. Run "${bin} --app archive --help"
  for the full list of options.

EXAMPLES
  ${bin}
  ${bin} --app server
  ${bin} --app proxy
  ${bin} --app archive export --room lobby
  ${bin} --app archive --help
`.trimStart();
