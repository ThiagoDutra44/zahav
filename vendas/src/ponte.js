// Ponte AO VIVO Vendas/Locações -> Fluxo de Caixa
// A cada gravação de uma venda, reconcilia (idempotente) os lançamentos-espelho dela
// no banco do fluxo-caixa. Cada lançamento é marcado com "[V<id>]" e origem='venda',
// então é 100% rastreável e reversível (basta apagar por origem='venda').
//
// Regras (escolhidas pelo usuário):
//  - Previsão + Recebido: o que está na previsão entra como 'orçado'; ao receber vira 'real'.
//  - Espelhar o caixa real: ao receber, entra o TOTAL (comissão + repasse) e sai o repasse.
import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FLUXO_DB = process.env.FLUXO_DB || resolve(__dirname, '..', '..', 'fluxo-caixa', 'data', 'fluxo.db');
const LIVRO = 'empresa';
const CC_COMISSAO = (seg) => (seg === 'locacao' ? 'receita · Comissão Locações' : 'receita · Comissão Vendas');
const CC_REPASSE = 'Repasse a corretores (passa pelo caixa)';
const CC_MARGINAL = 'receita · RECEITA MARGINAL'; // receitas marginais (premiação, comissão financiamento, etc.)
const pad = (n) => String(n).padStart(2, '0');
const addDiasISO = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// Regra de dia útil do fluxo-caixa: uma PREVISÃO que cai em sáb/dom/feriado só se realiza no próximo
// dia útil. Não se aplica a 'real' (já aconteceu — PIX e cartão rodam no fim de semana).
// Os feriados vêm da própria tabela do fluxo-caixa, então a regra é a mesma dos dois lados.
function diaUtil(iso, tipo) {
  if (tipo === 'real' || !fdb || !iso) return iso;
  let fer;
  try { fer = new Set(fdb.prepare('SELECT data FROM feriados').all().map((r) => r.data)); } catch { return iso; }
  let cur = iso;
  for (let i = 0; i < 14; i++) {
    const w = new Date(cur + 'T00:00:00Z').getUTCDay();
    if (w !== 0 && w !== 6 && !fer.has(cur)) return cur;
    cur = addDiasISO(cur, 1);
  }
  return cur;
}

let fdb = null;
export function abrirFluxo() {
  if (!existsSync(FLUXO_DB)) { console.log('Ponte: fluxo.db não encontrado — ponte desligada.'); return false; }
  try {
    fdb = new DatabaseSync(FLUXO_DB);
    fdb.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 4000;');
    console.log('Ponte com o Fluxo de Caixa LIGADA →', FLUXO_DB);
    return true;
  } catch (e) { console.error('Ponte: falha ao abrir fluxo.db:', e.message); fdb = null; return false; }
}
export const ponteAtiva = () => !!fdb;

const delDaVenda = (id) => fdb.prepare("DELETE FROM lancamentos WHERE origem='venda' AND nome LIKE ?").run(`[V${id}] %`);
// no re-sync apaga só o previsto: o que já foi confirmado como 'real' no fluxo-caixa fica de pé
const delPrevistos = (id) => fdb.prepare("DELETE FROM lancamentos WHERE origem='venda' AND tipo<>'real' AND nome LIKE ?").run(`[V${id}] %`);
// "slot" = que compromisso é este, independente do estado e do nome do cliente/produto.
// Corta o "· CLIENTE (produto)" do fim (senão renomear o produto criaria um 2º lançamento) e
// neutraliza prevista/recebida (é o mesmo compromisso nos dois estados). Ex.:
//   "[V9] Comissão prevista · ANA (IPANEMA)"            -> "[V9] Comissão *"
//   "[V9] Marginal recebida · Premiação · ANA (LEBLON)" -> "[V9] Marginal * · Premiação"
const slot = (n) => {
  const s = String(n);
  const i = s.lastIndexOf(' · ');
  return (i > 0 ? s.slice(0, i) : s).replace(/\b(prevista|recebida)\b/gi, '*');
};

