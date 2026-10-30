import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

export const ROOT = join(here, '..', '..');
export const CLI = join(ROOT, 'build', 'chat-archive-cli.js');

/**
 * Runs the archive CLI and resolves with its output.
 *
 * @param {string[]} args
 * @param {{ input?: string, env?: Record<string, string> }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string, output: string }>}
 */
export function runCli(args, options = {}) {
  const { input, env = {} } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: '1', ...env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, output: `${stdout}${stderr}` }));

    if (typeof input === 'string') child.stdin.end(input);
    else child.stdin.end();
  });
}
