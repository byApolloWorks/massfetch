#!/usr/bin/env node
/**
 * massfetch command.
 *
 * Starts the massfetch web interface on your computer. The first run creates a
 * private Python environment automatically, so there is nothing to set up.
 *
 *   massfetch                       start and open the browser
 *   massfetch --port 8080           use another port
 *   massfetch --no-open             do not open the browser
 *   massfetch --install-launcher    create a desktop shortcut and app menu entry
 *   massfetch --uninstall-launcher  remove them
 *   massfetch --update              update yt-dlp (fixes most "download failed" errors)
 *   massfetch --doctor              check that everything is set up correctly
 *   massfetch --reset               delete the private Python environment
 *
 * @author Jollibe Dablo (byApolloWorks)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const pkg = require('../package.json');
const py = require('../lib/python');
const launcher = require('../lib/launcher');

const HELP = `massfetch ${pkg.version}
Bulk video and image downloader with a local web interface.

Usage:
  massfetch [options]

Options:
  --port <number>          Port to use (default 5757)
  --no-open                Do not open the browser automatically
  --install-launcher       Create a desktop shortcut and app menu entry
  --uninstall-launcher     Remove the shortcut and app menu entry
  --update                 Update yt-dlp to the latest version, then start
  --doctor                 Check Python, packages and ffmpeg
  --reset                  Delete the private Python environment (rebuilt on next run)
  -v, --version            Show the version
  -h, --help               Show this help

Made by Jollibe Dablo (byApolloWorks).`;

/** Print a message and stop with an error code. */
function fail(message) {
  console.error(message);
  process.exit(1);
}

/** Find Python or explain how to install it. */
function requirePython() {
  const python = py.findPython();
  if (!python) {
    fail(
      'massfetch needs Python 3.9 or newer, but none was found.\n' +
        'Install it from https://www.python.org/downloads/ and run massfetch again.\n' +
        'Already installed somewhere else? Set MASSFETCH_PYTHON (or BDOWNLOAD_PYTHON) to its full path.'
    );
  }
  return python;
}

/** Print a setup report. */
function doctor() {
  const ok = (label, value) => console.log(`  [ok]   ${label}: ${value}`);
  const bad = (label, value) => console.log(`  [fail] ${label}: ${value}`);

  console.log(`massfetch ${pkg.version} setup check\n`);
  ok('Node', process.version);

  const python = py.findPython();
  python ? ok('Python', `${python.version} (${python.command})`) : bad('Python', 'not found (need 3.9 or newer)');

  fs.existsSync(py.venvPython())
    ? ok('Private environment', py.venvDir())
    : bad('Private environment', 'not created yet (it is created on the first run)');

  const ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  ffmpeg.status === 0
    ? ok('ffmpeg', ffmpeg.stdout.split('\n')[0])
    : bad('ffmpeg', 'not found (optional, needed for full quality video)');
}

/** Start the Python web server and keep running until it exits. */
function startServer(python, args, upgrade) {
  const venvPython = py.ensureEnvironment(python, { upgrade });
  const child = spawn(venvPython, [path.join(py.PYTHON_DIR, 'server.py'), ...args], {
    stdio: 'inherit',
    cwd: py.PYTHON_DIR
  });
  const stop = () => child.kill('SIGTERM');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => process.exit(code === null ? 0 : code));
}

function main() {
  const argv = process.argv.slice(2);
  const has = (flag) => argv.includes(flag);

  if (has('-h') || has('--help')) return console.log(HELP);
  if (has('-v') || has('--version')) return console.log(pkg.version);
  if (has('--doctor')) return doctor();

  if (has('--reset')) {
    py.resetEnvironment();
    return console.log('Private Python environment deleted. It will be rebuilt the next time you run massfetch.');
  }

  if (has('--install-launcher')) {
    try {
      const created = launcher.installLauncher();
      console.log('Launcher created:');
      created.forEach((item) => console.log('  ' + item));
      console.log('\nYou can now start MassFetch from your desktop or app menu.');
    } catch (error) {
      fail('Could not create the launcher: ' + error.message);
    }
    return;
  }

  if (has('--uninstall-launcher')) {
    try {
      launcher.uninstallLauncher();
      console.log('Launcher removed.');
    } catch (error) {
      fail('Could not remove the launcher: ' + error.message);
    }
    return;
  }

  // Everything else is passed on to the Python server (--port, --no-open).
  const passthrough = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') {
      if (!/^\d+$/.test(argv[i + 1] || '')) fail('--port needs a number, for example: massfetch --port 8080');
      passthrough.push('--port', argv[++i]);
    } else if (argv[i] === '--no-open') {
      passthrough.push('--no-open');
    } else if (argv[i] !== '--update') {
      fail(`Unknown option: ${argv[i]}\n\n${HELP}`);
    }
  }

  startServer(requirePython(), passthrough, has('--update'));
}

main();
