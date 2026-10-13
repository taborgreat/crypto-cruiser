// Update 27: the site is private. Every request (pages, API, websocket) needs a login.
//
// Credentials come from AUTH_USERS ("name:password,name2:password2"). The browser sends them as HTTP Basic
// auth once; the server answers with a cookie (tc_sid) that names this browser's session from then on, and
// that cookie is what the websocket upgrade is checked against too. One cookie = one Session (session.ts),
// so two browsers never share a car, a pedal or a trading wallet. The cookie list is kept on disk so a
// server restart does not hand anyone a fresh, empty session.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import { ENV } from './config.js';
import { log } from './log.js';

export const COOKIE = 'tc_sid';
const COOKIE_DAYS = 365;

export interface Login { sid: string; user: string; createdAt: number; lastSeen: number }

function parseUsers(): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of (process.env.AUTH_USERS ?? '').split(',')) {
    const i = pair.indexOf(':');
    if (i <= 0) continue;
    out.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export class Auth {
  private users = parseUsers();
  private logins = new Map<string, Login>();
  private file = path.join(ENV.dataDir, 'logins.json');
  readonly open: boolean;

  constructor() {
    this.open = this.users.size === 0;
    if (this.open) log.warn('auth', 'AUTH_USERS is not set: the site is OPEN to anyone who can reach it');
    else log.info('auth', `${this.users.size} login(s) configured`);
    try {
      const rows = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Login[];
      for (const r of rows) if (r.sid && (this.open || this.users.has(r.user))) this.logins.set(r.sid, r);
    } catch { /* first run */ }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify([...this.logins.values()]), { mode: 0o600 });
    } catch (err) { log.warn('auth', 'save', (err as Error).message); }
  }

  private fromCookie(req: http.IncomingMessage): Login | null {
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    const l = sid ? this.logins.get(sid) : undefined;
    if (!l) return null;
    l.lastSeen = Date.now();
    return l;
  }

  private fromBasic(req: http.IncomingMessage): string | null {
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Basic ')) return null;
    const dec = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const i = dec.indexOf(':');
    if (i < 0) return null;
    const user = dec.slice(0, i), pass = dec.slice(i + 1);
    const want = this.users.get(user);
    return want !== undefined && safeEqual(pass, want) ? user : null;
  }

  /**
   * The login for an HTTP request. A valid cookie wins; else Basic auth creates one (and sets the cookie);
   * else a 401 with the browser's password prompt is written and null returned.
   */
  http(req: http.IncomingMessage, res: http.ServerResponse): Login | null {
    const fromCookie = this.fromCookie(req);
    if (fromCookie) return fromCookie;
    const user = this.open ? 'guest' : this.fromBasic(req);
    if (!user) {
      const wantsPage = (req.method ?? 'GET') === 'GET' && !(req.url ?? '').startsWith('/api/') && /text\/html/.test(req.headers.accept ?? '');
      if (wantsPage) {
        // a browser: the login form (Update 27: Phantom's mobile browser never shows the Basic-auth prompt)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(loginPage(false));
      } else {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="TRAFFIC", charset="UTF-8"', 'content-type': 'text/plain', 'cache-control': 'no-store' });
        res.end('login required');
      }
      return null;
    }
    return this.issue(req, res, user);
  }

  /** POST /login from the form: name + password as x-www-form-urlencoded; on success the cookie is set and / is loaded. */
  async loginForm(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await new Promise<string>((resolve, reject) => {
      let d = '';
      req.on('data', (c) => { d += c; if (d.length > 10_000) req.destroy(); });
      req.on('end', () => resolve(d));
      req.on('error', reject);
    });
    const params = new URLSearchParams(body);
    const name = (params.get('user') ?? '').trim(), pass = params.get('pass') ?? '';
    const want = this.users.get(name);
    if (this.open || (want !== undefined && safeEqual(pass, want))) {
      this.issue(req, res, this.open ? 'guest' : name);
      res.writeHead(303, { location: '/' });
      res.end();
      return;
    }
    log.warn('auth', `failed login for "${name}" from ${req.headers['x-forwarded-for'] ?? req.socket.remoteAddress}`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(loginPage(true));
  }

  private issue(req: http.IncomingMessage, res: http.ServerResponse, user: string): Login {
    const sid = crypto.randomBytes(24).toString('hex');
    const login: Login = { sid, user, createdAt: Date.now(), lastSeen: Date.now() };
    this.logins.set(sid, login);
    this.save();
    const secure = (req.headers['x-forwarded-proto'] ?? '') === 'https' ? '; Secure' : '';
    res.setHeader('set-cookie', `${COOKIE}=${sid}; Path=/; Max-Age=${COOKIE_DAYS * 86_400}; HttpOnly; SameSite=Lax${secure}`);
    log.info('auth', `login ${user} -> session ${sid.slice(0, 8)}`);
    return login;
  }

  /** The login for a websocket upgrade: the cookie only (the page that opened it already logged in). */
  upgrade(req: http.IncomingMessage): Login | null {
    const l = this.fromCookie(req);
    if (l) return l;
    if (!this.open) return null;
    // open mode without a cookie (e.g. a bare ws client): one shared guest session
    let g = this.logins.get('guest');
    if (!g) { g = { sid: 'guest', user: 'guest', createdAt: Date.now(), lastSeen: Date.now() }; this.logins.set('guest', g); }
    return g;
  }
}

function loginPage(failed: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TRAFFIC · login</title>
<style>
  :root { --bg:#06040f; --fg:#e6e4f5; --muted:#9a93b8; --liq:#ff3b3b; --away:#35d07f; }
  html,body { height:100%; margin:0; background:var(--bg); color:var(--fg); font:15px system-ui,-apple-system,sans-serif; }
  body { display:flex; align-items:center; justify-content:center; padding:20px; box-sizing:border-box; }
  form { width:min(360px,100%); background:rgba(0,0,0,.7); border:1px solid rgba(255,255,255,.2); border-radius:12px; padding:22px; box-sizing:border-box; }
  h1 { margin:0 0 4px; font-size:22px; letter-spacing:.3em; }
  p { margin:0 0 18px; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.15em; }
  label { display:block; font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.15em; margin:12px 0 6px; }
  input { width:100%; box-sizing:border-box; font:16px system-ui; padding:12px; border-radius:8px; border:1px solid rgba(255,255,255,.25); background:rgba(255,255,255,.06); color:var(--fg); }
  input:focus { outline:none; border-color:var(--away); }
  button { width:100%; margin-top:18px; padding:14px; font:600 15px system-ui; letter-spacing:.1em; border:0; border-radius:8px; background:var(--away); color:#06111c; cursor:pointer; }
  .err { color:var(--liq); margin:10px 0 0; text-transform:none; letter-spacing:0; }
</style></head><body>
<form method="post" action="/login" autocomplete="on">
  <h1>TRAFFIC</h1><p>private · login required</p>
  <label for="u">Name</label><input id="u" name="user" autocapitalize="none" autocorrect="off" autocomplete="username" required autofocus>
  <label for="p">Password</label><input id="p" name="pass" type="password" autocomplete="current-password" required>
  ${failed ? '<p class="err">Wrong name or password.</p>' : ''}
  <button type="submit">ENTER</button>
</form></body></html>`;
}
