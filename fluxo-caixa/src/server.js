import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync, readdirSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openDb, DB_PATH, SCHEMA } from './db.js';
import {
  ehReceita, valorComSinal, addDays, weekday, proximoDiaUtil,
  gerarLancamentosRecorrencia, isoToParts, partsToISO, ultimoDiaDoMes,
  ehAjuste, CENTRO_AJUSTE, FERIADOS_2027,
} from './rules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = openDb();
db.exec(SCHEMA); // garante tabelas mesmo sem seed (boot limpo em disco vazio, p/ a nuvem)
// Receita de administração digitada à mão (mês a mês). Fica SÓ aqui — não gera lançamento, não entra
// no caixa nem em break-even. Serve unicamente para compor a coluna Adm. do Faturamento Real.
db.exec('CREATE TABLE IF NOT EXISTS faturamento_adm (ano INTEGER NOT NULL, mes INTEGER NOT NULL, valor REAL NOT NULL DEFAULT 0, PRIMARY KEY (ano, mes))');
// 'paralelo' = pendência que veio de um lançamento MOVIDO: entra no caixa mas é NEUTRA ao orçado
// (orçamento paralelo). Pendências criadas direto no mapa seguem normais (paralelo=0), como hoje.
if (!db.prepare("PRAGMA table_info(pendencias_mapa)").all().some((c) => c.name === 'paralelo')) {
  try { db.exec('ALTER TABLE pendencias_mapa ADD COLUMN paralelo INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* já existe */ }
}
// SÉRIES: repetição de um lançamento (intervalo + data-fim; valor uniforme ou escalonado).
db.exec(`CREATE TABLE IF NOT EXISTS series (
  id INTEGER PRIMARY KEY,
  descricao TEXT NOT NULL,
  centro_custo TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'orçado',
  frequencia TEXT NOT NULL,       -- semanal | quinzenal | mensal | anual
  valor REAL,                     -- valor base (p/ prorrogar uniforme)
  fim TEXT,                       -- data-fim ISO
  livro TEXT NOT NULL DEFAULT 'empresa',
  ativo INTEGER NOT NULL DEFAULT 1,
  aviso_adiado TEXT,              -- ISO: não avisar até esta data
  criado_em TEXT
);`);
if (!db.prepare('PRAGMA table_info(lancamentos)').all().some((c) => c.name === 'serie_id')) {
  try { db.exec('ALTER TABLE lancamentos ADD COLUMN serie_id INTEGER'); } catch (e) { /* já existe */ }
}
// INTEGRAÇÃO NOTION (experimento): tabela ISOLADA. A Márcia registra no Notion; o job insere aqui como
// 'pendente'; ao aprovar, cria um lançamento NORMAL em lancamentos. Não altera lancamentos nem as somas.
db.exec(`CREATE TABLE IF NOT EXISTS notion_entrada (
  id INTEGER PRIMARY KEY,
  notion_page_id TEXT UNIQUE,
  nome TEXT NOT NULL,              -- "Descrição — Fornecedor (Empresa)" já montado
  valor REAL NOT NULL,            -- positivo, como a Márcia digita; vira negativo ao aprovar
  vencimento TEXT,                -- ISO
  centro_custo TEXT,
  comprovante TEXT,               -- link do Drive
  empresa TEXT,                   -- Matriz RJ | Filial SP (informativo)
  fornecedor TEXT,
  status TEXT NOT NULL DEFAULT 'pendente',  -- pendente | aprovado | rejeitado
  motivo TEXT,                    -- motivo da rejeição
  lancamento_id INTEGER,          -- id do lançamento criado na aprovação
  notion_sync TEXT,               -- último status devolvido ao Notion (enviado|aprovado|rejeitado)
  created_at TEXT DEFAULT (datetime('now'))
);`);
const PUBLIC = resolve(__dirname, '..', 'public');
const app = express();
app.use(express.json());
// serve o index com <base href> dinâmico — funciona standalone (/) e montado no ZAHAV (/fluxo)
app.get(['/', '/index.html'], (req, res) => {
  const base = (req.baseUrl || '') + '/';
  const v = (f) => { try { return Math.floor(statSync(resolve(PUBLIC, f)).mtimeMs); } catch { return Date.now(); } };
  const html = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8')
    .replace('<head>', `<head>\n  <base href="${base}">`)
    .replace('href="styles.css"', `href="styles.css?v=${v('styles.css')}"`)
    .replace('src="app.js"', `src="app.js?v=${v('app.js')}"`);
  res.type('html').send(html);
});
app.use(express.static(PUBLIC));

const ANO = 2026;
// os recorrentes vão até 2027-12-31; sem os feriados de 2027 a regra de dia útil ficaria cega lá
{
  const ins = db.prepare('INSERT OR IGNORE INTO feriados (data, descricao, ambito) VALUES (?,?,?)');
  for (const [data, desc, ambito] of FERIADOS_2027) ins.run(data, desc, ambito);
}
const feriadosSet = () => new Set(db.prepare('SELECT data FROM feriados').all().map((r) => r.data));
// data LOCAL (nunca toISOString: em UTC-3 o dia "virava" às 21h e o backend ficava 1 dia à frente do front)
const hojeISO = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

// ---------- REGRA DE DIA ÚTIL ----------
// Toda obrigação/previsão (orçado) que cai em sábado, domingo ou feriado vai para o próximo dia útil.
// NÃO se aplica a 'real': isso já aconteceu (PIX e cartão rodam no fim de semana) — mudar a data
// falsificaria o dia em que o dinheiro de fato se moveu.
const diaUtilPara = (data, tipo) => (tipo === 'real' ? data : proximoDiaUtil(data, feriadosSet()));

// Filtro de livro para LEITURA: ausente/'all' => combinado (empresa + dutra).
const livroFiltro = (req) => (req.query.livro && req.query.livro !== 'all' ? req.query.livro : null);
// Livro alvo para ESCRITA (novo lançamento/recorrente/âncora): default 'empresa'.
const livroAlvo = (req) => ((req.body && req.body.livro) || req.query.livro || 'empresa');
// compat
const livroDe = (req) => livroFiltro(req) || 'empresa';

// Âncora de caixa por livro: saldo real contado numa data (tabela livros).
function ancora(livro = 'empresa') {
  const l = db.prepare('SELECT ancora_data, ancora_valor FROM livros WHERE id=?').get(livro);
  return { data: l?.ancora_data || `${ANO}-01-01`, valor: Number(l?.ancora_valor || 0) };
}
// Projetado = real + previsto (orçado). Realizado = só lançamentos 'real' (dinheiro que de fato entrou/saiu).
function baselineCaixa(livro = 'empresa') {
  const a = ancora(livro);
  const antes = db.prepare(`SELECT COALESCE(SUM(valor),0) s FROM lancamentos WHERE livro=? AND COALESCE(origem,'') <> 'reembolso' AND data < ?`).get(livro, a.data).s;
  return a.valor - antes;
}
function baselineReal(livro = 'empresa') {
  const a = ancora(livro);
  const antes = db.prepare("SELECT COALESCE(SUM(valor),0) s FROM lancamentos WHERE livro=? AND COALESCE(origem,'') <> 'reembolso' AND data < ? AND tipo='real'").get(livro, a.data).s;
  return a.valor - antes;
}
function caixaAteDia(d, livro = 'empresa') {
  const ate = db.prepare(`SELECT COALESCE(SUM(valor),0) s FROM lancamentos WHERE livro=? AND COALESCE(origem,'') <> 'reembolso' AND data <= ?`).get(livro, d).s;
  return baselineCaixa(livro) + ate;
}
function caixaRealAteDia(d, livro = 'empresa') {
  const ate = db.prepare("SELECT COALESCE(SUM(valor),0) s FROM lancamentos WHERE livro=? AND COALESCE(origem,'') <> 'reembolso' AND data <= ? AND tipo='real'").get(livro, d).s;
  return baselineReal(livro) + ate;
}

// segunda-feira da semana que contém `iso`
function segundaDaSemana(iso) {
  let cur = iso;
  while (weekday(cur) !== 1) cur = addDays(cur, -1);
  return cur;
}

// ---------- META ----------
app.get('/api/meta', (req, res) => {
  const hoje = hojeISO();
  res.json({
    ano: ANO,
    livros: db.prepare('SELECT id, nome FROM livros ORDER BY ordem, id').all(),
    centros_custo: db.prepare('SELECT nome, eh_receita FROM centros_custo ORDER BY eh_receita, nome').all(),
    origens: db.prepare('SELECT nome FROM origens_receita ORDER BY nome').all().map((r) => r.nome),
    hoje,
  });
});

// Cria um novo centro de custo (para os dropdowns). eh_receita=1 => entrada (+), senão saída (−).
app.post('/api/centros_custo', (req, res) => {
  const nome = String(req.body.nome || '').trim();
  if (!nome) return res.status(400).json({ erro: 'nome é obrigatório' });
  const ehRec = req.body.eh_receita ? 1 : 0;
  db.prepare('INSERT OR IGNORE INTO centros_custo (nome, eh_receita) VALUES (?, ?)').run(nome, ehRec);
  res.json({ ok: true, nome, eh_receita: ehRec });
});

// Caixa numa data (default hoje) — realizado, projetado e âncora (livro default empresa)
app.get('/api/caixa', (req, res) => {
  const d = req.query.data || hojeISO();
  const livro = livroDe(req);
  res.json({ data: d, realizado: caixaRealAteDia(d, livro), projetado: caixaAteDia(d, livro), ancora: ancora(livro) });
});

// ---------- SEMANA (seg–sex) ----------
app.get('/api/semana', (req, res) => {
  const ref = req.query.start || `${ANO}-01-05`;
  const livro = livroDe(req);
  const seg = segundaDaSemana(ref);
  const sex = addDays(seg, 4);
  const base = baselineCaixa(livro);

  // caixa de abertura da semana = baseline + tudo antes da segunda
  const antes = db.prepare(`SELECT COALESCE(SUM(valor),0) s FROM lancamentos WHERE livro=? AND COALESCE(origem,'') <> 'reembolso' AND data < ?`).get(livro, seg).s;
  let acumulado = base + antes;
  const caixaAbertura = acumulado;

  const dias = [];
  for (let i = 0; i < 5; i++) {
    const data = addDays(seg, i);
    const lancs = db.prepare('SELECT * FROM lancamentos WHERE livro=? AND data=? ORDER BY (valor>0) DESC, id').all(livro, data);
    const total = lancs.reduce((a, l) => a + l.valor, 0);
    acumulado += total;
    const fer = db.prepare('SELECT descricao FROM feriados WHERE data=?').get(data);
    dias.push({ data, weekday: weekday(data), lancamentos: lancs, total, caixa_projetado: acumulado, feriado: fer?.descricao || null });
  }
  const semanaTotal = dias.reduce((a, d) => a + d.total, 0);
  res.json({ seg, sex, dias, semanaTotal, caixa_abertura: caixaAbertura, caixa_fechamento: acumulado });
});

// ---------- PERÍODO (N semanas a partir de uma data) ----------
app.get('/api/periodo', (req, res) => {
  const start = req.query.start || `${ANO}-01-05`;
  const livro = livroDe(req); // default empresa
  const n = Math.max(1, Math.min(6, parseInt(req.query.semanas || '1') || 1));
  const seg0 = segundaDaSemana(start);
  const base = baselineCaixa(livro);
  const baseR = baselineReal(livro);
  const sumLE = db.prepare(`SELECT COALESCE(SUM(valor),0) s FROM lancamentos WHERE livro=? AND COALESCE(origem,'') <> 'reembolso' AND data <= ?`);
  const sumLER = db.prepare("SELECT COALESCE(SUM(valor),0) s FROM lancamentos WHERE livro=? AND COALESCE(origem,'') <> 'reembolso' AND data <= ? AND tipo='real'");
  const sumLT = db.prepare(`SELECT COALESCE(SUM(valor),0) s FROM lancamentos WHERE livro=? AND COALESCE(origem,'') <> 'reembolso' AND data < ?`);
  const dayLancs = db.prepare('SELECT * FROM lancamentos WHERE livro=? AND data=? ORDER BY (valor>0) DESC, id');
  const ferGet = db.prepare('SELECT descricao FROM feriados WHERE data=?');
  // modo GHOST (só visual/temporário): ids "fantasmados" saem de TODA a contagem (cards, P1/P2 e caixa),
  // mas continuam na lista dos dias (marcados) para aparecerem apagados. O caixa é a soma acumulada base +
  // (≤ data); tirar um ghost = subtrair o acumulado dele até a data. Ghosts são itens visíveis da janela,
  // sempre ≥ âncora, então o baseline não muda.
  const ghostIds = String(req.query.ghost || '').split(',').map(Number).filter(Boolean);
  // ghostr = chaves estáveis de recorrentes "recorrencia_id|data" — sobrevivem à regeneração do [R]
  // (quando o recorrente se regenera o id muda, mas recorrencia_id+data continua o mesmo).
  const ghostRKeys = String(req.query.ghostr || '').split(',').map((s) => s.trim()).filter(Boolean);
  // resolve as linhas fantasmadas por id OU por (recorrencia_id, data)
  let ghostRows = [];
  if (ghostIds.length || ghostRKeys.length) {
    const parts = [], params = [];
    if (ghostIds.length) { parts.push(`id IN (${ghostIds.map(() => '?').join(',')})`); params.push(...ghostIds); }
    for (const k of ghostRKeys) { const [rid, dt] = k.split('|'); if (rid && dt) { parts.push('(recorrencia_id=? AND data=?)'); params.push(Number(rid), dt); } }
    if (parts.length) ghostRows = db.prepare(`SELECT id,data,valor,tipo,origem,recorrencia_id FROM lancamentos WHERE livro=? AND (${parts.join(' OR ')})`).all(livro, ...params);
  }
  const ghostSet = new Set(ghostRows.map((r) => r.id));
  // ids fantasmados (passados como id puro) que AINDA existem — o front usa p/ podar órfãos de id.
  // Os ghost por recorrência (ghostr) NÃO entram aqui: eles se re-resolvem sozinhos a cada carga.
  const ghostVivos = ghostIds.length
    ? db.prepare(`SELECT id FROM lancamentos WHERE id IN (${ghostIds.map(() => '?').join(',')})`).all(...ghostIds).map((r) => r.id)
    : [];
  const gVal = (g) => (g.origem === 'reembolso' ? 0 : g.valor);         // reembolso já é neutro ao caixa
  const ghostLE = (d) => ghostRows.reduce((s, g) => (g.data <= d ? s + gVal(g) : s), 0);
  const ghostLT = (d) => ghostRows.reduce((s, g) => (g.data < d ? s + gVal(g) : s), 0);
  const ghostLER = (d) => ghostRows.reduce((s, g) => (g.data <= d && g.tipo === 'real' ? s + gVal(g) : s), 0);
  const ghostConsol = ghostRows.reduce((s, g) => s + gVal(g), 0);
  // ===== PROJEÇÃO A PARTIR DO CAIXA REAL DE HOJE =====
  // A projeção não arrasta mais orçado ATRASADO (data < hoje): parte do caixa realizado de hoje e
  // soma só o orçado de hoje em diante. Assim um orçado vencido não paga some da projeção futura —
  // ele vira o indicador "atrasado". Dias passados mostram o caixa realizado daquele dia.
  const hoje = hojeISO();
  const caixaRealHoje = baseR + sumLER.get(livro, hoje).s - ghostLER(hoje);
  const sumOrc = db.prepare("SELECT COALESCE(SUM(valor),0) s FROM lancamentos WHERE livro=? AND tipo<>'real' AND COALESCE(origem,'') <> 'reembolso' AND data >= ? AND data <= ?");
  const ghostOrcRange = (a, b) => ghostRows.reduce((s, g) => ((g.tipo !== 'real' && g.origem !== 'reembolso' && g.data >= a && g.data <= b) ? s + g.valor : s), 0);
  // caixa projetado no fim do dia d: passado = realizado; hoje/futuro = caixa real de hoje + orçado [hoje..d]
  const projCaixa = (d) => (d < hoje
    ? baseR + sumLER.get(livro, d).s - ghostLER(d)
    : caixaRealHoje + sumOrc.get(livro, hoje, d).s - ghostOrcRange(hoje, d));
  // atrasado = orçado vencido (data < hoje) ainda em aberto, fora da projeção (vira alerta)
  const atrasado = db.prepare("SELECT COALESCE(SUM(valor),0) s FROM lancamentos WHERE livro=? AND tipo<>'real' AND COALESCE(origem,'') <> 'reembolso' AND data < ?").get(livro, hoje).s
    - ghostRows.reduce((s, g) => ((g.tipo !== 'real' && g.origem !== 'reembolso' && g.data < hoje) ? s + g.valor : s), 0);
  const semanas = [];
  for (let w = 0; w < n; w++) {
    const seg = addDays(seg0, w * 7), sex = addDays(seg, 4), dom = addDays(seg, 6);
    const dias = [];
    // seg–sex sempre; sáb/dom SÓ quando têm lançamento (senão a grade fica poluída de dia vazio).
    // Sem isso, um lançamento caindo no fim de semana somava no caixa mas ficava invisível — e o
    // fechamento de uma semana não batia com a abertura da seguinte.
    for (let i = 0; i < 7; i++) {
      const data = addDays(seg, i);
      const lancs = dayLancs.all(livro, data);
      if (i >= 5 && !lancs.length) continue;
      lancs.forEach((l) => { l.ghost = ghostSet.has(l.id) ? 1 : 0; });   // marca p/ o front apagar
      // reembolso (paguei pela conta pessoal) e ghost ficam FORA do total do dia (mas seguem na lista)
      const t = lancs.reduce((a, l) => a + ((l.origem === 'reembolso' || l.ghost) ? 0 : l.valor), 0);
      const tReal = lancs.reduce((a, l) => a + (l.tipo === 'real' && l.origem !== 'reembolso' && !l.ghost ? l.valor : 0), 0);
      dias.push({ data, weekday: weekday(data), fds: i >= 5, lancamentos: lancs, total: t, total_real: tReal, caixa_projetado: projCaixa(data), caixa_realizado: baseR + sumLER.get(livro, data).s - ghostLER(data), feriado: ferGet.get(data)?.descricao || null });
    }
    const semanaTotal = dias.reduce((a, d) => a + d.total, 0);
    // fecha no DOMINGO (não na sexta): assim caixa_fechamento da semana == caixa_abertura da seguinte
    semanas.push({ seg, sex, dom, dias, semanaTotal, caixa_abertura: projCaixa(addDays(seg, -1)), caixa_fechamento: projCaixa(dom), caixa_fechamento_real: baseR + sumLER.get(livro, dom).s - ghostLER(dom) });
  }
  // Janela de apuração dos quadros: por padrão o período exibido (seg da 1ª semana → DOM da última).
  // 'de'/'ate' explícitos (ex.: "resto do mês") restringem a apuração a um intervalo exato — e como
  // somam TODOS os dias da janela (igual ao caixa), garantem que receitas+despesas == caixa_fim − caixa_inicial.
  // Fecha no domingo (não na sexta): senão um lançamento de sábado entraria no caixa e ficaria fora
  // dos quadros, quebrando essa identidade e o encaixe com a abertura da semana seguinte.
  const ehPJ = (cc) => String(cc || '').toLowerCase().replace(/\s+/g, '').includes('pjbank');
  const janDe = req.query.de || seg0;
  const janAte = req.query.ate || addDays(seg0, (n - 1) * 7 + 6);
  const winRows = db.prepare("SELECT id, centro_custo, tipo, valor, origem FROM lancamentos WHERE livro=? AND COALESCE(origem,'') <> 'reembolso' AND data BETWEEN ? AND ?").all(livro, janDe, janAte);
  // Despesas em 2 baldes que somam o total: "enc. adm e repasse" (centros encargos adm + repasses,
  // o pass-through da locação) e o "consolidado empresa" (= total − esse balde), calculado no front.
  const ehEncAdm = (cc) => String(cc || '').trim().toLowerCase() === 'encargos adm';
  const ehRepasse = (cc) => String(cc || '').trim().toLowerCase() === 'repasses';
  let recReal = 0, recPrev = 0, despReal = 0, despPrev = 0, pjReal = 0, pjPrev = 0, outReal = 0, outPrev = 0;
  let encRepReal = 0, encRepPrev = 0, ajustes = 0, pendPar = 0;
  for (const l of winRows) {
    if (ghostSet.has(l.id)) continue;   // ghost: fora de toda a contagem dos cards
    // 'ajuste de caixa' (conciliação) é NEUTRO: entra no caixa, mas não é receita nem despesa
    if (l.origem === 'ajuste') { ajustes += l.valor; continue; }
    // pendência PARALELA (lançamento movido): entra no caixa mas NÃO no orçado — orçamento de pendências
    if (l.origem === 'pendencia_par') { pendPar += l.valor; continue; }
    // "Retirada Dutra" é categoria de saída: fica sempre no lado despesa (mesmo o crédito de reembolso +, que abate)
    if (l.valor > 0 && l.centro_custo !== 'Retirada Dutra') {
      if (l.tipo === 'real') recReal += l.valor; else recPrev += l.valor;
      if (ehPJ(l.centro_custo)) { if (l.tipo === 'real') pjReal += l.valor; else pjPrev += l.valor; }
      else { if (l.tipo === 'real') outReal += l.valor; else outPrev += l.valor; }
    } else {
      if (l.tipo === 'real') despReal += l.valor; else despPrev += l.valor;
      if (ehEncAdm(l.centro_custo) || ehRepasse(l.centro_custo)) { if (l.tipo === 'real') encRepReal += l.valor; else encRepPrev += l.valor; }
    }
  }
  const receitas = recReal + recPrev;       // entradas (real + orçado) da janela
  const despesas = despReal + despPrev;      // saídas (negativo)
  res.json({
    start: seg0, semanas, total: receitas + despesas + ajustes + pendPar,   // ajustes e pendências paralelas só mexem no caixa
    ajustes: +ajustes.toFixed(2),                                 // conciliação (neutro: nem receita nem despesa)
    pendencias: +pendPar.toFixed(2),                              // orçamento paralelo de pendências (fora do orçado)
    ghost_consol: +ghostConsol.toFixed(2),                        // consolidado dos "fantasmados" (fora de tudo)
    ghost_n: ghostRows.length,
    ghost_vivos: ghostVivos,                                      // ids que ainda existem (p/ podar órfãos no front)
    caixa_inicial: projCaixa(addDays(janDe, -1)),                 // caixa antes do início da janela (projeção do caixa real)
    receitas, despesas,
    caixa_fim: projCaixa(janAte),
    caixa_fim_real: baseR + sumLER.get(livro, janAte).s - ghostLER(janAte),
    caixa_real_hoje: +caixaRealHoje.toFixed(2),                   // âncora da projeção
    atrasado: +atrasado.toFixed(2),                               // orçado vencido em aberto (fora da projeção)
    receita: { realizado: recReal, previsto: recPrev },
    despesa: { real: despReal, previsto: despPrev },
    receita_pjbank: { realizado: pjReal, previsto: pjPrev },
    receita_outras: { realizado: outReal, previsto: outPrev },
    despesa_grupos: { enc_adm_repasse: { real: encRepReal, previsto: encRepPrev } },
    janela: { de: janDe, ate: janAte },
  });
});

// ---------- RELATÓRIO (datas livres, para impressão) ----------
app.get('/api/relatorio', (req, res) => {
  const livro = livroDe(req);
  const de = req.query.de, ate = req.query.ate;
  if (!de || !ate) return res.status(400).json({ erro: 'de e ate são obrigatórios' });
  const base = baselineCaixa(livro), baseR = baselineReal(livro);
  const sLE = (d) => db.prepare(`SELECT COALESCE(SUM(valor),0) s FROM lancamentos WHERE livro=? AND COALESCE(origem,'') <> 'reembolso' AND data <= ?`).get(livro, d).s;
  const sLER = (d) => db.prepare("SELECT COALESCE(SUM(valor),0) s FROM lancamentos WHERE livro=? AND COALESCE(origem,'') <> 'reembolso' AND data <= ? AND tipo='real'").get(livro, d).s;
  const sLT = (d) => db.prepare(`SELECT COALESCE(SUM(valor),0) s FROM lancamentos WHERE livro=? AND COALESCE(origem,'') <> 'reembolso' AND data < ?`).get(livro, d).s;
  const sLTR = (d) => db.prepare("SELECT COALESCE(SUM(valor),0) s FROM lancamentos WHERE livro=? AND COALESCE(origem,'') <> 'reembolso' AND data < ? AND tipo='real'").get(livro, d).s;
  const lancs = db.prepare('SELECT data,nome,centro_custo,tipo,valor,prioridade,origem FROM lancamentos WHERE livro=? AND data>=? AND data<=? ORDER BY data, (valor>0) DESC, id').all(livro, de, ate);
  let receitas = 0, despesas = 0, recReal = 0, recPrev = 0, despReal = 0, despPrev = 0, ajustes = 0, pendPar = 0;
  let p1 = 0, p2 = 0, dEnc = 0, dRep = 0, dCom = 0, dAmo = 0; // prioridades + descontos da despesa líquida
  const cc = {};
  for (const l of lancs) {
    // 'ajuste de caixa' (conciliação) é NEUTRO: aparece no extrato, mas fora de receitas/despesas
    if (l.origem === 'ajuste') { ajustes += l.valor; continue; }
    // pendência PARALELA: orçamento de pendências — no caixa, fora de receitas/despesas e do porCC
    if (l.origem === 'pendencia_par') { pendPar += l.valor; continue; }
    if (l.valor > 0) { receitas += l.valor; if (l.tipo === 'real') recReal += l.valor; else recPrev += l.valor; }
    else {
      despesas += l.valor; if (l.tipo === 'real') despReal += l.valor; else despPrev += l.valor;
      const cl = String(l.centro_custo || '').toLowerCase();
      if (cl.includes('encargos adm')) dEnc += l.valor;
      else if (cl.includes('repass')) dRep += l.valor;
      else if (cl.includes('comiss')) dCom += l.valor;
      else if (cl.includes('amortiza')) dAmo += l.valor;
    }
    // pagamentos: nulo conta como P1. Pendências do mapa (origem 'pendencia') não são P1/P2 (orçamento à parte)
    if (l.valor < 0 && l.origem !== 'pendencia') { if (l.prioridade === 'P2') p2 += l.valor; else p1 += l.valor; }
    (cc[l.centro_custo] ??= { total: 0, real: 0, orcado: 0 });
    cc[l.centro_custo].total += l.valor;
    if (l.tipo === 'real') cc[l.centro_custo].real += l.valor; else cc[l.centro_custo].orcado += l.valor;
  }
  const descTotal = dEnc + dRep + dCom + dAmo;
  const porCC = Object.entries(cc).map(([nome, o]) => ({ nome, total: o.total, real: o.real, orcado: o.orcado })).sort((a, b) => a.total - b.total);
  res.json({
    de, ate, livro,
    caixa_abertura: base + sLT(de), caixa_abertura_real: baseR + sLTR(de),
    caixa_fechamento: base + sLE(ate), caixa_fechamento_real: baseR + sLER(ate),
    receitas, despesas, recReal, recPrev, despReal, despPrev, resultado: receitas + despesas,
    ajustes: +ajustes.toFixed(2),   // conciliação (neutro: fora de receitas/despesas, só no caixa)
    pendencias: +pendPar.toFixed(2), // orçamento paralelo de pendências (fora do orçado)
    despesa_liquida: despesas - descTotal, // operacional (descontando enc. adm, repasses, comissão e amortizações)
    descontos: { encargos_adm: dEnc, repasses: dRep, comissao: dCom, amortizacoes: dAmo, total: descTotal },
    prioridades: { p1, p2, total: p1 + p2 },
    porCC, lancamentos: lancs,
  });
});

// ---------- CONSOLIDADO MENSAL (calculado) ----------
app.get('/api/consolidado', (req, res) => {
  const livro = livroDe(req);
  const meses = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const rows = db.prepare(`
    SELECT substr(data,6,2) mm,
           SUM(CASE WHEN valor>0 THEN valor ELSE 0 END) receita,
           SUM(CASE WHEN valor<0 THEN valor ELSE 0 END) despesa,
           SUM(valor) saldo,
           SUM(CASE WHEN tipo='orçado' THEN valor ELSE 0 END) orcado,
           SUM(CASE WHEN tipo='real' THEN valor ELSE 0 END) real
    FROM lancamentos WHERE livro=? AND COALESCE(origem,'') NOT IN ('reembolso','ajuste') GROUP BY mm`).all(livro);
  const by = {}; rows.forEach((r) => (by[+r.mm] = r));
  const out = meses.map((nome, i) => {
    const r = by[i + 1] || {};
    return { mes: nome, receita: r.receita || 0, despesa: r.despesa || 0, saldo: r.saldo || 0, orcado: r.orcado || 0, real: r.real || 0 };
  });
  res.json(out);
});

// ---------- PREVISÃO DE RECEITA (mensal: realizado x previsto) ----------
app.get('/api/receitas', (req, res) => {
  const livro = livroDe(req);
  const meses = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const rows = db.prepare(`
    SELECT substr(data,6,2) mm,
      SUM(CASE WHEN valor>0 AND tipo='real'   THEN valor ELSE 0 END) realizado,
      SUM(CASE WHEN valor>0 AND tipo='orçado' THEN valor ELSE 0 END) previsto
    FROM lancamentos WHERE livro=? AND COALESCE(origem,'') NOT IN ('reembolso','ajuste') GROUP BY mm`).all(livro);
  const by = {}; rows.forEach((r) => (by[+r.mm] = r));
  // por origem (centro de custo receita ·), no ano todo
  const porOrigem = db.prepare(`
    SELECT centro_custo origem,
      SUM(CASE WHEN tipo='real' THEN valor ELSE 0 END) realizado,
      SUM(CASE WHEN tipo='orçado' THEN valor ELSE 0 END) previsto
    FROM lancamentos WHERE livro=? AND COALESCE(origem,'') NOT IN ('reembolso','ajuste') AND valor>0 GROUP BY centro_custo ORDER BY (SUM(valor)) DESC`).all(livro);
  const meses_out = meses.map((nome, i) => {
    const r = by[i + 1] || {};
    const realizado = r.realizado || 0, previsto = r.previsto || 0;
    return { mes: nome, realizado, previsto, total: realizado + previsto };
  });
  res.json({ meses: meses_out, por_origem: porOrigem });
});

// ---------- RECEITA A ENTRAR POR HORIZONTE (esteira de recebíveis) ----------
app.get('/api/receita-horizonte', (req, res) => {
  const livro = livroDe(req);
  const ref = req.query.ref || `${ANO}-06-22`;
  const seg = segundaDaSemana(ref);
  const q = (cond, params) => {
    const r = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN tipo='real' THEN valor ELSE 0 END),0) real,
      COALESCE(SUM(CASE WHEN tipo='orçado' THEN valor ELSE 0 END),0) prev
      FROM lancamentos WHERE livro=? AND COALESCE(origem,'') NOT IN ('reembolso','ajuste') AND valor>0 AND ${cond}`).get(livro, ...params);
    return { real: r.real, previsto: r.prev, total: r.real + r.prev };
  };
  // semana COMERCIAL: exibe seg–sex (22–26); soma cobre seg–dom (contígua, não perde nada)
  const sem = (k, label) => {
    const de = addDays(seg, k * 7), dom = addDays(de, 6);
    return { label, de, ate: addDays(de, 4), ...q('data BETWEEN ? AND ?', [de, dom]) };
  };
  // Horizontes fixos por DIAS (nome não muda com o calendário):
  const d28 = addDays(seg, 28), d39 = addDays(seg, 39);
  const buckets = [
    sem(0, 'Esta semana'),
    sem(1, '2ª semana'),
    sem(2, '3ª semana'),
    sem(3, '4ª semana'),
    { label: '30+ dias', de: d28, ate: d39, ...q('data BETWEEN ? AND ?', [d28, d39]) },
    { label: '40+ dias', de: addDays(seg, 40), ate: null, ...q('data > ?', [d39]) },
  ];
  res.json({ ref: seg, buckets, total: buckets.reduce((a, b) => a + b.total, 0) });
});

// ---------- DUTRA (centro de custo "Retirada Dutra", separado por tipo) ----------
app.get('/api/dutra', (req, res) => {
  // card 💰 Dutra = TUDO classificado como "Retirada Dutra" (recorrentes Dutra + lançado manual), em qualquer livro
  const mes = req.query.mes; // YYYY-MM opcional
  const where = mes ? "AND substr(data,1,7)=?" : '';
  const params = mes ? [mes] : [];
  // retirada consolidada = retiradas do centro 'Retirada Dutra' (−, exibidas positivas)
  // MENOS os reembolsos "conta pessoal" (origem='reembolso', em QUALQUER centro; são − e ABATEM).
  const row = db.prepare(`SELECT
      -SUM(CASE WHEN tipo='real'  AND centro_custo='Retirada Dutra' AND COALESCE(origem,'')<>'reembolso' THEN valor ELSE 0 END)
        + SUM(CASE WHEN tipo='real'  AND origem='reembolso' THEN valor ELSE 0 END) real,
      -SUM(CASE WHEN tipo='orçado' AND centro_custo='Retirada Dutra' AND COALESCE(origem,'')<>'reembolso' THEN valor ELSE 0 END)
        + SUM(CASE WHEN tipo='orçado' AND origem='reembolso' THEN valor ELSE 0 END) orcado
    FROM lancamentos WHERE 1=1 ${where}`).get(...params);
  res.json({ real: row.real || 0, orcado: row.orcado || 0 });
});

// ---------- RECORRÊNCIAS ----------
const HORIZONTE = '2027-12-31';

// Re-aplica uma recorrência nos lançamentos FUTUROS (>= cutoff):
// apaga as ocorrências automáticas (orçado) futuras e regenera a partir do cadastro,
// preservando os 'real' (já confirmados) e as exceções (remanejados/cancelados).
function reaplicarRecorrencia(rec, cutoff, oldDescricao) {
  const livro = rec.livro || 'empresa';
  const nomeAntigo = `[R] ${oldDescricao || rec.descricao}`;
  db.prepare("DELETE FROM lancamentos WHERE livro=? AND nome=? AND data>=? AND tipo!='real' AND origem='recorrente'").run(livro, nomeAntigo, cutoff);
  if (!rec.ativo) return;
  const fset = feriadosSet();
  const excs = db.prepare('SELECT * FROM excecoes WHERE livro=? AND lower(descricao)=lower(?)').all(livro, rec.descricao);
  const novos = gerarLancamentosRecorrencia(rec, cutoff, HORIZONTE, fset, excs);
  const existeReal = db.prepare("SELECT 1 FROM lancamentos WHERE livro=? AND nome=? AND data=? AND tipo='real' LIMIT 1");
  const ins = db.prepare("INSERT INTO lancamentos (data,nome,centro_custo,tipo,valor,origem,recorrencia_id,livro) VALUES (?,?,?,?,?, 'recorrente', ?, ?)");
  for (const n of novos) {
    if (existeReal.get(livro, n.nome, n.data)) continue; // não duplica onde já foi confirmado
    ins.run(n.data, n.nome, n.centro_custo, n.tipo, n.valor, rec.id, livro);
  }
}

app.get('/api/recorrencias', (req, res) => {
  res.json(db.prepare('SELECT * FROM recorrencias WHERE livro=? ORDER BY ativo DESC, descricao').all(livroDe(req)));
});

app.post('/api/recorrencias', (req, res) => {
  const b = req.body;
  const livro = livroAlvo(req);
  if (!b.descricao || !b.centro_custo) return res.status(400).json({ erro: 'descrição e centro de custo são obrigatórios' });
  const info = db.prepare(`INSERT INTO recorrencias (descricao,centro_custo,tipo,valor,frequencia,dia_mes,dia_semana,inicio,fim,ativo,livro)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(b.descricao, b.centro_custo, b.tipo || 'orçado', Math.abs(Number(b.valor) || 0),
    b.frequencia || 'mensal', b.dia_mes || null, b.dia_semana || null, b.inicio || null, b.fim || null, b.ativo === false ? 0 : 1, livro);
  const novo = db.prepare('SELECT * FROM recorrencias WHERE id=?').get(info.lastInsertRowid);
  db.exec('BEGIN'); try { reaplicarRecorrencia(novo, hojeISO()); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ erro: String(e) }); }
  res.json({ ok: true, recorrencia: novo });
});

