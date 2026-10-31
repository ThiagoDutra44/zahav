// Ponte Vendas -> Fluxo de Caixa
// Empurra a comissão (IMOVELUM) de cada venda ASSINADA ainda não sincronizada
// como um lançamento de RECEITA no banco do fluxo-caixa.
//
// SEGURO POR PADRÃO: roda em modo simulação (dry-run) e só MOSTRA o que faria.
// Para gravar de verdade no fluxo-caixa, rode:  npm run ponte -- --apply
//
// Cada lançamento criado é marcado com "[V<id>]" no nome e origem='venda',
// então é rastreável e reversível (basta apagar por esse marcador).
import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { DB_PATH as VENDAS_DB } from '../src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
// caminho do banco do fluxo-caixa (projeto irmão)
const FLUXO_DB = process.env.FLUXO_DB ||
  resolve(__dirname, '..', '..', 'fluxo-caixa', 'data', 'fluxo.db');

const CENTRO_CUSTO = 'receita · Comissão de Vendas'; // "receita" no nome => sinal + no fluxo
const LIVRO_FLUXO = 'empresa';
const pad = (n) => String(n).padStart(2, '0');

if (!existsSync(FLUXO_DB)) {
  console.error(`Banco do fluxo-caixa não encontrado em:\n  ${FLUXO_DB}\nDefina FLUXO_DB=... se estiver em outro lugar.`);
  process.exit(1);
}

const vdb = new DatabaseSync(VENDAS_DB);
const fdb = new DatabaseSync(FLUXO_DB);
fdb.exec('PRAGMA journal_mode = WAL;');

// vendas assinadas ainda não sincronizadas
const pend = vdb.prepare(`SELECT * FROM vendas
  WHERE status='ASSINADA' AND fluxo_sync=0 AND faturamento > 0
  ORDER BY ano, mes`).all();

if (!pend.length) {
  console.log('Nada a sincronizar: nenhuma venda ASSINADA pendente.');
  process.exit(0);
}

console.log(`${APPLY ? '🟢 APLICANDO' : '🔍 SIMULAÇÃO (use --apply para gravar)'} — ${pend.length} venda(s) ASSINADA(s):\n`);

const insFluxo = fdb.prepare(`INSERT INTO lancamentos
  (data, nome, centro_custo, tipo, valor, origem, prioridade, livro)
  VALUES (?,?,?, 'orçado', ?, 'venda', NULL, ?)`);
const markSync = vdb.prepare('UPDATE vendas SET fluxo_sync=1, fluxo_lanc_id=? WHERE id=?');

let totalFat = 0;
for (const v of pend) {
  const data = v.data || `${v.ano}-${pad(v.mes)}-15`; // estimativa: meio do mês da venda
  const nome = `[V${v.id}] Comissão · ${v.cliente}${v.produto ? ' (' + v.produto + ')' : ''}`;
  totalFat += v.faturamento;
  console.log(`  ${data}  +${v.faturamento.toLocaleString('pt-BR')}  ${nome}`);
  if (APPLY) {
    const info = insFluxo.run(data, nome, CENTRO_CUSTO, v.faturamento, LIVRO_FLUXO);
    markSync.run(info.lastInsertRowid, v.id);
  }
}

console.log(`\nTotal de comissão: R$ ${totalFat.toLocaleString('pt-BR')}`);
console.log(APPLY
  ? `✅ Lançado no fluxo-caixa (centro de custo "${CENTRO_CUSTO}", livro "${LIVRO_FLUXO}").`
  : `Nada foi gravado. Rode "npm run ponte -- --apply" para confirmar.`);
