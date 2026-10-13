// Update 13: instant signing. A small dedicated trading wallet whose keypair lives on this machine
// (data/trading-wallet.json, or TRADING_WALLET_SECRET) signs every Jupiter transaction here, so there is no
// Phantom approve screen. Positions then belong to this wallet. It is a hot key: keep it small, fund it
// from Phantom, withdraw when done. Anyone with the file controls its funds.
import fs from 'node:fs';
import path from 'node:path';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ENV } from './config.js';
import { rpcCall } from './feed/rpcws.js';
import { log } from './log.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error('invalid base58');
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const ch of s) { if (ch === '1') bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}

export class TradingWallet {
  keypair: Keypair | null = null;

  private constructor(private file: string, readonly owner: string | null) {}

  /** Update 27: the trading wallet of a Phantom owner lives in data/wallets/<owner>/trading-wallet.json. */
  static forOwner(owner: string): TradingWallet {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner)) throw new Error('bad wallet address');
    return new TradingWallet(path.join(ENV.dataDir, 'wallets', owner, 'trading-wallet.json'), owner);
  }

  /** The placeholder before any Phantom wallet has connected: nothing loads, nothing is created. */
  static unowned(): TradingWallet {
    return new TradingWallet('', null);
  }

  static legacyFile(): string { return path.join(ENV.dataDir, 'trading-wallet.json'); }

  get address(): string | null { return this.keypair?.publicKey.toBase58() ?? null; }

  /**
   * The pre-Update-27 single wallet (data/trading-wallet.json): the first owner to connect without a wallet of
   * their own takes it over, so a funded key is never left behind. The file is moved, so it happens once.
   */
  adoptLegacy(): boolean {
    if (!this.owner || this.keypair) return false;
    const legacy = TradingWallet.legacyFile();
    if (!fs.existsSync(legacy)) return false;
    try {
      const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(legacy, 'utf8')) as number[]));
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.renameSync(legacy, this.file);
      this.keypair = kp;
      log.warn('trading', `legacy trading wallet ${this.address} now belongs to Phantom ${this.owner.slice(0, 4)}… (${this.file})`);
      return true;
    } catch (err) {
      log.warn('trading', 'adopt legacy', (err as Error).message);
      return false;
    }
  }

  /** TRADING_WALLET_SECRET (JSON array or base58) wins; else the file in the data folder. */
  load(): boolean {
    if (!this.file) return false;
    const env = process.env.TRADING_WALLET_SECRET?.trim();
    try {
      if (env && !this.owner) {
        this.keypair = Keypair.fromSecretKey(env.startsWith('[') ? Uint8Array.from(JSON.parse(env) as number[]) : base58Decode(env));
        log.info('trading', `trading wallet from env: ${this.address}`);
        return true;
      }
      if (fs.existsSync(this.file)) {
        this.keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(this.file, 'utf8')) as number[]));
        log.info('trading', `trading wallet loaded: ${this.address} (${this.file})`);
        return true;
      }
    } catch (err) {
      log.warn('trading', 'load', (err as Error).message);
    }
    return false;
  }

  create(): string {
    if (this.keypair) return this.address!;
    if (!this.file) throw new Error('No owner for the trading wallet');
    const kp = Keypair.generate();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
    this.keypair = kp;
    log.warn('trading', `created trading wallet ${kp.publicKey.toBase58()} · HOT KEY at ${this.file} · keep balances small`);
    return this.address!;
  }

  signB64(txB64: string): string {
    if (!this.keypair) throw new Error('No trading wallet');
    const tx = VersionedTransaction.deserialize(Buffer.from(txB64, 'base64'));
    tx.sign([this.keypair]);
    return Buffer.from(tx.serialize()).toString('base64');
  }

  async balanceSol(): Promise<number | null> {
    if (!this.keypair) return null;
    const r = await rpcCall<{ value?: number }>('getBalance', [this.address]);
    return typeof r?.value === 'number' ? r.value / LAMPORTS_PER_SOL : null;
  }

  /** An unsigned SOL transfer into the trading wallet from `from`; Phantom signs and sends it in the browser. */
  async fundTx(from: string, amountSol: number): Promise<string> {
    if (!this.keypair) throw new Error('No trading wallet');
    const bh = await rpcCall<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'finalized' }]);
    const payer = new PublicKey(from);
    const msg = new TransactionMessage({
      payerKey: payer, recentBlockhash: bh.value.blockhash,
      instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: this.keypair.publicKey, lamports: Math.round(amountSol * LAMPORTS_PER_SOL) })],
    }).compileToV0Message();
    return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
  }

  /** Everything but the fee back to `to`, signed here. */
  async withdrawAll(to: string): Promise<{ txid: string; sol: number }> {
    if (!this.keypair) throw new Error('No trading wallet');
    const bal = await this.balanceSol();
    const lamports = Math.floor((bal ?? 0) * LAMPORTS_PER_SOL) - 10_000;
    if (lamports <= 0) throw new Error('Nothing to withdraw');
    const bh = await rpcCall<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'finalized' }]);
    const msg = new TransactionMessage({
      payerKey: this.keypair.publicKey, recentBlockhash: bh.value.blockhash,
      instructions: [SystemProgram.transfer({ fromPubkey: this.keypair.publicKey, toPubkey: new PublicKey(to), lamports })],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([this.keypair]);
    const txid = await rpcCall<string>('sendTransaction', [Buffer.from(tx.serialize()).toString('base64'), { encoding: 'base64', skipPreflight: false, maxRetries: 3 }]);
    return { txid, sol: lamports / LAMPORTS_PER_SOL };
  }
}
