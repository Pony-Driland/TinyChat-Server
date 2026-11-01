const { spawnSync } = require('child_process');
const path = require('path');
const { parseArgs } = require('node:util');
const { compile } = require('nexe');
const esbuild = require('esbuild');
const fs = require('fs-extra');

const config = {
  outputDir: 'dist',
  outputDirName: 'Tiny-RP-Chat',
  nodeModulesDir: 'node_modules',
  stagingDir: '.nexe-build', // Transient folder, never shipped.
};

/**
 * Modules that must stay outside the bundle.
 *
 * @type {readonly string[]}
 */
const EXTERNAL_MODULES = Object.freeze([
  'sqlite3',
]);

/**
 * @typedef {string | readonly [string, readonly string[]]} NativeModuleEntry
 */

/**
 * Native modules that must be shipped next to the binary.
 *
 * Each entry is either:
 * - A string: the package and its whole runtime dependency tree are copied.
 * - A tuple `[name, whitelist]`: only the packages listed in `whitelist`
 *   (plus the root) are copied. Use this when the package declares
 *   install-time-only dependencies that should not ship.
 *
 * @type {readonly NativeModuleEntry[]}
 */
const NATIVE_MODULES = Object.freeze([
  ['sqlite3', ['bindings', 'file-uri-to-path']],
]);

const projectRoot = path.resolve(__dirname, '../../');
const buildOutputDir = `${config.outputDir}/${config.outputDirName}`;
const buildOutputPath = path.join(projectRoot, buildOutputDir);
const stagingPath = path.join(projectRoot, config.stagingDir);

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
// esbuild Bundle
// ----------------------

/**
 * Bundles one entry point into a single CommonJS file.
 *
 * @param {string} entryPoint Absolute path of the entry file.
 * @param {string} outfile Absolute path of the output file.
 * @returns {Promise<void>} Resolves when the bundle is written.
 * @throws {TypeError} If `entryPoint` or `outfile` is not a non-empty string.
 */
const bundleEntry = async (entryPoint, outfile) => {
  if (typeof entryPoint !== 'string' || entryPoint.length === 0) {
    throw new TypeError('entryPoint must be a non-empty string.');
  }

  if (typeof outfile !== 'string' || outfile.length === 0) {
    throw new TypeError('outfile must be a non-empty string.');
  }

  await esbuild.build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    minify: false,
    keepNames: true,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'info',
    external: [...EXTERNAL_MODULES],
  });
};

/**
 * Bundles the server and the proxy with esbuild.
 *
 * @returns {Promise<void>} Resolves when both bundles are written.
 */
