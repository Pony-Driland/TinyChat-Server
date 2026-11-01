/**
 * Unified entry point for the Tiny Chat binaries.
 *
 * The mode is selected with `--app <mode>` and defaults to `server`. The flag
 * is stripped from `process.argv` before the target module is loaded, so the
 * target sees the same argv it would see when executed standalone.
 *
 * @module launcher
 */

import { VERSION, getLauncherHelp } from './api/help';

const MODES = Object.freeze(['server', 'proxy', 'archive']);
const DEFAULT_MODE = 'server';
const FLAGS = Object.freeze(['--app', '-a']);

/**
 * Extracts `--app <mode>` (or `--app=<mode>`) from argv.
 *
 * @param {string[]} argv Arguments without the node/script prefix.
 * @returns {{ mode: string | null, argv: string[] }} The selected mode (null when omitted) and the cleaned argv.
 * @throws {TypeError} If `argv` is not an array.
 * @throws {Error} If `--app` is used without a value.
 */
const extractMode = (argv) => {
  if (!Array.isArray(argv)) {
    throw new TypeError('argv must be an array of strings.');
  }

  const cleaned = [];
  let mode = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (FLAGS.includes(arg)) {
      const value = argv[i + 1];

      if (typeof value === 'undefined') {
        throw new Error(`${arg} requires a value. Use one of: ${MODES.join(', ')}.`);
      }

      mode = value;
      i++;
      continue;
    }

    if (arg.startsWith('--app=')) {
      mode = arg.slice('--app='.length);
      continue;
    }

    cleaned.push(arg);
  }

  return { mode, argv: cleaned };
};

const { mode: rawMode, argv } = extractMode(process.argv.slice(2));

// No --app: the launcher owns --help and --version.
if (rawMode === null) {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(getLauncherHelp());
    process.exit(0);
  }

  if (argv.includes('-v') || argv.includes('--version')) {
    console.log(VERSION);
    process.exit(0);
  }
}

const mode = rawMode ?? DEFAULT_MODE;

if (!MODES.includes(mode)) {
  console.error(`Unknown mode: "${mode}". Use one of: ${MODES.join(', ')}.`);
  process.exit(1);
}

// The target must not see the launcher flag.
process.argv = [process.argv[0], process.argv[1], ...argv];

/**
 * Loads the module that matches the selected mode.
 *
 * The dynamic import is intentional: it keeps the three entry points from
 * running their top-level side effects until the correct one is selected.
 *
 * @returns {Promise<unknown>} Resolves when the target module is loaded.
 */
const load = () => {
  if (mode === 'server') return import('./server/index.js');
  if (mode === 'proxy') return import('./proxy/index.js');
  return import('../build/tiny-chat-archive-cli.js');
};

load().catch((error) => {
  console.error(error);
  process.exit(1);
});