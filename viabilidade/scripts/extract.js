// Extrai os dados da planilha de viabilidade (estrutura nova: 1 aba por filial + PAGA?)
// para data/seed.json. Uso: node scripts/extract.js ["C:/caminho/para/arquivo.xlsx"]
import XLSX from 'xlsx';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = process.argv[2] || 'C:/FINANCEIRO 2026/FINANCEIRO_VIABILIDADE_2026_3.xlsx';
const ANO = 2026;

const clean = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v);
const up = (v) => String(clean(v) || '').toUpperCase();
function num(v) {
  if (v === '' || v === null || v === undefined) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  let s = String(v).replace(/[R$\s%]/g, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
// "SIM"/"NÃO" -> 1/0 (coluna PAGA?)
const paga = (v) => (up(v) === 'SIM' ? 1 : 0);

const wb = XLSX.readFile(SRC);
function grid(name) {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  const r = XLSX.utils.decode_range(ws['!ref']);
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: r.e });
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: true });
}
// acha a linha do cabeçalho que contém um texto (ex.: "ITEM") e retorna {row, col}
function acha(g, txt, colMax = 6) {
  for (let i = 0; i < g.length; i++)
    for (let c = 0; c <= colMax; c++)
      if (up(g[i][c]) === txt) return { row: i, col: c };
  return null;
}
const PARAR = ['DESEMBOLSO', 'SUBTOTAL', 'TOTAL'];
const ehParada = (s) => PARAR.some((p) => up(s).startsWith(p));

// ---------- CENTROS DE CUSTO (abas MATRIZ, BARRA, COPACABANA, VILA OLÍMPIA) ----
const ABAS_CENTRO = [
  { aba: 'MATRIZ', centro: 'MATRIZ', tipo: 'fixo' },
  { aba: 'BARRA', centro: 'BARRA', tipo: 'variavel' },
  { aba: 'COPACABANA', centro: 'COPACABANA', tipo: 'variavel' },
  { aba: 'VILA OLÍMPIA', centro: 'VILA OLÍMPIA', tipo: 'variavel' },
];
const custos = [];
const colaboradores = [];
for (const { aba, centro, tipo } of ABAS_CENTRO) {
  const g = grid(aba);
  // bloco de itens: cabeçalho tem "PAGA?" (col D); categoria 2 cols à esquerda, valor 1 à esquerda
  const h = acha(g, 'PAGA?', 4);
  if (h && h.col >= 2) {
    const catC = h.col - 2, valC = h.col - 1, pagaC = h.col;
    let ordem = 0;
    for (let i = h.row + 1; i < g.length; i++) {
      const cat = clean(g[i][catC]);
      if (!cat) continue;
      if (ehParada(cat)) break;
      custos.push({
        ano: ANO, centro_custo: centro, categoria: up(cat),
        valor: num(g[i][valC]), tipo, ativo: paga(g[i][pagaC]), ordem: ordem++,
      });
    }
  }
  // MATRIZ também tem o bloco FOLHA DE PAGAMENTO (nome, cargo, R$/mês, PAGA?)
  if (aba === 'MATRIZ') {
    const f = acha(g, 'FOLHA DE PAGAMENTO', 10);
    if (f) {
      let ordem = 0;
      for (let i = f.row + 1; i < g.length; i++) {
        const nome = clean(g[i][f.col]);
        if (!nome) continue;
        if (ehParada(nome) || up(nome) === 'CARGO') break;
        colaboradores.push({
          ano: ANO, nome: up(nome), cargo: up(g[i][f.col + 1]),
          salario: num(g[i][f.col + 2]), ativo: paga(g[i][f.col + 3]), ordem: ordem++,
        });
      }
    }
  }
}

// ---------- PREMISSAS (% comissão por praça + parâmetros) ---------------------
const premissas = [];
{
  const g = grid('PREMISSAS');
  const h = acha(g, '% COMISSÃO POR PRAÇA', 4);
  if (h) {
    for (let i = h.row + 1; i < g.length; i++) {
      const praca = clean(g[i][h.col]);
      if (!praca) { if (g[i].every((c) => c === '')) continue; else break; }
      if (up(praca).startsWith('PARÂMETROS') || up(praca).startsWith('PARAMETROS')) break;
      premissas.push({ ano: ANO, chave: 'comissao:' + up(praca), rotulo: String(praca), valor: num(g[i][h.col + 1]) });
    }
  }
  // parâmetros gerais conhecidos (procura por rótulo)
  const param = (txtInclui, chave) => {
    for (const row of g) {
      const r = up(row[1]);
      if (r.includes(txtInclui)) { premissas.push({ ano: ANO, chave, rotulo: clean(row[1]), valor: num(row[2]) }); return; }
    }
  };
  param('RECEITA NÃO-COMISSÃO', 'param:receita_nao_comissao');
  param('MARGEM-ALVO', 'param:margem_alvo');
  param('MARGEM-ALERTA', 'param:margem_alerta');
  param('MESES DE CAIXA', 'param:meses_caixa');
}

