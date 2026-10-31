// Cria/popula data/vendas.db a partir de data/seed.json
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DB_PATH, SCHEMA } from '../src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const seed = JSON.parse(readFileSync(resolve(ROOT, 'data/seed.json'), 'utf8'));

// recria do zero (mantém comportamento previsível do seed)
for (const ext of ['', '-wal', '-shm']) {
  const f = DB_PATH + ext;
  if (existsSync(f)) rmSync(f);
}

const db = openDb();
db.exec(SCHEMA);

db.exec('BEGIN');
try {
  const insMeta = db.prepare('INSERT OR REPLACE INTO metas (ano, meta_vgv, meta_fat) VALUES (?,?,?)');
  for (const m of seed.metas || []) insMeta.run(m.ano, m.meta_vgv || 0, m.meta_fat || 0);

  const insCad = db.prepare('INSERT OR IGNORE INTO cadastros (tipo, nome, ativo) VALUES (?,?,1)');
  for (const c of seed.cadastros || []) insCad.run(c.tipo, c.nome);

  const insVenda = db.prepare(`INSERT INTO vendas
    (ano, mes, data, cliente, produto, filial, corretor, opcionista, gerente,
     vgv, margem_pct, faturamento, status, mapa_calor, livro)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'imovelum')`);
  for (const v of seed.vendas || []) {
    insVenda.run(v.ano, v.mes, v.data || null, v.cliente, v.produto || null, v.filial || null,
      v.corretor || null, v.opcionista || null, v.gerente || null,
      v.vgv || 0, v.margem_pct || 0, v.faturamento || 0,
      v.status || 'INTERESSE', v.mapa_calor || null);
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('Seed falhou:', e);
  process.exit(1);
}

const n = db.prepare('SELECT COUNT(*) c FROM vendas').get().c;
const nc = db.prepare('SELECT COUNT(*) c FROM cadastros').get().c;
console.log(`Banco criado em ${DB_PATH}`);
console.log(`  vendas: ${n} · cadastros: ${nc}`);
