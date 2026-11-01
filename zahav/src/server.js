// ZAHAV — painel unificado ImovelUm, protegido por login + 2FA.
import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as auth from './auth.js';
import { DB_PATH as FLUXO_DB_PATH } from '../../fluxo-caixa/src/db.js';
import { DB_PATH as VENDAS_DB_PATH } from '../../vendas/src/db.js';
import { DB_PATH as VIAB_DB_PATH } from '../../viabilidade/src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dirname, '..', 'public');

// cada módulo exporta { app } (Express app sem listen quando montado aqui)
const { app: fluxoApp } = await import('../../fluxo-caixa/src/server.js');
let vendasApp = null, viabApp = null;
try { ({ app: vendasApp } = await import('../../vendas/src/server.js')); } catch (e) { console.warn('Vendas não montado:', e.message); }
try { ({ app: viabApp } = await import('../../viabilidade/src/server.js')); } catch (e) { console.warn('Viabilidade não montado:', e.message); }

const app = express();
app.set('trust proxy', true); // atrás de proxy (Cloudflare/Render): req.secure e req.ip ficam corretos
app.use(express.json({ limit: '30mb' })); // limite maior p/ a restauração (upload dos bancos em base64)

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

// ---------- RESTAURAÇÃO (seed inicial / backup-restore) — protegida por token ----------
// Ativa só quando RESTORE_TOKEN está definido (defina no Render durante o seed; remova depois).
const AUTH_PATH = process.env.AUTH_FILE || resolve(__dirname, '..', 'data', 'auth.json');
const RESTORE_TARGETS = { fluxo: FLUXO_DB_PATH, vendas: VENDAS_DB_PATH, viabilidade: VIAB_DB_PATH, auth: AUTH_PATH };
const RESTORE_TOKEN = process.env.RESTORE_TOKEN || '';
function restoreOk(t) {
  if (!RESTORE_TOKEN || !t) return false;
  const a = Buffer.from(String(t)), b = Buffer.from(RESTORE_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}
const RESTORE_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Restaurar dados · ZAHAV</title>
<style>body{margin:0;background:#0b1020;color:#cdd9ff;font:15px/1.5 system-ui,Segoe UI,Arial;display:grid;place-items:center;min-height:100vh}
.box{background:#121a33;border:1px solid #243154;border-radius:14px;padding:26px;max-width:460px;width:92%}
h1{font-size:19px;margin:0 0 4px;color:#D4AF37}p{color:#8ea0c8;margin:4px 0 16px;font-size:13px}
label{display:block;margin:12px 0 4px;font-size:13px}input[type=file]{width:100%;font-size:13px}
button{margin-top:20px;width:100%;padding:12px;border:0;border-radius:10px;background:#D4AF37;color:#1a1200;font-weight:700;font-size:15px;cursor:pointer}
button:disabled{opacity:.5;cursor:wait}.ok{color:#34d399}.err{color:#f87171}#msg{margin-top:14px;font-size:13px;min-height:18px}</style></head>
<body><div class="box"><h1>Restaurar dados do ZAHAV</h1>
<p>Envie os bancos atuais (e o login) para este servidor. Ao confirmar, o sistema grava e reinicia com seus dados.</p>
<label>fluxo.db (Fluxo de Caixa)</label><input type="file" id="fluxo" accept=".db">
<label>vendas.db (Vendas)</label><input type="file" id="vendas" accept=".db">
<label>viabilidade.db (Viabilidade)</label><input type="file" id="viabilidade" accept=".db">
<label>auth.json (login + 2FA) — opcional</label><input type="file" id="auth" accept=".json">
<button id="go">Restaurar e reiniciar</button><div id="msg"></div></div>
<script>
const qs=new URLSearchParams(location.search), token=qs.get('token');
const b64=f=>new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result.split(',')[1]||'');r.onerror=rej;r.readAsDataURL(f)});
document.getElementById('go').onclick=async()=>{
  const btn=document.getElementById('go'), msg=document.getElementById('msg');
  const payload={}; for(const k of ['fluxo','vendas','viabilidade','auth']){const el=document.getElementById(k); if(el.files[0]) payload[k]=await b64(el.files[0]);}
  if(!Object.keys(payload).length){msg.className='err';msg.textContent='Selecione ao menos um arquivo.';return;}
  btn.disabled=true; msg.className=''; msg.textContent='Enviando e gravando…';
  try{const r=await fetch('/api/restore?token='+encodeURIComponent(token),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
    const j=await r.json(); if(!r.ok) throw new Error(j.erro||'falhou');
    msg.className='ok'; msg.textContent='Restaurado: '+j.restaurados.join(', ')+'. Reiniciando… aguarde ~30s e acesse /login.';
  }catch(e){btn.disabled=false; msg.className='err'; msg.textContent='Erro: '+e.message;}
};
</script></body></html>`;
app.get('/restore', (req, res) => {
  if (!restoreOk(req.query.token)) return res.status(404).send('Not found');
  res.type('html').send(RESTORE_HTML);
});
app.post('/api/restore', (req, res) => {
  if (!restoreOk(req.query.token || (req.body && req.body.token))) return res.status(403).json({ erro: 'token inválido' });
  const b = req.body || {}, feitos = [];
  try {
    for (const k of ['fluxo', 'vendas', 'viabilidade', 'auth']) {
      if (!b[k]) continue;
      const p = RESTORE_TARGETS[k];
      writeFileSync(p, Buffer.from(b[k], 'base64'));
      for (const ext of ['-wal', '-shm']) { try { if (existsSync(p + ext)) unlinkSync(p + ext); } catch { /* ok */ } }
      feitos.push(k);
    }
  } catch (e) { return res.status(500).json({ erro: e.message }); }
  res.json({ ok: true, restaurados: feitos, reiniciando: true });
  setTimeout(() => process.exit(0), 800); // sai; o Render reinicia o serviço e reabre os dados restaurados
});

// ---------- BACKUP (download protegido por token) — alimenta o job diário off-site ----------
// Formato de saída = MESMO que /api/restore aceita, então um backup pode ser re-restaurado direto.
const BACKUP_TOKEN = process.env.BACKUP_TOKEN || '';
function backupOk(t) {
  if (!BACKUP_TOKEN || !t) return false;
  const a = Buffer.from(String(t)), b = Buffer.from(BACKUP_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}
function dumpDb(srcPath) {
  // VACUUM INTO: cópia consistente (inclui o WAL) sem travar o banco em uso; depois lê e apaga o temp.
  const tmp = srcPath + '.bak.tmp';
  for (const ext of ['', '-wal', '-shm']) { try { if (existsSync(tmp + ext)) unlinkSync(tmp + ext); } catch { /* ok */ } }
  const db = new DatabaseSync(srcPath, { readOnly: true });
  try { db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); } finally { db.close(); }
  const b64 = readFileSync(tmp).toString('base64');
  for (const ext of ['', '-wal', '-shm']) { try { if (existsSync(tmp + ext)) unlinkSync(tmp + ext); } catch { /* ok */ } }
  return b64;
}
app.get('/api/backup', (req, res) => {
  if (!backupOk(req.query.token)) return res.status(404).send('Not found');
  try {
    const out = { ts: new Date().toISOString() };
    out.fluxo = dumpDb(FLUXO_DB_PATH);
    out.vendas = dumpDb(VENDAS_DB_PATH);
    out.viabilidade = dumpDb(VIAB_DB_PATH);
    out.auth = existsSync(AUTH_PATH) ? readFileSync(AUTH_PATH).toString('base64') : null;
    res.json(out);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

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

// ---------- Notion sync agendado (roda na nuvem, só se NOTION_TOKEN estiver definido) ----------
if (process.env.NOTION_TOKEN) {
  try {
    const { runSync } = await import('../../fluxo-caixa/notion-sync.mjs');
    const everyMs = Math.max(60000, Number(process.env.NOTION_SYNC_MS) || 5 * 60 * 1000);
    let rodando = false;
    const tick = async () => {
      if (rodando) return; // nunca sobrepõe duas passadas
      rodando = true;
      try { await runSync(); } catch (e) { console.warn('[notion-sync] erro:', e.message); }
      finally { rodando = false; }
    };
    setTimeout(tick, 30000);     // primeira passada ~30s após o boot
    setInterval(tick, everyMs);  // depois a cada 5 min (padrão)
    console.log(`Notion sync ATIVO (a cada ${everyMs} ms).`);
  } catch (e) { console.warn('Notion sync não iniciou:', e.message); }
} else {
  console.log('Notion sync inativo (defina NOTION_TOKEN para ligar).');
}

const PORT = process.env.PORT || 5190;
app.listen(PORT, () => console.log(`ZAHAV rodando em http://localhost:${PORT} (login ${auth.estaConfigurado() ? 'configurado' : 'PENDENTE — abra /setup'})`));
