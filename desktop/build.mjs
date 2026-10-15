#!/usr/bin/env node
// Local development build from the exact client manifest; no publishing/signing keys.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build, Platform, Arch } from 'electron-builder';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.dirname(here);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'CLIENT-MANIFEST.json')));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
for (const f of manifest.files) {
  if (f.sha256 !== sha(fs.readFileSync(path.join(root, f.path)))) throw Error(`Source file changed: ${f.path}`);
}
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('The current desktop target is an Apple-silicon Mac');
// Electron 44 downloads its binary lazily. Building after a clean npm ci must
// work before anyone has launched the application or run the Electron CLI.
const electronDir = path.join(here, 'node_modules/electron');
const installEnv = { ...process.env };
delete installEnv.ELECTRON_OVERRIDE_DIST_PATH;
execFileSync(process.execPath, [path.join(electronDir, 'install.js')], { env: installEnv, stdio: 'inherit' });
const electronVersion = JSON.parse(fs.readFileSync(path.join(electronDir, 'package.json'))).version;
if (fs.readFileSync(path.join(electronDir, 'dist/version'), 'utf8').trim().replace(/^v/, '') !== electronVersion) throw Error('Installed Electron binary differs from the locked package');
await build({ publish: 'never', targets: Platform.MAC.createTarget(['dir'], Arch.arm64), config: {
  appId: 'cc.onemaple.offercrew', productName: 'OfferCrew',
  electronDist: path.join(electronDir, 'dist'),
  directories: { output: 'dist' },
  files: ['main.mjs', 'preload.cjs', 'lib/**', 'assets/trayTemplate.png', 'assets/trayTemplate@2x.png', 'package.json'],
  extraMetadata: { version: manifest.version, offercrew: { updates: false } },
  mac: { category: 'public.app-category.productivity', icon: path.join(here, 'assets/OfferCrew.icns'), identity: null },
  afterPack: async ctx => {
    const app = path.join(ctx.appOutDir, 'OfferCrew.app'), engine = path.join(app, 'Contents/Resources/engine');
    for (const f of manifest.files.filter(x => !x.path.startsWith('desktop/'))) {
      const dest = path.join(engine, f.path); fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(root, f.path), dest);
    }
    fs.cpSync(path.join(root, 'node_modules'), path.join(engine, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    for (const name of ['LICENSE', 'LICENSES.chromium.html']) fs.copyFileSync(path.join(here, 'node_modules/electron/dist', name), path.join(app, 'Contents/Resources', name === 'LICENSE' ? 'LICENSE.electron.txt' : name));
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  },
} });
