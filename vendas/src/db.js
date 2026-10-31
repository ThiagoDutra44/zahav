import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.VENDAS_DB || resolve(__dirname, '..', 'data', 'vendas.db');

export function openDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  return db;
}

// Funil de vendas (ordem do mais frio ao fechado). ASSINADA = venda realizada.
export const FUNIL = ['INTERESSE', 'CRÉDITO', 'PROPOSTA', 'MINUTA', 'ASSINADA'];
// Estados terminais "perdidos" que ficavam visíveis no funil — aposentados em favor de CANCELADA.
// (mantido como lista p/ não quebrar referências; hoje vazio.)
export const PERDIDOS = [];
// Desistência: único status de saída. A proposta cancelada sai da planilha de vendas
// e vai p/ o quadro de desistências apartado (com motivo).
export const DESISTENCIA = 'CANCELADA';
export const STATUS_FECHADO = 'ASSINADA';
export const CALORES = ['QUENTE', 'MORNO', 'FRIO'];

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS vendas (
  id INTEGER PRIMARY KEY,
  ano INTEGER NOT NULL,
  mes INTEGER NOT NULL,                 -- 1-12 (mês de referência da venda)
  data TEXT,                            -- ISO YYYY-MM-DD opcional (assinatura/fechamento)
  cliente TEXT NOT NULL,
  produto TEXT,                         -- "BAIRRO/PRODUTO" da planilha
  filial TEXT,
  corretor TEXT,
  opcionista TEXT,
  gerente TEXT,
  vgv REAL NOT NULL DEFAULT 0,          -- Valor Geral de Vendas
  margem_pct REAL DEFAULT 0,            -- IUM % (comissão sobre o VGV)
  faturamento REAL NOT NULL DEFAULT 0,  -- IMOVELUM = vgv * margem_pct/100
  status TEXT NOT NULL DEFAULT 'INTERESSE', -- funil (ver FUNIL); CANCELADA = desistência (sai da planilha)
  motivo TEXT,                          -- observação do motivo da desistência (status CANCELADA)
  mapa_calor TEXT,                      -- QUENTE | MORNO | FRIO
  segmento TEXT NOT NULL DEFAULT 'venda', -- venda | locacao (mesma estrutura, dados separados)
  data_recebimento TEXT,                -- ISO: previsão de entrada da comissão (faturamento)
  recebido INTEGER NOT NULL DEFAULT 0,  -- 1 = comissão efetivamente recebida (concilia c/ fluxo de caixa)
  data_recebido TEXT,                   -- ISO: data real do recebimento
  valor_recebido REAL NOT NULL DEFAULT 0, -- total que entrou na conta (comissão + repasse de corretores); 0 = igual à comissão
  prever_caixa INTEGER NOT NULL DEFAULT 1, -- (quentes) 1 = esta venda conta na previsão de caixa
  fora_caixa INTEGER NOT NULL DEFAULT 0,   -- 1 = não espelha no fluxo-caixa (financeiro antigo já conciliado)
  administra INTEGER NOT NULL DEFAULT 0, -- (locação) 1 = ImovelUm administra o imóvel
  taxa_adm REAL NOT NULL DEFAULT 0,      -- (locação) taxa de administração % sobre o aluguel
  livro TEXT NOT NULL DEFAULT 'imovelum',
  fluxo_sync INTEGER NOT NULL DEFAULT 0,    -- 1 = comissão já lançada no fluxo-caixa
  fluxo_lanc_id INTEGER,                     -- id do lançamento espelho no fluxo-caixa
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vendas_ano ON vendas(ano);
CREATE INDEX IF NOT EXISTS idx_vendas_status ON vendas(status);
CREATE INDEX IF NOT EXISTS idx_vendas_corretor ON vendas(corretor);

-- Listas de apoio (GERENTES, CORRETORES, OPCIONISTAS, FILIAIS)
CREATE TABLE IF NOT EXISTS cadastros (
  id INTEGER PRIMARY KEY,
  tipo TEXT NOT NULL,                   -- gerente | corretor | opcionista | filial
  nome TEXT NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1,
  UNIQUE(tipo, nome)
);

-- Premissas/metas por ano e segmento (VGV e faturamento)
CREATE TABLE IF NOT EXISTS metas (
  ano INTEGER NOT NULL,
  segmento TEXT NOT NULL DEFAULT 'venda',
  meta_vgv REAL NOT NULL DEFAULT 0,
  meta_fat REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (ano, segmento)
);

CREATE TABLE IF NOT EXISTS config (
  chave TEXT PRIMARY KEY,
  valor TEXT
);

-- Receitas marginais: dinheiros extras de uma venda (premiação, comissão de financiamento, etc.)
-- que entram em data/valor próprios, fora da comissão principal. Aparecem nos Recebíveis pela data prevista.
CREATE TABLE IF NOT EXISTS receitas_marginais (
  id INTEGER PRIMARY KEY,
  venda_id INTEGER NOT NULL,
  tipo TEXT,                         -- descrição (ex.: Premiação, Comissão financiamento)
  valor REAL NOT NULL DEFAULT 0,
  data_prevista TEXT,                -- ISO: previsão de recebimento
  recebido INTEGER NOT NULL DEFAULT 0,
  data_recebido TEXT,                -- ISO: data real do recebimento
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_marg_venda ON receitas_marginais(venda_id);

-- Parcelas da comissão: quando a comissão de uma venda entra em 2+ momentos (ex.: 50% assinatura,
-- 50% registro). A soma deve fechar o faturamento. Quando existem, substituem a data única de
-- recebimento: cada parcela aparece nos Recebíveis na sua data e a ponte espelha uma a uma no caixa.
CREATE TABLE IF NOT EXISTS comissao_parcelas (
  id INTEGER PRIMARY KEY,
  venda_id INTEGER NOT NULL,
  valor REAL NOT NULL DEFAULT 0,
  data_prevista TEXT,                -- ISO: previsão de recebimento desta parcela
  recebido INTEGER NOT NULL DEFAULT 0,
  data_recebido TEXT,                -- ISO: data real do recebimento
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cp_venda ON comissao_parcelas(venda_id);
`;
