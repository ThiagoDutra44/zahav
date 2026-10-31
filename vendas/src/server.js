import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync, readdirSync, rmSync, readFileSync, statSync } from 'node:fs';
import { openDb, DB_PATH, SCHEMA, FUNIL, PERDIDOS, DESISTENCIA, STATUS_FECHADO, CALORES } from './db.js';
import { abrirFluxo, ponteAtiva, sincronizarVenda, removerVenda, sincronizarTudo, limparTudo, statusPonte } from './ponte.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = openDb();
db.exec(SCHEMA); // garante tabelas mesmo sem seed
// próxima sexta-feira a partir de hoje (inclui hoje se hoje for sexta)
const proximaSextaISO = () => {
  const t = new Date(); const dd = (5 - t.getDay() + 7) % 7;
  const f = new Date(t); f.setDate(t.getDate() + dd);
  const p = (n) => String(n).padStart(2, '0');
  return `${f.getFullYear()}-${p(f.getMonth() + 1)}-${p(f.getDate())}`;  // local, não UTC
};
// migração: colunas de recebimento + segmento em bancos antigos
const colunas = db.prepare('PRAGMA table_info(vendas)').all().map((c) => c.name);
if (!colunas.includes('data_recebimento')) db.exec('ALTER TABLE vendas ADD COLUMN data_recebimento TEXT');
if (!colunas.includes('recebido')) db.exec('ALTER TABLE vendas ADD COLUMN recebido INTEGER NOT NULL DEFAULT 0');
if (!colunas.includes('data_recebido')) db.exec('ALTER TABLE vendas ADD COLUMN data_recebido TEXT');
if (!colunas.includes('segmento')) db.exec("ALTER TABLE vendas ADD COLUMN segmento TEXT NOT NULL DEFAULT 'venda'");
if (!colunas.includes('administra')) db.exec('ALTER TABLE vendas ADD COLUMN administra INTEGER NOT NULL DEFAULT 0');
if (!colunas.includes('taxa_adm')) db.exec('ALTER TABLE vendas ADD COLUMN taxa_adm REAL NOT NULL DEFAULT 0');
if (!colunas.includes('valor_recebido')) db.exec('ALTER TABLE vendas ADD COLUMN valor_recebido REAL NOT NULL DEFAULT 0');
if (!colunas.includes('prever_caixa')) db.exec('ALTER TABLE vendas ADD COLUMN prever_caixa INTEGER NOT NULL DEFAULT 1');
if (!colunas.includes('fora_caixa')) db.exec('ALTER TABLE vendas ADD COLUMN fora_caixa INTEGER NOT NULL DEFAULT 0');
if (!colunas.includes('motivo')) db.exec('ALTER TABLE vendas ADD COLUMN motivo TEXT');
// bolinha AZUL: previsão de faturamento (NÃO vai pro caixa). Exclusiva com prever_caixa (vermelha).
if (!colunas.includes('prever_fat')) db.exec('ALTER TABLE vendas ADD COLUMN prever_fat INTEGER NOT NULL DEFAULT 0');
db.exec('CREATE INDEX IF NOT EXISTS idx_vendas_segmento ON vendas(segmento)');
// migração: metas passam a ter chave (ano, segmento)
const metaCols = db.prepare('PRAGMA table_info(metas)').all().map((c) => c.name);
if (!metaCols.includes('segmento')) {
  db.exec(`CREATE TABLE metas_new (ano INTEGER NOT NULL, segmento TEXT NOT NULL DEFAULT 'venda',
    meta_vgv REAL NOT NULL DEFAULT 0, meta_fat REAL NOT NULL DEFAULT 0, PRIMARY KEY (ano, segmento));
    INSERT INTO metas_new (ano, segmento, meta_vgv, meta_fat) SELECT ano, 'venda', meta_vgv, meta_fat FROM metas;
    DROP TABLE metas; ALTER TABLE metas_new RENAME TO metas;`);
}
// NÃO reescrevemos datas de recebimento escolhidas pelo usuário. A única regra de data é a de
// dia útil (feriado/sábado/domingo), aplicada no fluxo-caixa. Datas ficam como o usuário definiu;
// mudanças feitas na tela de Vendas sincronizam sozinhas com o caixa pela ponte (sincronizarVenda).
abrirFluxo(); // liga a ponte com o fluxo-caixa (se o banco existir)

const PUBLIC = resolve(__dirname, '..', 'public');
const app = express();
app.use(express.json());
// assets (html/js/css) sempre revalidados — o navegador pega a versão nova sem precisar de Ctrl+F5
app.use((req, res, next) => {
  if (req.method === 'GET' && /(^\/$|\.(?:js|css|html)$)/.test(req.path)) res.set('Cache-Control', 'no-cache');
  next();
});
app.get(['/', '/index.html'], (req, res) => {
  const base = (req.baseUrl || '') + '/';
  // ?v=<mtime> nos assets: cada alteração vira URL nova, o navegador busca a versão fresca (mata o cache do iframe)
  const ver = (f) => { try { return Math.floor(statSync(resolve(PUBLIC, f)).mtimeMs).toString(36); } catch { return ''; } };
  const html = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8')
    .replace('<head>', `<head>\n  <base href="${base}">`)
    .replace('href="styles.css"', `href="styles.css?v=${ver('styles.css')}"`)
    .replace('src="app.js"', `src="app.js?v=${ver('app.js')}"`);
  res.type('html').send(html);
});
app.use(express.static(PUBLIC));

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
// data LOCAL (nunca toISOString: em UTC-3 o dia "virava" às 21h)
const hojeISO = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const anoDe = (req) => parseInt(req.query.ano) || new Date().getFullYear();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
// faturamento = vgv * margem% ; mantém os dois coerentes
const calcFaturamento = (vgv, margem) => +(num(vgv) * num(margem) / 100).toFixed(2);
// segmento (venda | locacao) — mesma estrutura, dados separados
const segDe = (req) => (((req.query && req.query.segmento) || (req.body && req.body.segmento)) === 'locacao' ? 'locacao' : 'venda');
// receitas marginais de uma venda (para a ponte espelhar no fluxo-caixa)
const margDe = (id) => db.prepare('SELECT * FROM receitas_marginais WHERE venda_id=?').all(id);
// parcelas da comissão (quando a comissão entra em 2+ momentos) — ordenadas pela data
const parcDe = (id) => db.prepare('SELECT * FROM comissao_parcelas WHERE venda_id=? ORDER BY COALESCE(data_prevista, data_recebido, \'9999\'), id').all(id);
// re-espelha a venda no fluxo-caixa (após mexer nas marginais/parcelas)
const resyncVenda = (id) => { const v = db.prepare('SELECT * FROM vendas WHERE id=?').get(id); if (v) sincronizarVenda(v, margDe(id), parcDe(id)); };

