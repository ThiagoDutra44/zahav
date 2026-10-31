import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync, readdirSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openDb, DB_PATH, SCHEMA, CENTROS, TIPOS_CUSTO, GRUPOS_RECEITA, MESES } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = openDb();

// ---------- PONTE COM VENDAS: "Atual" = média dos 2 meses fechados (real) ----------
const VENDAS_DB = process.env.VENDAS_DB || resolve(__dirname, '..', '..', 'vendas', 'data', 'vendas.db');
const normNome = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
// os 2 meses fechados mais recentes (exclui o mês em curso), rola sozinho
function mesesFechados(ref = new Date()) {
  const y = ref.getFullYear(), m = ref.getMonth() + 1;
  const out = [];
  for (let k = 1; k <= 2; k++) { let mm = m - k, yy = y; while (mm <= 0) { mm += 12; yy -= 1; } out.push({ ano: yy, mes: mm }); }
  return out;
}
// lê o Vendas e devolve, por unidade (filial), a média mensal de VGV + comissão real + cota %
function atualReal() {
  if (!existsSync(VENDAS_DB)) return null;
  let vdb;
  try {
    vdb = new DatabaseSync(VENDAS_DB);
    const meses = mesesFechados();
    const cond = meses.map(() => '(ano=? AND mes=?)').join(' OR ');
    const rows = vdb.prepare(`SELECT filial, SUM(vgv) vgv, SUM(faturamento) fat, COUNT(*) n
      FROM vendas WHERE status='ASSINADA' AND segmento='venda' AND (${cond}) GROUP BY filial`).all(...meses.flatMap((x) => [x.ano, x.mes]));
    const unidades = rows.filter((r) => r.filial && r.vgv > 0).map((r) => ({
      unidade: r.filial, chave: normNome(r.filial),
      vgv_mes: r.vgv / meses.length,
      comissao_pct: r.vgv ? +(r.fat / r.vgv * 100).toFixed(4) : 0,
      n: r.n,
    }));
    const vgvTot = unidades.reduce((a, u) => a + u.vgv_mes, 0);
    unidades.forEach((u) => (u.cota = vgvTot ? u.vgv_mes / vgvTot : 0));
    const comissao_media = vgvTot ? unidades.reduce((a, u) => a + u.vgv_mes * u.comissao_pct / 100, 0) / vgvTot : 0;
    unidades.sort((a, b) => b.vgv_mes - a.vgv_mes);
    return { unidades, vgv_mes: vgvTot, comissao_media, meses };
  } catch (e) { console.warn('atualReal (vendas) falhou:', e.message); return null; }
  finally { try { vdb && vdb.close(); } catch {} }
}
// VGV/faturamento projetado do ANO = realizado YTD (meses fechados) + média mensal × meses restantes,
// por filial, aplicando o % de comissão REAL de cada uma.
function projecaoAno(anoRef) {
  if (!existsSync(VENDAS_DB)) return null;
  let vdb;
  try {
    vdb = new DatabaseSync(VENDAS_DB);
    const now = new Date();
    const nFech = (anoRef === now.getFullYear()) ? now.getMonth() : 12; // meses fechados (jan..mês anterior); ano passado inteiro = 12
    if (nFech < 1) return null;
    const restam = 12 - nFech;
    const rows = vdb.prepare(`SELECT filial, SUM(vgv) vgv, SUM(faturamento) fat FROM vendas
      WHERE ano=? AND status='ASSINADA' AND segmento='venda' AND mes<=? GROUP BY filial`).all(anoRef, nFech);
    let vgv_ano = 0, fat_ano = 0, realVgv = 0, realFat = 0;
    for (const r of rows) {
      const media = r.vgv / nFech;
      const projVgv = r.vgv + media * restam;
      const pct = r.vgv ? r.fat / r.vgv : 0;
      vgv_ano += projVgv; fat_ano += projVgv * pct;
      realVgv += r.vgv; realFat += r.fat;
    }
    if (!realVgv) return null;
    return { vgv_ano, fat_ano, realizado_vgv: realVgv, realizado_fat: realFat, comissao_media: realFat / realVgv, n_fechados: nFech, restam };
  } catch (e) { console.warn('projecaoAno falhou:', e.message); return null; }
  finally { try { vdb && vdb.close(); } catch {} }
}
// ---------- PONTE COM CASH FLOW: break-even de caixa ----------
// Custo REAL (sem 'repasses') × previsão de recebimento (receitas sem 'receita · PJ BANK'), do mês.
const FLUXO_DB = process.env.FLUXO_DB || resolve(__dirname, '..', '..', 'fluxo-caixa', 'data', 'fluxo.db');
function breakEvenCaixa() {
  if (!existsSync(FLUXO_DB)) return null;
  let fdb;
  try {
    fdb = new DatabaseSync(FLUXO_DB);
    const now = new Date();
    const ym = (m, y) => { while (m <= 0) { m += 12; y -= 1; } return `${y}-${String(m).padStart(2, '0')}`; };
    const mCorr = ym(now.getMonth() + 1, now.getFullYear()), mAnt = ym(now.getMonth(), now.getFullYear());
    // 'ajuste' (conciliação de caixa) é neutro: fora de custo e de recebimento
    const base = "livro='empresa' AND COALESCE(origem,'') NOT IN ('reembolso','ajuste') AND substr(data,1,7)=?";
    const custo = (m, tipo) => fdb.prepare(`SELECT COALESCE(SUM(valor),0) s FROM lancamentos WHERE ${base} AND valor<0 AND centro_custo<>'repasses'${tipo ? " AND tipo=?" : ''}`).get(...(tipo ? [m, tipo] : [m])).s;
    const receb = (m, tipo) => fdb.prepare(`SELECT COALESCE(SUM(valor),0) s FROM lancamentos WHERE ${base} AND valor>0 AND centro_custo<>'receita · PJ BANK'${tipo ? " AND tipo=?" : ''}`).get(...(tipo ? [m, tipo] : [m])).s;
    const cR = custo(mCorr, 'real'), cO = custo(mCorr, 'orçado'), rR = receb(mCorr, 'real'), rO = receb(mCorr, 'orçado');
    const cTot = cR + cO, rTot = rR + rO;
    const acCusto = custo(mAnt, 'real'), acReceb = receb(mAnt, 'real');
    const corrente = { ym: mCorr, custo_real: cR, custo_orcado: cO, custo_total: cTot, receb_real: rR, receb_orcado: rO, receb_total: rTot,
      resultado: +(rTot + cTot).toFixed(2), breakeven: +Math.abs(cTot).toFixed(2), falta: +Math.max(0, Math.abs(cTot) - rTot).toFixed(2) };
    const anterior = { ym: mAnt, custo: acCusto, recebimento: acReceb, resultado: +(acReceb + acCusto).toFixed(2) };
    return { corrente, anterior, acumulo: +(anterior.resultado + corrente.resultado).toFixed(2) };
  } catch (e) { console.warn('breakEvenCaixa (fluxo) falhou:', e.message); return null; }
  finally { try { fdb && fdb.close(); } catch {} }
}
db.exec(SCHEMA);
const PUBLIC = resolve(__dirname, '..', 'public');
const app = express();
app.use(express.json());
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

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const up = (s) => (s ? String(s).toUpperCase().replace(/\s+/g, ' ').trim() : null);
const anoDe = (req) => parseInt(req.query.ano) || new Date().getFullYear();
const COLM = MESES.map((_, i) => 'm' + String(i + 1).padStart(2, '0')); // m01..m12
const somaMeses = (row) => COLM.reduce((a, c) => a + num(row[c]), 0);

