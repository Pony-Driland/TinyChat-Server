const { execSync, spawnSync } = require('child_process');
const path = require('path');
const { parseArgs } = require('node:util');
const { compile } = require('nexe');
const fs = require('fs-extra');

const config = {
  outputDir: 'dist',
  outputDirName: 'Tiny-RP-Chat',
  nodeModulesDir: 'node_modules',
  babelSourceDir: 'src/server',
  babelSourceDir2: 'src/proxy',
  babelSourceDir3: 'src/api',
  sourceFolderName: 'src',
  stagingDir: '.nexe-build', // Transient folder, never shipped.
};

const projectRoot = path.resolve(__dirname, '../../');
const buildOutputDir = `${config.outputDir}/${config.outputDirName}`;
const buildOutputPath = path.join(projectRoot, buildOutputDir);
const stagingPath = path.join(projectRoot, config.stagingDir);
const stagingSrcPath = path.join(stagingPath, config.sourceFolderName);

const PYTHON_CANDIDATES =
  process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];

const USAGE = [
  'Usage: yarn build [options]',
  '',
  'Options:',
  '  -p, --python <path>  Python 3 interpreter used by nexe (default: auto-detect)',
  '  -h, --help           Show this help',
  '',
  'Environment:',
  '  PYTHON               Same as --python, used when the flag is omitted',
].join('\n');

/**
 * @typedef {Object} CliOptions
 * @property {string|undefined} python Value passed with --python.
 * @property {boolean} help True when --help was requested.
 */

/**
 * @typedef {Object} PythonInterpreter
 * @property {string} command Absolute path of the interpreter.
 * @property {string} version Raw version output, e.g. `Python 3.12.4`.
 */

/**
 * Parses the build script arguments.
 *
 * @param {string[]} argv Arguments without the node/script prefix.
 * @returns {CliOptions} Parsed options.
 * @throws {TypeError} If `argv` is not an array or contains an unknown option.
 */