// ---------- META (listas de apoio para a UI) ----------
app.get('/api/meta', (req, res) => {
  const seg = segDe(req);
  const cad = (tipo) => db.prepare('SELECT nome FROM cadastros WHERE tipo=? AND ativo=1 ORDER BY nome').all(tipo).map((r) => r.nome);
  const anos = db.prepare('SELECT DISTINCT ano FROM vendas WHERE segmento=? ORDER BY ano DESC').all(seg).map((r) => r.ano);
  if (!anos.includes(new Date().getFullYear())) anos.unshift(new Date().getFullYear());
  res.json({
    hoje: hojeISO(),
    segmento: seg,
    anos,
    funil: FUNIL,
    perdidos: PERDIDOS,
    desistencia: DESISTENCIA,
    status_fechado: STATUS_FECHADO,
    calores: CALORES,
    gerentes: cad('gerente'),
    corretores: cad('corretor'),
    opcionistas: cad('opcionista'),
    filiais: cad('filial'),
  });
});

// ---------- VENDAS: listar (com filtros) ----------
app.get('/api/vendas', (req, res) => {
  const ano = anoDe(req);
  // canceladas (desistências) saem da planilha — vivem no relatório apartado (/api/desistencias)
  const cond = ['ano=?', 'segmento=?', 'status!=?'];
  const params = [ano, segDe(req), DESISTENCIA];
  if (req.query.status) { cond.push('status=?'); params.push(String(req.query.status).toUpperCase()); }
  if (req.query.corretor) { cond.push('corretor=?'); params.push(String(req.query.corretor).toUpperCase()); }
  if (req.query.filial) { cond.push('filial=?'); params.push(String(req.query.filial).toUpperCase()); }
  if (req.query.mes) { cond.push('mes=?'); params.push(parseInt(req.query.mes)); }
  const rows = db.prepare(`SELECT *,
      (SELECT COUNT(*) FROM comissao_parcelas cp WHERE cp.venda_id = vendas.id) parcelas_qtd,
      (SELECT COUNT(*) FROM comissao_parcelas cp WHERE cp.venda_id = vendas.id AND cp.recebido = 1) parcelas_rec
    FROM vendas WHERE ${cond.join(' AND ')} ORDER BY mes, id`).all(...params);
  res.json(rows);
});

// ---------- VENDAS: criar ----------
app.post('/api/vendas', (req, res) => {
  const b = req.body || {};
  if (!b.cliente) return res.status(400).json({ erro: 'cliente é obrigatório' });
  const ano = parseInt(b.ano) || new Date().getFullYear();
  const mes = Math.min(12, Math.max(1, parseInt(b.mes) || (new Date().getMonth() + 1)));
  const vgv = num(b.vgv);
  const margem = num(b.margem_pct);
  const fat = b.faturamento != null && !b.margem_pct ? num(b.faturamento) : calcFaturamento(vgv, margem);
  const up = (s) => (s ? String(s).toUpperCase() : null);
  const dataReceb = b.data_recebimento || proximaSextaISO();
  const administra = b.administra ? 1 : 0;
  const info = db.prepare(`INSERT INTO vendas
    (ano, mes, data, cliente, produto, filial, corretor, opcionista, gerente,
     vgv, margem_pct, faturamento, status, motivo, mapa_calor, segmento, administra, taxa_adm, data_recebimento, prever_caixa, livro)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 0, 'imovelum')`).run(
    ano, mes, b.data || null, b.cliente, b.produto || null, up(b.filial), up(b.corretor),
    up(b.opcionista), up(b.gerente), vgv, margem, fat,
    up(b.status) || 'INTERESSE', b.motivo ? String(b.motivo).trim() || null : null, up(b.mapa_calor), segDe(req), administra, administra ? num(b.taxa_adm) : 0, dataReceb);
  const nova = db.prepare('SELECT * FROM vendas WHERE id=?').get(info.lastInsertRowid);
  sincronizarVenda(nova, margDe(nova.id), parcDe(nova.id)); // ponte ao vivo
  res.json(nova);
});

