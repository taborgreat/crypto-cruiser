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
import type { Session } from './session.js';
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

export function createServer(session: Session): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(session, req, res, url);
        return;
      }
      serveStatic(req, res, url.pathname);
    } catch (err) {
      log.error('http', (err as Error).message);
      send(res, 500, { ok: false, message: (err as Error).message });
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    const hello: ServerMsg[] = [{ type: 'hello', serverTime: Date.now() }, { type: 'status', status: session.status() }];
    if (session.lastFrame) hello.push({ type: 'frame', frame: session.lastFrame });
    ws.send(JSON.stringify(hello));
  });
  // one message per animation frame
  let queue: ServerMsg[] = [];
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    timer = null;
    if (!queue.length) return;
    const msgs = collapseBatch(queue);
    queue = [];
    const text = JSON.stringify(msgs);
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(text);
  };
  session.on('msg', (msg: ServerMsg) => {
    queue.push(msg);
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  });
  setInterval(() => session.broadcastStatus(true), 2000);
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

  if (p === '/api/live/trading' && method === 'POST') return send(res, 200, await session.tradingAction(String(body.action ?? ''), { to: typeof body.to === 'string' ? body.to : undefined, from: typeof body.from === 'string' ? body.from : undefined, amountSol: typeof body.amountSol === 'number' ? body.amountSol : undefined }));
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