// ---------- PREVISIBILIDADES: receita projetada por canal, mês a mês ----------
const prevRows = grid('PREVISIBILIDADES');
let hdr = -1, jan = -1;
for (let i = 0; i < prevRows.length && hdr < 0; i++) {
  const j = prevRows[i].findIndex((v) => up(v) === 'JAN');
  if (j >= 0) { hdr = i; jan = j; }
}
const grupoDe = (canal) => {
  const c = up(canal);
  if (c.includes('LOCAÇ') || c.includes('LOCAC')) return 'locacao';
  if (c === 'ADM' || c.includes('ADMINIST')) return 'adm';
  return 'venda';
};
const previsoes = [];
let pOrd = 0;
if (hdr >= 0) {
  const colCanal = 1, colPct = jan + 13;
  for (let i = hdr + 1; i < prevRows.length; i++) {
    const canal = up(prevRows[i][colCanal]);
    if (!canal) continue;
    const meses = []; let soma = 0;
    for (let m = 0; m < 12; m++) { const v = num(prevRows[i][jan + m]); meses.push(v); soma += v; }
    if (soma === 0) continue;
    const pctv = num(prevRows[i][colPct]);
    const p = { ano: ANO, grupo: grupoDe(canal), canal, comissao_pct: pctv, ativo: pctv > 0 ? 1 : 0, ordem: pOrd++ };
    for (let m = 0; m < 12; m++) p['m' + String(m + 1).padStart(2, '0')] = meses[m];
    previsoes.push(p);
  }
}

// ---------- RESULTADO MÊS: 4 cenários (Atual / 60 / 120 / 210 dias) -----------
// Layout em 2x2: cada bloco tem unidade | VGV | COMISSÃO(R$) | %COMISSÃO.
const resRows = grid('RESULTADO MÊS');
const FIXAS = new Set(['ADMNISTRAÇÃO', 'ADMINISTRAÇÃO', 'LOCAÇÕES', 'SÓCIOS', 'CUSTO PJ', 'ADITIVO CUSTO']);
function leBloco(rotuloHdr, nome) {
  const h = acha(resRows, rotuloHdr, 9);
  if (!h) return null;
  const uni = h.col, vgvC = h.col + 1, comC = h.col + 2, pctC = h.col + 3;
  const linhas = []; let ordem = 0;
  for (let i = h.row + 1; i < resRows.length; i++) {
    const u = up(resRows[i][uni]);
    if (!u) continue;
    if (u.startsWith('VGV MÊS') || u.startsWith('CUSTO MÊS')) break;
    const vgv = num(resRows[i][vgvC]);
    const comR$ = num(resRows[i][comC]);
    const pct = num(resRows[i][pctC]); // já é fração (0.02) na planilha nova
    if (FIXAS.has(u)) {
      if (u === 'CUSTO PJ' || u === 'ADITIVO CUSTO') continue; // custo vem das abas de centro
      linhas.push({ unidade: u, vgv: 0, comissao_pct: 0, receita_fixa: comR$, ordem: ordem++ });
    } else {
      const p = pct ? pct * 100 : (vgv ? +(comR$ / vgv * 100).toFixed(4) : 0);
      linhas.push({ unidade: u, vgv, comissao_pct: p, receita_fixa: 0, ordem: ordem++ });
    }
  }
  return { ano: ANO, nome, ordem: 0, linhas };
}
const cenarios = [
  leBloco('ATUAL', 'Atual'),
  leBloco('CENÁRIO 60 DIAS', '60 dias'),
  leBloco('CENÁRIO 120 DIAS', '120 dias'),
  leBloco('CENÁRIO 210 DIAS', '210 dias'),
].filter(Boolean).map((c, i) => ({ ...c, ordem: i }));

const seed = { gerado_em: new Date().toISOString().slice(0, 10), origem: SRC, ano: ANO, custos, colaboradores, previsoes, cenarios, premissas };

mkdirSync(resolve(ROOT, 'data'), { recursive: true });
const out = resolve(ROOT, 'data/seed.json');
writeFileSync(out, JSON.stringify(seed, null, 2), 'utf8');

// conferência: total por centro (só PAGA?=SIM) + folha
const folhaAtiva = colaboradores.filter((c) => c.ativo).reduce((a, c) => a + c.salario, 0);
const porCentro = {};
for (const c of custos) if (c.ativo) porCentro[c.centro_custo] = (porCentro[c.centro_custo] || 0) + c.valor;
porCentro['MATRIZ'] = (porCentro['MATRIZ'] || 0) + folhaAtiva; // folha entra na matriz
const totalGeral = Object.values(porCentro).reduce((a, v) => a + v, 0);
console.log('Extração concluída ->', out);
console.log({
  custos: custos.length, colaboradores: colaboradores.length, folhaAtiva: Math.round(folhaAtiva),
  previsoes: previsoes.length, cenarios: cenarios.map((c) => `${c.nome}:${c.linhas.length}`),
  premissas: premissas.length,
  porCentro: Object.fromEntries(Object.entries(porCentro).map(([k, v]) => [k, Math.round(v * 100) / 100])),
  totalGeral: Math.round(totalGeral * 100) / 100,
});
