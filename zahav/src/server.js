// ZAHAV — painel unificado ImovelUm, protegido por login + 2FA.
import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as auth from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dirname, '..', 'public');

// cada módulo exporta { app } (Express app sem listen quando montado aqui)
const { app: fluxoApp } = await import('../../fluxo-caixa/src/server.js');
let vendasApp = null, viabApp = null;
try { ({ app: vendasApp } = await import('../../vendas/src/server.js')); } catch (e) { console.warn('Vendas não montado:', e.message); }
try { ({ app: viabApp } = await import('../../viabilidade/src/server.js')); } catch (e) { console.warn('Viabilidade não montado:', e.message); }

const app = express();
app.set('trust proxy', true); // atrás do túnel Cloudflare: req.secure e req.ip ficam corretos
app.use(express.json());

// --- cookies (parse simples) ---
app.use((req, _res, next) => {
  req.cookies = {};
  (req.headers.cookie || '').split(';').forEach((c) => { const i = c.indexOf('='); if (i > 0) req.cookies[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); });
  next();
});

// --- proteção contra força-bruta (memória) ---
const tentativas = new Map(); // ip -> { n, ate }
function bloqueado(ip) { const t = tentativas.get(ip); return t && t.n >= 5 && Date.now() < t.ate; }
function registrarFalha(ip) { const t = tentativas.get(ip) || { n: 0, ate: 0 }; t.n += 1; t.ate = Date.now() + 10 * 60 * 1000; tentativas.set(ip, t); }
function limparFalhas(ip) { tentativas.delete(ip); }

// cookie de SESSÃO (sem Max-Age/Expires): morre ao fechar o navegador -> pede login de novo.
// O token ainda tem validade própria (SESSAO_MS) como teto, caso o navegador restaure abas.
const setCookie = (res, tok, req) => res.setHeader('Set-Cookie', `zsess=${tok}; HttpOnly; SameSite=Lax; Path=/${req && req.secure ? '; Secure' : ''}`);
const page = (f) => (req, res) => res.sendFile(resolve(PUBLIC, f));

// ---------- ROTAS PÚBLICAS (sem login) ----------
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() })); // Render health check
app.get('/logo.png', (req, res) => res.sendFile(resolve(PUBLIC, 'logo.png')));

app.get('/setup', (req, res) => auth.estaConfigurado() ? res.redirect('/') : page('setup.html')(req, res));
app.post('/api/setup', async (req, res) => {
  if (auth.estaConfigurado()) return res.status(403).json({ erro: 'já configurado' });
  try { const r = await auth.configurar(req.body.senha); res.json({ ok: true, ...r }); }
  catch (e) { res.status(400).json({ erro: e.message }); }
});

app.get('/login', (req, res) => auth.estaConfigurado() ? page('login.html')(req, res) : res.redirect('/setup'));
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (bloqueado(ip)) return res.status(429).json({ erro: 'Muitas tentativas. Tente em 10 min.' });
  const { senha, codigo } = req.body;
  if (!auth.verificarSenha(senha) || !auth.verificarTotp(codigo)) { registrarFalha(ip); return res.status(401).json({ erro: 'Senha ou código inválido.' }); }
  limparFalhas(ip);
  setCookie(res, auth.criarToken(), req);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', 'zsess=; HttpOnly; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/me', (req, res) => res.json({ autenticado: auth.verificarToken(req.cookies.zsess) }));

// ---------- PORTÃO: tudo abaixo exige login ----------
app.use((req, res, next) => {
  if (!auth.estaConfigurado()) return res.redirect('/setup');
  if (auth.verificarToken(req.cookies.zsess)) return next();
  if (req.path.startsWith('/api') || req.path.startsWith('/fluxo') || req.path.startsWith('/vendas') || req.path.startsWith('/viabilidade'))
    return res.status(401).json({ erro: 'não autenticado' });
  return res.redirect('/login');
});

// ---------- MÓDULOS + SHELL (protegidos) ----------
app.use('/fluxo', fluxoApp);
if (vendasApp) app.use('/vendas', vendasApp);
if (viabApp) app.use('/viabilidade', viabApp);
app.use(express.static(PUBLIC));

const PORT = process.env.PORT || 5190;
app.listen(PORT, () => console.log(`ZAHAV rodando em http://localhost:${PORT} (login ${auth.estaConfigurado() ? 'configurado' : 'PENDENTE — abra /setup'})`));