// Mantém a categoria "FOLHA DE PAGAMENTO" (MATRIZ) igual ao total dos colaboradores ativos.
function sincronizaFolha(ano) {
  const total = db.prepare('SELECT COALESCE(SUM(salario),0) t FROM colaboradores WHERE ano=? AND ativo=1').get(ano).t;
  const existe = db.prepare("SELECT id FROM custos WHERE ano=? AND categoria='FOLHA DE PAGAMENTO'").get(ano);
  if (existe) db.prepare('UPDATE custos SET valor=?, origem=? WHERE id=?').run(total, 'folha', existe.id);
  else db.prepare(`INSERT INTO custos (ano, centro_custo, categoria, valor, tipo, origem, ordem)
    VALUES (?, 'MATRIZ', 'FOLHA DE PAGAMENTO', ?, 'fixo', 'folha', 0)`).run(ano, total);
  return total;
}

// ---------- META ----------
app.get('/api/meta', (req, res) => {
  const anos = db.prepare(`SELECT ano FROM (
      SELECT ano FROM custos UNION SELECT ano FROM previsoes UNION SELECT ano FROM colaboradores UNION SELECT ano FROM cenarios
    ) GROUP BY ano ORDER BY ano DESC`).all().map((r) => r.ano);
  if (!anos.includes(new Date().getFullYear())) anos.unshift(new Date().getFullYear());
  const _h = new Date(), _p = (n) => String(n).padStart(2, '0');
  const hojeLocal = `${_h.getFullYear()}-${_p(_h.getMonth() + 1)}-${_p(_h.getDate())}`;  // local, não UTC
  res.json({ hoje: hojeLocal, anos, centros: CENTROS, tipos: TIPOS_CUSTO, grupos: GRUPOS_RECEITA, meses: MESES });
});