const parseCli = (argv) => {
  if (!Array.isArray(argv)) {
    throw new TypeError('argv must be an array of strings.');
  }

  let values;

  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        python: { type: 'string', short: 'p' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (error) {
    throw new TypeError(`${error.message}\n\n${USAGE}`);
  }

  if (values.python !== undefined && values.python.trim().length === 0) {
    throw new TypeError(`--python requires a path.\n\n${USAGE}`);
  }

  return { python: values.python, help: values.help };
};

/**
 * Checks whether a path points to an executable file.
 *
 * @param {string} filePath Absolute path to check.
 * @returns {boolean} True when the path is a file and is executable.
 */
const isExecutableFile = (filePath) => {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Searches an executable inside the current PATH.
 *
 * @param {string} executable Executable name, e.g. `python3`.
 * @returns {string|null} Absolute path of the executable, or null when not found.
 */
const findInPath = (executable) => {
  const platformExtensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : [''];

  const extensions = path.extname(executable) ? [''] : platformExtensions;
  const directories = (process.env.PATH || '').split(path.delimiter).filter(Boolean);

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${executable}${extension}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }

  return null;
};

/**
 * Validates a Python interpreter and reads its version.
 *
 * @param {string} command Absolute path of the interpreter.
 * @returns {PythonInterpreter} The interpreter and its raw version string.
 * @throws {Error} If the interpreter cannot be executed.
 * @throws {RangeError} If the interpreter is not Python 3 or newer.
 */
const validatePython = (command) => {
  const { status, stdout, stderr } = spawnSync(command, ['--version'], { encoding: 'utf8' });

  if (status !== 0) {
    throw new Error(`"${command} --version" exited with code ${status}.`);
  }

  const version = `${stdout || ''}${stderr || ''}`.trim();
  const match = /^Python (\d+)\.\d+\.\d+/.exec(version);

  if (!match) {
    throw new Error(`Unable to read the version of "${command}". Output: "${version}".`);
  }

  if (Number(match[1]) < 3) {
    throw new RangeError(`nexe requires Python 3, but "${command}" is ${version}.`);
  }

  return { command, version };
};

/**
 * Resolves which Python interpreter nexe must use.
 *
 * @param {string|undefined} explicitPath Value received from --python.
 * @returns {PythonInterpreter} The resolved interpreter.
 * @throws {TypeError} If `explicitPath` is not a string or undefined.
 * @throws {Error} If the interpreter cannot be found or is not executable.
 */
const resolvePython = (explicitPath) => {
  if (explicitPath !== undefined && typeof explicitPath !== 'string') {
    throw new TypeError('explicitPath must be a string or undefined.');
  }

  const requested = explicitPath ?? process.env.PYTHON ?? process.env.npm_config_python;

  if (requested) {
    const looksLikePath = requested.includes('/') || requested.includes(path.sep);
    const fromPath = looksLikePath ? null : findInPath(requested);
    const command = fromPath ?? path.resolve(requested);

    if (!isExecutableFile(command)) {
      throw new Error(`Python interpreter not found or not executable: "${requested}".`);
    }

    return validatePython(command);
  }

  for (const candidate of PYTHON_CANDIDATES) {
    const command = findInPath(candidate);
    if (command) return validatePython(command);
  }

  throw new Error(
    `No Python interpreter found. Tried: ${PYTHON_CANDIDATES.join(', ')}. ` +
      'Pass one explicitly with --python <path>.',
  );
};

const clearDistFolder = () => {
  console.log('🧹 Clearing dist folder before build...');
  fs.emptyDirSync(buildOutputPath);
  fs.emptyDirSync(stagingPath);
};

const cleanupStaging = () => {
  if (fs.existsSync(stagingPath)) {
    fs.removeSync(stagingPath);
  }
};

// ----------------------
// Babel Transpile
// ----------------------
const transpileWithBabel = () => {
  console.log('🔨 Transpiling code with Babel...');

  const env = { ...process.env };
  Object.keys(env).forEach((key) => {
    if (key.startsWith('npm_config_version_') || key === 'npm_config_argv') {
      delete env[key];
    }
  });

  const options = { stdio: 'inherit', env, cwd: projectRoot };
  const babel = path.join(projectRoot, 'node_modules', '.bin', 'babel');

  const sourceDirs = [config.babelSourceDir, config.babelSourceDir2, config.babelSourceDir3];

  for (const sourceDir of sourceDirs) {
    const outDir = path.join(stagingPath, sourceDir);
    execSync(`"${babel}" "${sourceDir}" --out-dir "${outDir}" --copy-files`, options);
  }
};

/**
 * Copies the editable .ini templates next to the binary.
 *
 * Templates are intentionally kept outside the bundle: the end user must be
 * able to edit them without rebuilding the executable.
 *
 * @returns {void}
 * @throws {Error} If a declared template does not exist in the repository.
 */
const copyConfigTemplates = () => {
  console.log('📄 Copying .ini templates next to the binary...');

  /** @type {Array<{ source: string, target: string }>} */
  const templates = [
    {
      source: path.join(projectRoot, 'src', 'server', 'config.ini'),
      target: path.join(buildOutputPath, 'config.ini'),
    },
  ];

  for (const { source, target } of templates) {
    if (!fs.existsSync(source)) {
      throw new Error(`Missing config template: ${source}`);
    }

    fs.copySync(source, target);
  }
};

// ----------------------
// Copy sqlite3 only
// ----------------------
const copySqlite3Modules = () => {
  const sourceDir = path.join(projectRoot, 'node_modules', 'sqlite3');
  const destDir = path.join(buildOutputPath, 'node_modules', 'sqlite3');

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

/**
 * Packages both binaries with nexe.
 *
 * @param {PythonInterpreter} python Interpreter resolved by {@link resolvePython}.
 * @returns {Promise<void>} Resolves when both binaries are written.
 * @throws {TypeError} If `python` is not a valid {@link PythonInterpreter}.
 */
const packageWithNexe = async (python) => {
  if (typeof python !== 'object' || python === null) {
    throw new TypeError('python must be a PythonInterpreter object.');
  }

  if (typeof python.command !== 'string' || python.command.length === 0) {
    throw new TypeError('python.command must be a non-empty string.');
  }

  if (typeof python.version !== 'string' || python.version.length === 0) {
    throw new TypeError('python.version must be a non-empty string.');
  }

  console.log(`📦 Packaging with nexe...`);
  console.log(`🐍 Python: ${python.command} (${python.version})`);

  process.env.PYTHON = python.command;

  const cfgBase = {
    name: 'Tiny Roleplay Server Chat',
    python: python.command,
    resourceRoot: projectRoot,
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
    ...cfgBase,
    input: path.join(stagingSrcPath, 'server', 'index.js'),
    output: path.join(buildOutputPath, 'tiny-chat'),
  });

  await compile({
    ...cfgBase,
    input: path.join(stagingSrcPath, 'proxy', 'index.js'),
    output: path.join(buildOutputPath, 'tiny-chat-proxy'),
  });
};

// ----------------------
// Build main
// ----------------------
const buildApp = async () => {
  const options = parseCli(process.argv.slice(2));

  if (options.help) {
    console.log(USAGE);
    return;
  }

  const python = resolvePython(options.python);

  console.log('🎯 Build Information:');
  console.log(`   - Dist Directory: ${config.outputDirName}`);
  console.log(`   - Output Directory: ${config.outputDir}`);
  console.log(`   - Server Directory: ${config.babelSourceDir}`);
  console.log(`   - Proxy Directory: ${config.babelSourceDir2}`);
  console.log(`   - API Directory: ${config.babelSourceDir3}`);
  console.log(`   - Python: ${python.command}`);

  clearDistFolder();
  transpileWithBabel();
  copyConfigTemplates();
  await packageWithNexe(python);
  copySqlite3Modules();
  cleanupStaging();

  console.log('🚀 Build completed successfully!');
};

buildApp().catch((error) => {
  console.error(`\n❌ ${error.message}`);
  try {
    cleanupStaging();
  } catch {
    /* ignore cleanup errors */
  }
  process.exitCode = 1;
});