// ---------- VENDAS: atualizar ----------
app.put('/api/vendas/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM vendas WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ erro: 'não encontrada' });
  const m = { ...cur, ...req.body };
  const up = (s) => (s ? String(s).toUpperCase() : null);
  const vgv = num(m.vgv);
  const margem = num(m.margem_pct);
  // se mexeu em vgv ou margem, recalcula faturamento; senão respeita o enviado
  const fat = ('vgv' in req.body || 'margem_pct' in req.body) ? calcFaturamento(vgv, margem) : num(m.faturamento);
  const administra = m.administra ? 1 : 0;
  let prever = m.prever_caixa === 0 || m.prever_caixa === '0' ? 0 : (m.prever_caixa ? 1 : 0);
  let preverFat = m.prever_fat === 0 || m.prever_fat === '0' ? 0 : (m.prever_fat ? 1 : 0);
  const foraCaixa = m.fora_caixa ? 1 : 0;
  const recebido = m.recebido ? 1 : 0;
  // AZUL (previsão) e VERMELHA (caixa) são exclusivas; o campo que veio no body vence o outro
  if (prever && preverFat) { if ('prever_caixa' in req.body) preverFat = 0; else prever = 0; }
  // venda feita (assinada/recebida) zera a previsão azul (vira verde na tela)
  if (recebido || up(m.status) === 'ASSINADA') preverFat = 0;
  // total que entrou: o informado, ou a própria comissão se recebido sem valor; 0 se não recebido
  const valorRecebido = recebido ? (num(m.valor_recebido) || fat) : 0;
  db.prepare(`UPDATE vendas SET ano=?, mes=?, data=?, cliente=?, produto=?, filial=?, corretor=?,
      opcionista=?, gerente=?, vgv=?, margem_pct=?, faturamento=?, status=?, motivo=?, mapa_calor=?, administra=?, taxa_adm=?, prever_caixa=?, prever_fat=?, fora_caixa=?, data_recebimento=?, recebido=?, data_recebido=?, valor_recebido=? WHERE id=?`).run(
    parseInt(m.ano), parseInt(m.mes), m.data || null, m.cliente, m.produto || null, up(m.filial),
    up(m.corretor), up(m.opcionista), up(m.gerente), vgv, margem, fat,
    up(m.status), m.motivo != null ? String(m.motivo).trim() || null : null, up(m.mapa_calor), administra, administra ? num(m.taxa_adm) : 0, prever, preverFat, foraCaixa, m.data_recebimento || null, recebido, m.data_recebido || null, valorRecebido, cur.id);
  const atualizada = db.prepare('SELECT * FROM vendas WHERE id=?').get(cur.id);
  sincronizarVenda(atualizada, margDe(atualizada.id), parcDe(atualizada.id)); // ponte ao vivo
  res.json(atualizada);
});

// ---------- VENDAS: mudar status (avançar/retroceder no funil) ----------
app.put('/api/vendas/:id/status', (req, res) => {
  const cur = db.prepare('SELECT * FROM vendas WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ erro: 'não encontrada' });
  const status = String(req.body.status || '').toUpperCase();
  if (![...FUNIL, ...PERDIDOS, DESISTENCIA].includes(status)) return res.status(400).json({ erro: 'status inválido' });
  // ao cancelar pode vir o motivo junto; ao reverter, limpa o motivo
  const motivo = status === DESISTENCIA ? (String(req.body.motivo || '').trim() || null) : null;
  db.prepare('UPDATE vendas SET status=?, motivo=? WHERE id=?').run(status, motivo, cur.id);
  const atualizada = db.prepare('SELECT * FROM vendas WHERE id=?').get(cur.id);
  sincronizarVenda(atualizada, margDe(atualizada.id), parcDe(atualizada.id)); // ponte ao vivo
  res.json(atualizada);
});

// ---------- VENDAS: confirmar recebimento em lote (ex.: meses antigos já recebidos) ----------
app.post('/api/vendas/confirmar-lote', (req, res) => {
  const seg = segDe(req);
  const ano = parseInt(req.body.ano) || new Date().getFullYear();
  const mesAte = Math.min(12, Math.max(1, parseInt(req.body.mes_ate) || 12));
  const foraCaixa = req.body.fora_caixa ? 1 : 0;
  // não toca em vendas com comissão parcelada (o recebimento delas é gerido pelas parcelas)
  const alvo = db.prepare(`SELECT * FROM vendas WHERE segmento=? AND ano=? AND mes<=? AND status='ASSINADA' AND recebido=0
    AND NOT EXISTS (SELECT 1 FROM comissao_parcelas cp WHERE cp.venda_id = vendas.id)`).all(seg, ano, mesAte);
  const upd = db.prepare('UPDATE vendas SET recebido=1, data_recebido=?, valor_recebido=faturamento, fora_caixa=? WHERE id=?');
  for (const v of alvo) {
    const data = `${v.ano}-${String(v.mes).padStart(2, '0')}-28`; // recebido dentro do mês da venda
    upd.run(data, foraCaixa, v.id);
    sincronizarVenda(db.prepare('SELECT * FROM vendas WHERE id=?').get(v.id), margDe(v.id), parcDe(v.id)); // ponte ao vivo (remove espelho se fora_caixa)
  }
  res.json({ ok: true, confirmadas: alvo.length, fora_caixa: !!foraCaixa });
});

// ---------- DESISTÊNCIAS (propostas canceladas — relatório apartado) ----------
app.get('/api/desistencias', (req, res) => {
  const ano = anoDe(req);
  const rows = db.prepare(`SELECT * FROM vendas WHERE ano=? AND segmento=? AND status=? ORDER BY mes, id`)
    .all(ano, segDe(req), DESISTENCIA);
  res.json(rows);
});

// ---------- VENDAS: excluir ----------
app.delete('/api/vendas/:id', (req, res) => {
  db.prepare('DELETE FROM receitas_marginais WHERE venda_id=?').run(req.params.id); // leva junto as marginais
  db.prepare('DELETE FROM comissao_parcelas WHERE venda_id=?').run(req.params.id);  // e as parcelas da comissão
  db.prepare('DELETE FROM vendas WHERE id=?').run(req.params.id);
  removerVenda(req.params.id); // ponte ao vivo
  res.json({ ok: true });
});

// ---------- RECEITAS MARGINAIS (extras da venda: premiação, comissão financiamento, etc.) ----------
app.get('/api/vendas/:id/marginais', (req, res) => {
  res.json(db.prepare('SELECT * FROM receitas_marginais WHERE venda_id=? ORDER BY id').all(req.params.id));
});
// substitui TODAS as marginais da venda (usado ao salvar a ficha)
app.put('/api/vendas/:id/marginais', (req, res) => {
  const vid = req.params.id;
  if (!db.prepare('SELECT 1 FROM vendas WHERE id=?').get(vid)) return res.status(404).json({ erro: 'venda não encontrada' });
  const itens = Array.isArray(req.body) ? req.body : (req.body.itens || []);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM receitas_marginais WHERE venda_id=?').run(vid);
    const ins = db.prepare('INSERT INTO receitas_marginais (venda_id, tipo, valor, data_prevista, recebido, data_recebido) VALUES (?,?,?,?,?,?)');
    for (const m of itens) {
      if (!num(m.valor)) continue; // ignora linha vazia/sem valor
      ins.run(vid, (m.tipo || '').trim() || null, num(m.valor), m.data_prevista || null, m.recebido ? 1 : 0, m.recebido ? (m.data_recebido || null) : null);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ erro: String(e) }); }
  resyncVenda(vid); // espelha as marginais no fluxo-caixa
  res.json(db.prepare('SELECT * FROM receitas_marginais WHERE venda_id=? ORDER BY id').all(vid));
});
// atualiza UMA marginal (edição inline nos Recebíveis: data, recebido)
app.put('/api/marginais/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM receitas_marginais WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ erro: 'não encontrada' });
  const m = { ...cur, ...req.body };
  const recebido = m.recebido ? 1 : 0;
  db.prepare('UPDATE receitas_marginais SET tipo=?, valor=?, data_prevista=?, recebido=?, data_recebido=? WHERE id=?')
    .run((m.tipo || '').trim() || null, num(m.valor), m.data_prevista || null, recebido, recebido ? (m.data_recebido || null) : null, cur.id);
  resyncVenda(cur.venda_id); // espelha no fluxo-caixa
  res.json(db.prepare('SELECT * FROM receitas_marginais WHERE id=?').get(cur.id));
});
app.delete('/api/marginais/:id', (req, res) => {
  const cur = db.prepare('SELECT venda_id FROM receitas_marginais WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM receitas_marginais WHERE id=?').run(req.params.id);
  if (cur) resyncVenda(cur.venda_id); // tira do fluxo-caixa
  res.json({ ok: true });
});

