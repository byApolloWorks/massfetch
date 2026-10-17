/**
 * Python helper for massfetch.
 *
 * Finds a suitable Python (3.9 or newer), creates a private virtual
 * environment the first time it is needed and installs the packages listed in
 * python/requirements.txt into it. Nothing is installed into the system Python.
 *
 * @author Jollibe Dablo (byApolloWorks)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const MIN_MAJOR = 3;
const MIN_MINOR = 9;
const PYTHON_DIR = path.resolve(__dirname, '..', 'python');
const REQUIREMENTS = path.join(PYTHON_DIR, 'requirements.txt');
const IS_WINDOWS = process.platform === 'win32';

/**
 * Folder where massfetch keeps its private files (the virtual environment).
 * @returns {string}
 */
function dataDir() {
  if (IS_WINDOWS) {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'massfetch');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'massfetch');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'massfetch');
}

/** @returns {string} Path of the virtual environment folder. */
function venvDir() {
  return path.join(dataDir(), 'venv');
}

/** @returns {string} Path of the Python program inside the virtual environment. */
function venvPython() {
  return IS_WINDOWS
    ? path.join(venvDir(), 'Scripts', 'python.exe')
    : path.join(venvDir(), 'bin', 'python');
}

/**
 * Run a command and return its result without throwing.
 * @param {string} command
 * @param {string[]} args
 */
function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8' });
}

/**
 * Find a Python 3.9+ on this computer.
 * Set MASSFETCH_PYTHON (or BDOWNLOAD_PYTHON) to force a specific Python program.
 * @returns {{command: string, args: string[], version: string} | null}
 */
function findPython() {
  const candidates = [];
  const forced = process.env.MASSFETCH_PYTHON || process.env.BDOWNLOAD_PYTHON;
  if (forced) {
    candidates.push({ command: forced, args: [] });
  }
  if (IS_WINDOWS) {
    candidates.push({ command: 'py', args: ['-3'] }, { command: 'python', args: [] }, { command: 'python3', args: [] });
  } else {
    candidates.push({ command: 'python3', args: [] }, { command: 'python', args: [] });
  }

  const probe = 'import sys;print("%d.%d" % sys.version_info[:2])';
  for (const candidate of candidates) {
    const result = run(candidate.command, [...candidate.args, '-c', probe]);
    if (result.status !== 0 || !result.stdout) continue;
    const [major, minor] = result.stdout.trim().split('.').map(Number);
    if (major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR)) {
      return { ...candidate, version: result.stdout.trim() };
    }
  }
  return null;
}

/**
 * Hash of the requirements file. When it changes, packages are installed again.
 * @returns {string}
 */
function requirementsHash() {
  return crypto.createHash('sha256').update(fs.readFileSync(REQUIREMENTS)).digest('hex').slice(0, 16);
}

/** @returns {string} Path of the marker file that records a finished install. */
function markerPath() {
  return path.join(dataDir(), 'venv.installed');
}

/**
 * Run a command with its output shown in the terminal.
 * @returns {boolean} true when the command succeeded.
 */
function runVisible(command, args) {
  return spawnSync(command, args, { stdio: 'inherit' }).status === 0;
}

/**
 * Make sure the virtual environment exists and has every package installed.
 * Does nothing (and is fast) when everything is already in place.
 *
 * @param {{command: string, args: string[]}} python  Python found by findPython().
 * @param {{upgrade?: boolean}} [options]  upgrade: update yt-dlp to its latest version.
 * @returns {string} Path of the virtual environment's Python.
 */
function ensureEnvironment(python, options = {}) {
  fs.mkdirSync(dataDir(), { recursive: true });

  if (!fs.existsSync(venvPython())) {
    console.log('First run: creating a private Python environment (one time only)...');
    if (!runVisible(python.command, [...python.args, '-m', 'venv', venvDir()])) {
      console.error('\nCould not create the Python environment.');
      if (process.platform === 'linux') {
        console.error('On Ubuntu or Debian, install the venv package first:  sudo apt install python3-venv');
      }
      process.exit(1);
    }
    fs.rmSync(markerPath(), { force: true });
  }

  const wanted = requirementsHash();
  const installed = fs.existsSync(markerPath()) ? fs.readFileSync(markerPath(), 'utf8').trim() : '';

  if (installed !== wanted) {
    console.log('Installing download tools (flask, yt-dlp, requests). This can take a minute...');
    const ok = runVisible(venvPython(), ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', REQUIREMENTS]);
    if (!ok) {
      console.error('\nCould not install the Python packages. Check your internet connection and try again.');
      process.exit(1);
    }
    fs.writeFileSync(markerPath(), wanted);
  }

  if (options.upgrade) {
    console.log('Updating yt-dlp to the latest version...');
    runVisible(venvPython(), ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'yt-dlp']);
  }

  return venvPython();
}

/** Delete the virtual environment so it is rebuilt on the next run. */
function resetEnvironment() {
  fs.rmSync(venvDir(), { recursive: true, force: true });
  fs.rmSync(markerPath(), { force: true });
}

module.exports = {
  PYTHON_DIR,
  dataDir,
  venvDir,
  venvPython,
  findPython,
  ensureEnvironment,
  resetEnvironment
};
