import fs from 'fs';
import path from 'path';
import ini from 'ini';

import isDebug from './isDebug';

/**
 * Resolves a file that ships next to the executable.
 *
 * A packaged binary (nexe/pkg) bakes the build machine path into `__dirname`,
 * so `__dirname` must never be used to read user-facing files. In production
 * the file is resolved from the folder that contains the executable.
 *
 * @param {string} devPath Absolute path used while running from source.
 * @param {string} fileName File name expected next to the executable.
 * @returns {string} Absolute path to the file.
 * @throws {TypeError} If `devPath` or `fileName` is not a non-empty string.
 */
export function resolveShippedFile(devPath, fileName) {
  if (typeof devPath !== 'string' || devPath.length === 0) {
    throw new TypeError('devPath must be a non-empty string.');
  }

  if (typeof fileName !== 'string' || fileName.length === 0) {
    throw new TypeError('fileName must be a non-empty string.');
  }

  if (isDebug()) return devPath;

  return path.join(path.dirname(process.execPath), fileName);
}

/**
 * @param {boolean|string} value
 * @returns {boolean}
 */
export const getIniBoolean = (value) =>
  (typeof value === 'boolean' && value) ||
  (typeof value === 'string' && (value === 'yes' || value === 'on' || value === 'true'))
    ? true
    : false;

/**
 * Function to ensure the .ini file exists. If it doesn't, it copies a template file.
 * @param {string} iniFilePath
 * @param {string} templateFilePath
 *
 * @returns {Promise<{ newCfg: { [key: string]: any; }; defaultCfg: { [key: string]: any; }; }>}
 */
export async function ensureIniFile(iniFilePath, templateFilePath) {
  // Check if the INI file exists
  if (!fs.existsSync(iniFilePath)) {
    console.log(`[APP] [INI] File ${iniFilePath} does not exist. Copying template...`);

    // Read the template file
    const templateContent = fs.readFileSync(templateFilePath, 'utf-8');

    // Write the template content to the INI file
    fs.writeFileSync(iniFilePath, templateContent);

    console.log(`[APP] [INI] Template copied to ${iniFilePath}`);
  } else {
    console.log(`[APP] [INI] File ${iniFilePath} already exists.`);
  }

  // Load the INI file using the ini module
  const config = ini.parse(fs.readFileSync(iniFilePath, 'utf-8'));
  const defaultCfg = ini.parse(fs.readFileSync(templateFilePath, 'utf-8'));
  console.log('[APP] [INI] INI file loaded!');

  return { newCfg: config, defaultCfg };
}

/**
 * Function to create folder to store files.
 *
 * @param {string} FOLDER_NAME
 * @param {string} defaultFolder
 * @returns {string}
 */
export function createAppDirectory(FOLDER_NAME, defaultFolder) {
  console.log('[APP] [INFO] Starting data directory creation...');

  const appDirectory = !isDebug()
    ? path.join(path.dirname(process.execPath), FOLDER_NAME) // For production, next to the .exe
    : path.join(defaultFolder, `../${FOLDER_NAME}`); // For development, inside the project folder

  console.log(`[APP] [INFO] Checking if directory ${appDirectory} exists...`);

  if (!fs.existsSync(appDirectory)) {
    console.log(`[APP] [WARNING] Directory ${appDirectory} not found. Creating...`);
    fs.mkdirSync(appDirectory, { recursive: true });
    console.log(`[APP] [SUCCESS] Directory ${appDirectory} successfully created.`);
  } else {
    console.log(`[APP] [INFO] Directory ${appDirectory} already exists.`);
  }

  return appDirectory;
}
