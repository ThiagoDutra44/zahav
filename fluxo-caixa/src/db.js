import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.FLUXO_DB || resolve(__dirname, '..', 'data', 'fluxo.db');

export function openDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  return db;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS centros_custo (
  id INTEGER PRIMARY KEY,
  nome TEXT UNIQUE NOT NULL,
  eh_receita INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS origens_receita (
  id INTEGER PRIMARY KEY,
  nome TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS feriados (
  data TEXT PRIMARY KEY,           -- ISO YYYY-MM-DD
  descricao TEXT NOT NULL,
  ambito TEXT NOT NULL DEFAULT 'Nacional'
);

CREATE TABLE IF NOT EXISTS recorrencias (
  id INTEGER PRIMARY KEY,
  descricao TEXT NOT NULL,
  centro_custo TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'orçado',
  valor REAL NOT NULL,             -- positivo no cadastro; sinal aplicado na geração
  frequencia TEXT NOT NULL,        -- mensal | semanal | quinzenal | anual
  dia_mes INTEGER,                 -- 1-31 (mensal)
  dia_semana TEXT,                 -- seg..sex (semanal)
  inicio TEXT,                     -- ISO
  fim TEXT,                        -- ISO
  offset_uteis INTEGER NOT NULL DEFAULT 0,  -- dias úteis somados ao dia-base (recebimento/repasse), recalculado por mês
  ativo INTEGER NOT NULL DEFAULT 1,
  livro TEXT NOT NULL DEFAULT 'empresa'
);

CREATE TABLE IF NOT EXISTS excecoes (
  id INTEGER PRIMARY KEY,
  descricao TEXT NOT NULL,
  dia_original INTEGER NOT NULL,
  mes_original INTEGER NOT NULL,
  acao TEXT NOT NULL,              -- MOVER | CANCELAR
  dia_nova INTEGER,
  mes_nova INTEGER,
  registrado_em TEXT,
  livro TEXT NOT NULL DEFAULT 'empresa'
);

CREATE TABLE IF NOT EXISTS lancamentos (
  id INTEGER PRIMARY KEY,
  data TEXT NOT NULL,              -- ISO YYYY-MM-DD
  nome TEXT NOT NULL,
  centro_custo TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'orçado',  -- orçado | real
  valor REAL NOT NULL,            -- já com sinal (receita +, resto -)
  origem TEXT NOT NULL DEFAULT 'manual', -- manual | recorrente | pendencia
  recorrencia_id INTEGER,
  prioridade TEXT,                -- null | P1 | P2  (substitui soma por cor)
  reembolso_de INTEGER,           -- id da despesa que este crédito de Retirada Dutra compensa (pago pela conta pessoal)
  livro TEXT NOT NULL DEFAULT 'empresa',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lanc_data ON lancamentos(data);
CREATE INDEX IF NOT EXISTS idx_lanc_cc ON lancamentos(centro_custo);

CREATE TABLE IF NOT EXISTS pendencias (
  id INTEGER PRIMARY KEY,
  descricao TEXT NOT NULL,
  centro_custo TEXT,
  tipo TEXT,
  valor REAL,
  data_origem TEXT,
  mes_origem TEXT,
  status TEXT NOT NULL DEFAULT 'PENDENTE',  -- PENDENTE | DISTRIBUIDA | ELIMINADA
  acao TEXT,                                 -- DISTRIBUIR | ELIMINAR
  nova_data TEXT,
  registrado_em TEXT DEFAULT (datetime('now')),
  livro TEXT NOT NULL DEFAULT 'empresa'
);

CREATE TABLE IF NOT EXISTS config (
  chave TEXT PRIMARY KEY,
  valor TEXT
);

-- Caixas/livros (empresa, dutra pessoal, ...) — cada um com sua âncora de saldo
CREATE TABLE IF NOT EXISTS livros (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  ancora_data TEXT,
  ancora_valor REAL DEFAULT 0,
  ordem INTEGER DEFAULT 0
);

-- Mapa de Pendências: dívidas/obrigações da reestruturação. Com data + ativo => viram
-- lançamento no calendário (centro amortizações [empresa] ou Retirada Dutra [dutra]).
-- Sem data e/ou inativas => entram só no consolidado (agrupado por categoria).
CREATE TABLE IF NOT EXISTS pendencias_mapa (
  id INTEGER PRIMARY KEY,
  descricao TEXT NOT NULL,
  categoria TEXT,
  valor REAL NOT NULL DEFAULT 0,   -- positivo no cadastro; sinal aplicado na geração (despesa)
  data TEXT,                       -- ISO ou null (null = não agendada)
  ativo INTEGER NOT NULL DEFAULT 1,
  livro TEXT NOT NULL DEFAULT 'empresa',
  lancamento_id INTEGER            -- lançamento gerado no calendário (quando lançada)
);
`;

// Coluna `livro` é adicionada via scripts/migrate-livros.js em bancos já existentes.
// Para um seed novo, scripts/seed.js garante a coluna e os livros padrão.
