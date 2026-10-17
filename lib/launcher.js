/**
 * Launcher creator for bdownload.
 *
 * Creates a desktop shortcut and an app menu entry that start bdownload with
 * one click:
 *   - Windows: shortcuts on the Desktop and in the Start Menu.
 *   - macOS:   "Bulk Downloader.app" in ~/Applications plus a Desktop shortcut.
 *   - Linux:   a .desktop file in the applications menu plus one on the Desktop.
 *
 * The shortcuts point at the Node and bdownload files that are installed right
 * now. If you move Node or reinstall bdownload somewhere else, run
 * `bdownload --install-launcher` again.
 *
 * @author Jollibe Dablo
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const APP_NAME = 'Bulk Downloader';
const COMMENT = 'Bulk video and image downloader';
const NODE = process.execPath;
const SCRIPT = path.resolve(__dirname, '..', 'bin', 'bdownload.js');
const ICON = path.resolve(__dirname, '..', 'python', 'static', 'icon.svg');

/** Quote a string for a POSIX shell using single quotes. */
function shQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/** Quote a string for the Exec= line of a Linux .desktop file. */
function desktopQuote(value) {
  return '"' + String(value).replace(/(["`$\\])/g, '\\$1') + '"';
}

/** Quote a string for a PowerShell single-quoted literal. */
function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

// ---------------------------------------------------------------- Windows

function windowsShortcutPaths() {
  const script =
    "[Environment]::GetFolderPath('Desktop'); [Environment]::GetFolderPath('Programs')";
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('PowerShell is required to create Windows shortcuts.');
  const [desktop, programs] = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return [path.join(desktop, `${APP_NAME}.lnk`), path.join(programs, `${APP_NAME}.lnk`)];
}

function installWindows() {
  const targets = windowsShortcutPaths();
  const lines = ['$ws = New-Object -ComObject WScript.Shell'];
  for (const target of targets) {
    lines.push(
      `$s = $ws.CreateShortcut(${psQuote(target)})`,
      `$s.TargetPath = ${psQuote(NODE)}`,
      `$s.Arguments = ${psQuote('"' + SCRIPT + '"')}`,
      `$s.WorkingDirectory = ${psQuote(os.homedir())}`,
      `$s.Description = ${psQuote(COMMENT)}`,
      '$s.Save()'
    );
  }
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', lines.join('; ')], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'Could not create the shortcuts.');
  return targets;
}

function uninstallWindows() {
  const targets = windowsShortcutPaths();
  targets.forEach((target) => fs.rmSync(target, { force: true }));
  return targets;
}

// ------------------------------------------------------------------ macOS

function macPaths() {
  const appDir = path.join(os.homedir(), 'Applications', `${APP_NAME}.app`);
  const desktopLink = path.join(os.homedir(), 'Desktop', `${APP_NAME}.app`);
  return { appDir, desktopLink };
}

function installMac() {
  const { appDir, desktopLink } = macPaths();
  const macos = path.join(appDir, 'Contents', 'MacOS');
  const resources = path.join(appDir, 'Contents', 'Resources');
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });

  const runCommand = path.join(resources, 'run.command');
  fs.writeFileSync(runCommand, `#!/bin/bash\nexec ${shQuote(NODE)} ${shQuote(SCRIPT)}\n`, { mode: 0o755 });

  const executable = path.join(macos, 'BulkDownloader');
  fs.writeFileSync(
    executable,
    '#!/bin/bash\nopen -a Terminal "$(dirname "$0")/../Resources/run.command"\n',
    { mode: 0o755 }
  );

  fs.writeFileSync(
    path.join(appDir, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>com.jollibedablo.bdownload</string>
  <key>CFBundleExecutable</key><string>BulkDownloader</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1.0</string>
</dict>
</plist>
`
  );

  const created = [appDir];
  if (fs.existsSync(path.dirname(desktopLink))) {
    fs.rmSync(desktopLink, { force: true, recursive: true });
    fs.symlinkSync(appDir, desktopLink);
    created.push(desktopLink);
  }
  return created;
}

function uninstallMac() {
  const { appDir, desktopLink } = macPaths();
  fs.rmSync(desktopLink, { force: true, recursive: true });
  fs.rmSync(appDir, { force: true, recursive: true });
  return [appDir, desktopLink];
}

// ------------------------------------------------------------------ Linux

function linuxDesktopDir() {
  const result = spawnSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8' });
  const fromXdg = result.status === 0 ? result.stdout.trim() : '';
  const folder = fromXdg || path.join(os.homedir(), 'Desktop');
  return fs.existsSync(folder) ? folder : null;
}

function linuxPaths() {
  const menuFile = path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    'applications',
    'bdownload.desktop'
  );
  const desktop = linuxDesktopDir();
  return { menuFile, desktopFile: desktop ? path.join(desktop, 'bdownload.desktop') : null };
}

function installLinux() {
  const { menuFile, desktopFile } = linuxPaths();
  const content = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${APP_NAME}`,
    `Comment=${COMMENT}`,
    `Exec=${desktopQuote(NODE)} ${desktopQuote(SCRIPT)}`,
    `Icon=${ICON}`,
    'Terminal=true',
    'Categories=Network;Utility;',
    ''
  ].join('\n');

  const created = [];
  for (const file of [menuFile, desktopFile]) {
    if (!file) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode: 0o755 });
    spawnSync('gio', ['set', file, 'metadata::trusted', 'true']); // lets GNOME run it; safe to ignore if missing
    created.push(file);
  }
  spawnSync('update-desktop-database', [path.dirname(menuFile)]); // refreshes the menu; safe to ignore if missing
  return created;
}

function uninstallLinux() {
  const { menuFile, desktopFile } = linuxPaths();
  const removed = [menuFile];
  fs.rmSync(menuFile, { force: true });
  if (desktopFile) {
    fs.rmSync(desktopFile, { force: true });
    removed.push(desktopFile);
  }
  return removed;
}

// ----------------------------------------------------------------- public

/**
 * Create the desktop shortcut and app menu entry for this operating system.
 * @returns {string[]} Paths that were created.
 */
function installLauncher() {
  if (process.platform === 'win32') return installWindows();
  if (process.platform === 'darwin') return installMac();
  return installLinux();
}

/**
 * Remove the shortcuts created by installLauncher().
 * @returns {string[]} Paths that were removed.
 */
function uninstallLauncher() {
  if (process.platform === 'win32') return uninstallWindows();
  if (process.platform === 'darwin') return uninstallMac();
  return uninstallLinux();
}

module.exports = { installLauncher, uninstallLauncher };
