#!/usr/bin/env node
// ============================================================================
// Integração Notion -> Zahav (experimento, tabela isolada notion_entrada)
//
// IDA  : lê cards com "Enviar para o Zahav" = true e "ID Zahav" vazio,
//        valida o básico, insere em notion_entrada (pendente) e grava
//        "Enviado" + ID no card. Se faltar algo, grava "Erro" no card.
// VOLTA: entradas aprovadas/rejeitadas no Zahav -> devolve ao card
//        (Sincronização = Aprovado / Rejeitado + motivo no campo Erro).
//
// NÃO cria lançamentos: isso acontece no Zahav (tela "Entrada Notion") ao aprovar.
//
// Uso:
//   node notion-sync.mjs             # roda ida+volta (grava)
//   node notion-sync.mjs --dry-run   # só loga, não grava (à prova de erro no Windows)
//   DRY_RUN=1 node notion-sync.mjs   # idem (aceita 1/true/yes/on, com espaços)
//   node notion-sync.mjs --setup     # cria as propriedades no Notion (1x) e remove "Alnitak"
//
// Token: variável de ambiente NOTION_TOKEN (nunca no código/repositório).
//        Em alternativa, arquivo gitignored data/notion-secret.json  -> { "token": "secret_..." }
// ============================================================================
import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_SOURCE_ID = 'c2f285d9-bb7a-4dc1-b51c-acf4b66a8f7e';
const NOTION_VERSION = '2025-09-03';
const FLUXO_DB = process.env.FLUXO_DB || resolve(__dirname, 'data', 'fluxo.db');
const LOG = resolve(__dirname, 'data', 'notion-sync.log');
// DRY_RUN à prova de erro: trim + aceita 1/true/yes/on (o "set DRY_RUN=1 && ..." do Windows
// grava "1 " com espaço no fim). Flag de linha de comando: --dry-run (ou --dry).
const envDry = String(process.env.DRY_RUN ?? '').trim().toLowerCase();
const DRY = ['1', 'true', 'yes', 'on'].includes(envDry) || process.argv.includes('--dry-run') || process.argv.includes('--dry');
const SETUP = process.argv.includes('--setup');

// centros de custo válidos no Notion (lista curta aprovada)
const CENTROS_VALIDOS = ['despesas operacionais', 'sistemas', 'marketing', 'jurídico', 'encargos adm', 'aquisições e melhorias', 'a classificar'];