// ---------- PARCELAS DA COMISSÃO (comissão recebida em 2+ momentos) ----------
app.get('/api/vendas/:id/parcelas', (req, res) => res.json(parcDe(req.params.id)));

// deriva o recebido/valor da VENDA a partir das parcelas: a venda só é "recebida" quando TODAS entraram
function derivarRecebimento(vid) {
  const ps = db.prepare('SELECT valor, recebido, data_recebido FROM comissao_parcelas WHERE venda_id=?').all(vid);
  if (!ps.length) return; // sem parcelas: mantém o recebimento único como está
  const todasRec = ps.every((p) => p.recebido);
  const recebidas = ps.filter((p) => p.recebido);
  const ultimaData = recebidas.map((p) => p.data_recebido).filter(Boolean).sort().pop() || null;
  const somaReceb = recebidas.reduce((s, p) => s + (Number(p.valor) || 0), 0);
  db.prepare('UPDATE vendas SET recebido=?, data_recebido=?, valor_recebido=? WHERE id=?')
    .run(todasRec ? 1 : 0, todasRec ? ultimaData : null, todasRec ? somaReceb : 0, vid);
}

// substitui TODAS as parcelas da venda (usado ao salvar a ficha)
app.put('/api/vendas/:id/parcelas', (req, res) => {
  const vid = Number(req.params.id);
  const v = db.prepare('SELECT * FROM vendas WHERE id=?').get(vid);
  if (!v) return res.status(404).json({ erro: 'venda não encontrada' });
  const arr = Array.isArray(req.body) ? req.body : [];
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM comissao_parcelas WHERE venda_id=?').run(vid);
    const ins = db.prepare('INSERT INTO comissao_parcelas (venda_id, valor, data_prevista, recebido, data_recebido) VALUES (?,?,?,?,?)');
    for (const p of arr) {
      const val = num(p.valor);
      if (val <= 0) continue;
      const rec = p.recebido ? 1 : 0;
      ins.run(vid, val, p.data_prevista || null, rec, rec ? (p.data_recebido || null) : null);
    }
    derivarRecebimento(vid);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ erro: String(e) }); }
  resyncVenda(vid); // espelha as parcelas no fluxo-caixa
  res.json(parcDe(vid));
});
// atualiza UMA parcela (edição inline nos Recebíveis: data, recebido)
app.put('/api/parcelas/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM comissao_parcelas WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ erro: 'não encontrada' });
  const m = { ...cur, ...req.body };
  const rec = m.recebido ? 1 : 0;
  db.prepare('UPDATE comissao_parcelas SET valor=?, data_prevista=?, recebido=?, data_recebido=? WHERE id=?')
    .run(num(m.valor), m.data_prevista || null, rec, rec ? (m.data_recebido || null) : null, cur.id);
  derivarRecebimento(cur.venda_id);
  resyncVenda(cur.venda_id);
  res.json(db.prepare('SELECT * FROM comissao_parcelas WHERE id=?').get(cur.id));
});

// ---------- PONTE com o Fluxo de Caixa ----------
app.get('/api/ponte/status', (req, res) => res.json(statusPonte()));
app.post('/api/ponte/sincronizar', (req, res) => {
  if (!ponteAtiva()) return res.status(400).json({ erro: 'ponte inativa (fluxo.db não encontrado)' });
  const todas = db.prepare('SELECT * FROM vendas').all();
  const n = sincronizarTudo(todas, margDe, parcDe);
  res.json({ ok: true, sincronizadas: n, ...statusPonte() });
});
app.delete('/api/ponte/limpar', (req, res) => {
  if (!ponteAtiva()) return res.status(400).json({ erro: 'ponte inativa' });
  const removidos = limparTudo();
  res.json({ ok: true, removidos });
});

