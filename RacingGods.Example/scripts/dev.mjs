import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = new Set();
let stopping = false;
let startupTimer;

function terminate(child, force = false) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // Angular can own an esbuild subprocess; terminate only this owned process tree.
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.on('error', () => child.kill('SIGKILL'));
    killer.on('exit', (code) => { if (code) child.kill('SIGKILL'); });
  } else {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  }
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(startupTimer);
  process.exitCode = code;
  for (const child of children) {
    if (child.connected) child.send({ type: 'shutdown' }, () => {});
    else terminate(child);
  }
  const force = setTimeout(() => {
    for (const child of children) terminate(child, true);
  }, 3000);
  force.unref();
  if (process.connected) process.disconnect();
}

function launch(args, ipc = false) {
  const child = spawn(process.execPath, args, {
    cwd: root, env: { ...process.env }, stdio: ipc ? ['ignore', 'inherit', 'inherit', 'ipc'] : ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  children.add(child);
  child.on('error', () => {
    console.error('A development server failed to start. Check installed dependencies and local ports.');
    children.delete(child);
    stop(1);
  });
  child.on('exit', (code) => {
    children.delete(child);
    if (!stopping) {
      console.error('A development server stopped; shutting down the other server.');
      stop(code || 1);
    }
  });
  return child;
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
process.on('message', (message) => {
  if (message?.type === 'shutdown') stop();
});
process.on('disconnect', () => stop());
const gateway = launch([path.join(root, 'server', 'index.mjs')], true);
startupTimer = setTimeout(() => {
  console.error('The local API gateway did not become ready.');
  stop(1);
}, 10_000);
gateway.once('message', (message) => {
  if (message?.type !== 'ready' || stopping) return;
  clearTimeout(startupTimer);
  launch([
    path.join(root, 'node_modules', '@angular', 'cli', 'bin', 'ng.js'),
    'serve', '--host', '127.0.0.1', '--port', '4200', '--proxy-config', 'proxy.conf.json',
  ]);
});