// ---------- CUSTOS (aba ORÇADO) ----------
app.get('/api/custos', (req, res) => {
  res.json(db.prepare('SELECT * FROM custos WHERE ano=? ORDER BY centro_custo, ordem, id').all(anoDe(req)));
});
app.post('/api/custos', (req, res) => {
  const b = req.body || {};
  if (!b.categoria) return res.status(400).json({ erro: 'categoria é obrigatória' });
  const info = db.prepare(`INSERT INTO custos (ano, centro_custo, categoria, valor, tipo, ordem)
    VALUES (?,?,?,?,?,?)`).run(
    parseInt(b.ano) || new Date().getFullYear(), up(b.centro_custo) || 'MATRIZ',
    up(b.categoria), num(b.valor), (b.tipo === 'variavel' ? 'variavel' : 'fixo'), parseInt(b.ordem) || 0);
  res.json(db.prepare('SELECT * FROM custos WHERE id=?').get(info.lastInsertRowid));
});
app.put('/api/custos/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM custos WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ erro: 'não encontrado' });
  const m = { ...cur, ...req.body };
  db.prepare('UPDATE custos SET centro_custo=?, categoria=?, valor=?, tipo=?, ativo=? WHERE id=?').run(
    up(m.centro_custo), up(m.categoria), num(m.valor), (m.tipo === 'variavel' ? 'variavel' : 'fixo'), m.ativo ? 1 : 0, cur.id);
  res.json(db.prepare('SELECT * FROM custos WHERE id=?').get(cur.id));
});
app.delete('/api/custos/:id', (req, res) => {
  db.prepare('DELETE FROM custos WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- COLABORADORES (folha) ----------
app.get('/api/colaboradores', (req, res) => {
  res.json(db.prepare('SELECT * FROM colaboradores WHERE ano=? ORDER BY ordem, id').all(anoDe(req)));
});
app.post('/api/colaboradores', (req, res) => {
  const b = req.body || {};
  if (!b.nome) return res.status(400).json({ erro: 'nome é obrigatório' });
  const ano = parseInt(b.ano) || new Date().getFullYear();
  const info = db.prepare('INSERT INTO colaboradores (ano, nome, cargo, salario, ativo, ordem) VALUES (?,?,?,?,?,?)').run(
    ano, up(b.nome), up(b.cargo), num(b.salario), b.ativo === 0 ? 0 : 1, parseInt(b.ordem) || 0);
  sincronizaFolha(ano);
  res.json(db.prepare('SELECT * FROM colaboradores WHERE id=?').get(info.lastInsertRowid));
});
app.put('/api/colaboradores/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM colaboradores WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ erro: 'não encontrado' });
  const m = { ...cur, ...req.body };
  db.prepare('UPDATE colaboradores SET nome=?, cargo=?, salario=?, ativo=? WHERE id=?').run(
    up(m.nome), up(m.cargo), num(m.salario), m.ativo ? 1 : 0, cur.id);
  sincronizaFolha(cur.ano);
  res.json(db.prepare('SELECT * FROM colaboradores WHERE id=?').get(cur.id));
});
app.delete('/api/colaboradores/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM colaboradores WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM colaboradores WHERE id=?').run(req.params.id);
  if (cur) sincronizaFolha(cur.ano);
  res.json({ ok: true });
});
// reordena a folha: recebe os ids na ordem desejada e grava 'ordem' = posição
app.post('/api/colaboradores/reordenar', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ erro: 'ids[] é obrigatório' });
  const upd = db.prepare('UPDATE colaboradores SET ordem=? WHERE id=?');
  db.exec('BEGIN');
  try { ids.forEach((id, i) => upd.run(i + 1, id)); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ erro: String(e) }); }
  res.json({ ok: true });
});

