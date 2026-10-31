// Extrai os dados da planilha VENDAS 2026.xlsm para data/seed.json
// Uso: node scripts/extract.js ["C:/caminho/para/VENDAS 2026.xlsm"]
import XLSX from 'xlsx';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = process.argv[2] ||
  'C:/Users/user/Shire Investimentos e Participações LTDA/ImovelUm - Diretoria - Diretoria/VENDAS HISTORICO/VENDAS 2026.xlsm';
const ANO = 2026;

const MESES = ['JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO',
  'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];
const mesIdx = (s) => MESES.indexOf(String(s).trim().toUpperCase()) + 1; // 1-12, ou 0

const clean = (v) => (typeof v === 'string' ? v.trim() : v);
// "R$ 1,126,794" | "R$ 47,325.33" -> número
function parseMoney(v) {
  if (v === '' || v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[R$\s]/g, '').replace(/\./g, '#').replace(/,/g, '');
  // depois de tirar separador de milhar (,) o '#' que sobrou é o ponto decimal
  const n = Number(s.replace(/#(?=\d{1,2}$)/, '.').replace(/#/g, ''));
  return Number.isFinite(n) ? n : 0;
}
// "4.20" | "4,20" | "4.20%" -> 4.2
function parsePct(v) {
  if (v === '' || v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace('%', '').replace(',', '.').trim());
  return Number.isFinite(n) ? n : 0;
}

const wb = XLSX.readFile(SRC, { bookVBA: false });
const grid = (name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' });

// ---------- REGISTRO DE VENDAS (aba "VENDAS 2026") ----------
// Layout: linha 2 é cabeçalho; linhas com mês em col A são separadores (com total mensal);
// demais linhas com col A preenchida são vendas. Colunas:
// A cliente · B produto · C filial · D corretor · E opcionista · F gerente
// G vgv · H imovelum(faturamento) · I status · J ium% · K mapa de calor
const vendasRows = grid('VENDAS 2026');
const vendas = [];
let mesAtual = 0;
for (let i = 2; i < vendasRows.length; i++) {
  const r = vendasRows[i];
  const a = clean(r[0]);
  if (!a) continue;
  const asMes = mesIdx(a);
  if (asMes) { mesAtual = asMes; continue; }          // linha separadora de mês
  // pula só o cabeçalho de verdade (A=CLIENTE e B=BAIRRO/PRODUTO);
  // há uma venda real cujo cliente foi anonimizado como "CLIENTE" — essa fica.
  if (String(a).toUpperCase() === 'CLIENTE' && String(clean(r[1]) || '').toUpperCase().includes('BAIRRO')) continue;
  if (!mesAtual) continue;
  const vgv = parseMoney(r[6]);
  const fat = parseMoney(r[7]);
  const margem = parsePct(r[9]) || (vgv ? +(fat / vgv * 100).toFixed(2) : 0);
  vendas.push({
    ano: ANO,
    mes: mesAtual,
    cliente: a,
    produto: clean(r[1]) || '',
    filial: clean(r[2]) || '',
    corretor: clean(r[3]) || '',
    opcionista: clean(r[4]) || '',
    gerente: clean(r[5]) || '',
    vgv,
    margem_pct: margem,
    faturamento: fat,
    status: String(clean(r[8]) || 'INTERESSE').toUpperCase(),
    mapa_calor: String(clean(r[10]) || '').toUpperCase() || null,
  });
}

// ---------- CADASTROS (aba "CADASTROS": A gerentes · B corretores · C opcionistas · D filiais) ----------
const cadRows = grid('CADASTROS');
const cadastros = [];
const cols = [['gerente', 0], ['corretor', 1], ['opcionista', 2], ['filial', 3]];
const vistos = new Set();
for (let i = 1; i < cadRows.length; i++) {
  for (const [tipo, c] of cols) {
    const nome = clean(cadRows[i]?.[c]);
    if (!nome) continue;
    const key = tipo + '|' + String(nome).toUpperCase();
    if (vistos.has(key)) continue;
    vistos.add(key);
    cadastros.push({ tipo, nome: String(nome).toUpperCase() });
  }
}

// ---------- METAS (aba "BASE 2026": Meta Anual VGV / Meta Anual FAT) ----------
const baseRows = grid('BASE 2026');
let meta_vgv = 0, meta_fat = 0;
for (const r of baseRows) {
  const rotulo = String(clean(r[0]) || '').toUpperCase();
  if (rotulo === 'META ANUAL VGV') meta_vgv = parseMoney(r[1]);
  if (rotulo === 'META ANUAL FAT') meta_fat = parseMoney(r[1]);
}

const seed = {
  gerado_em: new Date().toISOString().slice(0, 10),
  origem: SRC,
  ano: ANO,
  metas: [{ ano: ANO, meta_vgv, meta_fat }],
  cadastros,
  vendas,
};

mkdirSync(resolve(ROOT, 'data'), { recursive: true });
const out = resolve(ROOT, 'data/seed.json');
writeFileSync(out, JSON.stringify(seed, null, 2), 'utf8');

console.log('Extração concluída ->', out);
console.log({ vendas: vendas.length, cadastros: cadastros.length, meta_vgv, meta_fat });
