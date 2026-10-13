// Phantom wallet bridge. Signs transactions built by Jupiter (via our server). Keys never leave Phantom.
import { Buffer } from 'buffer';
import { VersionedTransaction } from '@solana/web3.js';

interface PhantomProvider {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  isConnected?: boolean;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  disconnect(): Promise<void>;
  signTransaction<T>(tx: T): Promise<T>;
  signAndSendTransaction<T>(tx: T, opts?: unknown): Promise<{ signature: string }>;
  on(event: 'connect' | 'disconnect' | 'accountChanged', cb: (arg: unknown) => void): void;
}

declare global {
  interface Window {
    phantom?: { solana?: PhantomProvider };
    solana?: PhantomProvider;
    Buffer?: typeof Buffer;
  }
}

if (!window.Buffer) window.Buffer = Buffer;

/** Keep this much SOL for transaction fees and request-account rent (matches the server). */
export const SOL_FEE_RESERVE_UI = 0.03;

export function getPhantom(): PhantomProvider | null {
  const p = window.phantom?.solana ?? window.solana;
  return p && p.isPhantom ? p : null;
}

export function hasPhantom(): boolean {
  return getPhantom() !== null;
}

export async function connectPhantom(onlyIfTrusted = false): Promise<string> {
  const p = getPhantom();
  if (!p) throw new Error('Phantom is not installed. Get it at phantom.com, then reload.');
  // Update 21: Phantom answers only on a secure origin (https, or localhost). On a plain http LAN address its
  // popup never comes and the promise hangs forever; time out and say why instead of freezing the panel.
  const insecure = !window.isSecureContext;
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(insecure
    ? `Phantom did not answer. This page is on ${location.origin}, which is not a secure origin, and Phantom only works over https or on localhost. Use the trading wallet (instant signing) here, or run npm run dev:lan:https and open the https address.`
    : 'Phantom did not answer after 25 s. Open the Phantom window, or reload and try again.')), onlyIfTrusted ? 8000 : 25_000));
  const res = await Promise.race([p.connect(onlyIfTrusted ? { onlyIfTrusted: true } : undefined), timeout]);
  return res.publicKey.toString();
}

export async function disconnectPhantom(): Promise<void> {
  const p = getPhantom();
  if (p) await p.disconnect().catch(() => undefined);
}

/** Sign only (for Jupiter 'instant' transactions that the keeper co-signs and submits). */
export async function signTransactionB64(txB64: string): Promise<string> {
  const p = getPhantom();
  if (!p) throw new Error('Phantom not available');
  const tx = VersionedTransaction.deserialize(Buffer.from(txB64, 'base64'));
  const signed = await p.signTransaction(tx);
  return Buffer.from(signed.serialize()).toString('base64');
}

/** Sign and broadcast through Phantom (for legacy transactions submitted by the client). */
export async function signAndSendB64(txB64: string): Promise<string> {
  const p = getPhantom();
  if (!p) throw new Error('Phantom not available');
  const tx = VersionedTransaction.deserialize(Buffer.from(txB64, 'base64'));
  const { signature } = await p.signAndSendTransaction(tx);
  return signature;
}

export function onAccountChanged(cb: (pubkey: string | null) => void): void {
  const p = getPhantom();
  if (!p) return;
  p.on('accountChanged', (arg) => {
    const pk = arg as { toString(): string } | null;
    cb(pk ? pk.toString() : null);
  });
  p.on('disconnect', () => cb(null));
}