// ---------- RECEBÍVEIS (previsão de entrada do faturamento por janela de semana) ----------
const addDiasISO = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// segunda-feira da semana que contém `iso`
const segDaSemana = (iso) => { const d = new Date(iso + 'T00:00:00Z'); const wd = (d.getUTCDay() + 6) % 7; return addDiasISO(iso, -wd); };
app.get('/api/recebiveis', (req, res) => {
  const ano = anoDe(req);
  const ref = req.query.ref || hojeISO();
  const seg0 = segDaSemana(ref);
  const dom0 = addDiasISO(seg0, 6);          // domingo desta semana
  const dom1 = addDiasISO(seg0, 13);          // fim da próxima
  const dom2 = addDiasISO(seg0, 20);          // fim da seguinte
  // data efetiva: se já recebido, usa a data real; senão a previsão
  const efetiva = (v) => (v.recebido && v.data_recebido) ? v.data_recebido : (v.data_recebimento || `${v.ano}-${String(v.mes).padStart(2, '0')}-15`);
  const vendas = db.prepare(`SELECT id, cliente, produto, filial, corretor, status, mapa_calor, faturamento, vgv, mes, ano, data, data_recebimento, recebido, data_recebido, valor_recebido, prever_caixa
    FROM vendas WHERE ano=? AND segmento=? AND status!=? AND faturamento > 0`).all(ano, segDe(req), DESISTENCIA);
  const bucketDe = (d) => (d < seg0 ? 0 : d <= dom0 ? 1 : d <= dom1 ? 2 : d <= dom2 ? 3 : 4);
  const buckets = [
    { chave: 'anterior', label: 'Anterior', de: null, ate: addDiasISO(seg0, -1) },
    { chave: 'esta', label: 'Esta semana', de: seg0, ate: dom0 },
    { chave: 'proxima', label: 'Próxima semana', de: addDiasISO(seg0, 7), ate: dom1 },
    { chave: 'seguinte', label: 'Semana seguinte', de: addDiasISO(seg0, 14), ate: dom2 },
    { chave: 'adiante', label: 'Mais à frente', de: addDiasISO(seg0, 21), ate: null },
  ].map((b) => ({ ...b, recebido: 0, confirmado: 0, potencial: 0, pot_quente: 0, pot_outro: 0, entrada: 0, repasse: 0, marginal_prev: 0, marginal_rec: 0, qtd: 0, itens: [] }));
  const classifica = (bkt, valor, recebido, confirmada, quente, entrada, repasse) => {
    bkt.qtd++;
    if (recebido) { bkt.recebido += valor; bkt.entrada += entrada; bkt.repasse += repasse; } // comissão (nossa) + caixa total
    else if (confirmada) bkt.confirmado += valor; // firme, a receber
    else { bkt.potencial += valor; if (quente) bkt.pot_quente += valor; else bkt.pot_outro += valor; } // aberto: só QUENTE prevê
  };
  for (const v of vendas) {
    const confirmada = v.status === STATUS_FECHADO;
    const quente = v.mapa_calor === 'QUENTE' && v.prever_caixa; // conta na previsão só se quente E habilitada
    const parcelas = parcDe(v.id).filter((p) => Number(p.valor) > 0);
    if (parcelas.length) {
      // comissão em parcelas: cada uma entra na sua data/bucket (a soma fecha o faturamento)
      parcelas.forEach((p, idx) => {
        const rec = !!p.recebido;
        const d = (rec && p.data_recebido) ? p.data_recebido : (p.data_prevista || `${v.ano}-${String(v.mes).padStart(2, '0')}-15`);
        const i = bucketDe(d);
        buckets[i].itens.push({ ...v, faturamento: p.valor, data_efetiva: d, recebido: rec, confirmada, quente, entrada: rec ? p.valor : 0, repasse: 0, parcela_id: p.id, parcela: `${idx + 1}/${parcelas.length}` });
        classifica(buckets[i], p.valor, rec, confirmada, quente, rec ? p.valor : 0, 0);
      });
      continue;
    }
    const d = efetiva(v);
    const i = bucketDe(d);
    const recebido = !!v.recebido;
    const entrada = recebido ? (v.valor_recebido || v.faturamento) : 0; // total que caiu na conta
    const repasse = Math.max(0, entrada - v.faturamento);               // parte de terceiros (sai depois)
    buckets[i].itens.push({ ...v, data_efetiva: d, recebido, confirmada, quente, entrada, repasse });
    classifica(buckets[i], v.faturamento, recebido, confirmada, quente, entrada, repasse);
  }
  // receitas marginais (extras): entram na esteira pela data prevista, separadas da comissão
  const margs = db.prepare(`SELECT rm.id, rm.venda_id, rm.tipo, rm.valor, rm.data_prevista, rm.recebido, rm.data_recebido,
      v.cliente, v.produto, v.filial, v.status
    FROM receitas_marginais rm JOIN vendas v ON v.id = rm.venda_id
    WHERE v.ano=? AND v.segmento=? AND v.status!=?`).all(ano, segDe(req), DESISTENCIA);
  for (const m of margs) {
    const d = (m.recebido && m.data_recebido) ? m.data_recebido : (m.data_prevista || `${ano}-01-15`);
    const i = bucketDe(d);
    const recebido = !!m.recebido;
    buckets[i].itens.push({ marginal: true, id: m.id, venda_id: m.venda_id, tipo: m.tipo || 'Receita marginal',
      cliente: m.cliente, produto: m.produto, filial: m.filial, status: m.status, faturamento: m.valor,
      valor: m.valor, data_efetiva: d, recebido });
    if (recebido) buckets[i].marginal_rec += m.valor; else buckets[i].marginal_prev += m.valor;
  }
  buckets.forEach((b) => b.itens.sort((a, c) => (a.data_efetiva < c.data_efetiva ? -1 : 1)));
  const futuros = buckets.filter((b) => b.chave !== 'anterior');
  res.json({
    ref, seg0,
    total_recebido: buckets.reduce((a, b) => a + b.recebido, 0),
    total_entrada: buckets.reduce((a, b) => a + b.entrada, 0),
    total_repasse: buckets.reduce((a, b) => a + b.repasse, 0),
    total_confirmado: futuros.reduce((a, b) => a + b.confirmado, 0),
    total_potencial: futuros.reduce((a, b) => a + b.potencial, 0),
    total_pot_quente: futuros.reduce((a, b) => a + b.pot_quente, 0),
    total_pot_outro: futuros.reduce((a, b) => a + b.pot_outro, 0),
    total_marginal_prev: futuros.reduce((a, b) => a + b.marginal_prev, 0),
    total_marginal_rec: buckets.reduce((a, b) => a + b.marginal_rec, 0),
    anterior_confirmado: buckets[0].confirmado,
    anterior_potencial: buckets[0].potencial,
    buckets,
  });
});