app.put('/api/recorrencias/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM recorrencias WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ erro: 'não encontrado' });
  const m = { ...cur, ...req.body };
  db.prepare(`UPDATE recorrencias SET descricao=?,centro_custo=?,tipo=?,valor=?,frequencia=?,dia_mes=?,dia_semana=?,inicio=?,fim=?,ativo=? WHERE id=?`)
    .run(m.descricao, m.centro_custo, m.tipo, Math.abs(Number(m.valor) || 0), m.frequencia, m.dia_mes || null, m.dia_semana || null, m.inicio || null, m.fim || null, m.ativo ? 1 : 0, cur.id);
  const novo = db.prepare('SELECT * FROM recorrencias WHERE id=?').get(cur.id);
  db.exec('BEGIN'); try { reaplicarRecorrencia(novo, hojeISO(), cur.descricao); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ erro: String(e) }); }
  res.json({ ok: true, recorrencia: novo });
});

app.delete('/api/recorrencias/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM recorrencias WHERE id=?').get(req.params.id);
  if (cur) {
    db.prepare("DELETE FROM lancamentos WHERE livro=? AND nome=? AND data>=? AND tipo!='real' AND origem='recorrente'").run(cur.livro || 'empresa', `[R] ${cur.descricao}`, hojeISO());
    db.prepare('DELETE FROM recorrencias WHERE id=?').run(cur.id);
  }
  res.json({ ok: true });
});

