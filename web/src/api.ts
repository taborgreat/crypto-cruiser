import type {
  ExitOrder, Flag, GhostParams, LiveOpenParams, Market, OpenParams, PedalAction, PositionState, RewindParams, Settings, SignRequest, StatusMsg, TradeRecord, ViewMode,
} from '../../shared/types.js';
import type { Candle } from '../../shared/candles.js';
import type { ConditionsState } from '../../shared/conditions.js';

export interface Result { ok: boolean; message: string; sign?: SignRequest; txid?: string; pending?: boolean }

const API_TIMEOUT_MS = 60_000;
async function call<T>(path: string, body?: unknown): Promise<T> {
  // every call has a timeout: the page must never freeze on a silent server
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(path, body === undefined
      ? { method: 'GET', signal: ctrl.signal }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
  } catch (err) {
    throw new Error((err as Error).name === 'AbortError' ? `${path}: no answer from the server after ${API_TIMEOUT_MS / 1000} s` : (err as Error).message);
  } finally {
    clearTimeout(timer);
  }
  const json = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok && !(json as { ok?: boolean }).ok) {
    throw new Error(json.message ?? `${path} failed (${res.status})`);
  }
  return json;
}

export const api = {
  status: () => call<StatusMsg>('/api/status'),
  settings: (partial: Partial<Settings>) => call<{ ok: boolean; settings: Settings }>('/api/settings', partial),
  mode: (partial: { view?: ViewMode; invert?: boolean }) => call<{ ok: boolean }>('/api/mode', partial),
  engine: (kind: 'paper' | 'live') => call<Result>('/api/engine', { kind }),
  market: (market: Market) => call<Result>('/api/market', { market }),
  feedRestart: () => call<Result>('/api/feed/restart', {}),
  ghosts: (ghosts: GhostParams[], primaryId?: string) => call<{ ok: boolean; ghosts: GhostParams[] }>('/api/ghosts', { ghosts, primaryId }),
  go: (id: string, extra: { inputToken?: 'SOL' | 'USDC'; inputAmount?: number; bankrollUsd?: number }) => call<Result>('/api/go', { id, ...extra }),
  cancelOrder: () => call<Result>('/api/order/cancel', {}),
  paperOpen: (p: OpenParams & { bankrollUsd?: number }) => call<Result>('/api/paper/open', p),
  paperReset: (bankrollUsd?: number) => call<Result>('/api/paper/reset', { bankrollUsd }),
  pedal: (action: PedalAction) => call<Result>('/api/pedal', { action }),
  liveConnect: (wallet: string) => call<Result>('/api/live/connect', { wallet }),
  liveTrading: (body: { action: 'create' | 'use' | 'phantom' | 'fund-tx' | 'withdraw' | 'balance' | 'swap-usdc'; to?: string; from?: string; amountSol?: number }) => call<Result & { txB64?: string; address?: string }>('/api/live/trading', body),
  liveDisconnect: () => call<Result>('/api/live/disconnect', {}),
  liveOpen: (p: LiveOpenParams) => call<Result>('/api/live/open', p),
  liveExecute: (id: string, signedTxB64: string) => call<Result>('/api/live/execute', { id, signedTxB64 }),
  liveCancel: (id: string) => call<Result>('/api/live/cancel', { id }),
  livePositions: () => call<{ ok: boolean; message: string; positions: unknown[]; selected: PositionState | null; trades: TradeRecord[] }>('/api/live/positions'),
  trades: () => call<TradeRecord[]>('/api/trades'),
  /** Update 17: the trades page: 'paper' or a wallet address. */
  tradesFor: (wallet: string, limit = 300) => call<TradeRecord[]>(`/api/trades?wallet=${encodeURIComponent(wallet)}&limit=${limit}`),
  conditionsDetail: () => call<{ state: ConditionsState | null; series: Array<{ h: string; res_sec: number; t0: number; closes: number[] }>; price: number }>('/api/conditions/detail'),
  candles: (intervalSec: number, limit = 1500) => call<{ interval: number; candles: Candle[] }>(`/api/candles?interval=${intervalSec}&limit=${limit}`),
  rewindStart: (p: RewindParams) => call<Result>('/api/rewind/start', p),
  rewindControl: (action: 'pause' | 'resume' | 'stop' | 'seek' | 'speed' | 'flag', value?: number | string) => call<Result>('/api/rewind/control', { action, value }),
  flag: (note = '') => call<{ ok: boolean; flag: Flag }>('/api/flag', { note }),
  exits: (body: { action: 'add'; kind: 'tp' | 'sl'; price: number; fraction: number } | { action: 'cancel'; id: string } | { action: 'clear' }) => call<Result & { exit?: ExitOrder }>('/api/exits', body),
};
