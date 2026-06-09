'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const tailwindCli = require.resolve('tailwindcss/lib/cli.js');
const outputStaticRoot = process.env.AMUTORRENT_STATIC_OUTPUT_ROOT
  ? path.resolve(process.env.AMUTORRENT_STATIC_OUTPUT_ROOT)
  : path.resolve(__dirname, '..', 'static');

const args = ['-i', './src/input.css', '-o', path.join(outputStaticRoot, 'output.css'), '--minify'];
fs.mkdirSync(outputStaticRoot, { recursive: true });

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