// ---------- DASHBOARD (reproduz a aba DASHBOARD 2026 da planilha) ----------
const mediana = (arr) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y), m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
app.get('/api/dashboard', (req, res) => {
  const ano = anoDe(req);
  const seg = segDe(req);
  const meta = db.prepare('SELECT meta_vgv, meta_fat FROM metas WHERE ano=? AND segmento=?').get(ano, seg) || { meta_vgv: 0, meta_fat: 0 };
  // faturamento = comissão da venda + receitas marginais (a receber/recebidas), atribuídas ao mês da venda
  const assinadas = db.prepare(`SELECT v.vgv,
      v.faturamento + COALESCE((SELECT SUM(valor) FROM receitas_marginais m WHERE m.venda_id=v.id),0) AS faturamento,
      v.filial, v.mes
    FROM vendas v WHERE v.ano=? AND v.segmento=? AND v.status=?`).all(ano, seg, STATUS_FECHADO);
  const vgvArr = assinadas.map((v) => v.vgv);
  const fatArr = assinadas.map((v) => v.faturamento);
  const soma = (a) => a.reduce((x, y) => x + y, 0);
  const vgvTotal = soma(vgvArr), fatTotal = soma(fatArr), qtd = assinadas.length;

  // tempo decorrido no ano (base 365 dias)
  const hoje = new Date();
  const isCurrent = ano === hoje.getFullYear();
  const DIAS_ANO = 365;
  const inicio = Date.UTC(ano, 0, 1);
  const diasDecorridos = isCurrent
    ? Math.min(DIAS_ANO, Math.floor((Date.UTC(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()) - inicio) / 86400000) + 1)
    : DIAS_ANO;
  const diasRestantes = Math.max(1, DIAS_ANO - diasDecorridos);
  const mesesDecorridos = diasDecorridos / DIAS_ANO * 12;
  const mesesRestantes = Math.max(0.1, 12 - mesesDecorridos);
  const fracAno = diasDecorridos / DIAS_ANO;

  // CADÊNCIA DE VENDAS: 1 venda a cada X dias (ano todo e últimos 3 meses)
  const refM = isCurrent ? (hoje.getMonth() + 1) : 12;
  const mesIni = Math.max(1, refM - 2);
  const qtd3 = assinadas.filter((v) => v.mes >= mesIni && v.mes <= refM).length;
  const janIni = Date.UTC(ano, mesIni - 1, 1);
  const fimRef = isCurrent ? Date.UTC(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()) : Date.UTC(ano, refM, 0);
  const dias3 = Math.max(1, Math.floor((fimRef - janIni) / 86400000) + 1);
  const cadencia = {
    ano: { qtd, dias: diasDecorridos, por_venda: qtd ? +(diasDecorridos / qtd).toFixed(1) : 0 },
    tri: { qtd: qtd3, dias: dias3, por_venda: qtd3 ? +(dias3 / qtd3).toFixed(1) : 0, de: mesIni, ate: refM },
  };

  // pipeline (funil ativo, não assinado nem perdido)
  const ativos = FUNIL.filter((s) => s !== STATUS_FECHADO);
  const ph = ativos.map(() => '?').join(',');
  const pipe = db.prepare(`SELECT COALESCE(SUM(vgv),0) vgv, COALESCE(SUM(faturamento),0) fat, COUNT(*) qtd
    FROM vendas WHERE ano=? AND segmento=? AND status IN (${ph})`).get(ano, seg, ...ativos);

  // por mês (realizado — do segmento atual)
  const byMes = {};
  for (const v of assinadas) { (byMes[v.mes] = byMes[v.mes] || { vgv: 0, fat: 0, qtd: 0 }); byMes[v.mes].vgv += v.vgv; byMes[v.mes].fat += v.faturamento; byMes[v.mes].qtd++; }
  // faturamento CONSOLIDADO por mês: TODOS os segmentos (vendas + locações) assinados + receita marginal
  const consolMes = db.prepare(`SELECT v.mes,
      COALESCE(SUM(v.faturamento + COALESCE((SELECT SUM(valor) FROM receitas_marginais m WHERE m.venda_id=v.id),0)),0) fat
    FROM vendas v WHERE v.ano=? AND v.status=? GROUP BY v.mes`).all(ano, STATUS_FECHADO);
  const byMesConsol = {}; consolMes.forEach((r) => (byMesConsol[r.mes] = r.fat));
  const por_mes = MESES.map((nome, i) => { const r = byMes[i + 1] || {}; return { mes: i + 1, nome, vgv: r.vgv || 0, fat: r.fat || 0, fat_consol: byMesConsol[i + 1] || 0, qtd: r.qtd || 0 }; });

  // por filial (realizado) com todas as métricas da planilha
  const byFil = {};
  for (const v of assinadas) { const f = v.filial || '—'; (byFil[f] = byFil[f] || { vgv: 0, fat: 0, u: 0 }); byFil[f].vgv += v.vgv; byFil[f].fat += v.faturamento; byFil[f].u++; }
  const por_filial = Object.entries(byFil).map(([nome, x]) => ({
    nome, vgv: x.vgv, fat: x.fat, unidades: x.u,
    margem: x.vgv ? +(x.fat / x.vgv * 100).toFixed(2) : 0,
    vgv_mes: Math.round(x.vgv / mesesDecorridos),
    fat_mes: Math.round(x.fat / mesesDecorridos),
    ticket: x.u ? Math.round(x.vgv / x.u) : 0,
    pct: vgvTotal ? +(x.vgv / vgvTotal * 100).toFixed(1) : 0,
  })).sort((a, b) => b.vgv - a.vgv);

  // funil (contagem e VGV por etapa)
  const funilRows = db.prepare('SELECT status, COUNT(*) qtd, COALESCE(SUM(vgv),0) vgv FROM vendas WHERE ano=? AND segmento=? GROUP BY status').all(ano, seg);
  const byStatus = {}; funilRows.forEach((r) => (byStatus[r.status] = r));
  const funil = FUNIL.map((s) => ({ status: s, qtd: byStatus[s]?.qtd || 0, vgv: byStatus[s]?.vgv || 0 }));

  // ===== CONSOLIDADO (TODOS os segmentos) — faturamento REAL do ano, igual ao Funil e ao Cash Flow.
  // Usado nos KPIs de topo de faturamento; o resto do dashboard segue por segmento.
  const assAll = db.prepare(`SELECT v.vgv,
      v.faturamento + COALESCE((SELECT SUM(valor) FROM receitas_marginais m WHERE m.venda_id=v.id),0) AS fat
    FROM vendas v WHERE v.ano=? AND v.status=?`).all(ano, STATUS_FECHADO);
  const vgvC = soma(assAll.map((v) => v.vgv)), fatC = soma(assAll.map((v) => v.fat)), qtdC = assAll.length;
  const metaC = db.prepare('SELECT COALESCE(SUM(meta_vgv),0) meta_vgv, COALESCE(SUM(meta_fat),0) meta_fat FROM metas WHERE ano=?').get(ano) || { meta_vgv: 0, meta_fat: 0 };
  const fatMesNecC = Math.max(0, metaC.meta_fat - fatC) / mesesRestantes;
  const fatDiaNecC = Math.max(0, metaC.meta_fat - fatC) / diasRestantes;
  const margFracC = vgvC > 0 ? fatC / vgvC : (metaC.meta_vgv > 0 ? metaC.meta_fat / metaC.meta_vgv : 0);
  // plano "de hoje até dezembro" — RITMO IGUAL: divido o que falta para a meta (gap) por igual
  // pelos meses do calendário que ainda restam (inclui o mês corrente). Cada mês precisa dessa
  // mesma cota de faturamento NOVO. O que o mês corrente já faturou (mes_ja) já está no total
  // do ano; é adiantado e NÃO abate a cota (senão o plano fecharia abaixo da meta).
  const mesAtual = isCurrent ? (hoje.getMonth() + 1) : (ano > hoje.getFullYear() ? 1 : 13);
  const mesesRestCal = Math.max(0, 12 - mesAtual + 1);
  const gapFat = Math.max(0, metaC.meta_fat - fatC);
  const alvoMes = mesesRestCal > 0 ? gapFat / mesesRestCal : 0;
  const jaMesAtual = mesesRestCal > 0 ? (byMesConsol[mesAtual] || 0) : 0;
  const nomesFrente = [];
  for (let m = mesAtual + 1; m <= 12; m++) nomesFrente.push(MESES[m - 1]);
  const consol = {
    fat: fatC, vgv: vgvC, qtd: qtdC, meta_fat: metaC.meta_fat,
    pct_meta_fat: metaC.meta_fat ? +(fatC / metaC.meta_fat * 100).toFixed(1) : 0,
    projecao_fat: fracAno ? Math.round(fatC / fracAno) : fatC,
    fat_mes: Math.round(fatMesNecC), fat_dia: Math.round(fatDiaNecC),
    vgv_p_fat_mes: margFracC > 0 ? Math.round(fatMesNecC / margFracC) : 0,
    margem_carregada: +(margFracC * 100).toFixed(2),
    // plano de faturamento (ritmo igual): cota mensal + recorte do mês atual e dos meses à frente
    meses_rest_cal: mesesRestCal,
    alvo_mes: Math.round(alvoMes),                 // cota de faturamento novo por mês (uniforme)
    mes_atual_nome: mesesRestCal > 0 ? MESES[mesAtual - 1] : '',
    mes_ja: Math.round(jaMesAtual),                // já faturado no mês atual (adiantado)
    mes_falta: Math.round(alvoMes),                // cota do mês (não é abatida pelo já feito)
    frente_n: nomesFrente.length,                  // quantos meses à frente
    frente_meses: nomesFrente,                     // nomes dos meses à frente
  };

  res.json({
    consol,
    ano, meta_vgv: meta.meta_vgv, meta_fat: meta.meta_fat,
    decorrido: { dias: diasDecorridos, dias_restantes: diasRestantes, meses: +mesesDecorridos.toFixed(2), meses_restantes: +mesesRestantes.toFixed(2), pct_ano: +(fracAno * 100).toFixed(1) },
    realizado: { vgv: vgvTotal, fat: fatTotal, qtd },
    cadencia,
    pipeline: { vgv: pipe.vgv, fat: pipe.fat, qtd: pipe.qtd },
    // tickets e medianas
    ticket_medio: qtd ? Math.round(vgvTotal / qtd) : 0,
    ticket_mediano: Math.round(mediana(vgvArr)),
    fat_medio_venda: qtd ? Math.round(fatTotal / qtd) : 0,
    fat_mediano_venda: Math.round(mediana(fatArr)),
    margem_media: vgvTotal ? +(fatTotal / vgvTotal * 100).toFixed(2) : 0,
    // médias por tempo
    fat_medio_mensal: Math.round(fatTotal / mesesDecorridos),
    fat_medio_dia: Math.round(fatTotal / diasDecorridos),
    vgv_medio_mensal: Math.round(vgvTotal / mesesDecorridos),
    vgv_medio_dia: Math.round(vgvTotal / diasDecorridos),
    // metas e projeção
    pct_meta_vgv: meta.meta_vgv ? +(vgvTotal / meta.meta_vgv * 100).toFixed(1) : 0,
    pct_meta_fat: meta.meta_fat ? +(fatTotal / meta.meta_fat * 100).toFixed(1) : 0,
    projecao_vgv: fracAno ? Math.round(vgvTotal / fracAno) : vgvTotal,
    projecao_fat: fracAno ? Math.round(fatTotal / fracAno) : fatTotal,
    necessario: (() => {
      const fatMes = Math.max(0, meta.meta_fat - fatTotal) / mesesRestantes;
      const fatDia = Math.max(0, meta.meta_fat - fatTotal) / diasRestantes;
      // margem CARREGADA (realizada): fat/vgv das assinadas; se ainda não há venda, cai na margem da meta
      const margFrac = vgvTotal > 0 ? fatTotal / vgvTotal : (meta.meta_vgv > 0 ? meta.meta_fat / meta.meta_vgv : 0);
      return {
        vgv_mes: Math.round(Math.max(0, meta.meta_vgv - vgvTotal) / mesesRestantes),
        fat_mes: Math.round(fatMes),
        vgv_dia: Math.round(Math.max(0, meta.meta_vgv - vgvTotal) / diasRestantes),
        fat_dia: Math.round(fatDia),
        // quanto preciso VENDER (VGV) no mês/dia p/ fechar a meta de FATURAMENTO, à margem carregada
        vgv_p_fat_mes: margFrac > 0 ? Math.round(fatMes / margFrac) : 0,
        vgv_p_fat_dia: margFrac > 0 ? Math.round(fatDia / margFrac) : 0,
        margem_carregada: +(margFrac * 100).toFixed(2),
      };
    })(),
    por_mes, por_filial, funil,
  });
});

