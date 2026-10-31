// Autenticação do ZAHAV: senha (scrypt) + 2FA (TOTP/RFC6238, implementado com crypto) +
// sessão assinada (HMAC). Single-user. QR via lib 'qrcode'.
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const QRCode = require('qrcode');

const __dirname = dirname(fileURLToPath(import.meta.url));
// Na nuvem (Render) o login vive no disco persistente — defina AUTH_FILE=/data/auth.json
const FILE = process.env.AUTH_FILE || resolve(__dirname, '..', 'data', 'auth.json');
const SESSAO_MS = 24 * 60 * 60 * 1000; // 24h — teto do token; o cookie é de sessão (morre ao fechar o navegador)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function ler() { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return null; } }
function salvar(obj) { mkdirSync(dirname(FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(obj, null, 2)); }

// ---- base32 (RFC 4648) ----
function base32Encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function base32Decode(s) {
  let bits = 0, val = 0; const out = [];
  for (const c of s.replace(/=+$/, '').toUpperCase()) { const i = B32.indexOf(c); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; } }
  return Buffer.from(out);
}

// ---- TOTP ----
function totpEm(secretB32, tMs) {
  const key = base32Decode(secretB32);
  let counter = Math.floor(tMs / 1000 / 30);
  const buf = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) { buf[i] = counter & 0xff; counter = Math.floor(counter / 256); }
  const h = createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

export function estaConfigurado() { const a = ler(); return !!(a && a.passHash && a.totpSecret); }

// 1ª vez: cria hash da senha + segredo TOTP + chave de sessão. Retorna QR pra escanear.
export async function configurar(senha, usuario = 'Thiago') {
  if (estaConfigurado()) throw new Error('já configurado');
  if (!senha || senha.length < 8) throw new Error('senha curta (mín. 8 caracteres)');
  const salt = randomBytes(16).toString('hex');
  const passHash = scryptSync(senha, salt, 64).toString('hex');
  const totpSecret = base32Encode(randomBytes(20));
  const sessionKey = randomBytes(32).toString('hex');
  salvar({ usuario, passHash, salt, totpSecret, sessionKey });
  const label = encodeURIComponent(`ZAHAV ImovelUm:${usuario}`);
  const otpauth = `otpauth://totp/${label}?secret=${totpSecret}&issuer=${encodeURIComponent('ZAHAV ImovelUm')}&digits=6&period=30`;
  const qr = await QRCode.toDataURL(otpauth, { margin: 1, width: 220 });
  return { qr, secret: totpSecret };
}

export function verificarSenha(senha) {
  const a = ler(); if (!a) return false;
  const h = scryptSync(senha || '', a.salt, 64);
  const ref = Buffer.from(a.passHash, 'hex');
  return h.length === ref.length && timingSafeEqual(h, ref);
}

export function verificarTotp(codigo) {
  const a = ler(); if (!a) return false;
  const c = String(codigo || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const now = Date.now();
  // tolerância alargada (±15 min) p/ absorver diferença de relógio servidor x celular
  for (let d = -30; d <= 30; d++) if (totpEm(a.totpSecret, now + d * 30000) === c) return true;
  return false;
}

// ---- sessão (token assinado, stateless) ----
export function criarToken() {
  const a = ler(); const exp = Date.now() + SESSAO_MS;
  const sig = createHmac('sha256', a.sessionKey).update(String(exp)).digest('hex');
  return `${exp}.${sig}`;
}
export function verificarToken(token) {
  const a = ler(); if (!a || !token) return false;
  const [exp, sig] = String(token).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const esperado = createHmac('sha256', a.sessionKey).update(String(exp)).digest('hex');
  const x = Buffer.from(sig), y = Buffer.from(esperado);
  return x.length === y.length && timingSafeEqual(x, y);
}
