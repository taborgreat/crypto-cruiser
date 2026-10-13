// HTTP API + websocket hub + static hosting of the built front end.
// The websocket at /ws is the single fan-out data API every client reads (Update 1). Update 9 §D: outgoing
// messages are queued and flushed once per ~16 ms as one array; within a flush only the latest anim tick
// (per source), frame and status survive, events never drop.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { GhostParams, LiveOpenParams, OpenParams, PedalAction, RewindParams, ServerMsg } from '../shared/types.js';
import { PEDAL_ACTIONS } from '../shared/types.js';
import { CANDLE_INTERVALS } from '../shared/candles.js';
import { collapseBatch } from '../shared/batch.js';
import { ENV } from './config.js';
import { Session } from './session.js';
import { Auth, type Login } from './auth.js';
import type { MarketHub } from './market.js';
import { log } from './log.js';

const FLUSH_MS = 16;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.md': 'text/markdown',
};

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2_000_000) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** Update 27: one Session per login cookie, created on first use, retired after a long idle. */
export class SessionManager {
  private sessions = new Map<string, Promise<Session>>();
  private gcTimer: NodeJS.Timeout;

  constructor(private hub: MarketHub) {
    this.gcTimer = setInterval(() => this.gc(), 60_000);
  }

  for(login: Login): Promise<Session> {
    let p = this.sessions.get(login.sid);
    if (!p) {
      const dir = path.join(ENV.dataDir, 'sessions', login.sid);
      const s = new Session(this.hub, login.sid, dir);
      log.info('session', `new session ${login.sid.slice(0, 8)} for ${login.user}`);
      p = s.start().then(() => s).catch((err) => { this.sessions.delete(login.sid); throw err; });
      this.sessions.set(login.sid, p);
    }
    return p;
  }

  /** A session with no browser for 30 min and nothing running is shut down; its market core follows. */
  private gc(): void {
    const now = Date.now();
    for (const [sid, p] of this.sessions) {
      void p.then((s) => {
        if (s.clients > 0 || now - s.idleSince < SESSION_IDLE_MS) return;
        if (s.paper.position || s.engine.position || s.status().wallets.some((w) => w.position)) return;
        this.sessions.delete(sid);
        s.shutdown();
        log.info('session', `retired idle session ${sid.slice(0, 8)}`);
      }).catch(() => undefined);
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.gcTimer);
    for (const p of this.sessions.values()) await p.then((s) => s.shutdown()).catch(() => undefined);
    this.sessions.clear();
  }
}

const SESSION_IDLE_MS = 30 * 60_000;

export function createServer(sessions: SessionManager, auth: Auth): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/login' && req.method === 'POST') { await auth.loginForm(req, res); return; }
      const login = auth.http(req, res);
      if (!login) return;
      if (url.pathname.startsWith('/api/')) {
        const session = await sessions.for(login);
        await handleApi(session, req, res, url);
        return;
      }
      serveStatic(req, res, url.pathname);
    } catch (err) {
      log.error('http', (err as Error).message);
      send(res, 500, { ok: false, message: (err as Error).message });
    }
  });

  // The websocket: one hub per session. Each session queues its own messages and flushes once per ~16 ms.
  const wss = new WebSocketServer({ noServer: true });
  const clientsOf = new Map<Session, Set<WebSocket>>();
  const wire = (session: Session): Set<WebSocket> => {
    let set = clientsOf.get(session);
    if (set) return set;
    set = new Set<WebSocket>();
    clientsOf.set(session, set);
    let queue: ServerMsg[] = [];
    let timer: NodeJS.Timeout | null = null;
    const flush = () => {
      timer = null;
      if (!queue.length) return;
      const msgs = collapseBatch(queue);
      queue = [];
      const text = JSON.stringify(msgs);
      for (const c of set!) if (c.readyState === WebSocket.OPEN) c.send(text);
    };
    session.on('msg', (msg: ServerMsg) => {
      if (!set!.size) { queue = []; return; }
      queue.push(msg);
      if (!timer) timer = setTimeout(flush, FLUSH_MS);
    });
    const status = setInterval(() => { if (set!.size) session.broadcastStatus(true); }, 2000);
    session.once('shutdown', () => { clearInterval(status); clientsOf.delete(session); for (const c of set!) c.close(); });
    return set;
  };
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    const login = auth.upgrade(req);
    if (!login) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sessions.for(login).then((session) => {
        const set = wire(session);
        set.add(ws);
        session.clients = set.size;
        session.idleSince = 0;
        const hello: ServerMsg[] = [{ type: 'hello', serverTime: Date.now() }, { type: 'status', status: session.status() }];
        if (session.lastFrame) hello.push({ type: 'frame', frame: session.lastFrame });
        ws.send(JSON.stringify(hello));
        ws.on('close', () => {
          set.delete(ws);
          session.clients = set.size;
          if (!set.size) session.idleSince = Date.now();
        });
      }).catch((err) => { log.error('ws', (err as Error).message); ws.close(); });
    });
  });
  return server;
}

