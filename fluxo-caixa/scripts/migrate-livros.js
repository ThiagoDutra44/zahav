// Migração: adiciona o conceito de "livro" (caixa) — empresa + dutra (pessoal).
import { openDb } from '../src/db.js';

const db = openDb();
const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);

db.exec('BEGIN');
try {
  for (const t of ['lancamentos', 'recorrencias', 'excecoes', 'pendencias']) {
    if (!hasCol(t, 'livro')) db.exec(`ALTER TABLE ${t} ADD COLUMN livro TEXT NOT NULL DEFAULT 'empresa'`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS livros (
    id TEXT PRIMARY KEY, nome TEXT NOT NULL, ancora_data TEXT, ancora_valor REAL DEFAULT 0, ordem INTEGER DEFAULT 0
  )`);
  // empresa herda a âncora atual do config
  const ad = db.prepare("SELECT valor FROM config WHERE chave='saldo_ancora_data'").get()?.valor || '2026-06-15';
  const av = Number(db.prepare("SELECT valor FROM config WHERE chave='saldo_ancora_valor'").get()?.valor || 0);
  db.prepare("INSERT OR IGNORE INTO livros(id,nome,ancora_data,ancora_valor,ordem) VALUES ('empresa',?,?,?,0)")
    .run('ImovelUm (Empresa)', ad, av);
  db.prepare("INSERT OR IGNORE INTO livros(id,nome,ancora_data,ancora_valor,ordem) VALUES ('dutra',?,?,?,1)")
    .run('Caixa Dutra (Pessoal)', '2026-06-15', 0);
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }

console.log('Migração de livros concluída.');
console.log('livros:', db.prepare('SELECT * FROM livros').all());
console.log('lançamentos por livro:', db.prepare('SELECT livro, COUNT(*) n FROM lancamentos GROUP BY livro').all());
db.close();
