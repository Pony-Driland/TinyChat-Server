/**
 * Babel plugin that inlines `.ini` imports as strings.
 *
 * The production bundle is built with esbuild using `loader: { '.ini': 'text' }`,
 * so `import template from './config.ini'` becomes a plain string. Babel has no
 * such loader, which breaks `yarn start` (babel-node) with a syntax error while
 * parsing the INI file as JavaScript.
 *
 * This plugin mirrors the esbuild behavior for the development workflow:
 *
 * ```js
 * import template from './config.ini';
 * // becomes
 * const template = "[server]\nport=35421\n...";
 * ```
 *
 * @module babel-plugin-ini-text
 */

const fs = require('fs');
const path = require('path');

/**
 * @param {import('@babel/core')} api Babel API.
 * @returns {{ name: string, visitor: import('@babel/core').Visitor }} Babel plugin object.
 */
module.exports = function iniTextPlugin(api) {
  const { types: t } = api;

  return {
    name: 'ini-text',
    visitor: {
      ImportDeclaration(importPath, state) {
        const { node } = importPath;

        if (typeof node.source.value !== 'string' || !node.source.value.endsWith('.ini')) return;

        if (node.specifiers.length !== 1 || !t.isImportDefaultSpecifier(node.specifiers[0])) {
          throw importPath.buildCodeFrameError(
            'An .ini import must have exactly one default specifier.',
          );
        }

        if (typeof state.filename !== 'string' || state.filename.length === 0) {
          throw importPath.buildCodeFrameError('Cannot resolve an .ini import without a filename.');
        }

        const iniPath = path.resolve(path.dirname(state.filename), node.source.value);
        const content = fs.readFileSync(iniPath, 'utf8');

        importPath.replaceWith(
          t.variableDeclaration('const', [
            t.variableDeclarator(node.specifiers[0].local, t.stringLiteral(content)),
          ]),
        );
      },
    },
  };
};