// Gera/atualiza TODAS as recorrências do livro pra frente (preenche meses novos, ex.: 2027)
app.post('/api/recorrencias/reaplicar', (req, res) => {
  const recs = db.prepare('SELECT * FROM recorrencias WHERE livro=?').all(livroDe(req));
  db.exec('BEGIN');
  try { for (const r of recs) reaplicarRecorrencia(r, hojeISO()); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ erro: String(e) }); }
  res.json({ ok: true, recorrencias: recs.length });
});

// ---------- FECHAMENTO DE MÊS ----------
// Repasse e encargos adm são obrigações DO MÊS. Ao fechar o mês, o que ficou em aberto
// (ainda 'orçado', não pago) sai da posição do mês e vira uma AMORTIZAÇÃO consolidada
// (centro 'amortizações'), datada no 1º dia útil do mês seguinte.
const nomeAmortMes = (mes) => `[AM] Repasse+enc.adm em aberto — ${mes}`;
function abertosDoMes(livro, mes) {
  const [y, m] = mes.split('-').map(Number);
  const de = `${mes}-01`, ate = `${mes}-${String(ultimoDiaDoMes(y, m)).padStart(2, '0')}`;
  return db.prepare(
    "SELECT * FROM lancamentos WHERE livro=? AND tipo='orçado' AND data BETWEEN ? AND ? AND (lower(centro_custo)='repasses' OR lower(centro_custo)='encargos adm') ORDER BY data, nome",
  ).all(livro, de, ate);
}

