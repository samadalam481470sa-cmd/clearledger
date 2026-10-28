import { type Server } from 'node:http';

/** Readiness owns only its listeners, not the server or the caller's resources. */
export function listenLoopback(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    function cleanup() {
      server.off('listening', onListening);
      server.off('error', onError);
    }
    function onListening() { cleanup(); resolve(); }
    function onError(error: Error) { cleanup(); reject(error); }
    server.once('listening', onListening);
    server.once('error', onError);
    try { server.listen(port, '127.0.0.1'); }
    catch (error) { cleanup(); reject(error); }
  });
}