// faturamento CONSOLIDADO por mês (todos os segmentos assinados + receita marginal) — p/ o cabeçalho do Funil
app.get('/api/faturamento-mes', (req, res) => {
  const ano = anoDe(req);
  const rows = db.prepare(`SELECT v.mes,
      COALESCE(SUM(v.faturamento + COALESCE((SELECT SUM(valor) FROM receitas_marginais m WHERE m.venda_id=v.id),0)),0) fat
    FROM vendas v WHERE v.ano=? AND v.status=? GROUP BY v.mes`).all(ano, STATUS_FECHADO);
  const meses = {}; let total = 0; rows.forEach((r) => { meses[r.mes] = r.fat; total += r.fat; });
  res.json({ ano, meses, total });
});

// ---------- RANKING (por corretor e por filial) ----------
app.get('/api/ranking', (req, res) => {
  const ano = anoDe(req);
  const seg = segDe(req);
  const por = (campo) => {
    const rows = db.prepare(`SELECT ${campo} nome, COALESCE(SUM(vgv),0) vgv,
        COALESCE(SUM(faturamento),0) fat, COUNT(*) unidades
      FROM vendas WHERE ano=? AND segmento=? AND status=? AND ${campo} IS NOT NULL AND ${campo}!=''
      GROUP BY ${campo} ORDER BY vgv DESC`).all(ano, seg, STATUS_FECHADO);
    const total = rows.reduce((a, r) => a + r.vgv, 0) || 1;
    return rows.map((r, i) => ({ pos: i + 1, ...r, pct: +(r.vgv / total * 100).toFixed(1) }));
  };
  res.json({ ano, corretores: por('corretor'), filiais: por('filial'), gerentes: por('gerente') });
});

