'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const tailwindCli = require.resolve('tailwindcss/lib/cli.js');

const args = ['-i', './src/input.css', '-o', './static/output.css', '--minify'];

const result = spawnSync(process.execPath, [tailwindCli, ...args], {
  cwd: path.resolve(__dirname, '..'),
  env: {
    ...process.env,
    // Tailwind 3 bundles Browserslist/caniuse data, so update-browserslist-db
    // cannot refresh it through package-lock.json. Remove this with Tailwind 4.
    BROWSERSLIST_IGNORE_OLD_DATA: 'true',
  },
  shell: false,
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
