// One RPC websocket for the whole process (Update 1). Every oracle and position account the server
// watches is an `accountSubscribe` on this single connection; the node pushes new account bytes on
// every change. Reconnects and resubscribes on drop. Also a tiny JSON-RPC HTTP helper.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { ENV } from '../config.js';
import { log } from '../log.js';

export type AccountCallback = (data: Uint8Array, slot: number) => void;

interface Sub {
  pubkey: string;
  cb: AccountCallback;
  reqId: number | null;
  subId: number | null;
}

export class RpcSubscriber extends EventEmitter {
  private ws: WebSocket | null = null;
  private subs = new Map<string, Sub>();
  private byReq = new Map<number, Sub>();
  private bySubId = new Map<number, Sub>();
  private nextId = 1;
  private backoff = 1000;
  private stopped = false;
  private pingTimer: NodeJS.Timeout | null = null;
  connected = false;
  lastMessageAt = 0;

  constructor(private url: string) {
    super();
  }

  get count(): number {
    return this.subs.size;
  }

  /** Subscribe to account changes. Returns an unsubscribe function. */
  subscribe(pubkey: string, cb: AccountCallback): () => void {
    const existing = this.subs.get(pubkey);
    if (existing) {
      // Chain callbacks: several consumers may watch one account.
      const prev = existing.cb;
      existing.cb = (d, s) => { prev(d, s); cb(d, s); };
      return () => { existing.cb = prev; };
    }
    const sub: Sub = { pubkey, cb, reqId: null, subId: null };
    this.subs.set(pubkey, sub);
    this.ensure();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.send(sub);
    return () => this.unsubscribe(pubkey);
  }

  private unsubscribe(pubkey: string): void {
    const sub = this.subs.get(pubkey);
    if (!sub) return;
    this.subs.delete(pubkey);
    if (sub.reqId !== null) this.byReq.delete(sub.reqId);
    if (sub.subId !== null) {
      this.bySubId.delete(sub.subId);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'accountUnsubscribe', params: [sub.subId] }));
      }
    }
  }

  private send(sub: Sub): void {
    if (!this.ws) return;
    sub.reqId = this.nextId++;
    sub.subId = null;
    this.byReq.set(sub.reqId, sub);
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0', id: sub.reqId, method: 'accountSubscribe',
      params: [sub.pubkey, { encoding: 'base64', commitment: 'processed' }],
    }));
  }

  private ensure(): void {
    if (this.ws || this.stopped) return;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      log.warn('rpcws', 'create failed', (err as Error).message);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      this.backoff = 1000;
      this.connected = true;
      this.byReq.clear();
      this.bySubId.clear();
      for (const sub of this.subs.values()) this.send(sub);
      log.info('rpcws', `connected, ${this.subs.size} subscription(s)`);
      this.emit('status', { connected: true });
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 20_000);
    });
    ws.on('message', (raw) => {
      this.lastMessageAt = Date.now();
      let msg: { id?: number; result?: unknown; method?: string; params?: { subscription?: number; result?: { context?: { slot?: number }; value?: { data?: [string, string] } } } };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (typeof msg.id === 'number' && typeof msg.result === 'number') {
        const sub = this.byReq.get(msg.id);
        if (sub) { sub.subId = msg.result; this.bySubId.set(msg.result, sub); }
        return;
      }
      if (msg.method === 'accountNotification' && msg.params) {
        const sub = typeof msg.params.subscription === 'number' ? this.bySubId.get(msg.params.subscription) : undefined;
        const b64 = msg.params.result?.value?.data?.[0];
        if (sub && b64) sub.cb(Buffer.from(b64, 'base64'), msg.params.result?.context?.slot ?? 0);
      }
    });
    const onDown = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      this.emit('status', { connected: false });
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.scheduleReconnect();
    };
    ws.on('close', onDown);
    ws.on('error', (err) => {
      log.warn('rpcws', err.message);
      try { ws.terminate(); } catch { /* ignore */ }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.subs.size) return;
    const wait = this.backoff;
    this.backoff = Math.min(30_000, this.backoff * 2);
    setTimeout(() => { if (!this.ws) this.connect(); }, wait);
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } }
    this.ws = null;
    this.subs.clear();
  }
}

let shared: RpcSubscriber | null = null;
export function rpcSubscriber(): RpcSubscriber {
  if (!shared) shared = new RpcSubscriber(ENV.rpcWsUrl);
  return shared;
}

/** JSON-RPC over HTTP (balances, account reads, blockhash, sendTransaction). Not used for prices. */
export async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(ENV.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message?: string; code?: number } };
  if (json.error) throw new Error(`${method}: ${json.error.message ?? 'rpc error'}`);
  return json.result as T;
}

export async function getAccountData(pubkey: string): Promise<Uint8Array | null> {
  const r = await rpcCall<{ value?: { data?: [string, string] } | null }>('getAccountInfo', [pubkey, { encoding: 'base64', commitment: 'processed' }]);
  const b64 = r?.value?.data?.[0];
  return b64 ? Buffer.from(b64, 'base64') : null;
}