// ---------- CADASTROS (CRUD simples das listas) ----------
app.get('/api/cadastros', (req, res) => {
  res.json(db.prepare('SELECT id, tipo, nome, ativo FROM cadastros ORDER BY tipo, nome').all());
});
app.post('/api/cadastros', (req, res) => {
  const { tipo, nome } = req.body || {};
  if (!tipo || !nome) return res.status(400).json({ erro: 'tipo e nome obrigatórios' });
  db.prepare('INSERT OR IGNORE INTO cadastros (tipo, nome, ativo) VALUES (?,?,1)').run(tipo, String(nome).toUpperCase());
  res.json({ ok: true });
});
app.delete('/api/cadastros/:id', (req, res) => {
  db.prepare('DELETE FROM cadastros WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- METAS (por ano e segmento) ----------
app.get('/api/metas', (req, res) => res.json(db.prepare('SELECT * FROM metas WHERE segmento=? ORDER BY ano DESC').all(segDe(req))));
app.put('/api/metas/:ano', (req, res) => {
  const ano = parseInt(req.params.ano);
  const seg = segDe(req);
  const cur = db.prepare('SELECT * FROM metas WHERE ano=? AND segmento=?').get(ano, seg) || { meta_vgv: 0, meta_fat: 0 };
  const meta_vgv = req.body.meta_vgv != null ? num(req.body.meta_vgv) : cur.meta_vgv;
  const meta_fat = req.body.meta_fat != null ? num(req.body.meta_fat) : cur.meta_fat;
  db.prepare('INSERT OR REPLACE INTO metas (ano, segmento, meta_vgv, meta_fat) VALUES (?,?,?,?)').run(ano, seg, meta_vgv, meta_fat);
  res.json({ ok: true, ano, segmento: seg, meta_vgv, meta_fat });
});

// Backup automático do banco: snapshot a cada start + a cada 6h, mantém os 30 mais recentes.
function backupDb() {
  try {
    const dir = resolve(dirname(DB_PATH), 'backups'); // backups ao lado do banco (disco persistente na nuvem)
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace('T', '_').replace(/:/g, '-').slice(0, 19);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    copyFileSync(DB_PATH, resolve(dir, `vendas-${ts}.db`));
    const files = readdirSync(dir).filter((f) => f.startsWith('vendas-') && f.endsWith('.db')).sort();
    for (const f of files.slice(0, -30)) rmSync(resolve(dir, f));
    console.log(`Backup do banco salvo (data/backups/vendas-${ts}.db)`);
  } catch (e) { console.error('Backup falhou:', e.message); }
}

export { app };

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const PORT = process.env.PORT || 5181;
  app.listen(PORT, () => {
    backupDb();
    setInterval(backupDb, 6 * 60 * 60 * 1000);
    console.log(`Vendas ImovelUm rodando em http://localhost:${PORT}`);
  });
}
