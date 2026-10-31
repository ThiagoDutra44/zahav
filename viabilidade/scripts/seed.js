// Cria/popula data/viabilidade.db a partir de data/seed.json
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DB_PATH, SCHEMA } from '../src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const seed = JSON.parse(readFileSync(resolve(ROOT, 'data/seed.json'), 'utf8'));

// PROTEÇÃO: o sistema é a fonte oficial dos dados. Recriar o banco apagaria tudo
// que foi editado na interface. Só recria do zero com --force (carga inicial / reset deliberado).
const FORCE = process.argv.includes('--force');
if (existsSync(DB_PATH) && !FORCE) {
  console.error('⛔ O banco já existe e o sistema é a FONTE OFICIAL dos dados.');
  console.error('   Rodar o seed agora APAGARIA tudo que você editou na interface.');
  console.error('   Se realmente quiser recriar do zero a partir da planilha:  npm run seed -- --force');
  process.exit(1);
}
// recria do zero (carga inicial ou reset explícito)
for (const ext of ['', '-wal', '-shm']) {
  const f = DB_PATH + ext;
  if (existsSync(f)) rmSync(f);
}

const db = openDb();
db.exec(SCHEMA);

const M = (p) => [...Array(12)].map((_, i) => p['m' + String(i + 1).padStart(2, '0')] || 0);

db.exec('BEGIN');
try {
  const insCusto = db.prepare(`INSERT INTO custos (ano, centro_custo, categoria, valor, tipo, ativo, origem, ordem)
    VALUES (?,?,?,?,?,?,?,?)`);
  for (const c of seed.custos || [])
    insCusto.run(c.ano, c.centro_custo, c.categoria, c.valor || 0, c.tipo || 'fixo', c.ativo == null ? 1 : c.ativo, c.origem || null, c.ordem || 0);

  const insColab = db.prepare(`INSERT INTO colaboradores (ano, nome, cargo, salario, ativo, ordem)
    VALUES (?,?,?,?,?,?)`);
  for (const c of seed.colaboradores || [])
    insColab.run(c.ano, c.nome, c.cargo || null, c.salario || 0, c.ativo == null ? 1 : c.ativo, c.ordem || 0);

  // Cria a linha "FOLHA DE PAGAMENTO" na MATRIZ = soma da folha ativa (espelha a planilha)
  const insPrem = db.prepare('INSERT OR REPLACE INTO premissas (ano, chave, rotulo, valor) VALUES (?,?,?,?)');
  for (const p of seed.premissas || []) insPrem.run(p.ano, p.chave, p.rotulo || null, p.valor || 0);
  const anos = [...new Set((seed.colaboradores || []).map((c) => c.ano))];
  for (const ano of anos) {
    const tot = (seed.colaboradores || []).filter((c) => c.ano === ano && c.ativo).reduce((a, c) => a + (c.salario || 0), 0);
    insCusto.run(ano, 'MATRIZ', 'FOLHA DE PAGAMENTO', tot, 'fixo', 1, 'folha', 99);
  }

  const insPrev = db.prepare(`INSERT INTO previsoes
    (ano, grupo, canal, comissao_pct, ativo, m01,m02,m03,m04,m05,m06,m07,m08,m09,m10,m11,m12, ordem)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const p of seed.previsoes || [])
    insPrev.run(p.ano, p.grupo, p.canal, p.comissao_pct || 0, p.ativo == null ? 1 : p.ativo, ...M(p), p.ordem || 0);

  const insCen = db.prepare('INSERT INTO cenarios (ano, nome, ordem) VALUES (?,?,?)');
  const insLin = db.prepare(`INSERT INTO cenario_linhas
    (cenario_id, unidade, vgv, comissao_pct, receita_fixa, ordem) VALUES (?,?,?,?,?,?)`);
  for (const c of seed.cenarios || []) {
    const info = insCen.run(c.ano, c.nome, c.ordem || 0);
    for (const l of c.linhas || [])
      insLin.run(info.lastInsertRowid, l.unidade, l.vgv || 0, l.comissao_pct || 0, l.receita_fixa || 0, l.ordem || 0);
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('Seed falhou:', e);
  process.exit(1);
}

const c = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
console.log(`Banco criado em ${DB_PATH}`);
console.log(`  custos: ${c('custos')} · colaboradores: ${c('colaboradores')} · previsoes: ${c('previsoes')} · cenarios: ${c('cenarios')} · linhas: ${c('cenario_linhas')}`);
