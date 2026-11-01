/**
 * Shared help text and version helpers for every Tiny RPG Chat binary.
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
Tiny RPG Chat Server v${VERSION}

USAGE
  ${bin} [options]

DESCRIPTION
  Starts the Tiny RPG Chat server. The server reads its configuration from
  config.ini next to the executable (or from the current directory when
  running from source).

OPTIONS
  -h, --help       Show this help
  -v, --version    Show the version

CONFIGURATION OVERRIDES
  --set <section>.<key>=<value>   Override a config.ini value (repeatable)

  Values are coerced: true/false become booleans, numbers become numbers,
  null becomes null, everything else stays a string. The override is applied
  on top of the file, so the file is still the source of truth for everything
  else.

  Examples:
    ${bin} --set server.port=8080
    ${bin} --set database.type=postgre --set database.host=db.local
    ${bin} --set limits.MESSAGE_SIZE=50000

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
Tiny RPG Chat v${VERSION}

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

CONFIGURATION OVERRIDES
  --set <section>.<key>=<value>   Override a config value (repeatable)

  Forwarded to the selected mode. See "${bin} --app <mode> --help".

SERVER MODE (--app server)
  Starts the Tiny RPG Chat server. The server reads its configuration from
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

/**
 * Help text of the standalone proxy binary.
 *
 * @param {string} [bin='tiny-chat-proxy'] Binary name shown in the usage line.
 * @returns {string} The formatted help text.
 */
export const getProxyHelp = (bin = 'tiny-chat-proxy') =>
  `
Tiny RPG Chat Proxy v${VERSION}

USAGE
  ${bin} [options]

DESCRIPTION
  Starts the Socket.IO proxy. The proxy reads its configuration from
  proxy-config.ini next to the executable.

OPTIONS
  -h, --help       Show this help
  -v, --version    Show the version

CONFIGURATION OVERRIDES
  --set <section>.<key>=<value>   Override a proxy-config.ini value (repeatable)

  Values are coerced: true/false become booleans, numbers become numbers,
  null becomes null, everything else stays a string. The override is applied
  on top of the file, so the file is still the source of truth for everything
  else.

  Examples:
    ${bin} --set server.port=8080
    ${bin} --set server.debug=true --set server.timeout=60000

FILES
  proxy-config.ini   Proxy configuration (port, auth, timeout)
`.trimStart();
