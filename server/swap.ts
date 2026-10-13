// Update 14: swap the trading wallet's USDC back to SOL through Jupiter Ultra (lite-api, no key needed):
// order → sign with the trading wallet → execute. Jupiter lands the transaction itself and answers with the
// signature, so there is no RPC send and no confirmation polling here.
import { SOL_MINT, USDC_MINT } from '../shared/types.js';
import { log } from './log.js';
import type { TradingWallet } from './trading.js';

const ULTRA = (process.env.JUP_ULTRA_API ?? 'https://lite-api.jup.ag/ultra/v1').replace(/\/$/, '');

interface UltraOrder {
  transaction?: string | null;
  requestId?: string;
  inAmount?: string;
  outAmount?: string;
  errorMessage?: string;
  error?: string;
}
interface UltraExecute {
  status?: string;
  signature?: string;
  error?: string;
  code?: number;
  inputAmountResult?: string;
  outputAmountResult?: string;
}

async function ultra<T>(path: string, init?: RequestInit, timeoutMs = 25_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${ULTRA}${path}`, { ...init, signal: ctrl.signal, headers: { 'content-type': 'application/json', accept: 'application/json', ...(init?.headers ?? {}) } });
  } catch (err) {
    throw new Error(`Jupiter swap ${path.split('?')[0]}: ${(err as Error).name === 'AbortError' ? `no answer after ${Math.round(timeoutMs / 1000)} s` : (err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) {
    const msg = (json as { error?: string; errorMessage?: string } | null)?.errorMessage ?? (json as { error?: string } | null)?.error ?? text.slice(0, 200);
    throw new Error(`Jupiter swap ${res.status}: ${msg}`);
  }
  return json as T;
}

/** Swaps `usdc` USDC of the trading wallet into SOL. Returns the signature and the amounts Jupiter reports. */
export async function swapUsdcToSol(tw: TradingWallet, usdc: number): Promise<{ txid: string; inUsdc: number; outSol: number }> {
  if (!tw.keypair || !tw.address) throw new Error('No trading wallet');
  const amount = Math.floor(usdc * 1e6);
  if (amount < 10_000) throw new Error('Less than 0.01 USDC to swap');
  const order = await ultra<UltraOrder>(`/order?inputMint=${USDC_MINT}&outputMint=${SOL_MINT}&amount=${amount}&taker=${tw.address}`);
  if (order.errorMessage || order.error) throw new Error(`Jupiter: ${order.errorMessage ?? order.error}`);
  if (!order.transaction || !order.requestId) throw new Error('Jupiter returned no swap transaction');
  const signed = tw.signB64(order.transaction);
  const res = await ultra<UltraExecute>('/execute', { method: 'POST', body: JSON.stringify({ signedTransaction: signed, requestId: order.requestId }) }, 60_000);
  if (res.status !== 'Success') {
    throw new Error(`Swap failed: ${res.error ?? (res.code !== undefined ? `code ${res.code}` : res.status ?? 'unknown')}${res.signature ? ` (tx ${res.signature.slice(0, 8)}…)` : ''}`);
  }
  const inUsdc = Number(res.inputAmountResult ?? order.inAmount ?? amount) / 1e6;
  const outSol = Number(res.outputAmountResult ?? order.outAmount ?? 0) / 1e9;
  log.info('swap', `${inUsdc.toFixed(2)} USDC → ${outSol.toFixed(4)} SOL (${res.signature ?? 'no signature'})`);
  return { txid: res.signature ?? '', inUsdc, outSol };
}
