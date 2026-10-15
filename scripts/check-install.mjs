#!/usr/bin/env node
// Actual isolated client acceptance. No production data, model or external action.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'offercrew-client-check-'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'CLIENT-MANIFEST.json')));
const checks = [], key = crypto.randomBytes(32).toString('hex');
const env = { ...process.env, RADAR_ROOT: data, RADAR_SANDBOX: '1', RADAR_LOCAL_AUTH: 'on', RADAR_LOCAL_KEY: key };
delete env.NODE_TEST_CONTEXT;
let child;
const mark = (name, details = {}) => checks.push({ name, passed: true, ...details });
const run = (script, args = []) => {
  const r = spawnSync(process.execPath, [path.join(root, script), ...args], { cwd: root, env, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) throw Error(`${script} failed (${r.status}): ${r.stderr.slice(-300)}`);
  return r.stdout;
};
try {
  const { DatabaseSync } = await import('node:sqlite');
  assert.equal(typeof DatabaseSync, 'function');
  for (const name of Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).dependencies)) await import(name);
  mark('clean-runtime-dependencies', { node: process.version });
  const linked = JSON.parse(run('bin/data-root.mjs', [data])); assert.equal(linked.ok, true);
  mark('fresh-data-root', { seeded: linked.seeded.length, version: linked.version });
  const model = JSON.parse(fs.readFileSync(path.join(data, 'config/model.json')));
  assert.deepEqual(model.text.backends, []); mark('no-model-selected-without-consent');
  run('bin/demo-seed.mjs'); mark('synthetic-data-created');
  const demoImage = fs.readFileSync(path.join(root, 'docs/demo/final-review-form.png'));
  for (const [n, name] of [[22, 'final'], [12, 'last'], [2, 'submitted'], [4, 'submitted'], [7, 'submitted'], [15, 'submitted']]) assert.deepEqual(fs.readFileSync(path.join(data, `runs/demo/auto-apply/${n}/${name}.png`)), demoImage);
  mark('all-six-demo-evidence-images-present');
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  child = spawn(process.execPath, [path.join(root, 'bin/serve.mjs'), '--sandbox', '--no-workers', '--port', String(port)], { cwd: data, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; child.stderr.on('data', b => { err = (err + b).slice(-2000); }); child.stdout.resume();
  const base = `http://127.0.0.1:${port}`, headers = { cookie: `offercrew_key=${key}` };
  let ready = false;
  for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw Error(`Server exited: ${err.slice(-300)}`); try { if ((await fetch(base + '/api/setup', { headers })).status === 200) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 200)); }
  assert.equal(ready, true); mark('standalone-engine-started');
  assert.equal((await fetch(base + '/api/setup')).status, 401); mark('local-auth-enforced');
  for (const route of ['/', '/api/setup', '/api/onboarding', '/api/snapshot', '/api/resume', '/api/model/source', '/phone/app.js', '/phone/talk-text.js']) {
    const r = await fetch(base + route, { headers }); assert.equal(r.status, 200, route); assert.ok((await r.arrayBuffer()).byteLength > 0); mark('read:' + route);
  }
  process.env.RADAR_ROOT = data; process.env.RADAR_SANDBOX = '1';
  const { all } = await import('../lib/leads.mjs'); assert.ok(all().length > 0); mark('sqlite-lead-data-readable');
  const metrics = JSON.parse(run('bin/metrics.mjs', ['--weekly']));
  assert.ok(metrics.total > 0); assert.ok(fs.existsSync(path.join(data, 'state/metrics.json'))); mark('operation-command-metrics');
  const { exportDocx, exportPdf, readBack, coverage } = await import('../lib/resume-export.mjs');
  const content = { lang: 'en', header: [{ id: 'name', text: 'Alex Chen' }], sections: [{ id: 'experience', kind: 'experience', title: { id: 'title', text: 'Experience' }, entries: [{ id: 'job', head: [{ id: 'company', text: 'Example Corp' }], lines: [{ id: 'work', text: 'Built a sample application.', bullet: true }] }] }] };
  for (const ext of process.env.OFFERCREW_CHECK_PDF === '1' ? ['docx', 'pdf'] : ['docx']) {
    const out = path.join(data, `resume.${ext}`);
    await (ext === 'docx' ? exportDocx : exportPdf)(content, out);
    const read = await readBack(out), text = typeof read === 'string' ? read : read.text;
    assert.ok(text.includes('Alex Chen') && text.includes('Example Corp')); mark(`existing-material-${ext}-export-without-model`, { bytes: fs.statSync(out).size, coverage: coverage(content, text) });
  }
  console.log(JSON.stringify({ schema: 1, ok: true, contentSha256: manifest.contentSha256, packageLockSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'package-lock.json'))).digest('hex'), checks, externalMessagesSent: false, modelCallsMade: false }));
} catch (e) {
  console.log(JSON.stringify({ schema: 1, ok: false, contentSha256: manifest.contentSha256, checks, error: String(e.message).slice(0, 500) })); process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise(r => child.once('exit', r)), new Promise(r => setTimeout(r, 5000))]); if (child.exitCode === null) child.kill('SIGKILL'); }
  fs.rmSync(data, { recursive: true, force: true });
}