app.get('/api/fechamento/preview', (req, res) => {
  const livro = livroDe(req);
  const mes = String(req.query.mes || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ erro: 'mês inválido' });
  const itens = abertosDoMes(livro, mes);
  res.json({
    mes, livro, itens, total: itens.reduce((a, l) => a + l.valor, 0),
    ja_fechado: !!db.prepare('SELECT 1 FROM lancamentos WHERE livro=? AND nome=? LIMIT 1').get(livro, nomeAmortMes(mes)),
  });
});

app.post('/api/fechamento', (req, res) => {
  const livro = req.body.livro || 'empresa';
  const mes = String(req.body.mes || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ erro: 'mês inválido' });
  const nomeAm = nomeAmortMes(mes);
  if (db.prepare('SELECT 1 FROM lancamentos WHERE livro=? AND nome=? LIMIT 1').get(livro, nomeAm))
    return res.status(409).json({ erro: 'mês já fechado (amortização já existe)' });
  const itens = abertosDoMes(livro, mes);
  if (!itens.length) return res.status(400).json({ erro: 'nada em aberto neste mês' });
  const total = itens.reduce((a, l) => a + l.valor, 0); // negativo
  const [y, m] = mes.split('-').map(Number);
  const prox = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const dataAm = proximoDiaUtil(prox, feriadosSet());
  db.exec('BEGIN');
  try {
    const ids = itens.map((l) => l.id);
    db.prepare(`DELETE FROM lancamentos WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    const info = db.prepare(
      "INSERT INTO lancamentos (data,nome,centro_custo,tipo,valor,origem,livro) VALUES (?,?, 'amortizações','orçado',?, 'fechamento', ?)",
    ).run(dataAm, nomeAm, -Math.abs(total), livro);
    db.exec('COMMIT');
    res.json({ ok: true, mes, removidos: itens.length, total, amortizacao: { id: info.lastInsertRowid, data: dataAm } });
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ erro: String(e) }); }
});

// ---------- MAPA DE PENDÊNCIAS ----------
// Pendência ativa + com data => vira lançamento no calendário (amortizações / Retirada Dutra).
// Sem data e/ou inativa => fica só no consolidado (por categoria).
function sincronizarPendencia(p) {
  if (p.lancamento_id) db.prepare('DELETE FROM lancamentos WHERE id=?').run(p.lancamento_id);
  let lancId = null;
  if (p.ativo && p.data) {
    const centro = p.livro === 'dutra' ? 'Retirada Dutra' : 'amortizações';
    // paralelo → origem 'pendencia_par': entra no caixa mas fica FORA do orçado (neutro, como o ajuste)
    const origem = p.paralelo ? 'pendencia_par' : 'pendencia';
    const info = db.prepare(`INSERT INTO lancamentos (data,nome,centro_custo,tipo,valor,origem,livro)
      VALUES (?,?,?,?,?,?,?)`).run(p.data, `[P] ${p.descricao}`, centro, 'orçado', -Math.abs(p.valor), origem, p.livro);
    lancId = info.lastInsertRowid;
  }
  db.prepare('UPDATE pendencias_mapa SET lancamento_id=? WHERE id=?').run(lancId, p.id);
}

app.get('/api/pendencias', (req, res) => {
  res.json(db.prepare('SELECT * FROM pendencias_mapa WHERE livro=? ORDER BY (data IS NULL), data, categoria, descricao').all(livroDe(req)));
});

app.get('/api/pendencias/consolidado', (req, res) => {
  const livro = livroDe(req);
  const categorias = db.prepare(`SELECT COALESCE(NULLIF(categoria,''),'(sem categoria)') categoria,
      COUNT(*) n, SUM(ABS(valor)) total
    FROM pendencias_mapa WHERE livro=? AND (data IS NULL OR data='' OR ativo=0)
    GROUP BY categoria ORDER BY total DESC`).all(livro);
  const total_pendente = categorias.reduce((a, r) => a + r.total, 0);
  const total_lancado = db.prepare(`SELECT COALESCE(SUM(ABS(valor)),0) s FROM pendencias_mapa
    WHERE livro=? AND ativo=1 AND data IS NOT NULL AND data!=''`).get(livro).s;
  res.json({ categorias, total_pendente, total_lancado });
});

app.post('/api/pendencias', (req, res) => {
  const b = req.body, livro = livroAlvo(req);
  if (!b.descricao) return res.status(400).json({ erro: 'descrição obrigatória' });
  const info = db.prepare(`INSERT INTO pendencias_mapa (descricao,categoria,valor,data,ativo,livro,paralelo) VALUES (?,?,?,?,?,?,?)`)
    .run(b.descricao, b.categoria || null, Math.abs(Number(b.valor) || 0), b.data || null, b.ativo === false ? 0 : 1, livro, b.paralelo ? 1 : 0);
  const p = db.prepare('SELECT * FROM pendencias_mapa WHERE id=?').get(info.lastInsertRowid);
  db.exec('BEGIN'); try { sincronizarPendencia(p); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ erro: String(e) }); }
  res.json({ ok: true, pendencia: db.prepare('SELECT * FROM pendencias_mapa WHERE id=?').get(p.id) });
});

app.put('/api/pendencias/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM pendencias_mapa WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ erro: 'não encontrado' });
  const m = { ...cur, ...req.body };
  db.prepare(`UPDATE pendencias_mapa SET descricao=?,categoria=?,valor=?,data=?,ativo=?,paralelo=? WHERE id=?`)
    .run(m.descricao, m.categoria || null, Math.abs(Number(m.valor) || 0), m.data || null, m.ativo ? 1 : 0, m.paralelo ? 1 : 0, cur.id);
  const p = db.prepare('SELECT * FROM pendencias_mapa WHERE id=?').get(cur.id);
  db.exec('BEGIN'); try { sincronizarPendencia(p); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ erro: String(e) }); }
  res.json({ ok: true, pendencia: db.prepare('SELECT * FROM pendencias_mapa WHERE id=?').get(p.id) });
});

app.delete('/api/pendencias/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM pendencias_mapa WHERE id=?').get(req.params.id);
  if (cur) {
    if (cur.lancamento_id) db.prepare('DELETE FROM lancamentos WHERE id=?').run(cur.lancamento_id);
    db.prepare('DELETE FROM pendencias_mapa WHERE id=?').run(cur.id);
  }
  res.json({ ok: true });
});

// tira UMA ocorrência recorrente [R] da grade gravando exceção CANCELAR — assim o gerador de recorrentes
// não a recria naquele mês (senão duplicaria com a pendência). Casa pela mesma chave do gerador.
function cancelarOcorrenciaR(l) {
  if (!l || !String(l.nome).startsWith('[R] ')) return;
  const desc = l.nome.slice(4);
  const [ly, lm] = String(l.data).split('-').map(Number);
  let dia = Number(String(l.data).slice(8, 10));   // fallback: dia do próprio lançamento
  if (l.recorrencia_id) { const rec = db.prepare('SELECT dia_mes FROM recorrencias WHERE id=?').get(l.recorrencia_id); if (rec && rec.dia_mes) dia = Math.min(rec.dia_mes, new Date(ly, lm, 0).getDate()); }
  const ex = db.prepare('SELECT id FROM excecoes WHERE livro=? AND lower(descricao)=lower(?) AND dia_original=? AND mes_original=?').get(l.livro, desc, dia, lm);
  if (ex) db.prepare("UPDATE excecoes SET acao='CANCELAR', dia_nova=NULL, mes_nova=NULL WHERE id=?").run(ex.id);
  else db.prepare("INSERT INTO excecoes (descricao,dia_original,mes_original,acao,livro) VALUES (?,?,?,'CANCELAR',?)").run(desc, dia, lm, l.livro);
}

// ---------- MOVER lançamento -> Mapa de Pendências (orçamento paralelo, com parcelas) ----------
app.post('/api/lancamentos/:id/mover-pendencia', (req, res) => {
  const l = db.prepare('SELECT * FROM lancamentos WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ erro: 'lançamento não encontrado' });
  // recorrente [R] PODE ir: gravamos uma exceção CANCELAR p/ o gerador não recriar aquela ocorrência.
  if (['venda', 'pendencia', 'pendencia_par'].includes(l.origem)) return res.status(409).json({ erro: 'Este lançamento é gerenciado (venda/pendência) — não pode ser movido para pendências.' });
  const livroAlvo = req.body.livro === 'dutra' ? 'dutra' : 'empresa';
  const categoria = req.body.categoria || l.centro_custo || null;
  const parcelas = Array.isArray(req.body.parcelas) ? req.body.parcelas
    .map((p) => ({ data: String(p.data || '').trim(), valor: Math.abs(Number(p.valor) || 0) }))
    .filter((p) => p.valor > 0) : [];
  if (!parcelas.length) return res.status(400).json({ erro: 'informe ao menos uma parcela (data e valor)' });
  if (parcelas.some((p) => !/^\d{4}-\d\d-\d\d$/.test(p.data))) return res.status(400).json({ erro: 'cada parcela precisa de uma data válida' });
  const soma = parcelas.reduce((s, p) => s + p.valor, 0);
  const orig = Math.abs(l.valor);
  if (Math.abs(soma - orig) > 0.01) return res.status(400).json({ erro: `a soma das parcelas (${soma.toFixed(2)}) precisa bater com o valor do lançamento (${orig.toFixed(2)})`, soma, original: orig });
  const base = String(l.nome).replace(/^\[[A-Z]\]\s*/, '').replace(/\s*\(\d+\/\d+\)\s*$/, '');
  const insP = db.prepare('INSERT INTO pendencias_mapa (descricao,categoria,valor,data,ativo,livro,paralelo) VALUES (?,?,?,?,1,?,1)');
  const criadas = [];
  db.exec('BEGIN');
  try {
    parcelas.forEach((p, i) => {
      const desc = parcelas.length > 1 ? `${base} (${i + 1}/${parcelas.length})` : base;
      const info = insP.run(desc, categoria, p.valor, p.data, livroAlvo);
      sincronizarPendencia(db.prepare('SELECT * FROM pendencias_mapa WHERE id=?').get(info.lastInsertRowid));
      criadas.push(info.lastInsertRowid);
    });
    cancelarOcorrenciaR(l);                                        // se for [R], não regenera aquela ocorrência
    db.prepare('DELETE FROM lancamentos WHERE id=?').run(l.id);   // sai do orçado; vira orçamento de pendências
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ erro: String(e) }); }
  res.json({ ok: true, criadas, livro: livroAlvo });
});

// lançamentos por ids (para a agenda do ghost mostrar nome/data/valor de cada um)
app.get('/api/lancamentos/por-ids', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(Number).filter(Boolean);
  if (!ids.length) return res.json([]);
  const ph = ids.map(() => '?').join(',');
  res.json(db.prepare(`SELECT id, data, nome, centro_custo, tipo, valor, livro, origem FROM lancamentos WHERE id IN (${ph}) ORDER BY data, id`).all(...ids));
});

// ---------- ENVIAR EM LOTE p/ pendências (modo ghost) ----------
// Modo principal 'itens' [{id,data}]: cada lançamento vira 1 pendência na data que VOCÊ apontou (um a
// um), mantendo o nome. Sem 'itens', usa 'ids' e cada um herda a própria data. Recorrentes [R] e
// gerenciados (venda/pendência/reembolso) são pulados.
app.post('/api/lancamentos/mover-pendencia-lote', (req, res) => {
  const ins = db.prepare('INSERT INTO pendencias_mapa (descricao,categoria,valor,data,ativo,livro,paralelo) VALUES (?,?,?,?,1,?,?)');
  const delPend = (p) => { if (p.lancamento_id) db.prepare('DELETE FROM lancamentos WHERE id=?').run(p.lancamento_id); db.prepare('DELETE FROM pendencias_mapa WHERE id=?').run(p.id); };
  const syncNew = (rowid) => sincronizarPendencia(db.prepare('SELECT * FROM pendencias_mapa WHERE id=?').get(rowid));
  const soData = (v) => (/^\d{4}-\d\d-\d\d$/.test(String(v || '').trim()) ? String(v).trim() : null);   // vazio/ inválido = FLUTUA (sem data)
  const normParc = (arr) => (Array.isArray(arr) ? arr.map((p) => ({ data: soData(p.data), valor: Math.abs(Number(p.valor) || 0) })).filter((p) => p.valor > 0) : []);
  // itens: {id, data, parcelas?} — data vazia = flutuante; ids (legado): herda a data do lançamento
  const entradas = Array.isArray(req.body.itens) && req.body.itens.length
    ? req.body.itens.map((x) => ({ id: Number(x.id), data: soData(x.data), parcelas: normParc(x.parcelas), herit: false }))
    : (Array.isArray(req.body.ids) ? req.body.ids.map((id) => ({ id: Number(id), data: null, parcelas: [], herit: true })) : []);
  if (!entradas.length) return res.status(400).json({ erro: 'informe itens[{id,data}] ou ids[]' });

  const movidos = [], reagendados = [], pulados = [];
  db.exec('BEGIN');
  try {
    for (const e of entradas) {
      const l = db.prepare('SELECT * FROM lancamentos WHERE id=?').get(e.id);
      if (!l || ['venda', 'reembolso'].includes(l.origem)) { pulados.push(e.id); continue; }
      const total = Math.abs(l.valor);
      const parc = e.parcelas;
      if (parc.length) {                                             // valida soma das parcelas
        const soma = parc.reduce((s, p) => s + p.valor, 0);
        if (Math.abs(soma - total) > 0.01) { db.exec('ROLLBACK'); return res.status(400).json({ erro: `parcelas do lançamento "${l.nome}" somam ${soma.toFixed(2)}, mas o valor é ${total.toFixed(2)}` }); }
      }
      const ehPend = l.origem === 'pendencia' || l.origem === 'pendencia_par';
      if (ehPend) {
        const p = db.prepare('SELECT * FROM pendencias_mapa WHERE lancamento_id=?').get(l.id);
        if (!p) { pulados.push(e.id); continue; }
        const base = String(p.descricao).replace(/\s*\(\d+\/\d+\)\s*$/, '');
        if (parc.length) {                                           // re-parcela: apaga a pendência e cria N
          delPend(p);
          parc.forEach((x, i) => syncNew(ins.run(`${base} (${i + 1}/${parc.length})`, p.categoria, x.valor, x.data, p.livro, p.paralelo ? 1 : 0).lastInsertRowid));
        } else {                                                     // reagenda (data ou FLUTUA=null)
          db.prepare('UPDATE pendencias_mapa SET data=? WHERE id=?').run(e.data, p.id);
          sincronizarPendencia(db.prepare('SELECT * FROM pendencias_mapa WHERE id=?').get(p.id));
        }
        reagendados.push(e.id);
        continue;
      }
      // não-pendência: vira pendência (paralelo=1). data = apontada, herdada, ou flutuante
      const desc = String(l.nome).replace(/^\[[A-Z]\]\s*/, '');
      if (parc.length) parc.forEach((x, i) => syncNew(ins.run(`${desc} (${i + 1}/${parc.length})`, l.centro_custo || null, x.valor, x.data, l.livro || 'empresa', 1).lastInsertRowid));
      else { const data = e.herit ? l.data : e.data; syncNew(ins.run(desc, l.centro_custo || null, total, data, l.livro || 'empresa', 1).lastInsertRowid); }
      cancelarOcorrenciaR(l);
      db.prepare('DELETE FROM lancamentos WHERE id=?').run(l.id);
      movidos.push(l.id);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ erro: String(e) }); }
  res.json({ ok: true, movidos, reagendados, pulados });
});

// ---------- LANÇAMENTOS: CRUD ----------
app.post('/api/lancamentos', (req, res) => {
  const { data, nome, centro_custo, tipo, valor, prioridade, reembolso_pf } = req.body;
  const livro = livroAlvo(req);
  if (!data || !nome || !centro_custo) return res.status(400).json({ erro: 'data, nome e centro_custo são obrigatórios' });
  // "paguei pela conta pessoal": MANTÉM o centro real do gasto (folha, marketing...). Marca origem='reembolso' →
  // fica FORA DO CAIXA e ABATE da retirada consolidada (você usou o caixa da empresa que estava com você). Não é despesa nova.
  const v = reembolso_pf ? -Math.abs(Number(valor) || 0) : valorComSinal(centro_custo, valor);
  // 'ajuste de caixa' = conciliação: entra no CAIXA mas fica FORA de receitas/despesas nos relatórios
  const org = reembolso_pf ? 'reembolso' : (ehAjuste(centro_custo) ? 'ajuste' : 'manual');
  const tp = tipo || 'orçado';
  const dt = diaUtilPara(data, tp);   // orçado em sáb/dom/feriado cai no próximo dia útil
  const info = db.prepare(`INSERT INTO lancamentos (data, nome, centro_custo, tipo, valor, origem, prioridade, livro)
    VALUES (?,?,?,?,?,?,?,?)`).run(dt, nome, centro_custo, tp, v, org, prioridade || null, livro);
  res.json(db.prepare('SELECT * FROM lancamentos WHERE id=?').get(info.lastInsertRowid));
});

app.put('/api/lancamentos/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM lancamentos WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ erro: 'não encontrado' });
  const m = { ...cur, ...req.body };
  const wantR = req.body.reembolso_pf; // true = vira abatimento da retirada; false = volta ao normal; undefined = edição comum
  let centro, v, origem;
  if (wantR === true) { centro = m.centro_custo; v = -Math.abs(Number(m.valor) || 0); origem = 'reembolso'; } // mantém o centro; só marca reembolso
  else if (wantR === false) { centro = m.centro_custo; v = valorComSinal(m.centro_custo, m.valor); origem = cur.origem === 'reembolso' ? 'manual' : cur.origem; }
  else { centro = m.centro_custo; v = ('valor' in req.body || 'centro_custo' in req.body) ? valorComSinal(m.centro_custo, m.valor) : cur.valor; origem = cur.origem; }
  db.prepare(`UPDATE lancamentos SET data=?, nome=?, centro_custo=?, tipo=?, valor=?, origem=?, prioridade=?, livro=? WHERE id=?`)
    .run(diaUtilPara(m.data, m.tipo), m.nome, centro, m.tipo, v, origem, m.prioridade ?? null, m.livro || 'empresa', cur.id);
  res.json(db.prepare('SELECT * FROM lancamentos WHERE id=?').get(cur.id));
});

app.delete('/api/lancamentos/:id', (req, res) => {
  db.prepare('DELETE FROM lancamentos WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// exclusão EM LOTE (vários lançamentos selecionados de uma vez)
app.post('/api/lancamentos/excluir-lote', (req, res) => {
  const ids = (req.body?.ids || []).map(Number).filter(Number.isInteger);
  if (!ids.length) return res.status(400).json({ erro: 'nenhum id' });
  const ph = ids.map(() => '?').join(',');
  let n = 0;
  db.exec('BEGIN');
  try { n = db.prepare(`DELETE FROM lancamentos WHERE id IN (${ph})`).run(...ids).changes; db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ erro: e.message }); }
  res.json({ ok: true, excluidos: n });
});

// ---------- SÉRIES: repetir um lançamento (intervalo + fim, valor uniforme ou escalonado) ----------
// próxima data da cadência a partir de 'iso'
const proxDataSerie = (iso, freq) => {
  if (freq === 'semanal') return addDays(iso, 7);
  if (freq === 'quinzenal') return addDays(iso, 14);
  const { y, m, d } = isoToParts(iso);
  if (freq === 'anual') return partsToISO(y + 1, m, Math.min(d, ultimoDiaDoMes(y + 1, m)));
  let ny = y, nm = m + 1; if (nm > 12) { nm = 1; ny += 1; }   // mensal
  return partsToISO(ny, nm, Math.min(d, ultimoDiaDoMes(ny, nm)));
};
// datas da cadência começando em 'primeira' (inclusive) até 'ate' (inclusive)
const datasSerie = (primeira, freq, ate, teto = 400) => {
  const out = []; let cur = primeira, g = 0;
  while (cur <= ate && g++ < teto) { out.push(cur); cur = proxDataSerie(cur, freq); }
  return out;
};

// cria a série + os lançamentos. itens: [{data, valor(+)}] — o front manda as datas/valores já prontos.
app.post('/api/series', (req, res) => {
  const b = req.body || {};
  const livro = b.livro || 'empresa';
  const freq = String(b.frequencia || 'mensal');
  const tipo = b.tipo || 'orçado';
  const itens = (Array.isArray(b.itens) ? b.itens : []).filter((it) => it && it.data && Number(it.valor) > 0);
  if (!b.nome || !b.centro_custo || !itens.length) return res.status(400).json({ erro: 'dados insuficientes' });
  db.exec('BEGIN');
  try {
    const fim = b.fim || itens[itens.length - 1].data;
    const valorBase = Math.abs(Number(b.valor) || Number(itens[itens.length - 1].valor) || 0);
    const info = db.prepare(`INSERT INTO series (descricao,centro_custo,tipo,frequencia,valor,fim,livro,ativo,criado_em)
      VALUES (?,?,?,?,?,?,?,1,?)`).run(b.nome, b.centro_custo, tipo, freq, valorBase, fim, livro, hojeISO());
    const sid = info.lastInsertRowid;
    const ins = db.prepare(`INSERT INTO lancamentos (data,nome,centro_custo,tipo,valor,origem,prioridade,livro,serie_id)
      VALUES (?,?,?,?,?, 'manual', ?, ?, ?)`);
    let n = 0;
    for (const it of itens) {
      ins.run(diaUtilPara(it.data, tipo), b.nome, b.centro_custo, tipo, valorComSinal(b.centro_custo, it.valor), b.prioridade || null, livro, sid);
      n++;
    }
    db.exec('COMMIT');
    res.json({ ok: true, serie_id: sid, criados: n });
  } catch (e) { db.exec('ROLLBACK'); res.status(500).json({ erro: String(e) }); }
});

// séries que estão acabando (última ocorrência a <=45 dias) — p/ o aviso de prorrogar
app.get('/api/series/avisos', (req, res) => {
  const hoje = hojeISO();
  const limite = addDays(hoje, 45);
  const livro = livroFiltro(req);
  const rows = db.prepare(`SELECT s.*,
      (SELECT MAX(data) FROM lancamentos l WHERE l.serie_id=s.id) ultima,
      (SELECT COUNT(*) FROM lancamentos l WHERE l.serie_id=s.id AND l.data>=?) restantes
    FROM series s WHERE s.ativo=1 ${livro ? 'AND s.livro=?' : ''}`).all(...(livro ? [hoje, livro] : [hoje]));
  const avisos = rows
    .filter((r) => r.ultima && r.ultima <= limite && (!r.aviso_adiado || r.aviso_adiado < hoje))
    .map((r) => ({ id: r.id, descricao: r.descricao, frequencia: r.frequencia, ultima: r.ultima, restantes: r.restantes, valor: r.valor, fim: r.fim }));
  res.json(avisos);
});

// prorroga: cria novas ocorrências (valor uniforme = valor base) até a nova data-fim
app.post('/api/series/:id/prorrogar', (req, res) => {
  const s = db.prepare('SELECT * FROM series WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ erro: 'série não encontrada' });
  const novaFim = req.body?.fim;
  if (!novaFim) return res.status(400).json({ erro: 'informe a nova data-fim' });
  const ult = db.prepare('SELECT MAX(data) m FROM lancamentos WHERE serie_id=?').get(s.id).m || hojeISO();
  const datas = datasSerie(proxDataSerie(ult, s.frequencia), s.frequencia, novaFim);
  db.exec('BEGIN');
  try {
    const ins = db.prepare(`INSERT INTO lancamentos (data,nome,centro_custo,tipo,valor,origem,prioridade,livro,serie_id)
      VALUES (?,?,?,?,?, 'manual', NULL, ?, ?)`);
    const v = valorComSinal(s.centro_custo, s.valor);
    for (const d of datas) ins.run(diaUtilPara(d, s.tipo), s.descricao, s.centro_custo, s.tipo, v, s.livro, s.id);
    db.prepare('UPDATE series SET fim=?, aviso_adiado=NULL WHERE id=?').run(novaFim, s.id);
    db.exec('COMMIT');
    res.json({ ok: true, criados: datas.length });
  } catch (e) { db.exec('ROLLBACK'); res.status(500).json({ erro: String(e) }); }
});

// adia o aviso (não perguntar de novo por um tempo)
app.post('/api/series/:id/adiar-aviso', (req, res) => {
  db.prepare('UPDATE series SET aviso_adiado=? WHERE id=?').run(req.body?.ate || addDays(hojeISO(), 14), req.params.id);
  res.json({ ok: true });
});
// encerra: para de avisar; mantém os lançamentos já criados
app.post('/api/series/:id/encerrar', (req, res) => {
  db.prepare('UPDATE series SET ativo=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
// exclui: remove as ocorrências futuras ainda orçadas e desativa a série (não mexe no que já é 'real')
app.delete('/api/series/:id', (req, res) => {
  db.exec('BEGIN');
  try {
    const n = db.prepare("DELETE FROM lancamentos WHERE serie_id=? AND tipo<>'real'").run(req.params.id).changes;
    db.prepare('UPDATE series SET ativo=0 WHERE id=?').run(req.params.id);
    db.exec('COMMIT');
    res.json({ ok: true, excluidos: n });
  } catch (e) { db.exec('ROLLBACK'); res.status(500).json({ erro: String(e) }); }
});

// ---------- ENTRADA NOTION (experimento, tabela isolada) ----------
// lista as entradas vindas do Notion (padrão: só pendentes)
app.get('/api/notion/entradas', (req, res) => {
  const st = req.query.status || 'pendente';
  const rows = st === 'todos'
    ? db.prepare('SELECT * FROM notion_entrada ORDER BY created_at DESC, id DESC').all()
    : db.prepare('SELECT * FROM notion_entrada WHERE status=? ORDER BY created_at DESC, id DESC').all(st);
  res.json(rows);
});
// aprovar: cria um lançamento NORMAL (orçado, valor negativo, livro empresa, origem 'notion'),
// exatamente como um lançamento manual (mesma regra de dia útil e sinal). Depois o usuário ajusta na tela normal.
app.post('/api/notion/entradas/:id/aprovar', (req, res) => {
  const e = db.prepare('SELECT * FROM notion_entrada WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ erro: 'entrada não encontrada' });
  if (e.status === 'aprovado' && e.lancamento_id) return res.json({ ok: true, ja: true, lancamento_id: e.lancamento_id });
  const centro = (req.body && req.body.centro_custo) || e.centro_custo;   // permite trocar o centro ao aprovar
  if (!centro) return res.status(400).json({ erro: 'centro de custo ausente' });
  const dt = diaUtilPara(e.vencimento, 'orçado');            // mesma regra do manual
  const v = valorComSinal(centro, e.valor);                  // despesa → negativo
  db.exec('BEGIN');
  try {
    const info = db.prepare(`INSERT INTO lancamentos (data, nome, centro_custo, tipo, valor, origem, prioridade, livro)
      VALUES (?,?,?, 'orçado', ?, 'notion', NULL, 'empresa')`).run(dt, e.nome, centro, v);
    db.prepare("UPDATE notion_entrada SET status='aprovado', centro_custo=?, motivo=NULL, lancamento_id=?, notion_sync=NULL WHERE id=?")
      .run(centro, info.lastInsertRowid, e.id);
    db.exec('COMMIT');
    res.json({ ok: true, lancamento_id: info.lastInsertRowid });
  } catch (err) { db.exec('ROLLBACK'); res.status(500).json({ erro: String(err) }); }
});
// rejeitar: guarda o motivo (o job devolve ao card depois)
app.post('/api/notion/entradas/:id/rejeitar', (req, res) => {
  const e = db.prepare('SELECT * FROM notion_entrada WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ erro: 'entrada não encontrada' });
  const motivo = String((req.body && req.body.motivo) || '').trim();
  if (!motivo) return res.status(400).json({ erro: 'informe o motivo' });
  db.prepare("UPDATE notion_entrada SET status='rejeitado', motivo=?, notion_sync=NULL WHERE id=?").run(motivo, e.id);
  res.json({ ok: true });
});

// ---------- REAGENDAR EM LOTE (btnReagendar_Click) ----------
// ---------- LOCALIZADOR: acha lançamentos por palavra (p/ antecipar/postergar) ----------
app.get('/api/lancamentos/buscar', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const livro = livroFiltro(req);                       // null = todos os livros
  const soOrcado = req.query.tipo !== 'todos';          // padrão: só orçado (obrigação ainda em aberto)
  // janela padrão: 1 mês atrás → 6 meses à frente (as recorrentes se repetem por anos; sem janela vira ruído)
  const desl = (meses) => { const d = new Date(hojeISO() + 'T12:00:00'); d.setMonth(d.getMonth() + meses); return d.toISOString().slice(0, 10); };
  const de = String(req.query.de || desl(-1)), ate = String(req.query.ate || desl(6));
  // o filtro por texto é feito em JS (não no LIKE) para ignorar ACENTO: em pt-BR o usuário digita
  // "cicero"/"comissao" e precisa achar "CÍCERO"/"Comissão". A janela de datas limita o que é lido.
  const cond = [
    soOrcado ? "tipo<>'real'" : '1=1',   // <>'real' e não ='orçado': imune a variação de acento na base
    'data BETWEEN ? AND ?',
    livro ? 'livro=?' : '1=1',
  ].join(' AND ');
  const params = [de, ate];
  if (livro) params.push(livro);
  const todos = db.prepare(`SELECT id, data, nome, centro_custo, tipo, valor, livro, origem, prioridade
    FROM lancamentos WHERE ${cond} ORDER BY data, id`).all(...params);
  const norm = (s) => String(s || '').normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase();
  const alvo = norm(q);
  const hits = todos.filter((l) => norm(l.nome).includes(alvo) || norm(l.centro_custo).includes(alvo));
  res.json({ de, ate, truncado: hits.length > 100, itens: hits.slice(0, 100) });
});

app.post('/api/lancamentos/mover', (req, res) => {
  const { ids, nova_data } = req.body;
  if (!Array.isArray(ids) || !ids.length || !nova_data) return res.status(400).json({ erro: 'ids[] e nova_data são obrigatórios' });
  const upd = db.prepare('UPDATE lancamentos SET data=? WHERE id=?');
  const exGet = db.prepare('SELECT id FROM excecoes WHERE livro=? AND lower(descricao)=lower(?) AND dia_original=? AND mes_original=?');
  const exUpd = db.prepare("UPDATE excecoes SET acao='MOVER', dia_nova=?, mes_nova=? WHERE id=?");
  const exIns = db.prepare("INSERT INTO excecoes (descricao,dia_original,mes_original,acao,dia_nova,mes_nova,livro) VALUES (?,?,?,'MOVER',?,?,?)");
  db.exec('BEGIN');
  try {
    for (const id of ids) {
      const l = db.prepare('SELECT data, nome, livro, tipo FROM lancamentos WHERE id=?').get(id);
      // se soltar num sáb/dom/feriado, a obrigação vai para o próximo dia útil (o 'real' fica onde caiu)
      const destino = diaUtilPara(nova_data, l && l.tipo);
      const [, nm, nd] = destino.split('-').map(Number);
      // remanejar um [R] vira exceção persistente (sobrevive à regeração dos recorrentes)
      if (l && l.nome.startsWith('[R] ')) {
        const desc = l.nome.slice(4);
        const [, om, od] = l.data.split('-').map(Number);
        const ex = exGet.get(l.livro, desc, od, om);
        if (ex) exUpd.run(nd, nm, ex.id); else exIns.run(desc, od, om, nd, nm, l.livro);
      }
      upd.run(destino, id);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ erro: String(e) }); }
  res.json({ ok: true, movidos: ids.length });
});

// ---------- DESDOBRAR: um lançamento vira N parcelas em datas diferentes ----------
// Caso de uso: uma comissão que entra em 2 (ou mais) momentos. Cada parcela na sua data e valor.
app.post('/api/lancamentos/desdobrar', (req, res) => {
  const id = Number(req.body.id);
  const parcelas = Array.isArray(req.body.parcelas) ? req.body.parcelas : [];
  if (!id || parcelas.length < 2) return res.status(400).json({ erro: 'informe o id e ao menos 2 parcelas' });
  const l = db.prepare('SELECT * FROM lancamentos WHERE id=?').get(id);
  if (!l) return res.status(404).json({ erro: 'lançamento não encontrado' });
  // Origens gerenciadas se regeneram sozinhas (ponte de Vendas, pendências, recorrentes) — desdobrar aqui seria desfeito.
  if (l.nome.startsWith('[R] ')) return res.status(409).json({ erro: 'Este é um lançamento RECORRENTE. Ajuste o valor/data na tela de Recorrentes, não aqui.' });
  if (l.origem === 'venda') return res.status(409).json({ erro: 'Esta comissão vem de uma VENDA (sistema Vendas). O desdobramento em 2 datas precisa ser feito lá — me avise que eu ligo isso no Vendas.' });
  if (l.origem === 'pendencia') return res.status(409).json({ erro: 'Este lançamento vem do Mapa de Pendências. Ajuste por lá.' });
  // valida parcelas
  const norm = parcelas.map((p) => ({ data: String(p.data || '').trim(), valor: Math.abs(Number(p.valor) || 0) }));
  if (norm.some((p) => !/^\d{4}-\d\d-\d\d$/.test(p.data) || !p.valor)) return res.status(400).json({ erro: 'cada parcela precisa de uma data válida e um valor maior que zero' });
  const soma = norm.reduce((s, p) => s + p.valor, 0);
  const orig = Math.abs(l.valor);
  if (Math.abs(soma - orig) > 0.01) return res.status(400).json({ erro: `a soma das parcelas (${soma.toFixed(2)}) precisa bater com o valor original (${orig.toFixed(2)})`, soma, original: orig });
  const sinal = l.valor < 0 ? -1 : 1;                                  // preserva a natureza (receita + / despesa −)
  const base = l.nome.replace(/\s*\(\d+\/\d+\)\s*$/, '');              // limpa sufixo (i/N) se reprocessar
  const ins = db.prepare(`INSERT INTO lancamentos (data,nome,centro_custo,tipo,valor,origem,prioridade,livro)
    VALUES (?,?,?,?,?,?,?,?)`);
  const criados = [];
  db.exec('BEGIN');
  try {
    norm.forEach((p, i) => {
      const info = ins.run(diaUtilPara(p.data, l.tipo), `${base} (${i + 1}/${norm.length})`, l.centro_custo, l.tipo,
        sinal * p.valor, l.origem || 'manual', l.prioridade || null, l.livro);
      criados.push(info.lastInsertRowid);
    });
    db.prepare('DELETE FROM lancamentos WHERE id=?').run(id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ erro: String(e) }); }
  res.json({ ok: true, criados });
});

// ---------- PRIORIDADE (P1/P2 — substitui soma por cor) ----------
app.get('/api/prioridades', (req, res) => {
  const livro = livroDe(req);
  // ghost: fora do P1/P2 também (ids numéricos → seguro inline)
  const ghostIds = String(req.query.ghost || '').split(',').map(Number).filter(Boolean);
  // ghostr (recorrencia_id|data) resolvido p/ ids atuais — mesmo critério do /api/periodo
  const ghostRKeys = String(req.query.ghostr || '').split(',').map((s) => s.trim()).filter(Boolean);
  const allGhostIds = [...ghostIds];
  for (const k of ghostRKeys) { const [rid, dt] = k.split('|'); if (rid && dt) { for (const r of db.prepare('SELECT id FROM lancamentos WHERE recorrencia_id=? AND data=?').all(Number(rid), dt)) allGhostIds.push(r.id); } }
  // pendências (mapa) e ajuste NÃO são P1/P2: são orçamento paralelo/neutro. Sem isso o P1 do mês
  // passava do orçado (as pendências paralelas saem da despesa mas contavam no P1).
  const gExcl = (allGhostIds.length ? ` AND id NOT IN (${allGhostIds.join(',')})` : '')
    + " AND COALESCE(origem,'') NOT IN ('ajuste','pendencia','pendencia_par')";
  // prioridade só em pagamentos (valor<0). Binário: nulo/'' conta como P1 (vermelho); P2 = azul. Sem "sem prioridade".
  const P1 = `valor<0 AND (prioridade IS NULL OR prioridade='' OR prioridade='P1')${gExcl}`;
  const P2 = `valor<0 AND prioridade='P2'${gExcl}`;
  // total + quebra: real = JÁ PAGO · falta = ainda orçado
  const SEL = `COALESCE(SUM(valor),0) t,
    COALESCE(SUM(CASE WHEN tipo='real' THEN valor END),0) r,
    COALESCE(SUM(CASE WHEN tipo<>'real' THEN valor END),0) o`;
  const out = (a1, a2) => res.json({
    P1: a1.t, P2: a2.t,
    P1_real: a1.r, P1_falta: a1.o,
    P2_real: a2.r, P2_falta: a2.o,
  });
  // modo janela de datas (de/ate): casa com /api/periodo quando há recorte (ex.: "resto do mês")
  if (req.query.de && req.query.ate) {
    const { de, ate } = req.query;
    const q = (cond) => db.prepare(`SELECT ${SEL} FROM lancamentos WHERE livro=? AND ${cond} AND data BETWEEN ? AND ?`).get(livro, de, ate);
    return out(q(P1), q(P2));
  }
  // modo período (start + semanas, seg–dom): casa exatamente com /api/periodo — inclui o fim de
  // semana, senão uma obrigação caindo no sábado ficava fora do P1/P2 mas dentro do caixa
  if (req.query.start) {
    const n = Math.max(1, Math.min(6, parseInt(req.query.semanas || '1') || 1));
    const seg0 = segundaDaSemana(req.query.start);
    const datas = [];
    for (let w = 0; w < n; w++) for (let i = 0; i < 7; i++) datas.push(addDays(addDays(seg0, w * 7), i));
    const ph = datas.map(() => '?').join(',');
    const q = (cond) => db.prepare(`SELECT ${SEL} FROM lancamentos WHERE livro=? AND ${cond} AND data IN (${ph})`).get(livro, ...datas);
    return out(q(P1), q(P2));
  }
  // modo mês (compatível com chamadas antigas)
  const mes = req.query.mes;
  const where = mes ? "AND substr(data,1,7)=?" : '';
  const params = mes ? [mes] : [];
  const q = (cond) => db.prepare(`SELECT ${SEL} FROM lancamentos WHERE livro=? AND ${cond} ${where}`).get(livro, ...params);
  out(q(P1), q(P2));
});

// ---------- ÂNCORA DE CAIXA por livro (saldo real numa data) ----------
app.put('/api/config/ancora', (req, res) => {
  const livro = livroAlvo(req);
  if (req.body.data) db.prepare('UPDATE livros SET ancora_data=? WHERE id=?').run(String(req.body.data), livro);
  if (req.body.valor !== undefined) db.prepare('UPDATE livros SET ancora_valor=? WHERE id=?').run(Number(req.body.valor) || 0, livro);
  res.json({ ok: true, ancora: ancora(livro), caixa_hoje: caixaRealAteDia(hojeISO(), livro) });
});

// ---------- LIVROS (caixas) ----------
app.get('/api/livros', (req, res) => res.json(db.prepare('SELECT id, nome, ancora_data, ancora_valor FROM livros ORDER BY ordem, id').all()));

// Backup automático do banco: snapshot a cada start + a cada 6h, mantém os 30 mais recentes.
function backupDb() {
  try {
    const dir = resolve(dirname(DB_PATH), 'backups'); // backups ao lado do banco (disco persistente na nuvem)
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace('T', '_').replace(/:/g, '-').slice(0, 19);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    copyFileSync(DB_PATH, resolve(dir, `fluxo-${ts}.db`));
    const files = readdirSync(dir).filter((f) => f.startsWith('fluxo-') && f.endsWith('.db')).sort();
    for (const f of files.slice(0, -30)) rmSync(resolve(dir, f));
    console.log(`Backup do banco salvo (data/backups/fluxo-${ts}.db)`);
  } catch (e) { console.error('Backup falhou:', e.message); }
}

// ---------- FATURAMENTO REAL (consolidado) ----------
// "Quanto a empresa realmente fatura no mês", por COMPETÊNCIA, somando:
// comissão de vendas + comissão de locações + receita marginal (do módulo Sales) + administração
// de imóveis. Independe da data de recebimento no caixa.
const VENDAS_DB = process.env.VENDAS_DB || resolve(__dirname, '..', '..', 'vendas', 'data', 'vendas.db');
app.get('/api/faturamento-real', (req, res) => {
  const ano = parseInt(req.query.ano) || new Date().getFullYear();
  const meses = Array.from({ length: 12 }, (_, i) => ({
    mes: i + 1, vendas: 0, locacoes: 0, marginal: 0, adm: 0, total: 0,
  }));
  // ADMINISTRAÇÃO: valor digitado à mão por mês (tabela faturamento_adm). Não vem do caixa nem do
  // aluguel/repasse — é só o que você informa que recebeu de adm. Entra apenas neste relatório.
  for (const r of db.prepare('SELECT mes, valor FROM faturamento_adm WHERE ano=?').all(ano)) {
    const m = meses[r.mes - 1]; if (m) m.adm = r.valor;
  }
  // VENDAS/LOCAÇÕES/MARGINAL: do módulo Sales, MESMO critério do Funil e do Dashboard —
  // só o faturamento REAL (venda ASSINADA). Nada de previsto/futuro (quente marcada não entra).
  let fonteVendas = false;
  if (existsSync(VENDAS_DB)) {
    const CRIT = "status='ASSINADA'";
    try {
      const vdb = new DatabaseSync(VENDAS_DB);
      vdb.exec('PRAGMA busy_timeout = 3000;');
      for (const r of vdb.prepare(`SELECT mes, segmento, COALESCE(SUM(faturamento),0) fat
          FROM vendas WHERE ano=? AND ${CRIT} GROUP BY mes, segmento`).all(ano)) {
        const m = meses[r.mes - 1]; if (!m) continue;
        if (r.segmento === 'locacao') m.locacoes += r.fat; else m.vendas += r.fat;
      }
      for (const r of vdb.prepare(`SELECT v.mes, COALESCE(SUM(rm.valor),0) val
          FROM receitas_marginais rm JOIN vendas v ON v.id = rm.venda_id
          WHERE v.ano=? AND ${CRIT.replace(/\b(status|recebido|mapa_calor|prever_caixa)\b/g, 'v.$1')} GROUP BY v.mes`).all(ano)) {
        const m = meses[r.mes - 1]; if (m) m.marginal += r.val;
      }
      fonteVendas = true;
    } catch (e) { console.warn('faturamento-real: leitura de vendas.db falhou:', e.message); }
  }
  let total = 0;
  for (const m of meses) { m.total = m.vendas + m.locacoes + m.marginal + m.adm; total += m.total; }
  res.json({ ano, meses, total, fonte: fonteVendas });
});

// grava (à mão) a receita de administração de um mês — só compõe o Faturamento Real
app.post('/api/faturamento-real/adm', (req, res) => {
  const ano = parseInt(req.body.ano), mes = parseInt(req.body.mes);
  const valor = Number(req.body.valor) || 0;
  if (!ano || !(mes >= 1 && mes <= 12)) return res.status(400).json({ erro: 'ano e mes (1-12) são obrigatórios' });
  if (valor) db.prepare('INSERT INTO faturamento_adm (ano,mes,valor) VALUES (?,?,?) ON CONFLICT(ano,mes) DO UPDATE SET valor=excluded.valor').run(ano, mes, valor);
  else db.prepare('DELETE FROM faturamento_adm WHERE ano=? AND mes=?').run(ano, mes);  // zero limpa
  res.json({ ok: true, ano, mes, valor });
});

export { app };

// roda standalone só quando executado diretamente (não quando montado no ZAHAV)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const PORT = process.env.PORT || 5180;
  app.listen(PORT, () => {
    backupDb();
    setInterval(backupDb, 6 * 60 * 60 * 1000); // a cada 6h enquanto estiver aberto
    console.log(`Fluxo de Caixa ImovelUm rodando em http://localhost:${PORT}`);
  });
}