// reconcilia UMA venda (recria os espelhos conforme o estado atual, preservando confirmações manuais)
export function sincronizarVenda(v, marginais = [], parcelas = []) {
  if (!fdb || !v) return;
  try {
    // fora do caixa = não espelha nada; aí limpa inclusive o que estiver confirmado
    if (v.fora_caixa) { delDaVenda(v.id); return; }
    // O usuário costuma confirmar o recebimento direto no fluxo-caixa (marca 'real' lá, não aqui).
    // Sem isso, cada re-sync desta venda apagava a confirmação dele sem aviso. Guardamos o lançamento
    // real de cada "slot" para PRESERVAR a confirmação (tipo real + data) mas ainda assim ACOMPANHAR o
    // valor quando a comissão muda no Sales (ex.: alterar a margem) — senão o valor ficava congelado.
    const jaReal = new Map(
      fdb.prepare("SELECT id,nome,valor,centro_custo FROM lancamentos WHERE origem='venda' AND tipo='real' AND nome LIKE ?")
        .all(`[V${v.id}] %`).map((r) => [slot(r.nome), r]),
    );
    const updReal = fdb.prepare('UPDATE lancamentos SET valor=?, centro_custo=? WHERE id=?');
    delPrevistos(v.id);
    const insRaw = fdb.prepare("INSERT INTO lancamentos (data,nome,centro_custo,tipo,valor,origem,prioridade,livro) VALUES (?,?,?,?,?, 'venda', NULL, ?)");
    const nome = (txt) => `[V${v.id}] ${txt} · ${v.cliente}${v.produto ? ' (' + v.produto + ')' : ''}`;
    // já confirmado no caixa (real): não duplica — ATUALIZA o valor/centro do lançamento real (mantém
    // tipo real e a data do recebimento). Novo slot: insere normalmente.
    const ins = (data, n, cc, tipo, valor, livro) => {
      const ex = jaReal.get(slot(n));
      if (ex) { if (Math.abs((ex.valor || 0) - valor) > 0.005 || ex.centro_custo !== cc) updReal.run(valor, cc, ex.id); return; }
      insRaw.run(data, n, cc, tipo, valor, livro);
    };
    // mesma regra da previsão de faturamento: previsto só entra se ASSINADA (firme) ou QUENTE c/ prever_caixa
    const perdida = v.status === 'DISTRATO' || v.status === 'PERDIDA' || v.status === 'CANCELADA';
    const firme = v.status === 'ASSINADA';
    const quenteAberta = v.mapa_calor === 'QUENTE' && !!v.prever_caixa && v.status !== 'ASSINADA';
    const podePrever = !perdida && (firme || quenteAberta);
    // --- comissão (faturamento) ---
    const fat = v.faturamento || 0;
    const parc = (parcelas || []).filter((p) => Number(p.valor) > 0);
    if (fat && parc.length) {
      // Comissão recebida em parcelas (datas próprias): espelha uma a uma. Repasse de corretores
      // NÃO é tratado neste modo (raro junto com parcelamento) — para repasse, use o recebimento único.
      parc.forEach((p, i) => {
        const val = Number(p.valor) || 0;
        const rot = `Comissão ${i + 1}/${parc.length}`;
        if (p.recebido) {
          const data = p.data_recebido || p.data_prevista || `${v.ano}-${pad(v.mes)}-15`;
          ins(data, nome(rot + ' recebida'), CC_COMISSAO(v.segmento), 'real', val, LIVRO);   // receita (+)
        } else if (podePrever) {
          const data = p.data_prevista || `${v.ano}-${pad(v.mes)}-15`;
          ins(diaUtil(data, 'orçado'), nome(rot + ' prevista'), CC_COMISSAO(v.segmento), 'orçado', val, LIVRO); // receita prevista (+)
        }
      });
    } else if (fat) {
      if (v.recebido) {
        const data = v.data_recebido || `${v.ano}-${pad(v.mes)}-15`;
        const total = v.valor_recebido || fat;
        const repasse = Math.max(0, total - fat);
        ins(data, nome('Comissão recebida'), CC_COMISSAO(v.segmento), 'real', fat, LIVRO);   // nossa receita (+)
        if (repasse > 0) {
          ins(data, nome('Repasse recebido'), CC_REPASSE, 'real', repasse, LIVRO);            // entra na conta (+)
          ins(diaUtil(data, 'orçado'), nome('Repasse a corretores'), CC_REPASSE, 'orçado', -repasse, LIVRO); // sai depois (previsto, -)
        }
      } else if (podePrever) {
        const data = v.data_recebimento || `${v.ano}-${pad(v.mes)}-15`;
        ins(diaUtil(data, 'orçado'), nome('Comissão prevista'), CC_COMISSAO(v.segmento), 'orçado', fat, LIVRO); // receita prevista (+)
      }
    }
    // --- receitas marginais (mesma regra: recebida sempre vira real; prevista só se podePrever) ---
    for (const mg of (marginais || [])) {
      const val = Number(mg.valor) || 0;
      if (!val) continue;
      const desc = (mg.tipo && String(mg.tipo).trim()) || 'Receita marginal';
      if (mg.recebido) {
        const data = mg.data_recebido || `${v.ano}-${pad(v.mes)}-15`;
        ins(data, nome('Marginal recebida · ' + desc), CC_MARGINAL, 'real', val, LIVRO);
      } else if (podePrever) {
        const data = mg.data_prevista || `${v.ano}-${pad(v.mes)}-15`;
        ins(diaUtil(data, 'orçado'), nome('Marginal prevista · ' + desc), CC_MARGINAL, 'orçado', val, LIVRO);
      }
    }
  } catch (e) { console.error('Ponte: erro ao sincronizar venda', v.id, '-', e.message); }
}
export function removerVenda(id) { if (fdb) { try { delDaVenda(id); } catch (e) { console.error('Ponte: erro ao remover', id, e.message); } } }

// reconcilia TODAS as vendas (uso na ativação inicial e em re-sincronizações)
export function sincronizarTudo(vendas, margGetter, parcGetter) {
  if (!fdb) return 0;
  let n = 0;
  fdb.exec('BEGIN');
  try { for (const v of vendas) { sincronizarVenda(v, margGetter ? margGetter(v.id) : [], parcGetter ? parcGetter(v.id) : []); n++; } fdb.exec('COMMIT'); }
  catch (e) { fdb.exec('ROLLBACK'); console.error('Ponte: erro no sincronizarTudo:', e.message); }
  return n;
}
// remove TODOS os espelhos de vendas (desconectar)
export function limparTudo() {
  if (!fdb) return 0;
  const info = fdb.prepare("DELETE FROM lancamentos WHERE origem='venda'").run();
  return info.changes;
}
export function statusPonte() {
  if (!fdb) return { ativa: false, lancamentos: 0 };
  return { ativa: true, db: FLUXO_DB, lancamentos: fdb.prepare("SELECT COUNT(*) c FROM lancamentos WHERE origem='venda'").get().c };
}
