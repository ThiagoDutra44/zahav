// Compara os "TOTAL DIA" da grade FLUXO 2026 v2 com a soma do banco por data.
import XLSX from 'xlsx';
import { openDb } from '../src/db.js';

const SRC = process.argv[2] || 'C:/FINANCEIRO 2026/Cash Flow v1.xlsm';
const ws = XLSX.readFile(SRC, { bookVBA: false }).Sheets['FLUXO 2026 v2'];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
const ci = (L) => { let n = 0; for (const c of L) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; };
const G = [['B', 'C', 'D', 'E'], ['G', 'H', 'I', 'J'], ['L', 'M', 'N', 'O'], ['Q', 'R', 'S', 'T'], ['V', 'W', 'X', 'Y']].map((a) => a.map(ci));
const pad = (n) => String(n).padStart(2, '0');
const toISO = (s) => { const d = new Date(Math.round((s - 25569) * 86400 * 1000)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };

const totGrid = {};
for (const g of G) {
  let cur = null;
  for (const r of rows) {
    const cc = String(r[g[1]]).toLowerCase().trim();
    const nome = String(r[g[0]]).toUpperCase().trim();
    const val = r[g[3]];
    if (cc === 'centro de custo') { cur = typeof val === 'number' ? toISO(val) : null; continue; }
    if (!cur) continue;
    if (nome.startsWith('TOTAL DIA') && typeof val === 'number') totGrid[cur] = (totGrid[cur] || 0) + val;
  }
}

const db = openDb();
const dbTot = {};
for (const r of db.prepare('SELECT data, SUM(valor) s FROM lancamentos GROUP BY data').all()) dbTot[r.data] = r.s;

const datas = [...new Set([...Object.keys(totGrid), ...Object.keys(dbTot)])].sort();
let ok = 0, dif = 0;
const difs = [];
for (const d of datas) {
  const g = totGrid[d] ?? 0, b = dbTot[d] ?? 0;
  if (Math.abs(g - b) < 0.005) ok++;
  else { dif++; difs.push({ data: d, planilha: +g.toFixed(2), sistema: +b.toFixed(2), delta: +(b - g).toFixed(2) }); }
}
const somaG = Object.values(totGrid).reduce((a, b) => a + b, 0);
const somaB = Object.values(dbTot).reduce((a, b) => a + b, 0);
console.log(`Dias com TOTAL DIA na planilha: ${Object.keys(totGrid).length}`);
console.log(`Dias batendo: ${ok}  |  Divergentes: ${dif}`);
console.log(`Soma geral planilha: ${somaG.toFixed(2)}  |  sistema: ${somaB.toFixed(2)}  |  delta: ${(somaB - somaG).toFixed(2)}`);
if (difs.length) { console.log('\nDivergências:'); for (const x of difs) console.log(' ', x.data, 'planilha=', x.planilha, 'sistema=', x.sistema, 'delta=', x.delta); }
db.close();
