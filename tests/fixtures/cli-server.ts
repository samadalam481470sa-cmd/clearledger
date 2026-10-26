import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface CliOptions {
  db: string; rpc: string; key: string; router: string; apiKey?: string;
  onSpawn?: (handle: CliHandle) => void;
}
export interface CliHandle {
  child: ChildProcess;
  url: string;
  apiKey: string;
  output(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(): Promise<void>;
}

/** Launch the real RPC entry point; no fixture worker, IPC, or manual ticks. */
export async function startCli(options: CliOptions): Promise<CliHandle> {
  if (!isAbsolute(options.db)) throw new Error('CLI test database path must be absolute');
  const apiKey = options.apiKey ?? randomBytes(24).toString('hex');
  if (apiKey.length < 32) throw new Error('CLI test API key must have at least 32 characters');
  const runtimeTemp = join(dirname(options.db), 'runtime-tmp');
  mkdirSync(runtimeTemp, { recursive: true });
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
    env: { ...process.env, RPC_URL: options.rpc, CHAIN_ID: '31337', RELAYER_PRIVATE_KEY: options.key,
      ROUTER_ADDRESS: options.router, API_KEY: apiKey, DB_PATH: options.db, PORT: '0',
      CONFIRMATIONS: '1', RPC_TIMEOUT_MS: '5000', ASSET_METADATA: '[]', TSX_DISABLE_CACHE: '1',
      TEMP: runtimeTemp, TMP: runtimeTemp, TMPDIR: runtimeTemp },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let url = '', closed = false, exitedProcess = false, spawnFailed = false;
  let stopping: Promise<void> | undefined;
  const messages: string[] = [];
  const remember = (line: string) => { messages.push(line); if (messages.length > 20) messages.shift(); };
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
    child.once('close', (code, signal) => { closed = true; resolveExit({ code, signal }); });
  });
  child.once('exit', () => { exitedProcess = true; });
  child.once('error', () => { spawnFailed = true; remember('CLI process error'); });
  for (const stream of [child.stdout!, child.stderr!]) {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop()!;
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        const match = /^ClearLedger RPC mode: (http:\/\/127\.0\.0\.1:([0-9]{1,5}))$/.exec(line);
        if (match && Number(match[2]) > 0 && Number(match[2]) <= 65535) {
          url = match[1]; remember(line);
        } else if (line === 'Worker waiting for RPC recovery' ||
          line === 'ClearLedger shutdown could not finish safely; inspect durable state on restart') remember(line);
        else if (line) remember('CLI diagnostic omitted');
      }
      // Never retain or expose arbitrary startup errors, keys, or transaction data.
      if (pending.length > 4096) { pending = ''; remember('CLI diagnostic omitted'); }
    });
  }
  function kill() {
    if (!stopping) stopping = (async () => {
      if (closed) return;
      if (!exitedProcess && child.pid) {
        try { child.kill('SIGKILL'); }
        catch { if (!exitedProcess) throw new Error('CLI test child could not be terminated'); }
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([exited, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('CLI test child termination timed out')), 5000);
        })]);
      } finally { clearTimeout(timer); }
    })();
    return stopping;
  }
  const handle: CliHandle = { child, get url() { return url; }, apiKey,
    output: () => messages.join('\n'), exited, kill };
  const deadline = performance.now() + 20000;
  try {
    // Register even an unready child so caller cleanup cannot overlook it when
    // startup and the first bounded termination attempt both fail.
    options.onSpawn?.(handle);
    while (performance.now() < deadline) {
      if (closed || exitedProcess || spawnFailed) throw new Error('RPC CLI exited before becoming ready');
      if (url) {
        try {
          const response = await fetch(url + '/healthz', { signal: AbortSignal.timeout(1000) });
          const health = await response.json() as { status?: string; mode?: string };
          if (response.ok && health.status === 'ok' && health.mode === 'rpc' && !exitedProcess)
            return handle;
        } catch { /* Readiness is retried within the fixed startup deadline. */ }
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
    }
    throw new Error('RPC CLI readiness timed out');
  } catch {
    await kill();
    throw new Error('RPC CLI could not become ready');
  }
}
