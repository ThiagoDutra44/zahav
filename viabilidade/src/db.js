import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.VIAB_DB || resolve(__dirname, '..', 'data', 'viabilidade.db');

export function openDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  return db;
}

// Centros de custo da operação (cada um é uma aba na planilha nova).
export const CENTROS = ['MATRIZ', 'BARRA', 'COPACABANA', 'VILA OLÍMPIA'];
// Custo fixo (matriz/estrutura) vs variável (por filial).
export const TIPOS_CUSTO = ['fixo', 'variavel'];
// Grupos de receita projetada (aba PREVISIBILIDADES).
//  venda   = comissão sobre o VGV de vendas
//  locacao = taxa de locação (pct=100 => repasse integral do valor)
//  adm     = taxa de administração (pct=100)
export const GRUPOS_RECEITA = ['venda', 'locacao', 'adm'];
export const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

export const SCHEMA = `
-- ORÇADO: itens de custo por centro de custo ----------------------------------
CREATE TABLE IF NOT EXISTS custos (
  id INTEGER PRIMARY KEY,
  ano INTEGER NOT NULL,
  centro_custo TEXT NOT NULL,            -- MATRIZ | CEO/BARRA | COPACABANA | VILA OLÍMPIA
  categoria TEXT NOT NULL,               -- ex.: GOOGLE, ZAP RJ, ALUGUEL, FOLHA DE PAGAMENTO
  valor REAL NOT NULL DEFAULT 0,         -- valor mensal orçado (preservado mesmo se desativado)
  tipo TEXT NOT NULL DEFAULT 'fixo',     -- fixo | variavel
  ativo INTEGER NOT NULL DEFAULT 1,      -- 1 = entra nas somas; 0 = despesa desligada
  origem TEXT,                           -- 'folha' marca a linha alimentada pelos colaboradores
  ordem INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_custos_ano ON custos(ano);
CREATE INDEX IF NOT EXISTS idx_custos_centro ON custos(centro_custo);

-- COLABORADORES: folha de pagamento -------------------------------------------
CREATE TABLE IF NOT EXISTS colaboradores (
  id INTEGER PRIMARY KEY,
  ano INTEGER NOT NULL,
  nome TEXT NOT NULL,
  cargo TEXT,
  salario REAL NOT NULL DEFAULT 0,
  ativo INTEGER NOT NULL DEFAULT 1,
  ordem INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_colab_ano ON colaboradores(ano);

-- PREVISIBILIDADES: receita projetada por canal, mês a mês ---------------------
CREATE TABLE IF NOT EXISTS previsoes (
  id INTEGER PRIMARY KEY,
  ano INTEGER NOT NULL,
  grupo TEXT NOT NULL DEFAULT 'venda',   -- venda | locacao | adm
  canal TEXT NOT NULL,                   -- COPACABANA, BARRA CEO, ITAIM BIBI, LOCAÇÕES RJ, ADM...
  comissao_pct REAL NOT NULL DEFAULT 0,  -- % sobre o VGV (100 = repasse integral p/ locação/adm)
  ativo INTEGER NOT NULL DEFAULT 1,      -- 1 = entra na projeção; 0 = canal desligado
  m01 REAL DEFAULT 0, m02 REAL DEFAULT 0, m03 REAL DEFAULT 0, m04 REAL DEFAULT 0,
  m05 REAL DEFAULT 0, m06 REAL DEFAULT 0, m07 REAL DEFAULT 0, m08 REAL DEFAULT 0,
  m09 REAL DEFAULT 0, m10 REAL DEFAULT 0, m11 REAL DEFAULT 0, m12 REAL DEFAULT 0,
  ordem INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_prev_ano ON previsoes(ano);

-- CENÁRIOS: metas mensais de VGV por unidade (aba RESULTADO MÊS) ---------------
CREATE TABLE IF NOT EXISTS cenarios (
  id INTEGER PRIMARY KEY,
  ano INTEGER NOT NULL,
  nome TEXT NOT NULL,                    -- Mínimo | Base | Agressivo
  ordem INTEGER NOT NULL DEFAULT 0,
  UNIQUE(ano, nome)
);
CREATE TABLE IF NOT EXISTS cenario_linhas (
  id INTEGER PRIMARY KEY,
  cenario_id INTEGER NOT NULL,
  unidade TEXT NOT NULL,                 -- CEO BARRA, COPACABANA, ... ADMINISTRAÇÃO, LOCAÇÕES
  vgv REAL NOT NULL DEFAULT 0,           -- VGV mensal previsto (0 p/ linhas de receita fixa)
  comissao_pct REAL NOT NULL DEFAULT 0,  -- % sobre o VGV
  receita_fixa REAL NOT NULL DEFAULT 0,  -- receita que não vem de VGV (adm, locação)
  ordem INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (cenario_id) REFERENCES cenarios(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cenlin_cen ON cenario_linhas(cenario_id);

-- PREMISSAS: % de comissão por praça + parâmetros globais (aba PREMISSAS) -------
CREATE TABLE IF NOT EXISTS premissas (
  id INTEGER PRIMARY KEY,
  ano INTEGER NOT NULL,
  chave TEXT NOT NULL,                   -- comissao:Barra | param:receita_nao_comissao | param:margem_alvo ...
  rotulo TEXT,
  valor REAL NOT NULL DEFAULT 0,
  UNIQUE(ano, chave)
);

-- Premissas globais por ano ---------------------------------------------------
CREATE TABLE IF NOT EXISTS config (
  chave TEXT PRIMARY KEY,
  valor TEXT
);
`;