async function handleApi(session: Session, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const p = url.pathname;
  const method = req.method ?? 'GET';
  const body = method === 'POST' ? await readBody(req) : {};

  if (p === '/api/status' && method === 'GET') return send(res, 200, session.status());
  if (p === '/api/settings' && method === 'POST') return send(res, 200, { ok: true, settings: session.settingsStore.update(body as never) });
  if (p === '/api/mode' && method === 'POST') return send(res, 200, { ok: true, mode: session.setMode(body as never) });
  if (p === '/api/engine' && method === 'POST') {
    const kind = body.kind === 'live' ? 'live' : 'paper';
    return send(res, 200, session.setEngine(kind));
  }
  if (p === '/api/market' && method === 'POST') return send(res, 200, await session.setMarket(String(body.market) as never));
  if (p === '/api/feed/restart' && method === 'POST') { session.restartFeed(); return send(res, 200, { ok: true }); }

  // Ghost mode (Update 1 / 3 / 4 / 8)
  if (p === '/api/ghosts' && method === 'POST') {
    const list = Array.isArray(body.ghosts) ? (body.ghosts as GhostParams[]) : [];
    return send(res, 200, session.setGhosts(list, typeof body.primaryId === 'string' ? body.primaryId : undefined));
  }
  if (p === '/api/go' && method === 'POST') {
    return send(res, 200, await session.go(String(body.id ?? ''), {
      inputToken: body.inputToken === 'USDC' ? 'USDC' : body.inputToken === 'SOL' ? 'SOL' : undefined,
      inputAmount: typeof body.inputAmount === 'number' ? body.inputAmount : undefined,
      bankrollUsd: typeof body.bankrollUsd === 'number' ? body.bankrollUsd : undefined,
    }));
  }
  if (p === '/api/order/cancel' && method === 'POST') return send(res, 200, await session.cancelOrder());

  // Rewind (Update 7)
  if (p === '/api/rewind/start' && method === 'POST') {
    const params: RewindParams = {
      lookbackSec: Number(body.lookbackSec) || 3600,
      durationSec: Number(body.durationSec) || 45,
      leverage: Number(body.leverage) || 100,
      collateralUsd: Number(body.collateralUsd) || 50,
      twoSided: body.twoSided !== false,
      side: Number(body.side) === 1 ? 1 : -1,
    };
    return send(res, 200, session.startRewind(params));
  }
  if (p === '/api/rewind/control' && method === 'POST') return send(res, 200, session.rewindControl(String(body.action), body.value as number | string | undefined));
  if (p === '/api/flag' && method === 'POST') return send(res, 200, { ok: true, flag: session.dropFlag(typeof body.note === 'string' ? body.note : '') });

  // Exits (Update 12): take profit / stop loss, partial
  if (p === '/api/exits' && method === 'POST') {
    const action = String(body.action ?? 'add');
    if (action === 'add') return send(res, 200, session.addExit(body.kind === 'sl' ? 'sl' : 'tp', Number(body.price), Number(body.fraction)));
    if (action === 'cancel') return send(res, 200, session.cancelExit(String(body.id ?? '')));
    if (action === 'clear') { session.clearExits('cleared by the driver'); return send(res, 200, { ok: true, message: 'Exits cleared.' }); }
    return send(res, 400, { ok: false, message: 'Unknown exits action' });
  }

  if (p === '/api/paper/open' && method === 'POST') {
    const params: OpenParams = {
      market: String(body.market ?? 'SOL-PERP') as OpenParams['market'],
      side: Number(body.side) === 1 ? 1 : -1,
      leverage: Number(body.leverage),
      collateralUsd: Number(body.collateralUsd),
      entry: typeof body.entry === 'number' ? body.entry : null,
    };
    if (typeof body.bankrollUsd === 'number' && !session.paper.position) session.resetPaper(body.bankrollUsd);
    return send(res, 200, await session.openPaper(params));
  }
  if (p === '/api/paper/reset' && method === 'POST') {
    session.resetPaper(typeof body.bankrollUsd === 'number' ? body.bankrollUsd : undefined);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/pedal' && method === 'POST') {
    const action = String(body.action) as PedalAction;
    if (!PEDAL_ACTIONS.includes(action)) return send(res, 400, { ok: false, message: 'Unknown pedal' });
    return send(res, 200, await session.pedal(action));
  }

  if (p === '/api/live/trading' && method === 'POST') return send(res, 200, await session.tradingAction(String(body.action ?? ''), { to: typeof body.to === 'string' ? body.to : undefined, from: typeof body.from === 'string' ? body.from : undefined, amountSol: typeof body.amountSol === 'number' ? body.amountSol : undefined, signedTxB64: typeof body.signedTxB64 === 'string' ? body.signedTxB64 : undefined, requestId: typeof body.requestId === 'string' ? body.requestId : undefined }));
  if (p === '/api/live/connect' && method === 'POST') return send(res, 200, await session.liveConnect(String(body.wallet)));
  if (p === '/api/live/disconnect' && method === 'POST') { session.liveDisconnect(); return send(res, 200, { ok: true }); }
  if (p === '/api/live/open' && method === 'POST') {
    const params: LiveOpenParams = {
      market: String(body.market ?? 'SOL-PERP') as LiveOpenParams['market'],
      side: Number(body.side) === 1 ? 1 : -1,
      leverage: Number(body.leverage),
      inputToken: body.inputToken === 'USDC' ? 'USDC' : 'SOL',
      inputAmount: Number(body.inputAmount),
      entry: typeof body.entry === 'number' ? body.entry : null,
    };
    return send(res, 200, await session.openLive(params));
  }
  if (p === '/api/live/execute' && method === 'POST') return send(res, 200, await session.liveExecute(String(body.id), String(body.signedTxB64)));
  if (p === '/api/live/cancel' && method === 'POST') return send(res, 200, { ok: session.liveCancel(String(body.id)) });
  if (p === '/api/live/positions' && method === 'GET') return send(res, 200, await session.walletReport());

  // Recent trades: on Solana for live (Jupiter trade history), in memory for practice.
  if (p === '/api/trades' && method === 'GET') {
    const wallet = url.searchParams.get('wallet');
    if (wallet === null) return send(res, 200, await session.trades());
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 300)));
    try { return send(res, 200, await session.tradesFor(wallet, limit)); } catch (err) { return send(res, 502, { ok: false, message: (err as Error).message }); }
  }
  if (p === '/api/conditions/detail' && method === 'GET') return send(res, 200, session.conditionsDetail());

  if (p === '/api/candles' && method === 'GET') {
    const sec = Number(url.searchParams.get('interval') ?? 60);
    const interval = (CANDLE_INTERVALS as readonly number[]).includes(sec) ? sec : 60;
    const limit = Math.min(5000, Math.max(10, Number(url.searchParams.get('limit') ?? 1500)));
    return send(res, 200, { interval, candles: session.layers.candles(interval).slice(-limit) });
  }
  if (p === '/api/ticks' && method === 'GET') {
    const minutes = Math.min(10_080, Math.max(1, Number(url.searchParams.get('minutes') ?? 30)));
    const n = Math.min(5000, Math.max(10, Number(url.searchParams.get('points') ?? 1000)));
    const now = Date.now();
    return send(res, 200, session.feed.history.sample(now - minutes * 60_000, now, n));
  }
  send(res, 404, { ok: false, message: 'Not found' });
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
  const dist = ENV.distDir;
  const hasDist = fs.existsSync(path.join(dist, 'index.html'));
  if (!hasDist) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>TRAFFIC server</title>
<body style="font-family:system-ui;background:#0b0d12;color:#dde">
<h1>TRAFFIC server is running</h1>
<p>The front end has not been built. Either run <code>npm run dev</code> and open the Vite URL (http://localhost:5173),
or run <code>npm run build</code> then restart with <code>npm start</code>.</p>
<p>API: <a href="/api/status" style="color:#8cf">/api/status</a></p></body>`);
    return;
  }
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(dist, rel));
  if (!file.startsWith(dist) || !fs.existsSync(file)) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': rel === '/index.html' ? 'no-cache' : 'public, max-age=31536000, immutable' });
  fs.createReadStream(file).pipe(res);
}
