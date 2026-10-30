const { execFileSync, execSync } = require('child_process');
const path = require('path');
const { compile } = require('nexe');
const fs = require('fs-extra');

const config = {
  outputDir: 'dist',
  outputDirName: 'Tiny-RP-Chat',
  nodeModulesDir: 'node_modules',
  babelSourceDir: 'src/server',
  babelSourceDir2: 'src/proxy',
  babelSourceDir3: 'src/api',
};

/**
 * @typedef {Object} PythonInterpreter
 * @property {string} command Absolute path of the interpreter executable.
 * @property {string} version Raw output of `<command> --version`.
 */

/**
 * Checks whether a path points to an executable file.
 *
 * @param {string} filePath Absolute path to check.
 * @returns {boolean} True when the path exists and is executable.
 */
const isExecutable = (filePath) => {
  try {
    return fs.statSync(filePath).isFile() && (fs.accessSync(filePath, fs.constants.X_OK), true);
  } catch {
    return false;
  }
};

/**
 * Searches an executable name inside the current PATH.
 *
 * @param {string} executable Executable name, e.g. `python3`.
 * @returns {string|null} Absolute path of the executable, or null when not found.
 * @throws {TypeError} If `executable` is not a non-empty string.
 */
const findInPath = (executable) => {
  if (typeof executable !== 'string' || executable.length === 0) {
    throw new TypeError('executable must be a non-empty string.');
  }

  const directories = (process.env.PATH || '').split(path.delimiter).filter(Boolean);

  for (const directory of directories) {
    const candidate = path.join(directory, executable);
    if (isExecutable(candidate)) return candidate;
  }

  return null;
};

/**
 * Runs `<command> --version` and returns the raw output.
 *
 * @param {string} command Absolute path of a Python interpreter.
 * @returns {string} Raw version string, e.g. `Python 3.12.4`.
 * @throws {TypeError} If `command` is not a non-empty string.
 * @throws {Error} If the interpreter cannot be executed.
 */
const readPythonVersion = (command) => {
  if (typeof command !== 'string' || command.length === 0) {
    throw new TypeError('command must be a non-empty string.');
  }

  try {
    return execFileSync(command, ['--version'], { encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(`Failed to run "${command} --version": ${error.message}`);
  }
};

/**
 * Resolves the Python 3 interpreter used by nexe to run `configure.py`.
 *
 * Resolution order:
 * 1. `PYTHON` environment variable.
 * 2. `npm_config_python` (set by `npm config set python <path>`).
 * 3. The first candidate found in `PATH`.
 *
 * @param {string[]} [candidates] Executable names probed in order.
 * @returns {PythonInterpreter} Resolved interpreter and its version string.
 * @throws {TypeError} If `candidates` is not a non-empty array of non-empty strings.
 * @throws {Error} If no interpreter is found.
 * @throws {RangeError} If the resolved interpreter is not Python 3.
 */
const resolvePython = (candidates = ['python3', 'python']) => {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new TypeError('candidates must be a non-empty array of strings.');
  }

  const explicit = process.env.PYTHON || process.env.npm_config_python;
  const found = [];

  if (explicit) {
    if (!isExecutable(explicit)) {
      throw new Error(`"${explicit}" is not an executable file.`);
    }
    found.push(explicit);
  } else {
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || candidate.length === 0) {
        throw new TypeError('Every candidate must be a non-empty string.');
      }

      const resolved = findInPath(candidate);
      if (resolved) found.push(resolved);
    }
  }

  if (found.length === 0) {
    throw new Error(`No Python interpreter found. Looked for: ${candidates.join(', ')}.`);
  }

  const [command] = found;
  const version = readPythonVersion(command);

  if (!version.startsWith('Python 3.')) {
    throw new RangeError(`Nexe requires Python 3, but "${command}" reported "${version}".`);
  }

  return { command, version };
};

const clearDistFolder = () => {
  const distPath = path.resolve(config.outputDir);
  console.log('🧹 Clearing dist folder before build...');
  fs.emptyDirSync(distPath);
};

// ----------------------
// Babel Transpile
// ----------------------
const transpileWithBabel = () => {
  console.log('🔨 Transpiling code with Babel...');
  execSync(
    `npx babel ${config.babelSourceDir} --out-dir ${config.outputDir}/${config.babelSourceDir} --copy-files`,
  );
  execSync(
    `npx babel ${config.babelSourceDir2} --out-dir ${config.outputDir}/${config.babelSourceDir2} --copy-files`,
  );
  execSync(
    `npx babel ${config.babelSourceDir3} --out-dir ${config.outputDir}/${config.babelSourceDir3} --copy-files`,
  );
};

// ----------------------
// Copy sqlite3 only
// ----------------------
const copySqlite3Modules = () => {
  const sourceDir = path.resolve('node_modules/sqlite3');
  const destDir = path.resolve(`dist/${config.outputDirName}/node_modules/sqlite3`);

  if (!fs.existsSync(sourceDir)) {
    console.log('⚠️ sqlite3 not found in node_modules.');
    return;
  }

  console.log('📂 Copying node_modules/sqlite3 to the final destination...');
  fs.ensureDirSync(destDir);
  fs.copySync(sourceDir, destDir);
};

// ----------------------
// Nexe package
// ----------------------
const packageWithNexe = async () => {
  console.log(`📦 Packaging with nexe...`);

  const python = resolvePython();
  process.env.PYTHON = python.command;
  console.log(`🐍 Python: ${python.command} (${python.version})`);

  const rootFolder = path.join(__dirname, '../../');

  const cfgBase = {
    name: 'Tiny Roleplay Server Chat',
    python: python.command,
    rc: {
      CompanyName: 'JasminDreasond',
      ProductName: 'Tiny Roleplay Server Chat',
      FileDescription: 'Lightweight server for roleplay/RPG chat rooms.',
      OriginalFilename: 'tiny-chat.exe',
      InternalName: 'tiny-chat',
      LegalCopyright: 'GNU AFFERO GENERAL PUBLIC LICENSE Version 3, 19 November 2007',
    },
    build: true,
  };

  await compile({
    resources: [path.join(rootFolder, './dist/src/server/config.ini')],
    input: path.join(rootFolder, './dist/src/server/index.js'),
    output: path.join(rootFolder, `./dist/${config.outputDirName}/tiny-chat`),
    ...cfgBase,
  });

  await compile({
    resources: [path.join(rootFolder, './dist/src/proxy/config.ini')],
    input: path.join(rootFolder, './dist/src/proxy/index.js'),
    output: path.join(rootFolder, `./dist/${config.outputDirName}/tiny-chat-proxy`),
    ...cfgBase,
  });
};

// ----------------------
// Build main
// ----------------------
const buildApp = async () => {
  console.log('🎯 Build Information:');
  console.log(`   - Dist Directory: ${config.outputDirName}`);
  console.log(`   - Output Directory: ${config.outputDir}`);
  console.log(`   - Server Directory: ${config.babelSourceDir}`);
  console.log(`   - Proxy Directory: ${config.babelSourceDir2}`);
  console.log(`   - API Directory: ${config.babelSourceDir3}`);

  clearDistFolder();
  transpileWithBabel();
  await packageWithNexe();

  // Copy sqlite3 after building
  copySqlite3Modules();

  console.log('🚀 Build completed successfully!');
};

buildApp();
