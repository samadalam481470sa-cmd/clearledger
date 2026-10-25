import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function message(child: ChildProcess, type: string, command?: Record<string, unknown>) {
  return new Promise<any>((resolveMessage, reject) => {
    const timer = setTimeout(() => finish(new Error('Signal fixture reply timed out')), 5000);
    function finish(error?: Error, value?: unknown) {
      clearTimeout(timer);
      child.off('message', received);
      child.off('error', failed);
      child.off('exit', exited);
      if (error) reject(error); else resolveMessage(value);
    }
    function received(value: any) { if (value.type === type) finish(undefined, value); }
    function failed() { finish(new Error('Signal fixture could not start')); }
    function exited() { finish(new Error('Signal fixture exited before replying')); }
    child.on('message', received);
    child.once('error', failed);
    child.once('exit', exited);
    if (!child.connected || child.exitCode !== null || child.signalCode !== null) {
      finish(new Error('Signal fixture is not connected')); return;
    }
    if (command) {
      try { child.send(command, error => { if (error) finish(new Error('Signal fixture command failed')); }); }
      catch { finish(new Error('Signal fixture command failed')); }
    }
  });
}

async function exit(child: ChildProcess, force = false) {
  if (!child.pid) return child.exitCode;
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return await new Promise<number | null>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      if (child.connected) child.disconnect();
      finish(new Error('Signal fixture failed to exit'));
    }, 5000);
    function finish(error?: Error, code: number | null = null) {
      clearTimeout(timer); child.off('exit', exited); child.off('error', failed);
      if (error) reject(error); else resolveExit(code);
    }
    function exited(code: number | null) { finish(undefined, code); }
    function failed() { finish(new Error('Signal fixture termination failed')); }
    child.once('exit', exited);
    child.once('error', failed);
    if (force) { try { child.kill('SIGKILL'); } catch { failed(); } }
  });
}

test('a real POSIX SIGTERM waits for the current worker tick before closing SQLite and exiting', {
  timeout: 15000,
  skip: process.platform === 'win32' ? 'Windows child.kill(SIGTERM) terminates the process; real catchable POSIX signal semantics are required.' : false
}, async () => {
  const dataRoot = resolve('data');
  mkdirSync(dataRoot, { recursive: true });
  const directory = mkdtempSync(join(dataRoot, 'lifecycle-signal-test-'));
  const dbPath = join(directory, 'signal.sqlite');
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/lifecycle-worker.ts'], {
      cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true
    });
    await message(child, 'ready', { type: 'start', db: dbPath });
    const stopping = message(child, 'stop-started');
    assert.ok(child.kill('SIGTERM'), 'Expected signal delivery to the tracked child');
    await stopping;
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    const pending = await message(child, 'state', { type: 'status' });
    assert.equal(pending.pending, true);
    assert.equal(pending.resourcesClosed, false);
    const during = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(during.prepare('SELECT COUNT(*) AS count FROM signal_audit').get()!.count, 0);
      assert.equal(during.prepare('SELECT closes FROM signal_resources').get()!.closes, 0);
    } finally { during.close(); }

    const completion = Promise.all([message(child, 'resources-closed'), message(child, 'shutdown-result', { type: 'release' })]);
    const [, result] = await completion;
    assert.equal(result.result, 'closed');
    assert.equal(await exit(child), 0);
    assert.equal(child.signalCode, null);
    const reopened = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.deepEqual(reopened.prepare('SELECT action FROM signal_audit').all().map(row => row.action), ['tick-complete']);
      assert.equal(reopened.prepare('SELECT closes FROM signal_resources').get()!.closes, 1);
    } finally { reopened.close(); }
  } finally {
    if (child) await exit(child, true);
    assert.equal(dirname(resolve(directory)), dataRoot);
    assert.ok(directory.startsWith(join(dataRoot, 'lifecycle-signal-test-')));
    rmSync(directory, { recursive: true, force: true });
  }
});
