import { readFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, SCHEMA, DB_PATH } from '../src/db.js';
import { FERIADOS_2026 } from '../src/rules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(resolve(__dirname, '..', 'data', 'seed.json'), 'utf8'));

// recria do zero
for (const ext of ['', '-wal', '-shm']) {
  const p = DB_PATH + ext;
  if (existsSync(p)) rmSync(p);
}

const db = openDb();
db.exec(SCHEMA);

const tx = (fn) => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } };

tx(() => {
  // centros de custo (despesa) + receita·<origem>
  const insCC = db.prepare('INSERT OR IGNORE INTO centros_custo(nome, eh_receita) VALUES(?, ?)');
  for (const nome of seed.centros_custo) insCC.run(nome, 0);
  insCC.run('Retirada Dutra', 0); // retirada/pró-labore do Dutra
  const insOrig = db.prepare('INSERT OR IGNORE INTO origens_receita(nome) VALUES(?)');
  for (const nome of seed.origens_receita) {
    insOrig.run(nome);
    insCC.run(`receita · ${nome}`, 1);
  }

  // feriados (lista canônica 2026 da especificação)
  const insFer = db.prepare('INSERT OR REPLACE INTO feriados(data, descricao, ambito) VALUES(?, ?, ?)');
  for (const [data, desc, amb] of FERIADOS_2026) insFer.run(data, desc, amb);

  // recorrências
  const insRec = db.prepare(`INSERT INTO recorrencias
    (descricao, centro_custo, tipo, valor, frequencia, dia_mes, dia_semana, inicio, fim, ativo)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const r of seed.recorrencias)
    insRec.run(r.descricao, r.centro_custo, r.tipo, r.valor, r.frequencia,
      r.dia_mes, r.dia_semana, r.inicio, r.fim, r.ativo);

  // exceções
  const insEx = db.prepare(`INSERT INTO excecoes
    (descricao, dia_original, mes_original, acao, dia_nova, mes_nova) VALUES (?,?,?,?,?,?)`);
  for (const e of seed.excecoes)
    insEx.run(e.descricao, e.dia_original, e.mes_original, e.acao, e.dia_nova, e.mes_nova);

  // lançamentos (já com sinal vindo do EXPORT)
  const insL = db.prepare(`INSERT INTO lancamentos
    (data, nome, centro_custo, tipo, valor, origem) VALUES (?,?,?,?,?,?)`);
  for (const l of seed.lancamentos) {
    const origem = l.nome.startsWith('[R] ') ? 'recorrente' : l.nome.startsWith('[P] ') ? 'pendencia' : 'manual';
    insL.run(l.data, l.nome, l.centro_custo, l.tipo, l.valor, origem);
  }

  // Âncora de caixa: saldo REAL contado em uma data (aba CAIXA da grade / "Início conciliação").
  // Caixa de qualquer dia = saldo_ancora + soma dos lançamentos a partir da data da âncora.
  const cfg = db.prepare('INSERT OR REPLACE INTO config(chave, valor) VALUES (?,?)');
  cfg.run('saldo_ancora_data', '2026-06-15');   // abertura da semana atual (S25)
  cfg.run('saldo_ancora_valor', '30185.97');    // caixa real contado em 15/06

  // Livros/caixas padrão (empresa + dutra pessoal)
  const insLivro = db.prepare('INSERT OR REPLACE INTO livros(id,nome,ancora_data,ancora_valor,ordem) VALUES (?,?,?,?,?)');
  insLivro.run('empresa', 'ImovelUm (Empresa)', '2026-06-15', 30185.97, 0);
  insLivro.run('dutra', 'Caixa Dutra (Pessoal)', '2026-06-15', 0, 1);
});

const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
console.log('Banco criado em', DB_PATH);
console.log({
  centros_custo: count('centros_custo'),
  origens_receita: count('origens_receita'),
  feriados: count('feriados'),
  recorrencias: count('recorrencias'),
  excecoes: count('excecoes'),
  lancamentos: count('lancamentos'),
});
db.close();
