// Extrai os dados do Cash Flow v1.xlsm para data/seed.json
// Uso: node scripts/extract.js ["C:/caminho/para/Cash Flow v1.xlsm"]
import XLSX from 'xlsx';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = process.argv[2] || 'C:/FINANCEIRO 2026/Cash Flow v1.xlsm';

// --- helpers de data (sistema de datas 1900 do Excel) ---
const pad = (n) => String(n).padStart(2, '0');
function serialToDate(serial) {
  // serial 25569 = 1970-01-01 (já considerando o bug do ano 1900)
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  return new Date(ms);
}
function serialToISO(serial) {
  const d = serialToDate(serial);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function serialToDDMM(serial) {
  const d = serialToDate(serial);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}`;
}
// Aceita: serial number | "dd/mm/aaaa" | "dd/mm" -> {iso?, dia, mes, ano?}
function parseDateCell(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'number') {
    const d = serialToDate(v);
    return { iso: serialToISO(v), dia: d.getUTCDate(), mes: d.getUTCMonth() + 1, ano: d.getUTCFullYear() };
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return null;
  const dia = +m[1], mes = +m[2];
  let ano = m[3] ? +m[3] : null;
  if (ano && ano < 100) ano += 2000;
  return { iso: ano ? `${ano}-${pad(mes)}-${pad(dia)}` : null, dia, mes, ano };
}

const wb = XLSX.readFile(SRC, { bookVBA: false });
const grid = (name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
const clean = (v) => (typeof v === 'string' ? v.trim() : v);

// ---------- LANÇAMENTOS (aba FLUXO 2026 v2 — a grade REAL e atual) ----------
// Layout posicional: 5 grupos de dia (seg–sex), cada um com 4 colunas nome/cc/tipo/valor.
// Cabeçalho do dia: ccCol == "centro de custo" e a data (serial) fica na valCol.
// Termina em "TOTAL DIA". Linhas de feriado (🏛️ ...) não têm valor -> ignoradas.
function colIdx(letter) {
  let n = 0;
  for (const ch of letter) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
const GRUPOS = [
  { nome: 'B', cc: 'C', tipo: 'D', val: 'E' },
  { nome: 'G', cc: 'H', tipo: 'I', val: 'J' },
  { nome: 'L', cc: 'M', tipo: 'N', val: 'O' },
  { nome: 'Q', cc: 'R', tipo: 'S', val: 'T' },
  { nome: 'V', cc: 'W', tipo: 'X', val: 'Y' },
].map((g) => ({ nome: colIdx(g.nome), cc: colIdx(g.cc), tipo: colIdx(g.tipo), val: colIdx(g.val) }));

const fluxoRows = grid('FLUXO 2026 v2');
const lancamentos = [];
for (const g of GRUPOS) {
  let dataAtual = null;
  for (const r of fluxoRows) {
    const nome = clean(r[g.nome]);
    const cc = clean(r[g.cc]);
    const tipo = clean(r[g.tipo]);
    const val = r[g.val];
    // cabeçalho do dia
    if (String(cc).toLowerCase() === 'centro de custo') {
      const d = parseDateCell(val);
      dataAtual = d?.iso || null;
      continue;
    }
    if (!dataAtual) continue;
    if (String(nome).toUpperCase().startsWith('TOTAL DIA')) continue;
    if (nome === '' || nome === null || nome === undefined) continue;
    if (typeof val !== 'number') continue; // feriados/rótulos não têm valor numérico
    lancamentos.push({
      data: dataAtual,
      nome,
      centro_custo: cc || '',
      tipo: tipo || 'orçado',
      valor: Number(val) || 0,
    });
  }
}
lancamentos.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));

// ---------- FERIADOS (aba EXPORT, colunas H:I) — referência; o seed usa FERIADOS_2026 ----------
const expRows = grid('EXPORT');
const feriados = [];
for (let i = 1; i < expRows.length; i++) {
  const r = expRows[i];
  const data = r[7], desc = clean(r[8]);
  if (data === '' || desc === '') continue;
  const d = parseDateCell(data);
  if (!d || !d.iso) continue;
  feriados.push({ data: d.iso, descricao: desc, dia: d.dia, mes: d.mes });
}

// ---------- RECORRÊNCIAS (aba RECORRENTES, cabeçalho linha 5 -> dados linha 6+) ----------
const recRows = grid('RECORRENTES');
const recorrencias = [];
for (let i = 5; i < recRows.length; i++) {
  const r = recRows[i];
  const descricao = clean(r[0]);
  if (!descricao) continue;
  const inicio = parseDateCell(r[7]);
  const fim = parseDateCell(r[8]);
  recorrencias.push({
    descricao,
    centro_custo: clean(r[1]),
    tipo: clean(r[2]) || 'orçado',
    valor: Number(r[3]) || 0,            // positivo no cadastro
    frequencia: clean(r[4]) || 'mensal',
    dia_mes: r[5] === '' ? null : Number(r[5]),
    dia_semana: clean(r[6]) || null,
    inicio: inicio?.iso || null,
    fim: fim?.iso || null,
    ativo: String(clean(r[9])).toUpperCase() === 'S' ? 1 : 0,
  });
}

// ---------- EXCEÇÕES (aba EXCECOES, cabeçalho linha 1, nota linha 2, dados linha 3+) ----------
const exRows = grid('EXCECOES');
const excecoes = [];
for (let i = 2; i < exRows.length; i++) {
  const r = exRows[i];
  const descricao = clean(r[0]);
  if (!descricao) continue;
  const orig = parseDateCell(r[1]);
  const nova = parseDateCell(r[3]);
  const acao = String(clean(r[2])).toUpperCase();
  if (!orig || (acao !== 'MOVER' && acao !== 'CANCELAR')) continue;
  excecoes.push({
    descricao,
    dia_original: orig.dia,
    mes_original: orig.mes,
    acao,
    dia_nova: nova?.dia ?? null,
    mes_nova: nova?.mes ?? null,
  });
}

// ---------- ORIGENS DE RECEITA (aba ORIGEM, dados linha 4+) ----------
const origRows = grid('ORIGEM');
const origens_receita = [];
for (let i = 3; i < origRows.length; i++) {
  const nome = clean(origRows[i][0]);
  if (nome) origens_receita.push(nome);
}

// ---------- CENTROS DE CUSTO (aba REF, coluna B = "CC (base)") ----------
const refRows = grid('REF');
const centros_custo = [];
for (let i = 1; i < refRows.length; i++) {
  const nome = clean(refRows[i][1]);
  if (nome && !centros_custo.includes(nome)) centros_custo.push(nome);
}

// ---------- SALDOS DE ABERTURA / CONSOLIDADO (aba CONSOLIDADO MENSAL) p/ validação ----------
const consRows = grid('CONSOLIDADO MENSAL');
const consolidado_esperado = [];
for (let i = 2; i < consRows.length; i++) {
  const mes = clean(consRows[i][0]);
  if (!mes || mes.toUpperCase() === 'TOTAL') continue;
  consolidado_esperado.push({ mes, custo_orcado: Number(consRows[i][1]) || 0 });
}

const seed = {
  gerado_em: new Date().toISOString().slice(0, 10),
  origem: SRC,
  centros_custo,
  origens_receita,
  feriados,
  recorrencias,
  excecoes,
  lancamentos,
  consolidado_esperado,
};

mkdirSync(resolve(ROOT, 'data'), { recursive: true });
const out = resolve(ROOT, 'data/seed.json');
writeFileSync(out, JSON.stringify(seed, null, 2), 'utf8');

console.log('Extração concluída ->', out);
console.log({
  centros_custo: centros_custo.length,
  origens_receita: origens_receita.length,
  feriados: feriados.length,
  recorrencias: recorrencias.length,
  excecoes: excecoes.length,
  lancamentos: lancamentos.length,
});
