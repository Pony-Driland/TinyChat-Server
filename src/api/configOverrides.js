/**
 * CLI overrides for the INI configuration files.
 *
 * The syntax is `--set section.key=value`, repeatable. Values are coerced to
 * boolean, number or null when possible, and kept as strings otherwise.
 *
 * @module configOverrides
 */

/**
 * @typedef {string | number | boolean | null} OverrideValue
 * @typedef {Record<string, Record<string, OverrideValue>>} OverrideMap
 */

const FLAG = '--set';
const FLAG_EQ = `${FLAG}=`;

/**
 * Error thrown when one or more overrides are invalid.
 */
export class ConfigOverrideError extends Error {
  /**
   * @param {string[]} errors One message per invalid override.
   */
  constructor(errors) {
    super(`Invalid configuration override(s):\n  - ${errors.join('\n  - ')}`);
    this.name = 'ConfigOverrideError';
    this.errors = errors;
  }
}

/**
 * Coerces a raw CLI string into a typed value.
 *
 * @param {string} raw Raw value from the command line.
 * @returns {OverrideValue} The coerced value.
 */
const coerce = (raw) => {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
};

/**
 * Infers the expected type of a config value.
 *
 * The INI parser returns every value as a string, so the type has to be
 * inferred from the content. `null` and empty strings are treated as "any"
 * because they are used as "unset" sentinels in the templates.
 *
 * @param {unknown} value Raw value from the INI file.
 * @returns {'boolean' | 'number' | 'string' | 'any'} The inferred type.
 */
export const inferType = (value) => {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (value === null || value === undefined) return 'any';
  if (typeof value !== 'string') return 'any';

  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'true' || trimmed === 'false') return 'boolean';
  if (trimmed === 'null' || trimmed === '') return 'any';
  if (!Number.isNaN(Number(trimmed))) return 'number';
  return 'string';
};

/**
 * Computes the Levenshtein distance between two strings.
 *
 * @param {string} a First string.
 * @param {string} b Second string.
 * @returns {number} The distance.
 */
const distance = (a, b) => {
  const matrix = Array.from({ length: a.length + 1 }, (_, i) => [i]);

  for (let j = 1; j <= b.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }

  return matrix[a.length][b.length];
};

/**
 * Returns the closest candidate, when it is close enough to be useful.
 *
 * @param {string} input The value typed by the user.
 * @param {string[]} candidates The available values.
 * @returns {string | null} The suggestion, or null when nothing is close enough.
 */
const suggest = (input, candidates) => {
  let best = null;
  let bestDistance = Infinity;

  for (const candidate of candidates) {
    const current = distance(input, candidate);
    if (current < bestDistance) {
      bestDistance = current;
      best = candidate;
    }
  }

  return bestDistance <= 3 ? best : null;
};

/**
 * Extracts every `--set section.key=value` pair from argv.
 *
 * @param {string[]} argv Arguments without the node/script prefix.
 * @returns {OverrideMap} Overrides grouped by section.
 * @throws {TypeError} If `argv` is not an array.
 * @throws {Error} If a `--set` value is malformed.
 */
export const parseOverrides = (argv) => {
  if (!Array.isArray(argv)) {
    throw new TypeError('argv must be an array of strings.');
  }

  /** @type {OverrideMap} */
  const overrides = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let raw;

    if (arg === FLAG) {
      raw = argv[++i];
    } else if (arg.startsWith(FLAG_EQ)) {
      raw = arg.slice(FLAG_EQ.length);
    } else {
      continue;
    }

    if (typeof raw !== 'string' || raw.length === 0) {
      throw new Error(`${FLAG} requires a value in the format section.key=value.`);
    }

    const eq = raw.indexOf('=');
    if (eq < 1) {
      throw new Error(`Invalid ${FLAG} value: "${raw}". Expected section.key=value.`);
    }

    const path = raw.slice(0, eq);
    const value = raw.slice(eq + 1);
    const dot = path.indexOf('.');

    if (dot < 1 || dot === path.length - 1) {
      throw new Error(`Invalid ${FLAG} key: "${path}". Expected section.key.`);
    }

    const section = path.slice(0, dot);
    const key = path.slice(dot + 1);

    if (!overrides[section]) overrides[section] = {};
    overrides[section][key] = coerce(value);
  }

  return overrides;
};

/**
 * Validates a single override against the expected type.
 *
 * @param {string} path Full key path (`section.key`).
 * @param {unknown} value Override value.
 * @param {unknown} reference Value from the template (or file) used as schema.
 * @returns {string | null} Error message, or null when the value is valid.
 */
const validate = (path, value, reference) => {
  const expected = inferType(reference);

  if (expected === 'any') return null;

  if (expected === 'boolean' && typeof value !== 'boolean') {
    return `Invalid value for "${path}": expected a boolean (true/false), got ${JSON.stringify(value)}.`;
  }

  if (expected === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    return `Invalid value for "${path}": expected a number, got ${JSON.stringify(value)}.`;
  }

  if (expected === 'string' && typeof value !== 'string') {
    return `Invalid value for "${path}": expected a string, got ${JSON.stringify(value)}.`;
  }

  return null;
};

/**
 * Applies overrides on top of a parsed INI object.
 *
 * When a section is missing from `target`, it is seeded from `defaults` so
 * the override does not wipe out the default values of that section.
 *
 * @param {Record<string, any>} target Parsed user config (mutated in place).
 * @param {OverrideMap} overrides Overrides returned by {@link parseOverrides}.
 * @param {Record<string, any>} [defaults={}] Parsed template config.
 * @returns {string[]} Applied keys, in `section.key` format.
 * @throws {TypeError} If `target` or `overrides` has an unexpected type.
 * @throws {ConfigOverrideError} If one or more overrides are invalid.
 */
export const applyOverrides = (target, overrides, defaults = {}) => {
  if (!target || typeof target !== 'object') {
    throw new TypeError('target must be an object.');
  }

  if (!overrides || typeof overrides !== 'object') {
    throw new TypeError('overrides must be an object.');
  }

  const applied = [];
  const errors = [];

  for (const [section, entries] of Object.entries(overrides)) {
    const template = defaults[section];
    const current = target[section];

    for (const [key, value] of Object.entries(entries)) {
      const path = `${section}.${key}`;
      const inTemplate = template && typeof template === 'object' && key in template;
      const inFile = current && typeof current === 'object' && key in current;

      if (!inTemplate && !inFile) {
        const candidates = [
          ...Object.keys(template && typeof template === 'object' ? template : {}),
          ...Object.keys(current && typeof current === 'object' ? current : {}),
        ].map((item) => `${section}.${item}`);
        const suggestion = suggest(path, [...new Set(candidates)]);

        errors.push(`Unknown key "${path}".${suggestion ? ` Did you mean "${suggestion}"?` : ''}`);
        continue;
      }

      const reference = inTemplate ? template[key] : current[key];
      const error = validate(path, value, reference);

      if (error) {
        errors.push(error);
        continue;
      }

      if (!target[section] || typeof target[section] !== 'object') {
        target[section] = { ...(defaults[section] || {}) };
      }

      target[section][key] = value;
      applied.push(path);
    }
  }

  if (errors.length > 0) throw new ConfigOverrideError(errors);

  return applied;
};