// ---------- PREVISÕES (aba PREVISIBILIDADES) ----------
app.get('/api/previsoes', (req, res) => {
  const rows = db.prepare('SELECT * FROM previsoes WHERE ano=? ORDER BY grupo, ordem, id').all(anoDe(req));
  res.json(rows.map((r) => ({ ...r, total: somaMeses(r), faturamento: +(somaMeses(r) * r.comissao_pct / 100).toFixed(2) })));
});
app.post('/api/previsoes', (req, res) => {
  const b = req.body || {};
  if (!b.canal) return res.status(400).json({ erro: 'canal é obrigatório' });
  const ano = parseInt(b.ano) || new Date().getFullYear();
  const grupo = GRUPOS_RECEITA.includes(b.grupo) ? b.grupo : 'venda';
  const info = db.prepare(`INSERT INTO previsoes
    (ano, grupo, canal, comissao_pct, ${COLM.join(',')}, ordem)
    VALUES (?,?,?,?, ${COLM.map(() => '?').join(',')}, ?)`).run(
    ano, grupo, up(b.canal), num(b.comissao_pct), ...COLM.map((c) => num(b[c])), parseInt(b.ordem) || 0);
  const r = db.prepare('SELECT * FROM previsoes WHERE id=?').get(info.lastInsertRowid);
  res.json({ ...r, total: somaMeses(r), faturamento: +(somaMeses(r) * r.comissao_pct / 100).toFixed(2) });
});
app.put('/api/previsoes/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM previsoes WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ erro: 'não encontrada' });
  const m = { ...cur, ...req.body };
  const grupo = GRUPOS_RECEITA.includes(m.grupo) ? m.grupo : 'venda';
  db.prepare(`UPDATE previsoes SET grupo=?, canal=?, comissao_pct=?, ativo=?, ${COLM.map((c) => c + '=?').join(',')} WHERE id=?`).run(
    grupo, up(m.canal), num(m.comissao_pct), m.ativo ? 1 : 0, ...COLM.map((c) => num(m[c])), cur.id);
  const r = db.prepare('SELECT * FROM previsoes WHERE id=?').get(cur.id);
  res.json({ ...r, total: somaMeses(r), faturamento: +(somaMeses(r) * r.comissao_pct / 100).toFixed(2) });
});
app.delete('/api/previsoes/:id', (req, res) => {
  db.prepare('DELETE FROM previsoes WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- CENÁRIOS (aba RESULTADO MÊS) ----------
function resultadoCenario(cen, custoMensal) {
  const linhas = db.prepare('SELECT * FROM cenario_linhas WHERE cenario_id=? ORDER BY ordem, id').all(cen.id);
  let vgv = 0, receita = 0;
  for (const l of linhas) { vgv += num(l.vgv); receita += num(l.vgv) * num(l.comissao_pct) / 100 + num(l.receita_fixa); }
  return { ...cen, linhas, vgv, receita: +receita.toFixed(2), custo: custoMensal, resultado: +(receita - custoMensal).toFixed(2) };
}
app.get('/api/cenarios', (req, res) => {
  const ano = anoDe(req);
  const custoMensal = db.prepare('SELECT COALESCE(SUM(valor),0) t FROM custos WHERE ano=? AND ativo=1').get(ano).t;
  const cens = db.prepare('SELECT * FROM cenarios WHERE ano=? ORDER BY ordem, id').all(ano);
  const real = atualReal();
  res.json(cens.map((c, i) => {
    // 1º cenário = "Atual" reflete o REAL (média 2 meses fechados do Vendas); preserva as linhas de receita fixa (ADM/Locações)
    if (i === 0 && real && real.unidades.length) {
      const vendasLinhas = real.unidades.map((u, k) => ({ id: 'real-' + k, unidade: u.unidade, vgv: +u.vgv_mes.toFixed(2), comissao_pct: u.comissao_pct, receita_fixa: 0 }));
      const fixas = db.prepare('SELECT id, unidade, vgv, comissao_pct, receita_fixa FROM cenario_linhas WHERE cenario_id=? AND receita_fixa>0 ORDER BY ordem, id').all(c.id);
      const linhas = [...vendasLinhas, ...fixas];
      let vgv = 0, receita = 0;
      for (const l of linhas) { vgv += num(l.vgv); receita += num(l.vgv) * num(l.comissao_pct) / 100 + num(l.receita_fixa); }
      return { ...c, linhas, vgv, receita: +receita.toFixed(2), custo: custoMensal, resultado: +(receita - custoMensal).toFixed(2), readonly: true, meses: real.meses };
    }
    return resultadoCenario(c, custoMensal);
  }));
});
app.put('/api/cenario_linhas/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM cenario_linhas WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ erro: 'não encontrada' });
  const m = { ...cur, ...req.body };
  db.prepare('UPDATE cenario_linhas SET unidade=?, vgv=?, comissao_pct=?, receita_fixa=? WHERE id=?').run(
    up(m.unidade), num(m.vgv), num(m.comissao_pct), num(m.receita_fixa), cur.id);
  res.json(db.prepare('SELECT * FROM cenario_linhas WHERE id=?').get(cur.id));
});

// ---------- PREMISSAS (comissão por praça + parâmetros) ----------
app.get('/api/premissas', (req, res) => {
  res.json(db.prepare('SELECT * FROM premissas WHERE ano=? ORDER BY chave').all(anoDe(req)));
});
app.put('/api/premissas/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM premissas WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ erro: 'não encontrada' });
  db.prepare('UPDATE premissas SET valor=? WHERE id=?').run(num(req.body.valor), cur.id);
  res.json(db.prepare('SELECT * FROM premissas WHERE id=?').get(cur.id));
});

// ---------- DASHBOARD (viabilidade do ano) ----------
app.get('/api/dashboard', (req, res) => {
  const ano = anoDe(req);
  // custos por centro
  const porCentroRows = db.prepare('SELECT centro_custo, COALESCE(SUM(valor),0) total FROM custos WHERE ano=? AND ativo=1 GROUP BY centro_custo').all(ano);
  const custoMensal = porCentroRows.reduce((a, r) => a + r.total, 0);
  const custoFixo = db.prepare("SELECT COALESCE(SUM(valor),0) t FROM custos WHERE ano=? AND ativo=1 AND tipo='fixo'").get(ano).t;
  const custoVar = custoMensal - custoFixo;

  // receita projetada por mês (todas as previsões) e por grupo
  const prev = db.prepare('SELECT * FROM previsoes WHERE ano=? AND ativo=1').all(ano);
  const recPorMes = COLM.map(() => 0);
  let vgvAnual = 0, fatAnual = 0;
  const porGrupo = {};
  for (const p of prev) {
    const soma = somaMeses(p);
    vgvAnual += soma;
    const f = soma * p.comissao_pct / 100;
    fatAnual += f;
    porGrupo[p.grupo] = (porGrupo[p.grupo] || 0) + f;
    COLM.forEach((c, i) => { recPorMes[i] += num(p[c]) * p.comissao_pct / 100; });
  }
  // VGV/faturamento ANUAL: projeção REAL (realizado YTD + média × meses restantes, comissões reais). Fallback = previsões (plano).
  const proj = projecaoAno(ano);
  let comissaoAnoPct = null, projFonte = 'previsoes';
  if (proj) { vgvAnual = proj.vgv_ano; fatAnual = proj.fat_ano; comissaoAnoPct = +(proj.comissao_media * 100).toFixed(2); projFonte = 'real'; }
  const por_mes = MESES.map((nome, i) => ({
    mes: i + 1, nome, receita: +recPorMes[i].toFixed(2),
    custo: +custoMensal.toFixed(2), resultado: +(recPorMes[i] - custoMensal).toFixed(2),
  }));

  // break-even mensal (aba EQUILÍBRIO): (custo - receita não-comissão) / comissão média PONDERADA pela cota.
  // "Atual" = média REAL dos 2 meses fechados (puxada do Vendas, por unidade/filial). Se indisponível → cenário manual.
  const recNaoCom = db.prepare("SELECT valor FROM premissas WHERE ano=? AND chave='param:receita_nao_comissao'").get(ano)?.valor || 0;
  const real = atualReal();
  let comissaoMedia = 0, vgvAtual = 0, atualUnidades = [], atualFonte = 'manual', atualMeses = null;
  if (real && real.unidades.length) {
    comissaoMedia = real.comissao_media; vgvAtual = real.vgv_mes;
    atualUnidades = real.unidades; atualFonte = 'real'; atualMeses = real.meses;
  } else {
    const atual = db.prepare('SELECT id FROM cenarios WHERE ano=? ORDER BY ordem, id LIMIT 1').get(ano);
    let comAtual = 0;
    if (atual) {
      for (const l of db.prepare('SELECT unidade, vgv, comissao_pct FROM cenario_linhas WHERE cenario_id=?').all(atual.id)) {
        vgvAtual += l.vgv; comAtual += l.vgv * l.comissao_pct / 100;
        if (l.vgv > 0) atualUnidades.push({ unidade: l.unidade, vgv_mes: l.vgv, comissao_pct: l.comissao_pct });
      }
    }
    comissaoMedia = vgvAtual ? comAtual / vgvAtual : 0;
    atualUnidades.forEach((u) => (u.cota = vgvAtual ? u.vgv_mes / vgvAtual : 0));
  }
  const comissaoCobrir = Math.max(0, custoMensal - recNaoCom);
  const breakeven_vgv = comissaoMedia ? comissaoCobrir / comissaoMedia : 0;
  // break-even por unidade = cota × total (quanto cada uma precisa vender p/ empatar)
  const breakeven_por_unidade = atualUnidades.map((u) => ({
    unidade: u.unidade, cota: +(u.cota * 100).toFixed(1),
    vgv_atual: +u.vgv_mes.toFixed(2), comissao_pct: +Number(u.comissao_pct).toFixed(2),
    breakeven: +(breakeven_vgv * u.cota).toFixed(2),
    falta: +Math.max(0, breakeven_vgv * u.cota - u.vgv_mes).toFixed(2),
  }));

  const custoAnual = custoMensal * 12;
  res.json({
    ano,
    custo_mensal: +custoMensal.toFixed(2), custo_anual: +custoAnual.toFixed(2),
    custo_fixo: +custoFixo.toFixed(2), custo_variavel: +custoVar.toFixed(2),
    por_centro: porCentroRows,
    vgv_anual: +vgvAnual.toFixed(2), faturamento_anual: +fatAnual.toFixed(2),
    resultado_anual: +(fatAnual - custoAnual).toFixed(2),
    faturamento_mensal_medio: +(fatAnual / 12).toFixed(2),
    margem_pct: fatAnual ? +((fatAnual - custoAnual) / fatAnual * 100).toFixed(1) : 0,
    vgv_ano_fonte: projFonte,                                    // 'real' (realizado YTD + run-rate) ou 'previsoes'
    comissao_ano_pct: comissaoAnoPct,                            // % comissão real do ano (YTD), quando fonte=real
    realizado_ytd: proj ? +proj.realizado_vgv.toFixed(2) : null,
    meses_fechados: proj ? proj.n_fechados : null,
    comissao_media_pct: +(comissaoMedia * 100).toFixed(2),
    vgv_atual: +vgvAtual.toFixed(2),
    receita_nao_comissao: +recNaoCom.toFixed(2),
    breakeven_vgv: +breakeven_vgv.toFixed(2),
    breakeven_por_unidade,
    breakeven_caixa: breakEvenCaixa(),   // custo real (Cash Flow, sem repasses) × previsão de recebimento (sem PJ Bank)
    atual_fonte: atualFonte,          // 'real' (média 2 meses do Vendas) ou 'manual'
    atual_meses: atualMeses,          // quais 2 meses fechados foram usados
    por_grupo: GRUPOS_RECEITA.map((g) => ({ grupo: g, faturamento: +(porGrupo[g] || 0).toFixed(2) })),
    por_mes,
  });
});

// Backup automático: snapshot a cada start + a cada 6h, mantém os 30 mais recentes.
function backupDb() {
  try {
    const dir = resolve(dirname(DB_PATH), 'backups'); // backups ao lado do banco (disco persistente na nuvem)
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace('T', '_').replace(/:/g, '-').slice(0, 19);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    copyFileSync(DB_PATH, resolve(dir, `viabilidade-${ts}.db`));
    const files = readdirSync(dir).filter((f) => f.startsWith('viabilidade-') && f.endsWith('.db')).sort();
    for (const f of files.slice(0, -30)) rmSync(resolve(dir, f));
    console.log(`Backup do banco salvo (data/backups/viabilidade-${ts}.db)`);
  } catch (e) { console.error('Backup falhou:', e.message); }
}

export { app };

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const PORT = process.env.PORT || 5182;
  app.listen(PORT, () => {
    backupDb();
    setInterval(backupDb, 6 * 60 * 60 * 1000);
    console.log(`Viabilidade ImovelUm rodando em http://localhost:${PORT}`);
  });
}
