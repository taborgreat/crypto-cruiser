import os from 'node:os';
import { ENV } from './config.js';
import { createServer } from './http.js';
import { Session } from './session.js';
import { log } from './log.js';

async function main(): Promise<void> {
  const session = new Session();
  await session.start();
  const server = createServer(session);
  server.listen(ENV.port, ENV.host, () => {
    log.info('server', `TRAFFIC listening on http://${ENV.host}:${ENV.port}  (ws: /ws, api: /api/*)`);
    log.info('server', `RPC ${ENV.rpcUrl}  |  Jupiter ${ENV.jupApi}  |  tick history ${ENV.tickHistoryDays} d in ${ENV.dataDir}`);
    if (ENV.host === '0.0.0.0' || ENV.host === '::') {
      const addrs = Object.values(os.networkInterfaces()).flat().filter((a) => !!a && a.family === 'IPv4' && !a.internal).map((a) => a!.address);
      log.warn('server', `LAN mode: open ${addrs.map((a) => `http://${a}:${ENV.port}`).join(' or ') || 'this machine\'s LAN address'} from another device (with npm run dev:lan use port 5173). Anyone on this network can drive the connected wallet: use it only on a network you trust.`);
    }
  });
  const stop = () => {
    session.shutdown();
    server.close();
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  log.error('server', err);
  process.exit(1);
});
