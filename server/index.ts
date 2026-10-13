import os from 'node:os';
import { ENV } from './config.js';
import { DEFAULT_SETTINGS } from '../shared/types.js';
import { createServer, SessionManager } from './http.js';
import { Auth } from './auth.js';
import { MarketHub } from './market.js';
import { log } from './log.js';

async function main(): Promise<void> {
  const hub = new MarketHub();
  // Update 27: the default market is always on so the tick history keeps recording with nobody connected
  // (ghost ages, candles and the rewind drive all read it). Other markets start when someone opens them.
  const always = hub.acquire('SOL-PERP', DEFAULT_SETTINGS.feed, DEFAULT_SETTINGS.atrWindow);
  await always.ready;
  const auth = new Auth();
  const sessions = new SessionManager(hub);
  const server = createServer(sessions, auth);
  server.listen(ENV.port, ENV.host, () => {
    log.info('server', `TRAFFIC listening on http://${ENV.host}:${ENV.port}  (ws: /ws, api: /api/*)  ${auth.open ? 'NO LOGIN' : 'login required'}`);
    log.info('server', `RPC ${ENV.rpcUrl}  |  Jupiter ${ENV.jupApi}  |  tick history ${ENV.tickHistoryDays} d in ${ENV.dataDir}`);
    if (ENV.host === '0.0.0.0' || ENV.host === '::') {
      const addrs = Object.values(os.networkInterfaces()).flat().filter((a) => !!a && a.family === 'IPv4' && !a.internal).map((a) => a!.address);
      log.warn('server', `LAN mode: open ${addrs.map((a) => `http://${a}:${ENV.port}`).join(' or ') || 'this machine\'s LAN address'} from another device (with npm run dev:lan use port 5173).${auth.open ? ' Anyone on this network can drive: set AUTH_USERS.' : ''}`);
    }
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void sessions.shutdown().finally(() => {
      hub.stopAll();
      server.close();
      setTimeout(() => process.exit(0), 200);
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  log.error('server', err);
  process.exit(1);
});