function token() {
  if (process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN;
  const f = resolve(__dirname, 'data', 'notion-secret.json');
  if (existsSync(f)) { try { return JSON.parse(readFileSync(f, 'utf8')).token; } catch {} }
  throw new Error('NOTION_TOKEN ausente (defina a variável de ambiente ou data/notion-secret.json).');
}
function log(...a) {
  const line = `[${new Date().toISOString()}]${DRY ? ' [DRY]' : ''} ` + a.join(' ');
  console.log(line);
  try { appendFileSync(LOG, line + '\n'); } catch {}
}

// ---------- Notion REST com rate-limit (~3/s) + retry/backoff ----------
let ultima = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function notion(path, { method = 'GET', body } = {}) {
  const TOK = token();
  for (let tent = 0; tent < 5; tent++) {
    const gap = 350 - (Date.now() - ultima);      // ~3 req/s
    if (gap > 0) await sleep(gap);
    ultima = Date.now();
    const res = await fetch('https://api.notion.com/v1' + path, {
      method,
      headers: { Authorization: `Bearer ${TOK}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 || res.status >= 500) {
      const wait = Number(res.headers.get('retry-after') || 0) * 1000 || (500 * 2 ** tent);
      log(`  aviso: HTTP ${res.status}, retry em ${wait}ms`);
      await sleep(wait); continue;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Notion ${res.status}: ${json.message || res.statusText}`);
    return json;
  }
  throw new Error('Notion: falhou após retries');
}

// ---------- leitura de propriedades ----------
const pTitle = (p) => (p?.title || []).map((t) => t.plain_text).join('').trim();
const pText = (p) => (p?.rich_text || []).map((t) => t.plain_text).join('').trim();
const pNum = (p) => (p && typeof p.number === 'number' ? p.number : null);
const pDate = (p) => p?.date?.start || null;
const pSelect = (p) => p?.select?.name || null;
const pCheck = (p) => !!p?.checkbox;
const pUrl = (p) => p?.url || null;

// ---------- escrita no card ----------
function propsEscrita({ idZahav, sincronizacao, erro, statusPago }) {
  const out = {};
  if (idZahav !== undefined) out['ID Zahav'] = { rich_text: idZahav ? [{ text: { content: String(idZahav) } }] : [] };
  if (sincronizacao !== undefined) out['Sincronização'] = { select: { name: sincronizacao } };
  if (erro !== undefined) out['Erro'] = { rich_text: erro ? [{ text: { content: erro } }] : [] };
  if (statusPago) out['Status'] = { select: { name: 'Pago' } };
  return out;
}
async function atualizarCard(pageId, campos) {
  if (DRY) { log(`  [card ${pageId}] -> ${JSON.stringify(campos)}`); return; }
  await notion(`/pages/${pageId}`, { method: 'PATCH', body: { properties: propsEscrita(campos) } });
}

// ---------- IDA: Notion -> notion_entrada ----------
async function ida(db) {
  const insert = db.prepare(`INSERT OR IGNORE INTO notion_entrada
    (notion_page_id, nome, valor, vencimento, centro_custo, comprovante, empresa, fornecedor, status, notion_sync)
    VALUES (?,?,?,?,?,?,?,?, 'pendente', NULL)`);
  const achaPorPage = db.prepare('SELECT id FROM notion_entrada WHERE notion_page_id=?');

  let cursor, novos = 0, erros = 0, repetidos = 0;
  do {
    const resp = await notion(`/data_sources/${DATA_SOURCE_ID}/query`, {
      method: 'POST',
      body: {
        filter: { and: [
          { property: 'Enviar para o Zahav', checkbox: { equals: true } },
          { property: 'ID Zahav', rich_text: { is_empty: true } },
        ] },
        page_size: 100, start_cursor: cursor,
      },
    });
    for (const page of resp.results) {
      const pr = page.properties || {};
      const descricao = pTitle(pr['Descrição']);
      const valor = pNum(pr['Valor']);
      const venc = pDate(pr['Vencimento']);
      const centro = pSelect(pr['Centro de custo']);
      const empresa = pSelect(pr['Empresa']);
      const fornecedor = pText(pr['Fornecedor']);
      const comprovante = pUrl(pr['Comprovante']);

      // validação do básico -> erro amigável, não cria nada
      const faltas = [];
      if (!descricao) faltas.push('a descrição');
      if (!venc) faltas.push('o vencimento');
      if (valor == null || valor <= 0) faltas.push('um valor maior que zero');
      if (!centro) faltas.push('o centro de custo');
      else if (!CENTROS_VALIDOS.includes(centro)) faltas.push(`um centro de custo válido (recebido: "${centro}")`);
      if (faltas.length) {
        erros++;
        log(`  ERRO card ${page.id}: falta ${faltas.join(', ')}`);
        await atualizarCard(page.id, { sincronizacao: 'Erro', erro: 'Falta ' + faltas.join(', ') + '. Complete e reenvie.' });
        continue;
      }

      // idempotência: já existe entrada para este card?
      const existente = achaPorPage.get(page.id);
      let entradaId;
      if (existente) { entradaId = existente.id; repetidos++; log(`  repetido card ${page.id} -> entrada #${entradaId} (não recria)`); }
      else {
        const nome = `${descricao}${fornecedor ? ' — ' + fornecedor : ''}${empresa ? ' (' + empresa + ')' : ''}`;
        if (DRY) { log(`  NOVO (não gravado) card ${page.id}: ${nome} | ${valor} | ${venc} | ${centro}`); entradaId = '(dry)'; novos++; }
        else {
          const info = insert.run(page.id, nome, valor, venc, centro, comprovante, empresa, fornecedor);
          entradaId = info.lastInsertRowid; novos++;
          log(`  novo card ${page.id} -> entrada #${entradaId}: ${nome}`);
        }
      }
      // write-back: ID Zahav + Enviado
      await atualizarCard(page.id, { idZahav: entradaId, sincronizacao: 'Enviado', erro: '' });
    }
    cursor = resp.has_more ? resp.next_cursor : null;
  } while (cursor);
  log(`IDA: ${novos} novo(s), ${repetidos} repetido(s), ${erros} com erro.`);
}

// ---------- VOLTA: notion_entrada -> card (só o que mudou) ----------
async function volta(db) {
  // devolve aprovados/rejeitados cujo notion_sync ainda não reflete o status atual
  const pend = db.prepare("SELECT * FROM notion_entrada WHERE status IN ('aprovado','rejeitado') AND (notion_sync IS NULL OR notion_sync <> status)").all();
  const marca = db.prepare('UPDATE notion_entrada SET notion_sync=? WHERE id=?');
  let n = 0;
  for (const e of pend) {
    if (!e.notion_page_id) continue;
    if (e.status === 'aprovado') await atualizarCard(e.notion_page_id, { sincronizacao: 'Aprovado', erro: '' });
    else await atualizarCard(e.notion_page_id, { sincronizacao: 'Rejeitado', erro: e.motivo || 'Rejeitado no Zahav.' });
    if (!DRY) marca.run(e.status, e.id);
    n++;
    log(`  volta entrada #${e.id} -> ${e.status}`);
  }
  log(`VOLTA: ${n} card(s) atualizado(s).`);
}

// ---------- SETUP: cria propriedades no Notion e remove "Alnitak" ----------
async function setup() {
  log('SETUP: criando propriedades e ajustando Empresa…');
  const body = { properties: {
    'Centro de custo': { select: { options: CENTROS_VALIDOS.map((name) => ({ name })) } },
    'Fornecedor': { rich_text: {} },
    'Enviar para o Zahav': { checkbox: {} },
    'Sincronização': { select: { options: ['Aguardando', 'Enviado', 'Aprovado', 'Rejeitado', 'Erro'].map((name) => ({ name })) } },
    'ID Zahav': { rich_text: {} },
    'Erro': { rich_text: {} },
    // remove "Alnitak": só mantém estas opções
    'Empresa': { select: { options: [{ name: 'Matriz RJ' }, { name: 'Filial SP' }] } },
  } };
  if (DRY) { log('  (dry) PATCH data_source properties: ' + JSON.stringify(Object.keys(body.properties))); return; }
  await notion(`/data_sources/${DATA_SOURCE_ID}`, { method: 'PATCH', body });
  log('SETUP concluído.');
}

// ---------- main ----------
(async () => {
  log(`=== notion-sync início ${SETUP ? '(setup)' : ''}${DRY ? ' DRY_RUN' : ''} ===`);
  try {
    if (SETUP) { await setup(); log('=== fim ==='); return; }
    const db = new DatabaseSync(FLUXO_DB);
    db.exec('PRAGMA busy_timeout = 4000;');
    await ida(db);
    await volta(db);
    log('=== fim ===');
  } catch (e) { log('FALHA: ' + e.message); process.exitCode = 1; }
})();