const bundleWithEsbuild = async () => {
  console.log('🔨 Bundling code with esbuild...');

  await bundleEntry(
    path.join(projectRoot, 'src', 'server', 'index.js'),
    path.join(stagingPath, 'server.cjs'),
  );

  await bundleEntry(
    path.join(projectRoot, 'src', 'proxy', 'index.js'),
    path.join(stagingPath, 'proxy.cjs'),
  );
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
// Native modules
// ----------------------

/**
 * Resolves the folder of an installed package.
 *
 * @param {string} packageName Package name. Scoped names are supported.
 * @param {string} fromDir Directory used as the resolution base.
 * @returns {string|null} Absolute path of the package folder, or null when not found.
 * @throws {TypeError} If `packageName` or `fromDir` is not a non-empty string.
 */
const resolvePackageDir = (packageName, fromDir) => {
  if (typeof packageName !== 'string' || packageName.length === 0) {
    throw new TypeError('packageName must be a non-empty string.');
  }

  if (typeof fromDir !== 'string' || fromDir.length === 0) {
    throw new TypeError('fromDir must be a non-empty string.');
  }

  try {
    return path.dirname(require.resolve(`${packageName}/package.json`, { paths: [fromDir] }));
  } catch {
    /* Some packages hide package.json behind the "exports" field. */
  }

  let current;

  try {
    current = path.dirname(require.resolve(packageName, { paths: [fromDir] }));
  } catch {
    return null;
  }

  while (true) {
    const manifestPath = path.join(current, 'package.json');

    if (fs.existsSync(manifestPath)) {
      try {
        if (JSON.parse(fs.readFileSync(manifestPath, 'utf8')).name === packageName) return current;
      } catch {
        /* Ignore malformed manifest and keep walking up. */
      }
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

/**
 * Normalizes a `NATIVE_MODULES` entry.
 *
 * @param {NativeModuleEntry} entry Raw entry.
 * @returns {{ name: string, whitelist: ReadonlySet<string> | null }} Normalized entry.
 * @throws {TypeError} If the entry is malformed.
 */
const normalizeNativeEntry = (entry) => {
  if (typeof entry === 'string') {
    if (entry.length === 0) {
      throw new TypeError('NATIVE_MODULES entry must not be an empty string.');
    }

    return { name: entry, whitelist: null };
  }

  if (!Array.isArray(entry) || entry.length !== 2) {
    throw new TypeError('NATIVE_MODULES entry must be a string or a [name, whitelist] tuple.');
  }

  const [name, whitelist] = entry;

  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('NATIVE_MODULES entry name must be a non-empty string.');
  }

  if (!Array.isArray(whitelist) || whitelist.some((item) => typeof item !== 'string')) {
    throw new TypeError(`NATIVE_MODULES whitelist of "${name}" must be an array of strings.`);
  }

  return { name, whitelist: new Set(whitelist) };
};

/**
 * Walks the runtime dependency tree of a package.
 *
 * Only `dependencies` are followed: `devDependencies` never ship and
 * `optionalDependencies` are not required to boot the binary.
 *
 * When `whitelist` is provided, only the packages it contains are resolved
 * and walked. The root package is always included.
 *
 * @param {string} rootName Name of the root package.
 * @param {string} fromDir Directory used as the resolution base.
 * @param {ReadonlySet<string> | null} [whitelist=null] Allowed package names, or null for everything.
 * @returns {Map<string, string>} Map of package name to absolute folder.
 * @throws {TypeError} If an argument has an unexpected type.
 */
const collectDependencyTree = (rootName, fromDir, whitelist = null) => {
  if (typeof rootName !== 'string' || rootName.length === 0) {
    throw new TypeError('rootName must be a non-empty string.');
  }

  if (typeof fromDir !== 'string' || fromDir.length === 0) {
    throw new TypeError('fromDir must be a non-empty string.');
  }

  if (whitelist !== null && !(whitelist instanceof Set)) {
    throw new TypeError('whitelist must be a Set or null.');
  }

  /** @type {Map<string, string>} */
  const collected = new Map();
  const queue = [{ name: rootName, base: fromDir, isRoot: true }];

  while (queue.length > 0) {
    const { name, base, isRoot } = queue.shift();
    if (collected.has(name)) continue;
    if (!isRoot && whitelist !== null && !whitelist.has(name)) continue;

    const packageDir = resolvePackageDir(name, base);

    if (!packageDir) {
      console.warn(`   ⚠️  Dependency not found, skipping: ${name}`);
      collected.set(name, '');
      continue;
    }

    collected.set(name, packageDir);

    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));

    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (!collected.has(dependency)) {
        queue.push({ name: dependency, base: packageDir, isRoot: false });
      }
    }
  }

  return collected;
};

/**
 * Copies the native modules and their runtime dependencies next to the binary.
 *
 * Native bindings (`.node`) cannot be bundled, so the whole dependency tree is
 * shipped as a plain `node_modules` folder and resolved at runtime.
 *
 * @returns {void}
 */
const copyNativeModules = () => {
  const targetNodeModules = path.join(buildOutputPath, 'node_modules');

  for (const entry of NATIVE_MODULES) {
    const { name, whitelist } = normalizeNativeEntry(entry);
    const sourceDir = path.join(projectRoot, 'node_modules', name);

    if (!fs.existsSync(sourceDir)) {
      console.log(`⚠️ ${name} not found in node_modules.`);
      continue;
    }

    console.log(
      `📂 Copying ${name}${whitelist ? ` (whitelist: ${whitelist.size} package(s))` : ' and its dependencies'}...`,
    );

    const tree = collectDependencyTree(name, projectRoot, whitelist);
    let copied = 0;

    for (const [pkgName, packageDir] of tree) {
      if (!packageDir) continue;

      const destination = path.join(targetNodeModules, pkgName);
      fs.ensureDirSync(path.dirname(destination));
      fs.copySync(packageDir, destination, { dereference: true });
      copied++;
    }

    console.log(`   ✅ ${copied} package(s) copied.`);
  }
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
    input: path.join(stagingPath, 'server.cjs'),
    output: path.join(buildOutputPath, 'tiny-chat'),
  });

  await compile({
    ...cfgBase,
    input: path.join(stagingPath, 'proxy.cjs'),
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
  console.log(`   - Python: ${python.command}`);

  clearDistFolder();
  await bundleWithEsbuild();
  copyConfigTemplates();
  await packageWithNexe(python);
  copyNativeModules();
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
