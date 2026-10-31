const $ = (s, r = document) => r.querySelector(s);
const api = (u, o) => fetch(u, o).then((r) => r.json());
const BRL = (n) => (n < 0 ? '-' : '') + 'R$ ' + Math.abs(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// exibição padronizada do centro de custo (não altera o valor gravado): 1ª letra de cada palavra
// maiúscula; siglas em caixa-alta; conectores (de/da/do/e) minúsculos
const _SIGLAS = new Set(['pdv', 'iof', 'pj']);
const _MINUS = new Set(['de', 'da', 'do', 'e']);
const capCC = (s) => String(s || '').split(/\s+/).map((w) => {
  const low = w.toLowerCase();
  if (w === '·') return '·';
  if (_MINUS.has(low)) return low;
  if (_SIGLAS.has(low)) return w.toUpperCase();
  return w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w;
}).join(' ');
// ordena centros: despesas primeiro (alfabético), receitas por último
const ordenaCC = (arr) => [...arr].sort((a, b) => {
  const ra = /receita/i.test(a), rb = /receita/i.test(b);
  if (ra !== rb) return ra ? 1 : -1;
  return capCC(a).localeCompare(capCC(b), 'pt');
});
const WD = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

let META = null;
let refDate = '2026-06-15';        // data de referência
let periodo = null;                // { semanas:[...], total, caixa_fim }
let view = 'semana';               // semana | 2sem | 4sem | mes
let recFiltroCC = null;            // filtro de centro de custo na tela de recorrentes
let ccFiltro = null;               // filtro de centro de custo no calendário (destaca 1, apaga o resto, recalcula somas)
let recFiltroLivro = null;         // filtro de caixa na tela de recorrentes (null=todos)
let pendLivro = 'empresa';         // caixa do Mapa de Pendências aberto
let pendFiltroCat = null;          // filtro de categoria no Mapa de Pendências
let temDutra = false;              // há lançamentos/caixa Dutra no período exibido?
const lq = (url) => url;           // calendário é unificado (empresa + dutra juntos)
const VIEWS = { semana: { semanas: 1 }, '2sem': { semanas: 2 }, '4sem': { semanas: 4 }, mes: {} };
const MESNOME = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const sel = new Set();              // ids selecionados p/ reagendar
// ghost persistido no navegador (localStorage): sustenta entre telas/reloads até você limpar ou enviar
const GHOST_KEY = 'zghost';
const _g0 = (() => { try { return JSON.parse(localStorage.getItem(GHOST_KEY) || '[]'); } catch { return []; } })();
// formato antigo = array de ids; novo = { i:[ids avulsos], r:[chaves "recorrencia_id|data"] }
const ghost = new Set(Array.isArray(_g0) ? _g0 : (_g0.i || []));   // ids de lançamentos avulsos
const ghostR = new Set(Array.isArray(_g0) ? [] : (_g0.r || []));   // recorrentes por chave estável
const saveGhost = () => { try { localStorage.setItem(GHOST_KEY, JSON.stringify({ i: [...ghost], r: [...ghostR] })); } catch {} };
// helpers: achar lançamento no período, chave de recorrência, e se está fantasmado
const lancById = (id) => { if (!periodo) return null; for (const w of periodo.semanas) for (const d of w.dias) for (const l of d.lancamentos) if (l.id === id) return l; return null; };
const recKey = (l) => (l && l.recorrencia_id ? l.recorrencia_id + '|' + l.data : null);
const isGhosted = (l) => !!l && (ghost.has(l.id) || l.ghost === 1 || (recKey(l) && ghostR.has(recKey(l))));
// ids atuais de tudo que está fantasmado (avulsos + recorrentes resolvidos no período exibido)
const ghostCurrentIds = () => { const ids = new Set(ghost); if (periodo) for (const w of periodo.semanas) for (const d of w.dias) for (const l of d.lancamentos) { const k = recKey(l); if (k && ghostR.has(k)) ids.add(l.id); } return [...ids]; };
let ghostMode = false;             // quando ligado, clicar num item fantasma/desfantasma

const pad = (n) => String(n).padStart(2, '0');
function fmtData(iso) { const [y, m, d] = iso.split('-'); return `${d}/${m}`; }
function hojeISO() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
// Semana de referência: seg–sex normal; mas no fim de semana (sáb/dom),
// como a sexta já passou, já aponta para a SEMANA SEGUINTE.
function refHoje() {
  const h = hojeISO();
  if (!h.startsWith('2026')) return '2026-06-15';
  const wd = new Date(h + 'T00:00:00Z').getUTCDay(); // 0 dom .. 6 sáb
  if (wd === 6) return addDiasISO(h, 2);  // sábado -> segunda seguinte
  if (wd === 0) return addDiasISO(h, 1);  // domingo -> segunda seguinte
  return h;                                // seg–sex: semana corrente
}
const allDias = () => (periodo ? periodo.semanas.flatMap((w) => w.dias) : []);
const allLancs = () => allDias().flatMap((d) => d.lancamentos);

// monta os parâmetros do período conforme a visão atual
function periodoParams() {
  if (view !== 'mes' && view !== 'mesresto') return { start: refDate, semanas: VIEWS[view].semanas, dimMes: null };
  const [y, mo] = refDate.split('-').map(Number);
  const ym = `${y}-${pad(mo)}`;
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const lastISO = `${ym}-${pad(lastDay)}`;
  // mês inteiro parte do dia 1; "resto do mês" parte de hoje (se hoje cair neste mês) ou do dia 1
  const ini = (view === 'mesresto' && hojeISO().slice(0, 7) === ym) ? hojeISO() : `${ym}-01`;
  let seg = ini; while (new Date(seg + 'T00:00:00Z').getUTCDay() !== 1) seg = addDiasISO(seg, -1);
  const semanas = Math.ceil((((new Date(lastISO + 'T00:00:00Z') - new Date(seg + 'T00:00:00Z')) / 86400000) + 1) / 7);
  const p = { start: seg, semanas: Math.min(6, semanas), dimMes: ym };
  // os quadros apuram a janela EXATA do mês (mês inteiro = dia 1→fim; resto do mês = hoje→fim),
  // sem vazar os dias da semana de borda (ex.: 29-30/06 aparecem na grade de julho mas NÃO contam)
  p.de = ini; p.ate = lastISO;
  if (view === 'mesresto') p.dimAntes = ini;
  return p;
}
function addDiasISO(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

async function boot() {
  META = await api(lq('api/meta'));
  refDate = refHoje(); // semana corrente (ou a seguinte, se já passou a sexta)
  bind();
  await render();
}

function bind() {
  $('#prev').onclick = () => move(-1);
  $('#next').onclick = () => move(1);
  $('#hoje').onclick = () => { refDate = refHoje(); render(); };
  $('#ccFilter').onchange = (e) => { ccFiltro = e.target.value || null; aplicarFiltroCC(); };
  $('#btnAdd').onclick = () => modalLancamento();
  $('#btnMover').onclick = () => modalMover();
  $('#btnExcluirSel').onclick = () => excluirSelecionados();
  $('#btnGhost').onclick = () => setGhostMode(!ghostMode);
  $('#btnLocalizar').onclick = () => modalLocalizar();
  $('#btnConsolidado').onclick = () => modalConsolidado();
  $('#btnReceitas').onclick = () => modalReceitas();
  $('#btnRecorrentes').onclick = () => modalRecorrentes('empresa');
  $('#btnRecorrentesDutra').onclick = () => modalRecorrentes('dutra');
  $('#btnFecharMes').onclick = () => modalFecharMes();
  $('#btnMapaPend').onclick = () => modalPendencias('empresa');
  $('#btnMapaPendDutra').onclick = () => modalPendencias('dutra');
  $('#btnRelatorio').onclick = () => {
    let de, ate;
    if (view === 'mesresto' && periodo.janela) {               // resto do mês = janela exata [hoje..fim do mês]
      de = periodo.janela.de; ate = periodo.janela.ate;
    } else if (view === 'mes') {                               // visão Mês = mês-calendário exato (sem vazar semana)
      const ym = periodo.dimMes || refDate.slice(0, 7);        // 'YYYY-MM'
      const [y, m] = ym.split('-').map(Number);
      de = `${ym}-01`;
      ate = `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
    } else {                                                   // semana / 2 / 4 semanas = intervalo exibido
      de = periodo.semanas[0].seg; ate = periodo.semanas.at(-1).sex;
    }
    const url = new URL('relatorio.html', document.baseURI);   // resolve certo standalone (/) e no ZAHAV (/fluxo/)
    url.search = `?de=${de}&ate=${ate}`;
    const a = document.createElement('a');                     // link real = não é bloqueado como pop-up
    a.href = url.href; a.target = '_blank'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  };
  $('#btnFatReal').onclick = () => modalFaturamentoReal();
  $('#btnNotion').onclick = () => modalNotionEntradas();
  // modo privacidade: borra a tela e revela só o dia atual + holofote do mouse + dias "pinados" no clique
  { let privOn = false; const film = $('#privacyFilm');
    $('#btnPriv').onclick = () => {
      privOn = !privOn;
      document.documentElement.classList.toggle('privacy', privOn);
      $('#btnPriv').classList.toggle('on', privOn);
      if (!privOn) document.querySelectorAll('.priv-focus').forEach((el) => el.classList.remove('priv-focus')); // limpa os pins ao sair
    };
    window.addEventListener('mousemove', (e) => { if (!privOn) return; film.style.setProperty('--mx', e.clientX + 'px'); film.style.setProperty('--my', e.clientY + 'px'); }, { passive: true });
    // clicar num dia/card deixa ele iluminado (pinado); clicar de novo apaga
    document.addEventListener('click', (e) => {
      if (!privOn || e.target.closest('#btnPriv')) return;
      const alvo = e.target.closest('.day, .card');
      if (alvo) alvo.classList.toggle('priv-focus');
    }, true); }
  // rodapé recolhível: atalhos ocultos por padrão; 1 clique abre/fecha (estado lembrado)
  { const foot = document.querySelector('.foot');
    foot.classList.toggle('collapsed', (localStorage.getItem('zfoot') || 'col') !== 'open');
    $('#footToggle').onclick = () => { const c = foot.classList.toggle('collapsed'); try { localStorage.setItem('zfoot', c ? 'col' : 'open'); } catch {} }; }
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
  $('#viewmodes').querySelectorAll('button').forEach((b) => {
    b.onclick = (e) => {
      if (b.dataset.view === 'mes') { e.stopPropagation(); abrirMenuMes(b); return; } // mês abre escolha
      view = b.dataset.view;
      $('#viewmodes').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      render();
    };
  });
}

// menu do botão "Mês": mês inteiro × quanto falta até o fim do mês
function abrirMenuMes(btn) {
  document.querySelector('.mesmenu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'mesmenu';
  menu.innerHTML = `<button data-v="mes" class="${view === 'mes' ? 'on' : ''}">📅 Mês inteiro</button>
    <button data-v="mesresto" class="${view === 'mesresto' ? 'on' : ''}">⏳ Quanto falta até o fim do mês</button>`;
  const r = btn.getBoundingClientRect();
  menu.style.left = `${r.left}px`;
  menu.style.top = `${r.bottom + 6}px`;
  document.body.appendChild(menu);
  menu.querySelectorAll('button').forEach((mb) => mb.onclick = () => {
    view = mb.dataset.v;
    $('#viewmodes').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x.dataset.view === 'mes'));
    menu.remove();
    render();
  });
  setTimeout(() => document.addEventListener('click', function h(e) {
    if (!menu.contains(e.target) && e.target !== btn) { menu.remove(); document.removeEventListener('click', h); }
  }), 0);
}
function move(dir) {
  if (view === 'mes' || view === 'mesresto') {
    const [y, mo] = refDate.split('-').map(Number);
    const d = new Date(Date.UTC(y, mo - 1 + dir, 1));
    refDate = d.toISOString().slice(0, 10);
  } else {
    refDate = addDiasISO(refDate, dir * VIEWS[view].semanas * 7);
  }
  render();
}

async function render(focusDay) {
  const p = periodoParams();
  let url = `api/periodo?start=${p.start}&semanas=${p.semanas}`;
  if (p.de && p.ate) url += `&de=${p.de}&ate=${p.ate}`;
  if (ghost.size) url += `&ghost=${[...ghost].join(',')}`;
  if (ghostR.size) url += `&ghostr=${encodeURIComponent([...ghostR].join(','))}`;
  periodo = await api(lq(url));
  // poda fantasmas órfãos (ex.: [R] regerado mudou de id) para o ghost não travar
  if (ghost.size && Array.isArray(periodo.ghost_vivos)) {
    const vivos = new Set(periodo.ghost_vivos);
    let mudou = false;
    for (const id of [...ghost]) if (!vivos.has(id)) { ghost.delete(id); mudou = true; }
    if (mudou) saveGhost();
  }
  periodo.dimMes = p.dimMes;
  periodo.dimAntes = p.dimAntes || null;
  sel.clear(); updateMoverBtn();
  // fim = último dia REALMENTE exibido (vira sáb/dom quando o fim de semana tem lançamento)
  const ini = periodo.semanas[0].seg;
  const ultima = periodo.semanas.at(-1);
  const fim = (ultima.dias.at(-1) || {}).data || ultima.sex;
  if (view === 'mes' || view === 'mesresto') {
    const [y, mo] = refDate.split('-').map(Number);
    const sufixo = view === 'mesresto' ? ` · resto (${fmtData(periodo.janela.de)}–${fmtData(periodo.janela.ate)})` : '';
    $('#weeklabel').textContent = `${MESNOME[mo - 1]} ${y}${sufixo}`;
  } else {
    $('#weeklabel').textContent = `${fmtData(ini)} a ${fmtData(fim)} · ${ini.slice(0, 4)}`;
  }
  renderCards();
  renderWeeks();
  renderGhostBar();   // atualiza o consolidado dos fantasmas
  renderAvisosSeries();   // avisa quando uma série (repetição) está acabando
  popularFiltroCC();
  aplicarFiltroCC();
  if (focusDay) {
    const inp = $(`.quickadd[data-day="${focusDay}"] .qa-nome`);
    if (inp) inp.focus();
  }
}

async function renderCards() {
  const mes = refDate.slice(0, 7);
  const pp = periodoParams();
  let prioUrl = pp.de && pp.ate ? `api/prioridades?de=${pp.de}&ate=${pp.ate}` : `api/prioridades?start=${pp.start}&semanas=${pp.semanas}`;
  if (ghost.size) prioUrl += `&ghost=${[...ghost].join(',')}`;
  if (ghostR.size) prioUrl += `&ghostr=${encodeURIComponent([...ghostR].join(','))}`;
  const [dutra, prio, caixa] = await Promise.all([
    api('api/dutra?mes=' + mes), api(prioUrl), api('api/caixa'),
  ]);
  const chR = caixa.realizado, chP = caixa.projetado;
  const ini = periodo.caixa_inicial, rec = periodo.receitas, desp = periodo.despesas, res = periodo.caixa_fim;
  const pj = periodo.receita_pjbank || { realizado: 0, previsto: 0 };
  const ou = periodo.receita_outras || { realizado: 0, previsto: 0 };
  const dg = periodo.despesa_grupos || { enc_adm_repasse: { real: 0, previsto: 0 } };
  const encRep = (dg.enc_adm_repasse.real || 0) + (dg.enc_adm_repasse.previsto || 0); // encargos adm + repasses (negativo)
  const consEmp = (desp || 0) - encRep; // consolidado empresa = total despesas − (enc. adm e repasse)
  const escopo = view === 'mes' ? 'do mês' : view === 'mesresto' ? 'no resto do mês' : periodo.semanas.length > 1 ? 'do período' : 'da semana';
  const escopoCurto = view === 'mes' ? 'mês' : view === 'mesresto' ? 'resto mês' : periodo.semanas.length > 1 ? 'período' : 'semana';
  const mny = (n) => n < 0 ? 'money neg' : 'money pos';
  // Falta (s/ caixa) = só o que ainda FALTA acontecer: receita prevista − despesa orçada (exclui o já realizado)
  const falta = (periodo.receita.previsto || 0) + (periodo.despesa.previsto || 0);
  const faltaLbl = '🎯 Falta (s/ caixa)';
  const faltaSub = 'previsto − orçado';
  $('#cards').innerHTML = `
    <div class="card caixa cxwide ${res < 0 ? 'neg' : 'pos'}" id="cardCaixa" title="Caixa do período — início (abertura real) → hoje (realizado) → fim projetado. Clique p/ ajustar a âncora.">
      <div class="lbl">💵 Caixa ${escopoCurto} · início → fim</div>
      <div class="cxtraj">
        <div class="cxseg"><div class="cxl">início</div><div class="cxv ${mny(ini)}">${BRL(ini)}</div></div>
        <div class="cxsep">→</div>
        <div class="cxseg"><div class="cxl">fim projetado</div><div class="cxv ${mny(res)}">${BRL(res)}</div></div>
      </div>
      <div class="sub" title="realizado = só o que já entrou/saiu · projetado = inclui o orçado do dia">hoje: real ${BRL(chR)} · proj ${BRL(chP)}</div></div>
    <div class="card"><div class="lbl">📈 Receitas ${escopoCurto}</div>
      <div class="val money pos">${BRL(rec)}</div>
      <div class="sub">real ${BRL(periodo.receita.realizado)} · prev ${BRL(periodo.receita.previsto)}</div></div>
    <div class="card receitas-split"><div class="lbl">🏦 PJ Bank × outras</div>
      <div class="rsplit">
        <div class="rs-line"><span class="rs-nm">PJ Bank</span><span class="rs-det">${BRL(pj.realizado)} · ${BRL(pj.previsto)}</span></div>
        <div class="rs-line"><span class="rs-nm">Outras</span><span class="rs-det">${BRL(ou.realizado)} · ${BRL(ou.previsto)}</span></div>
      </div></div>
    <div class="card" title="Despesas ${escopoCurto} — real ${BRL(periodo.despesa.real)} · orçado ${BRL(periodo.despesa.previsto)}"><div class="lbl">📉 Despesas ${escopoCurto}</div>
      <div class="val money neg">${BRL(desp)}</div>
      <div class="rsplit desp">
        <div class="rs-line" title="Consolidado empresa = despesas do mês − (enc. adm e repasse)"><span class="rs-nm">consolidado empresa</span><span class="rs-det">${BRL(consEmp)}</span></div>
        <div class="rs-line" title="Encargos adm + repasses (pass-through da locação)"><span class="rs-nm">enc. adm e repasse</span><span class="rs-det">${BRL(encRep)}</span></div>
      </div></div>
    <div class="card despesas-split"><div class="lbl">📉 Desp real×orç</div>
      <div class="rsplit">
        <div class="rs-line" title="Despesa já realizada (saiu de fato)"><span class="rs-nm">real</span><span class="rs-det">${BRL(periodo.despesa.real)}</span></div>
        <div class="rs-line" title="Despesa ainda orçada (prevista)"><span class="rs-nm">orçado</span><span class="rs-det">${BRL(periodo.despesa.previsto)}</span></div>
      </div></div>
    <div class="card"><div class="lbl">${faltaLbl}</div>
      <div class="val ${mny(falta)}">${BRL(falta)}</div>
      <div class="sub">${faltaSub}</div></div>
    <div class="card p1" title="P1 ${escopoCurto} — total ${BRL(prio.P1)} · já pago ${BRL(prio.P1_real)} · falta ${BRL(prio.P1_falta)}"><div class="lbl">🔴 P1 ${escopoCurto}</div><div class="val">${BRL(prio.P1)}</div><div class="sub">pago ${BRL(prio.P1_real)} · falta ${BRL(prio.P1_falta)}</div></div>
    <div class="card p2" title="P2 ${escopoCurto} — total ${BRL(prio.P2)} · já pago ${BRL(prio.P2_real)} · falta ${BRL(prio.P2_falta)}"><div class="lbl">🔵 P2 ${escopoCurto}</div><div class="val">${BRL(prio.P2)}</div><div class="sub">pago ${BRL(prio.P2_real)} · falta ${BRL(prio.P2_falta)}</div></div>
    ${periodo.pendencias ? `<div class="card" title="Orçamento paralelo de pendências ${escopoCurto} — no caixa, mas FORA do orçado"><div class="lbl">🧭 Pendências ${escopoCurto}</div><div class="val money neg">${BRL(periodo.pendencias)}</div><div class="sub">no caixa · fora do orçado</div></div>` : ''}`;
  // Dutra ocupa o canto superior direito (linha do título), liberando a grade p/ 8 cards simétricos
  $('#cardsTop').innerHTML = `<div class="card gold dutra2"><div class="lbl">💰 Dutra (mês)</div>
      <div class="d2">
        <div><div class="d2l">Real</div><div class="val">${BRL(dutra.real)}</div></div>
        <div><div class="d2l">Orçado</div><div class="val">${BRL(dutra.orcado)}</div></div>
      </div></div>`;
  $('#cardCaixa').onclick = () => modalAncora('empresa', caixa.ancora);
}

function modalAncora(livroAlvo, a) {
  const nome = livroAlvo === 'dutra' ? 'Caixa Dutra (pessoal)' : 'Caixa Empresa';
  openModal(`<h2>Âncora · ${nome}</h2>
    <p style="color:var(--ink-dim);font-size:13px">O caixa parte do saldo real contado nesta data. Tudo a partir daqui é somado; antes, subtraído.</p>
    <div class="row">
      <div class="field"><label>Data do saldo real</label><input id="a_data" type="date" value="${a.data}"></div>
      <div class="field"><label>Saldo real (R$)</label><input id="a_valor" type="number" step="0.01" value="${a.valor}"></div>
    </div>
    <div class="modal-actions"><button class="ghost" onclick="closeModal()">Cancelar</button>
      <button class="primary" onclick="saveAncora('${livroAlvo}')">Salvar</button></div>`);
}
window.saveAncora = async (livroAlvo) => {
  await api('api/config/ancora', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ livro: livroAlvo || 'empresa', data: $('#a_data').value, valor: parseFloat($('#a_valor').value || '0') }),
  });
  closeModal(); render();
};

// ---- Filtro de centro de custo no calendário: destaca 1 centro, apaga os demais e recalcula somas ----
function popularFiltroCC() {
  const selEl = $('#ccFilter'); if (!selEl) return;
  const centros = ordenaCC([...new Set(allLancs().map((l) => l.centro_custo))]);
  if (ccFiltro && !centros.includes(ccFiltro)) ccFiltro = null; // centro saiu do período exibido
  selEl.innerHTML = '<option value="">centro: todos</option>' +
    centros.map((c) => `<option value="${c.replace(/"/g, '&quot;')}" ${c === ccFiltro ? 'selected' : ''}>${capCC(c)}</option>`).join('');
}
function aplicarFiltroCC() {
  const grid = $('#grid'); const banner = $('#ccBanner'); if (!grid || !banner) return;
  const cards = $('#cards'); const cardsTop = $('#cardsTop'); const cons = $('#ccConsolidado');
  const mny = (n) => (n < 0 ? 'money neg' : 'money pos');
  const setTV = (data, valor) => { const el = grid.querySelector(`.day[data-day="${data}"] .tv`); if (el) { el.textContent = BRL(valor); el.className = 'tv ' + mny(valor); } };
  if (!ccFiltro) { // limpa o filtro: restaura cards e totais
    grid.classList.remove('cc-filtrando');
    grid.querySelectorAll('.item.cc-dim').forEach((e) => e.classList.remove('cc-dim'));
    for (const d of allDias()) setTV(d.data, d.total);
    banner.classList.add('hidden'); banner.innerHTML = '';
    if (cons) { cons.classList.add('hidden'); cons.innerHTML = ''; }
    if (cards) cards.style.display = ''; if (cardsTop) cardsTop.style.display = '';
    return;
  }
  grid.classList.add('cc-filtrando');
  grid.querySelectorAll('.item').forEach((e) => e.classList.toggle('cc-dim', e.dataset.cc !== ccFiltro));
  for (const d of allDias()) {
    const soma = d.lancamentos.filter((l) => l.centro_custo === ccFiltro).reduce((a, l) => a + l.valor, 0);
    setTV(d.data, soma); // Total dia conta só o centro filtrado
  }
  // consolidado da seleção, sobre a janela exata do período (mesma base dos cards)
  const jde = periodo.janela ? periodo.janela.de : null, jate = periodo.janela ? periodo.janela.ate : null;
  const its = allLancs().filter((l) => l.centro_custo === ccFiltro && (!jde || (l.data >= jde && l.data <= jate)));
  let real = its.filter((l) => l.tipo === 'real').reduce((a, l) => a + l.valor, 0);
  let orc = its.filter((l) => l.tipo !== 'real').reduce((a, l) => a + l.valor, 0);
  // Retirada Dutra: abate os reembolsos (despesas pagas pela conta pessoal do Dutra) — mesmo líquido do card 💰
  if (ccFiltro === 'Retirada Dutra') {   // abate reembolsos (pagos pela conta pessoal do Dutra) → mostra só o líquido
    const reemb = allLancs().filter((l) => l.origem === 'reembolso' && (!jde || (l.data >= jde && l.data <= jate)));
    real -= reemb.filter((l) => l.tipo === 'real').reduce((a, l) => a + l.valor, 0);
    orc -= reemb.filter((l) => l.tipo !== 'real').reduce((a, l) => a + l.valor, 0);
  }
  const total = real + orc;
  const pgto = its.filter((l) => l.valor < 0); // prioridade só em pagamentos; nulo conta como P1
  const p2 = pgto.filter((l) => l.prioridade === 'P2').reduce((a, l) => a + l.valor, 0);
  const p1 = pgto.filter((l) => l.prioridade !== 'P2').reduce((a, l) => a + l.valor, 0);
  if (cards) cards.style.display = 'none'; if (cardsTop) cardsTop.style.display = 'none';
  if (cons) {
    cons.classList.remove('hidden');
    cons.innerHTML = `
      <div class="card" style="grid-column:span 2;border-color:var(--gold)"><div class="lbl">🔎 ${capCC(ccFiltro)}</div><div class="val ${mny(total)}">${BRL(total)}</div><div class="sub">${its.length} lançamento(s) no período</div></div>
      <div class="card"><div class="lbl">Real</div><div class="val ${mny(real)}">${BRL(real)}</div><div class="sub">já confirmado</div></div>
      <div class="card"><div class="lbl">Orçado</div><div class="val ${mny(orc)}">${BRL(orc)}</div><div class="sub">previsto</div></div>
      <div class="card p1"><div class="lbl">🔴 P1</div><div class="val">${BRL(p1)}</div><div class="sub">&nbsp;</div></div>
      <div class="card p2"><div class="lbl">🔵 P2</div><div class="val">${BRL(p2)}</div><div class="sub">&nbsp;</div></div>`;
  }
  banner.classList.remove('hidden');
  banner.innerHTML = `<span>🔎 Filtrando por centro: <b>${capCC(ccFiltro)}</b></span><button onclick="limparFiltroCC()">limpar filtro</button>`;
}
window.limparFiltroCC = () => { ccFiltro = null; const s = $('#ccFilter'); if (s) s.value = ''; aplicarFiltroCC(); };

function dayHTML(d, ccOpts, today, dimMes, dimAntes) {
  const itens = d.lancamentos.map((l) => itemHTML(l)).join('') ||
    '<div style="color:var(--ink-dim);font-size:12px;padding:8px;text-align:center">— sem lançamentos —</div>';
  const [y, m, dd] = d.data.split('-');
  const foraMes = dimMes && d.data.slice(0, 7) !== dimMes;
  const antesDeHoje = dimAntes && d.data < dimAntes;          // "resto do mês": dias já passados
  const dim = foraMes || antesDeHoje ? 'dim' : '';
  return `<section class="day ${d.data === today ? 'today' : ''} ${d.feriado ? 'holiday' : ''} ${d.fds ? 'fds' : ''} ${dim}" data-day="${d.data}">
      <div class="dhead"><div class="dw">${WD[d.weekday]}${d.fds ? ' <span class="fdstag" title="Lançamento caindo no fim de semana">fim de semana</span>' : ''} ${d.feriado ? `· <span class="fer">${d.feriado}</span>` : ''}</div>
        <div class="dd">${dd}/${m}</div></div>
      <div class="items">${itens}</div>
      <div class="quickadd" data-day="${d.data}">
        <input class="qa-nome" placeholder="+ lançar (descrição)" title="Descrição">
        <select class="qa-cc" title="Centro de custo" onfocus="this.dataset.prev=this.value" onchange="onCentroSelect(this)"><option value="">— centro —</option>${ccOpts}</select>
        <div class="qa-row2">
          <button type="button" class="qa-tipo" data-tipo="orçado" title="Clique p/ alternar orçado ⇄ real">orçado</button>
          <input class="qa-valor" type="number" step="0.01" placeholder="valor" title="Valor (sinal automático) · Enter p/ salvar">
        </div>
      </div>
      <div class="dfoot"><div class="tt-wrap" onclick="toggleDayIO(this)" title="Clique: quanto entrou e saiu no dia">
          <div class="tt">Total dia</div><div class="tv ${d.total < 0 ? 'money neg' : 'money pos'}">${BRL(d.total)}</div>
          ${(() => { const io = d.lancamentos.reduce((a, l) => { if (l.origem === 'reembolso' || l.ghost) return a; if (l.valor >= 0) a.e += l.valor; else a.s += l.valor; return a; }, { e: 0, s: 0 }); return `<div class="dio" hidden>↑ <b class="money pos">${BRL(io.e)}</b> · ↓ <b class="money neg">${BRL(Math.abs(io.s))}</b></div>`; })()}</div>
        <div style="text-align:right"><div class="cx">Caixa proj.</div><div class="cxv ${d.caixa_projetado < 0 ? 'money neg' : 'money pos'}">${BRL(d.caixa_projetado)}</div>
          ${Math.abs(d.caixa_realizado - d.caixa_projetado) > 0.005 ? `<div class="cxr ${d.caixa_realizado < 0 ? 'money neg' : 'money pos'}">real ${BRL(d.caixa_realizado)}</div>` : ''}</div></div>
    </section>`;
}
// mostra/oculta o "entrou/saiu" do dia (clicando no Total dia)
window.toggleDayIO = (el) => { const io = el.querySelector('.dio'); if (io) io.hidden = !io.hidden; };

function renderWeeks() {
  const today = hojeISO();
  const ccOpts = ccOptions('');
  const multi = periodo.semanas.length > 1;
  $('#grid').innerHTML = periodo.semanas.map((w) => {
    const head = multi ? `<div class="weekhead">
        <span>semana <b>${fmtData(w.seg)}–${fmtData(w.sex)}</b></span>
        <span>resultado <b class="${w.semanaTotal < 0 ? 'money neg' : 'money pos'}">${BRL(w.semanaTotal)}</b>
          · caixa fim <b class="${w.caixa_fechamento < 0 ? 'money neg' : 'money pos'}" title="Caixa no fim do domingo — é exatamente o caixa de abertura da semana seguinte">${BRL(w.caixa_fechamento)}</b></span>
      </div>` : '';
    // colunas = nº de dias exibidos (6 ou 7 quando o fim de semana tem lançamento)
    return `<div class="weekblock">${head}<div class="weekgrid" style="grid-template-columns:repeat(${w.dias.length},1fr)">${w.dias.map((d) => dayHTML(d, ccOpts, today, periodo.dimMes, periodo.dimAntes)).join('')}</div></div>`;
  }).join('');
  $('#grid').querySelectorAll('.item').forEach((el) => {
    const id = +el.dataset.id;
    el.onclick = (e) => {
      if (ghostMode) { toggleGhost(id); return; }                        // modo ghost: clique fantasma/desfantasma
      if (e.target.closest('.prio')) { ciclaPrioridade(id); return; }     // chave seletora: nenhuma → P1 → P2 → nenhuma
      if (e.target.closest('.tag-toggle')) { toggleTipo(id); return; }    // tipo a um clique
      if (e.shiftKey || e.ctrlKey) { toggleSel(id, el); return; }
      modalLancamento(allLancs().find((l) => l.id === id));
    };
    // ---- arrastar (kanban) ----
    el.addEventListener('dragstart', (e) => {
      const ids = sel.has(id) ? [...sel] : [id];   // se faz parte de uma seleção, arrasta o grupo
      e.dataTransfer.setData('text/plain', JSON.stringify(ids));
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
  });
  // ---- soltar num dia ----
  $('#grid').querySelectorAll('.day').forEach((day) => {
    day.addEventListener('dragover', (e) => { e.preventDefault(); day.classList.add('dragover'); });
    day.addEventListener('dragleave', () => day.classList.remove('dragover'));
    day.addEventListener('drop', async (e) => {
      e.preventDefault(); day.classList.remove('dragover');
      let ids; try { ids = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
      if (!ids?.length) return;
      const novaData = day.dataset.day;
      await api(lq('api/lancamentos/mover'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, nova_data: novaData }),
      });
      render();
    });
  });
  // entrada rápida: Enter salva e foca o próximo; tipo a um clique
  $('#grid').querySelectorAll('.quickadd').forEach((box) => {
    box.querySelectorAll('input,select,button').forEach((inp) => {
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); quickAdd(box); } });
    });
    const tbtn = box.querySelector('.qa-tipo');
    tbtn.addEventListener('click', () => {
      const novo = tbtn.dataset.tipo === 'real' ? 'orçado' : 'real';
      tbtn.dataset.tipo = novo; tbtn.textContent = novo;
    });
  });
}

async function toggleTipo(id) {
  const l = allLancs().find((x) => x.id === id);
  if (!l) return;
  await api(lq(`api/lancamentos/${id}`), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tipo: l.tipo === 'real' ? 'orçado' : 'real' }),
  });
  render();
}

function ciclaPrioridade(id) {
  const l = allLancs().find((x) => x.id === id); if (!l) return;
  setPrioridade(id, l.prioridade === 'P2' ? 'P1' : 'P2'); // vermelho (P1) ⇄ azul (P2)
}
async function setPrioridade(id, p) {
  const l = allLancs().find((x) => x.id === id);
  if (!l) return;
  const nova = p || null;                       // chave seletora binária: P1 (vermelho) ⇄ P2 (azul)
  if (l.prioridade === nova) return;            // já está nesse estado
  await api(lq(`api/lancamentos/${id}`), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prioridade: nova }),
  });
  render();
}

async function quickAdd(box) {
  const data = box.dataset.day;
  const nome = box.querySelector('.qa-nome').value.trim();
  const centro_custo = box.querySelector('.qa-cc').value;
  const tipo = box.querySelector('.qa-tipo').dataset.tipo;
  const valor = parseFloat(box.querySelector('.qa-valor').value || '0');
  if (!nome) { flash(box.querySelector('.qa-nome')); return; }
  if (!centro_custo) { flash(box.querySelector('.qa-cc')); return; }
  if (!valor) { flash(box.querySelector('.qa-valor')); return; }
  await api(lq('api/lancamentos'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data, nome, centro_custo, tipo, valor }),
  });
  render(data); // recarrega e devolve o foco a este dia
}
function flash(el) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 600); el.focus(); }

function itemHTML(l) {
  const pos = l.valor >= 0;
  const tipo = `<span class="tag tag-toggle ${l.tipo === 'real' ? 'real' : 'orc'}" title="Clique p/ alternar real ⇄ orçado">${l.tipo === 'real' ? 'real' : 'orç'}</span>`;
  const pst = l.prioridade === 'P2' ? 'p2' : 'p1';
  // prioridade (P1/P2) só faz sentido em pagamentos; recebimentos (valor +) não têm a chave
  const prio = pos ? '' : `<div class="prio pstate-${pst}" title="Prioridade — clique p/ alternar (vermelho: P1 · azul: P2)"><span class="pknob"></span></div>`;
  return `<div class="item ${sel.has(l.id) ? 'sel' : ''} ${(l.ghost || ghost.has(l.id)) ? 'ghosted' : ''}" data-id="${l.id}" data-cc="${(l.centro_custo || '').replace(/"/g, '&quot;')}" draggable="true" title="Arraste p/ outro dia · clique p/ editar · Shift+clique p/ selecionar">
    <div class="body"><div class="nm">${l.nome}</div><div class="cc">${capCC(l.centro_custo)} ${tipo}${l.origem === 'reembolso' ? ' <span class="tag" style="border-color:var(--gold);color:var(--gold)" title="Pago pela conta pessoal — abate da retirada, fora do caixa">conta pessoal</span>' : ''}</div></div>
    <div class="vlwrap"><div class="vl ${pos ? 'pos' : 'neg'}">${BRL(l.valor)}</div>${prio}</div></div>`;
}

function toggleSel(id, el) {
  if (sel.has(id)) { sel.delete(id); el.classList.remove('sel'); }
  else { sel.add(id); el.classList.add('sel'); }
  updateMoverBtn();
}
function updateMoverBtn() {
  const b = $('#btnMover'); b.disabled = sel.size === 0;
  b.textContent = sel.size ? `Reagendar ${sel.size} selecionado(s)` : 'Reagendar selecionados';
  const d = $('#btnExcluirSel'); if (d) { d.disabled = sel.size === 0; d.textContent = sel.size ? `Excluir ${sel.size} selecionado(s)` : 'Excluir selecionados'; }
}
async function excluirSelecionados() {
  const ids = [...sel];
  if (!ids.length) return;
  if (!confirm(`Excluir ${ids.length} lançamento(s) selecionado(s)? Esta ação não pode ser desfeita.`)) return;
  const r = await api(lq('api/lancamentos/excluir-lote'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
  });
  for (const id of ids) { sel.delete(id); if (ghost.delete(id)) saveGhost(); }
  updateMoverBtn();
  render();
}

/* ---------- Modo Ghost (bancada de simulação: fora da conta da semana) ---------- */
function setGhostMode(on) {
  ghostMode = on;
  const b = $('#btnGhost'); if (b) { b.classList.toggle('primary', on); b.classList.toggle('ghost', !on); }
  const g = $('#grid'); if (g) g.classList.toggle('ghost-mode', on);
  renderGhostBar();
}
function toggleGhost(id) {
  const l = lancById(id), k = recKey(l);
  if (k) { if (ghostR.has(k)) ghostR.delete(k); else ghostR.add(k); }   // recorrente: chave estável (sobrevive à regeneração)
  else { if (ghost.has(id)) ghost.delete(id); else ghost.add(id); }      // avulso: por id
  saveGhost();
  render();  // re-render: backend recalcula tudo sem os fantasmas
}
// fantasmar/desfantasmar direto do modal do lançamento (fecha o modal)
window.toggleGhostModal = (id) => { toggleGhost(id); closeModal(); };
window.limparGhost = () => { ghost.clear(); ghostR.clear(); saveGhost(); render(); };
// abre a AGENDA do envio em lote: cada lançamento fantasmado com o SEU nome e a SUA data (um a um)
window.enviarGhostPendencias = () => { if (ghost.size || ghostR.size) modalGhostPendencias(); };

let GP = null;   // estado da agenda em lote: { itens, blocked, dates{}, parc{} }
async function modalGhostPendencias() {
  openModal('<h2>🧭 Pendências</h2><p style="color:var(--ink-dim);font-size:13px">carregando…</p>');
  const alvoIds = ghostCurrentIds();                             // avulsos + recorrentes resolvidos p/ id atual
  const pedidos = alvoIds.length;
  let itens;
  try { itens = await api(lq('api/lancamentos/por-ids?ids=' + alvoIds.join(','))); }
  catch (e) { openModal('<h2>🧭 Pendências</h2><p class="money neg">Erro: ' + e.message + '</p><div class="modal-actions"><button class="ghost" onclick="closeModal()">Fechar</button></div>'); return; }
  const vivos = new Set(itens.map((l) => l.id));                 // poda fantasmas avulsos órfãos (id regerado)
  let expirados = 0;
  for (const id of [...ghost]) if (!vivos.has(id)) { ghost.delete(id); expirados++; }
  if (expirados) saveGhost();
  const motivoBloqueio = (l) => l.origem === 'venda' ? 'comissão de venda' : (l.origem === 'reembolso' ? 'pago na conta pessoal' : '');
  const bons = itens.filter((l) => !motivoBloqueio(l));
  const blocked = itens.filter(motivoBloqueio);
  GP = { itens: bons, blocked, motivoBloqueio, dates: {}, parc: {}, expirados };
  bons.forEach((l) => { GP.dates[l.id] = l.data; });             // data padrão = a do próprio lançamento
  renderGpGrid();
  render();  // reflete a poda de expirados na barra
}

function renderGpGrid() {
  const g = GP;
  const jaPend = (l) => l.origem === 'pendencia' || l.origem === 'pendencia_par';
  const total = g.itens.reduce((s, l) => s + Math.abs(l.valor), 0);
  const linhaBoa = (l) => {
    const tag = jaPend(l) ? ' <span class="tag" style="border-color:var(--gold);color:var(--gold);font-size:10px">reagenda</span>' : '';
    const parc = g.parc[l.id];
    const dataCell = parc
      ? `<span style="color:var(--gold);font-size:12px">✂️ ${parc.length} parcela(s)</span> <button class="lnkp" data-parc="${l.id}" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:12px">editar</button>`
      : `<input type="date" class="gp_data" data-id="${l.id}" value="${g.dates[l.id] || ''}" style="width:145px">
         <span class="gp_flu" style="font-size:11px;color:${g.dates[l.id] ? 'var(--ink-dim)' : 'var(--gold)'}">${g.dates[l.id] ? '' : '🎈 flutua'}</span>`;
    return `<tr data-id="${l.id}">
      <td class="l">${l.nome}${tag}<div style="color:var(--ink-dim);font-size:11px">${capCC(l.centro_custo)}${l.livro === 'dutra' ? ' · <span style="color:var(--gold)">Dutra</span>' : ''}</div></td>
      <td>${dataCell}</td>
      <td style="text-align:center"><button class="gp_cut" data-id="${l.id}" title="Parcelar este" style="background:none;border:none;cursor:pointer;font-size:15px">✂️</button></td>
      <td class="money neg" style="text-align:right;white-space:nowrap">${BRL(-Math.abs(l.valor))}</td></tr>`;
  };
  const linhaBloq = (l) => `<tr style="opacity:.5">
    <td class="l">${l.nome}<div style="color:var(--ink-dim);font-size:11px">${capCC(l.centro_custo)}</div></td>
    <td colspan="2"><span class="neg" style="font-size:12px">✕ ${g.motivoBloqueio(l)}</span></td>
    <td class="money neg" style="text-align:right">${BRL(-Math.abs(l.valor))}</td></tr>`;
  const expNota = g.expirados ? `<div style="color:var(--ink-dim);font-size:12px;margin-top:6px">${g.expirados} fantasma(s) expiraram (id regerado) e foram removidos.</div>` : '';
  openModal(`<div class="modal-wide"><h2>🧭 Pendências — datar / reagendar</h2>
    <p style="color:var(--ink-dim);font-size:13px;margin:0 0 10px">Data por item (<b>um a um</b>). Deixe a data <b>vazia</b> para a pendência <b>flutuar</b> 🎈 (fica no consolidado, sem cair no caixa numa data). <b>✂️</b> parcela o item. Quem já é pendência (<span style="color:var(--gold)">reagenda</span>) só muda; os demais viram pendência. Cinza = não pode.</p>
    ${g.itens.length ? `<div class="row" style="margin:0 0 8px;align-items:flex-end;gap:8px">
      <div class="field" style="max-width:170px;margin:0"><label>Aplicar data a todos</label><input type="date" id="gp_all"></div>
      <button class="ghost" id="gp_allbtn">↧ aplicar</button>
      <button class="ghost" id="gp_flutall" title="Deixa todos sem data (flutuando)">🎈 todos sem data</button>
    </div>` : '<p class="neg" style="font-size:13px">Nenhum destes pode ir para pendências — veja os motivos abaixo.</p>'}
    <div style="max-height:44vh;overflow:auto"><table style="width:100%"><thead><tr><th class="l">Lançamento</th><th class="l">Data prevista</th><th></th><th style="text-align:right">Valor</th></tr></thead>
      <tbody id="gp_body">${g.itens.map(linhaBoa).join('') + g.blocked.map(linhaBloq).join('')}</tbody>
      ${g.itens.length ? `<tfoot><tr style="font-weight:800;border-top:2px solid var(--gold)"><td class="l">Total (${g.itens.length})</td><td colspan="2"></td><td class="money neg" style="text-align:right">${BRL(-total)}</td></tr></tfoot>` : ''}</table></div>
    ${expNota}
    <div class="modal-actions">
      <button class="ghost" onclick="closeModal()">Fechar</button>
      ${g.itens.length ? '<button class="primary" id="gp_ok">Confirmar</button>' : ''}
    </div></div>`);

  document.querySelectorAll('#gp_body .gp_data').forEach((inp) => inp.oninput = () => {
    GP.dates[+inp.dataset.id] = inp.value;
    const flu = inp.parentElement.querySelector('.gp_flu');
    if (flu) { flu.textContent = inp.value ? '' : '🎈 flutua'; flu.style.color = inp.value ? 'var(--ink-dim)' : 'var(--gold)'; }
  });
  document.querySelectorAll('#gp_body .gp_cut').forEach((b) => b.onclick = () => modalParcelarItem(+b.dataset.id));
  document.querySelectorAll('#gp_body .lnkp').forEach((b) => b.onclick = () => modalParcelarItem(+b.dataset.parc));
  if (!g.itens.length) return;
  $('#gp_allbtn').onclick = () => { const d = $('#gp_all').value; if (d) { g.itens.forEach((l) => { if (!g.parc[l.id]) GP.dates[l.id] = d; }); renderGpGrid(); } };
  $('#gp_flutall').onclick = () => { g.itens.forEach((l) => { if (!g.parc[l.id]) GP.dates[l.id] = ''; }); renderGpGrid(); };
  $('#gp_ok').onclick = enviarGpAgenda;
}

// editor de parcelas de UM item da agenda (data pode ficar vazia = parcela flutuante)
function modalParcelarItem(id) {
  const l = GP.itens.find((x) => x.id === id); if (!l) return;
  const total = Math.abs(l.valor);
  const atual = GP.parc[id] || [{ data: GP.dates[id] || '', valor: +(total / 2).toFixed(2) }, { data: '', valor: +(total - +(total / 2).toFixed(2)).toFixed(2) }];
  const linha = (p, i) => `<tr><td style="width:36px;color:var(--ink-dim);text-align:center">${i + 1}ª</td>
    <td><input type="date" class="pi_data" value="${p.data || ''}" style="width:100%"></td>
    <td><input type="number" step="0.01" class="pi_val" value="${(+p.valor || 0).toFixed(2)}" style="width:110px;text-align:right"></td>
    <td style="width:30px;text-align:center"><button class="pi_del" tabindex="-1" style="background:none;border:none;color:var(--neg);cursor:pointer">✕</button></td></tr>`;
  openModal(`<div class="modal-wide"><h2>✂️ Parcelar</h2>
    <p style="color:var(--ink-dim);font-size:13px;margin:0 0 8px"><b>${l.nome}</b> · total <b class="neg">${BRL(-total)}</b>. Cada parcela na sua data (vazia = flutua 🎈); a última fecha o total.</p>
    <table style="width:100%"><thead><tr><th></th><th class="l">Data</th><th class="l">Valor</th><th></th></tr></thead><tbody id="pi_body">${atual.map(linha).join('')}</tbody></table>
    <div class="row" style="margin-top:8px;align-items:center;gap:12px"><button class="ghost" id="pi_add">+ parcela</button><span id="pi_soma" style="font-size:13px"></span></div>
    <div class="modal-actions"><button class="ghost" id="pi_back">‹ Voltar</button><button class="warn" id="pi_none">Não parcelar</button><button class="primary" id="pi_ok">Aplicar parcelas</button></div></div>`);
  const body = $('#pi_body');
  const rows = () => [...body.querySelectorAll('tr')];
  const vals = () => rows().map((r) => Math.abs(parseFloat(r.querySelector('.pi_val').value) || 0));
  const rebalance = () => { const rr = rows(); if (rr.length < 2) return; const outros = rr.slice(0, -1).reduce((s, r) => s + Math.abs(parseFloat(r.querySelector('.pi_val').value) || 0), 0); rr[rr.length - 1].querySelector('.pi_val').value = (total - outros).toFixed(2); };
  const refresh = () => { const s = vals().reduce((a, b) => a + b, 0); const ok = Math.abs(s - total) < 0.01 && vals().every((v) => v > 0); $('#pi_soma').innerHTML = `soma <b class="${ok ? 'pos' : 'neg'}">${BRL(s)}</b> / ${BRL(total)}` + (ok ? ' ✓' : ''); $('#pi_ok').disabled = !ok; rows().forEach((r) => r.querySelector('.pi_del').style.visibility = rows().length > 2 ? 'visible' : 'hidden'); };
  const wire = () => rows().forEach((r, i, arr) => { r.querySelector('.pi_val').oninput = () => { if (i < arr.length - 1) rebalance(); refresh(); }; r.querySelector('.pi_del').onclick = () => { if (rows().length > 2) { r.remove(); rebalance(); wire(); refresh(); } }; });
  $('#pi_add').onclick = () => { body.insertAdjacentHTML('beforeend', linha({ data: '', valor: 0 }, rows().length)); rebalance(); wire(); refresh(); };
  wire(); refresh();
  $('#pi_back').onclick = () => renderGpGrid();
  $('#pi_none').onclick = () => { delete GP.parc[id]; renderGpGrid(); };
  $('#pi_ok').onclick = () => { GP.parc[id] = rows().map((r) => ({ data: r.querySelector('.pi_data').value, valor: Math.abs(parseFloat(r.querySelector('.pi_val').value) || 0) })); renderGpGrid(); };
}

async function enviarGpAgenda() {
  const lista = GP.itens.map((l) => GP.parc[l.id] ? { id: l.id, parcelas: GP.parc[l.id] } : { id: l.id, data: GP.dates[l.id] || '' });
  $('#gp_ok').disabled = true;
  try {
    const r = await api(lq('api/lancamentos/mover-pendencia-lote'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itens: lista }) });
    if (r && r.erro) { alert('Erro: ' + r.erro); $('#gp_ok').disabled = false; return; }
    ghost.clear(); ghostR.clear(); saveGhost(); GP = null; closeModal(); render();
  } catch (e) { alert('Erro: ' + e.message); $('#gp_ok').disabled = false; }
}
window.modalGhostPendencias = modalGhostPendencias;
// barra flutuante do ghost: recolhida numa pílula 👻 por padrão; 1 clique expande as ações.
let ghostBarAberta = (() => { try { return localStorage.getItem('zghostbar') === 'open'; } catch { return false; } })();
window.toggleGhostBar = () => { ghostBarAberta = !ghostBarAberta; try { localStorage.setItem('zghostbar', ghostBarAberta ? 'open' : 'mini'); } catch {} renderGhostBar(); };
function renderGhostBar() {
  let bar = $('#ghostBar');
  if (!ghost.size && !ghostR.size) { if (bar) bar.remove(); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'ghostBar'; document.body.appendChild(bar); }
  const consol = periodo && periodo.ghost_consol != null ? periodo.ghost_consol : 0;
  const n = (periodo && periodo.ghost_n != null) ? periodo.ghost_n : (ghost.size + ghostR.size);
  bar.classList.toggle('mini', !ghostBarAberta);
  if (!ghostBarAberta) {
    bar.innerHTML = `<button class="gb-pill" onclick="toggleGhostBar()" title="${n} lançamento(s) no ghost · clique p/ abrir">👻 ${n}</button>`;
    return;
  }
  bar.innerHTML = `<button class="gb-pill" onclick="toggleGhostBar()" title="Recolher">👻</button>
    <span class="gb-n">${n} fora da conta</span>
    <span class="gb-v ${consol < 0 ? 'money neg' : 'money pos'}">consolidado ${BRL(consol)}</span>
    <button class="primary" onclick="enviarGhostPendencias()">→ Pendências</button>
    <button class="ghost" onclick="limparGhost()">Limpar</button>`;
}

// aviso de série (repetição) chegando ao fim — mostra a mais próxima com ações
async function renderAvisosSeries() {
  let bar = $('#serieAvisoBar');
  let avisos = [];
  try { avisos = await api(lq('api/series/avisos')); } catch { avisos = []; }
  if (!avisos || !avisos.length) { if (bar) bar.remove(); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'serieAvisoBar'; document.body.appendChild(bar); }
  const a = avisos[0], resto = avisos.length - 1;
  bar.innerHTML = `<span class="sa-tt">🔁 Repetição acabando</span>
    <span class="sa-n"><b>${a.descricao}</b> — última em ${fmtData(a.ultima)}${a.restantes ? ` · ${a.restantes} restante(s)` : ''}</span>
    <button class="primary" onclick="prorrogarSerie(${a.id})">Prorrogar</button>
    <button class="ghost" onclick="adiarAvisoSerie(${a.id})">Depois</button>
    <button class="ghost" onclick="encerrarSerie(${a.id})">Encerrar</button>
    ${resto > 0 ? `<span class="sa-more">+${resto} outra(s)</span>` : ''}`;
}
window.prorrogarSerie = async (id) => {
  const ate = prompt('Prorrogar a repetição até que data? (formato AAAA-MM-DD)');
  if (!ate) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ate)) return alert('Data inválida. Use AAAA-MM-DD, ex.: 2027-06-30.');
  const r = await api(lq(`api/series/${id}/prorrogar`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fim: ate }) });
  if (r && r.criados === 0) alert('Nenhuma data nova nesse intervalo — escolha uma data-fim mais à frente.');
  render();
};
window.adiarAvisoSerie = async (id) => {
  await api(lq(`api/series/${id}/adiar-aviso`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  render();
};
window.encerrarSerie = async (id) => {
  if (!confirm('Encerrar esta repetição? Os lançamentos já criados continuam; ela só para de avisar e não gera novos.')) return;
  await api(lq(`api/series/${id}/encerrar`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  render();
};

/* ---------- Localizador de lançamentos (achar + antecipar/postergar) ---------- */
async function modalLocalizar() {
  openModal(`<div class="modal-wide"><h2>🔎 Localizar lançamento</h2>
    <p style="color:var(--ink-dim);font-size:13px;margin:0 0 10px">Digite uma palavra da descrição (ou do centro de custo). Marque os que quiser e escolha a nova data — serve pra <b>antecipar</b> ou <b>postergar</b> um pagamento já lançado.</p>
    <div class="row">
      <div class="field" style="flex:1"><label>Buscar</label><input id="loc_q" placeholder="ex.: aluguel, C2S, Débora, marketing…"></div>
      <div class="field" style="max-width:180px"><label>Mostrar</label><select id="loc_tipo">
        <option value="orcado">só orçado (em aberto)</option><option value="todos">todos (real + orçado)</option></select></div>
      <div class="field" style="max-width:150px"><label>Horizonte</label><select id="loc_hor">
        <option value="6">6 meses</option><option value="3">3 meses</option><option value="12">12 meses</option><option value="36">tudo</option></select></div>
    </div>
    <div id="loc_res" style="max-height:40vh;overflow:auto;margin-top:8px"><div style="color:var(--ink-dim);font-size:13px;padding:10px">Digite ao menos 2 letras…</div></div>
    <div class="row" style="margin-top:12px;align-items:flex-end;gap:10px">
      <div class="field" style="max-width:190px;margin:0"><label>Mover selecionados para</label><input id="loc_data" type="date" value="${hojeISO()}"></div>
      <button class="primary" id="loc_mover" disabled>Mover selecionados</button>
      <button class="ghost" id="loc_split" disabled title="Divide 1 lançamento em parcelas com datas diferentes — ex.: comissão recebida em 2 momentos">✂️ Desdobrar em datas</button>
      <span id="loc_msg" style="color:var(--ink-dim);font-size:12px"></span>
    </div>
    <div class="modal-actions"><button class="ghost" onclick="closeModal()">Fechar</button></div>
  </div>`);

  const all = (s) => [...document.querySelectorAll(s)];
  const q = $('#loc_q'), res = $('#loc_res'), btn = $('#loc_mover'), split = $('#loc_split'), msg = $('#loc_msg');
  let locRows = [];                                                   // resultados da última busca (p/ o desdobramento achar o objeto)
  const marcados = () => all('#loc_res input[type=checkbox][data-id]:checked').map((c) => +c.dataset.id);
  const sync = () => {
    const n = marcados().length;
    btn.disabled = !n; btn.textContent = n ? `Mover ${n} lançamento(s)` : 'Mover selecionados';
    split.disabled = n !== 1;                                         // desdobrar é sempre de 1 lançamento
  };

  let timer;
  const buscar = async () => {
    const termo = q.value.trim();
    if (termo.length < 2) { res.innerHTML = '<div style="color:var(--ink-dim);font-size:13px;padding:10px">Digite ao menos 2 letras…</div>'; sync(); return; }
    const extra = $('#loc_tipo').value === 'todos' ? '&tipo=todos' : '';
    const hor = +$('#loc_hor').value;
    const d = new Date(hojeISO() + 'T12:00:00'); d.setMonth(d.getMonth() + hor);
    const ate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const r = await api(`api/lancamentos/buscar?q=${encodeURIComponent(termo)}${extra}&ate=${ate}`);
    const rows = r.itens || [];
    locRows = rows;
    if (!rows.length) { res.innerHTML = '<div style="color:var(--ink-dim);font-size:13px;padding:10px">Nada encontrado para “' + termo + '” entre ' + fmtData(r.de) + ' e ' + fmtData(r.ate) + '.</div>'; sync(); return; }
    res.innerHTML = `<div style="color:var(--ink-dim);font-size:12px;padding:4px 2px 6px">${rows.length} resultado(s) · janela ${fmtData(r.de)} → ${fmtData(r.ate)}${r.truncado ? ' · <b style="color:var(--gold)">mostrando só os 100 primeiros — refine a busca</b>' : ''}</div>
      <table style="width:100%"><thead><tr>
        <th style="width:30px"><input type="checkbox" id="loc_all" title="marcar todos"></th>
        <th class="l">Data</th><th class="l">Descrição</th><th class="l">Centro</th><th>Tipo</th><th>Valor</th></tr></thead>
      <tbody>${rows.map((l) => `<tr>
        <td><input type="checkbox" data-id="${l.id}"></td>
        <td>${fmtData(l.data)}</td>
        <td class="l">${l.nome}${l.livro === 'dutra' ? ' <span style="color:var(--gold);font-size:11px">(Dutra)</span>' : ''}</td>
        <td class="l">${capCC(l.centro_custo)}</td>
        <td style="text-align:center"><span class="tag ${l.tipo === 'real' ? 'real' : 'orc'}">${l.tipo === 'real' ? 'real' : 'orç'}</span></td>
        <td class="${l.valor < 0 ? 'money neg' : 'money pos'}">${BRL(l.valor)}</td></tr>`).join('')}</tbody></table>`;
    $('#loc_all').onchange = (e) => { all('#loc_res input[type=checkbox][data-id]').forEach((c) => (c.checked = e.target.checked)); sync(); };
    all('#loc_res input[type=checkbox][data-id]').forEach((c) => (c.onchange = sync));
    sync();
  };
  q.oninput = () => { clearTimeout(timer); timer = setTimeout(buscar, 250); };
  $('#loc_tipo').onchange = buscar;
  $('#loc_hor').onchange = buscar;
  q.focus();

  btn.onclick = async () => {
    const ids = marcados(); if (!ids.length) return;
    const nova = $('#loc_data').value;
    if (!nova) { msg.textContent = 'escolha a data'; return; }
    btn.disabled = true; msg.textContent = 'movendo…';
    try {
      await api('api/lancamentos/mover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, nova_data: nova }) });
      closeModal(); await render();
    } catch (e) { msg.textContent = 'erro: ' + e.message; btn.disabled = false; }
  };
  split.onclick = () => {
    const id = marcados()[0];
    const l = locRows.find((x) => x.id === id);
    if (l) modalDesdobrar(l);
  };
}
window.modalLocalizar = modalLocalizar;

// Desdobra 1 lançamento em N parcelas com datas próprias (ex.: comissão recebida em 2 momentos).
// A última parcela é sempre o resto (total − demais), então a soma bate sozinha.
function modalDesdobrar(l) {
  const total = Math.abs(l.valor);
  const rec = l.valor >= 0;
  const meta = (total / 2);
  const linha = (data, valor, i) => `<tr data-p="${i}">
    <td style="width:44px;color:var(--ink-dim);text-align:center">${i + 1}ª</td>
    <td><input type="date" class="dsp_data" value="${data}" style="width:100%"></td>
    <td><input type="number" step="0.01" class="dsp_val" value="${valor.toFixed(2)}" style="width:120px;text-align:right"></td>
    <td style="width:34px;text-align:center"><button class="dsp_del" title="remover parcela" tabindex="-1" style="background:none;border:none;color:var(--neg);cursor:pointer;font-size:14px">✕</button></td></tr>`;
  openModal(`<div class="modal-wide"><h2>✂️ Desdobrar em datas</h2>
    <p style="color:var(--ink-dim);font-size:13px;margin:0 0 4px"><b>${l.nome}</b> · ${capCC(l.centro_custo)}</p>
    <p style="color:var(--ink-dim);font-size:13px;margin:0 0 10px">Total de <b class="${rec ? 'pos' : 'neg'}">${BRL(l.valor)}</b> dividido em parcelas — cada uma na sua data. A <b>última</b> ajusta sozinha para fechar o total.</p>
    <table style="width:100%"><thead><tr><th></th><th class="l">Data</th><th class="l">Valor</th><th></th></tr></thead>
      <tbody id="dsp_body">${linha(l.data, meta, 0) + linha(l.data, total - meta, 1)}</tbody></table>
    <div class="row" style="margin-top:8px;align-items:center;gap:12px">
      <button class="ghost" id="dsp_add">+ parcela</button>
      <span id="dsp_soma" style="font-size:13px"></span>
    </div>
    <div class="modal-actions">
      <button class="ghost" onclick="modalLocalizar()">‹ Voltar</button>
      <button class="primary" id="dsp_ok">Desdobrar</button>
    </div></div>`);

  const body = $('#dsp_body'), somaEl = $('#dsp_soma'), okBtn = $('#dsp_ok');
  const rows = () => [...body.querySelectorAll('tr')];
  const vals = () => rows().map((r) => Math.abs(parseFloat(r.querySelector('.dsp_val').value) || 0));
  // recalcula a ÚLTIMA parcela = total − soma das demais (mantém o total fechado sem o usuário fazer conta)
  const rebalance = () => {
    const rr = rows(); if (rr.length < 2) return;
    const last = rr[rr.length - 1].querySelector('.dsp_val');
    const outros = rr.slice(0, -1).reduce((s, r) => s + Math.abs(parseFloat(r.querySelector('.dsp_val').value) || 0), 0);
    last.value = (total - outros).toFixed(2);
  };
  const refresh = () => {
    const s = vals().reduce((a, b) => a + b, 0);
    const ok = Math.abs(s - total) < 0.01 && vals().every((v) => v > 0);
    somaEl.innerHTML = `soma <b class="${ok ? 'pos' : 'neg'}">${BRL(s)}</b> / total ${BRL(total)}` + (ok ? ' ✓' : '');
    okBtn.disabled = !ok;
    rows().forEach((r, i) => { r.querySelector('.dsp_del').style.visibility = rows().length > 2 ? 'visible' : 'hidden'; });
  };
  const wire = () => {
    rows().forEach((r, i, arr) => {
      const val = r.querySelector('.dsp_val');
      val.oninput = () => { if (i < arr.length - 1) rebalance(); refresh(); };
      r.querySelector('.dsp_del').onclick = () => { if (rows().length > 2) { r.remove(); rebalance(); wire(); refresh(); } };
    });
  };
  $('#dsp_add').onclick = () => {
    const last = rows()[rows().length - 1];
    last.insertAdjacentHTML('beforebegin', linha(l.data, 0, rows().length));
    rebalance(); wire(); refresh();
  };
  wire(); refresh();

  okBtn.onclick = async () => {
    const parcelas = rows().map((r) => ({ data: r.querySelector('.dsp_data').value, valor: Math.abs(parseFloat(r.querySelector('.dsp_val').value) || 0) }));
    if (parcelas.some((p) => !p.data || !p.valor)) { somaEl.innerHTML = '<span class="neg">preencha data e valor de todas</span>'; return; }
    okBtn.disabled = true;
    try {
      const r = await api('api/lancamentos/desdobrar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: l.id, parcelas }) });
      if (r && r.erro) { somaEl.innerHTML = '<span class="neg">' + r.erro + '</span>'; okBtn.disabled = false; return; }
      closeModal(); await render();
    } catch (e) { somaEl.innerHTML = '<span class="neg">erro: ' + e.message + '</span>'; okBtn.disabled = false; }
  };
}
window.modalDesdobrar = modalDesdobrar;

// Move um lançamento para o Mapa de Pendências (orçamento paralelo): abre uma agenda com data(s)
// prevista(s) — pode parcelar. Sai do orçado; entra no caixa como pendência (neutra ao orçamento).
function modalMoverPendencia(l) {
  const total = Math.abs(l.valor);
  const meta = +(total / 2).toFixed(2);   // metade arredondada; a 2ª parcela leva o resto exato (evita 1 centavo de diferença)
  const linha = (data, valor, i) => `<tr data-p="${i}">
    <td style="width:44px;color:var(--ink-dim);text-align:center">${i + 1}ª</td>
    <td><input type="date" class="mp_data" value="${data}" style="width:100%"></td>
    <td><input type="number" step="0.01" class="mp_val" value="${valor.toFixed(2)}" style="width:120px;text-align:right"></td>
    <td style="width:34px;text-align:center"><button class="mp_del" title="remover parcela" tabindex="-1" style="background:none;border:none;color:var(--neg);cursor:pointer;font-size:14px">✕</button></td></tr>`;
  openModal(`<div class="modal-wide"><h2>🧭 Mover para pendências</h2>
    <p style="color:var(--ink-dim);font-size:13px;margin:0 0 4px"><b>${l.nome}</b> · ${capCC(l.centro_custo)}</p>
    <p style="color:var(--ink-dim);font-size:13px;margin:0 0 10px"><b class="neg">${BRL(-total)}</b> sai do orçado e vira <b>orçamento de pendências</b>: entra no caixa na(s) data(s) prevista(s), mas não conta no orçamento. Pode parcelar — a <b>última</b> fecha o total sozinha.</p>
    <div class="row" style="margin:0 0 8px;max-width:280px"><div class="field" style="margin:0"><label>Mapa</label>
      <select id="mp_livro"><option value="empresa" ${l.livro !== 'dutra' ? 'selected' : ''}>Mapa de Pendências</option>
      <option value="dutra" ${l.livro === 'dutra' ? 'selected' : ''}>Pendências Dutra</option></select></div></div>
    <table style="width:100%"><thead><tr><th></th><th class="l">Data prevista</th><th class="l">Valor</th><th></th></tr></thead>
      <tbody id="mp_body">${linha(l.data, meta, 0) + linha(l.data, +(total - meta).toFixed(2), 1)}</tbody></table>
    <div class="row" style="margin-top:8px;align-items:center;gap:12px">
      <button class="ghost" id="mp_add">+ parcela</button>
      <span id="mp_soma" style="font-size:13px"></span>
    </div>
    <div class="modal-actions">
      <button class="ghost" onclick="closeModal()">Cancelar</button>
      <button class="primary" id="mp_ok">Mover para pendências</button>
    </div></div>`);

  const body = $('#mp_body'), somaEl = $('#mp_soma'), okBtn = $('#mp_ok');
  const rows = () => [...body.querySelectorAll('tr')];
  const vals = () => rows().map((r) => Math.abs(parseFloat(r.querySelector('.mp_val').value) || 0));
  const rebalance = () => {
    const rr = rows(); if (rr.length < 2) return;
    const last = rr[rr.length - 1].querySelector('.mp_val');
    const outros = rr.slice(0, -1).reduce((s, r) => s + Math.abs(parseFloat(r.querySelector('.mp_val').value) || 0), 0);
    last.value = (total - outros).toFixed(2);
  };
  const refresh = () => {
    const s = vals().reduce((a, b) => a + b, 0);
    const ok = Math.abs(s - total) < 0.01 && vals().every((v) => v > 0);
    somaEl.innerHTML = `soma <b class="${ok ? 'pos' : 'neg'}">${BRL(s)}</b> / total ${BRL(total)}` + (ok ? ' ✓' : '');
    okBtn.disabled = !ok;
    rows().forEach((r) => { r.querySelector('.mp_del').style.visibility = rows().length > 1 ? 'visible' : 'hidden'; });
  };
  const wire = () => {
    rows().forEach((r, i, arr) => {
      r.querySelector('.mp_val').oninput = () => { if (i < arr.length - 1) rebalance(); refresh(); };
      r.querySelector('.mp_del').onclick = () => { if (rows().length > 1) { r.remove(); rebalance(); wire(); refresh(); } };
    });
  };
  $('#mp_add').onclick = () => {
    rows()[rows().length - 1].insertAdjacentHTML('beforebegin', linha(l.data, 0, rows().length));
    rebalance(); wire(); refresh();
  };
  wire(); refresh();

  okBtn.onclick = async () => {
    const parcelas = rows().map((r) => ({ data: r.querySelector('.mp_data').value, valor: Math.abs(parseFloat(r.querySelector('.mp_val').value) || 0) }));
    if (parcelas.some((p) => !p.data || !p.valor)) { somaEl.innerHTML = '<span class="neg">preencha data e valor de todas</span>'; return; }
    okBtn.disabled = true;
    try {
      const r = await api(lq(`api/lancamentos/${l.id}/mover-pendencia`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ livro: $('#mp_livro').value, parcelas }) });
      if (r && r.erro) { somaEl.innerHTML = '<span class="neg">' + r.erro + '</span>'; okBtn.disabled = false; return; }
      if (ghost.delete(l.id)) saveGhost();   // moveu p/ pendências: sai do ghost
      closeModal(); await render();
    } catch (e) { somaEl.innerHTML = '<span class="neg">erro: ' + e.message + '</span>'; okBtn.disabled = false; }
  };
}
window.modalMoverPendencia = modalMoverPendencia;

// Faturamento Real: vendas+locações+marginal (do Sales) + adm (você digita à mão, por mês)
async function modalFaturamentoReal() {
  const ano = +(refDate || '2026').slice(0, 4) || new Date().getFullYear();
  openModal('<h2>💰 Faturamento Real ' + ano + '</h2><p style="color:var(--ink-dim);font-size:13px">carregando…</p>');
  let d;
  try { d = await api('api/faturamento-real?ano=' + ano); } catch (e) { openModal('<h2>💰 Faturamento Real</h2><p class="money neg">Erro: ' + e.message + '</p><div class="modal-actions"><button class="ghost" onclick="closeModal()">Fechar</button></div>'); return; }
  const cel = (v) => `<td class="${v < 0 ? 'money neg' : (v ? 'money pos' : '')}" style="text-align:right">${v ? BRL(v) : '—'}</td>`;
  const linhas = d.meses.map((m) => `<tr data-mes="${m.mes}">
      <td class="l">${MESNOME[m.mes - 1]}</td>
      ${cel(m.vendas)}${cel(m.locacoes)}${cel(m.marginal)}
      <td style="text-align:right"><input class="fr-adm" data-mes="${m.mes}" type="number" step="0.01" value="${m.adm || ''}" placeholder="0,00"
        style="width:110px;text-align:right;padding:4px 6px;font-size:13px" title="Digite o que recebeu de administração neste mês"></td>
      <td class="fr-tot money pos" data-mes="${m.mes}" style="text-align:right;font-weight:700">${BRL(m.total)}</td></tr>`).join('');
  openModal(`<div class="modal-wide"><h2>💰 Faturamento Real ${ano}</h2>
    <p style="color:var(--ink-dim);font-size:13px;margin:0 0 10px">Comissão de vendas + locações + receita marginal (do módulo Sales) — só o <b>faturamento real</b>: vendas <b>assinadas</b>, mesmo critério do Funil e do Dashboard (nada de previsto/quente). A coluna <b>Adm.</b> você preenche à mão com o que recebeu de administração no mês — fica só neste relatório, não mexe no caixa.</p>
    <table style="width:100%"><thead><tr>
        <th class="l">Mês</th><th style="text-align:right">Vendas</th><th style="text-align:right">Locações</th>
        <th style="text-align:right">Marginal</th><th style="text-align:right">Adm. (manual)</th><th style="text-align:right">Total</th></tr></thead>
      <tbody>${linhas}</tbody>
      <tfoot><tr style="font-weight:800;border-top:2px solid var(--gold)">
        <td class="l">Total ${ano}</td>
        <td class="money pos" style="text-align:right">${BRL(d.meses.reduce((s, m) => s + m.vendas, 0))}</td>
        <td class="money pos" style="text-align:right">${BRL(d.meses.reduce((s, m) => s + m.locacoes, 0))}</td>
        <td class="money pos" style="text-align:right">${BRL(d.meses.reduce((s, m) => s + m.marginal, 0))}</td>
        <td class="fr-adm-tot money pos" style="text-align:right">${BRL(d.meses.reduce((s, m) => s + m.adm, 0))}</td>
        <td class="fr-grand money pos" style="text-align:right">${BRL(d.total)}</td></tr></tfoot></table>
    <div class="modal-actions"><button class="ghost" onclick="closeModal()">Fechar</button></div></div>`);

  // fixo por mês (vendas+loc+marginal), p/ recalcular o total quando você mexe na adm
  const fixo = {}; d.meses.forEach((m) => { fixo[m.mes] = m.vendas + m.locacoes + m.marginal; });
  const recalc = () => {
    let somaAdm = 0, grand = 0;
    document.querySelectorAll('#modalBox .fr-adm').forEach((inp) => {
      const mes = +inp.dataset.mes, adm = +inp.value || 0;
      somaAdm += adm; grand += fixo[mes] + adm;
      const tc = document.querySelector(`#modalBox .fr-tot[data-mes="${mes}"]`); if (tc) tc.textContent = BRL(fixo[mes] + adm);
    });
    document.querySelector('#modalBox .fr-adm-tot').textContent = BRL(somaAdm);
    document.querySelector('#modalBox .fr-grand').textContent = BRL(grand);
  };
  document.querySelectorAll('#modalBox .fr-adm').forEach((inp) => {
    inp.oninput = recalc;                                   // atualiza a tela na hora
    inp.onchange = async () => {                            // salva ao sair do campo
      try { await api('api/faturamento-real/adm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ano, mes: +inp.dataset.mes, valor: +inp.value || 0 }) }); }
      catch (e) { alert('Erro ao salvar adm: ' + e.message); }
    };
  });
}
window.modalFaturamentoReal = modalFaturamentoReal;

/* ---------- Modais ---------- */
// ---------- ENTRADA NOTION: fila simples de aprovação ----------
async function modalNotionEntradas() {
  openModal('<div class="modal-wide"><h2>📥 Entrada Notion</h2><p style="color:var(--ink-dim);font-size:13px">carregando…</p></div>');
  let rows;
  try { rows = await api(lq('api/notion/entradas?status=pendente')); }
  catch (e) { openModal(`<h2>📥 Entrada Notion</h2><p class="money neg">Erro: ${e.message}</p><div class="modal-actions"><button class="ghost" onclick="closeModal()">Fechar</button></div>`); return; }
  const linhas = (rows || []).map((e) => `
    <tr data-id="${e.id}">
      <td class="l">${e.nome}${e.comprovante ? ` · <a href="${e.comprovante}" target="_blank" rel="noopener" style="color:var(--gold)">comprovante</a>` : ''}</td>
      <td>${e.vencimento ? fmtData(e.vencimento) : '—'}</td>
      <td class="money neg" style="text-align:right">${BRL(-Math.abs(e.valor || 0))}</td>
      <td class="l">${e.centro_custo || '<span class="money neg">— sem centro —</span>'}</td>
      <td style="white-space:nowrap">
        <button class="primary" data-ap="${e.id}">Aprovar</button>
        <button class="danger" data-rj="${e.id}">Rejeitar</button>
      </td></tr>`).join('');
  openModal(`<div class="modal-wide"><h2>📥 Entrada Notion <span style="color:var(--ink-dim);font-size:13px;font-weight:400">· ${rows.length} pendente(s)</span></h2>
    <p style="color:var(--ink-dim);font-size:13px;margin:0 0 8px">Contas registradas pela Márcia no Notion. Aprovar cria um lançamento normal (orçado, saída, livro empresa) — depois você ajusta na tela de sempre se precisar.</p>
    ${rows.length ? `<table style="width:100%"><thead><tr><th class="l">Lançamento</th><th>Venc.</th><th style="text-align:right">Valor</th><th class="l">Centro de custo</th><th></th></tr></thead><tbody>${linhas}</tbody></table>`
      : '<div class="empty" style="padding:16px">Nenhuma entrada pendente.</div>'}
    <div class="modal-actions"><button class="ghost" onclick="closeModal()">Fechar</button></div></div>`);
  $('#modalBox').querySelectorAll('[data-ap]').forEach((b) => { b.onclick = () => aprovarNotion(+b.dataset.ap); });
  $('#modalBox').querySelectorAll('[data-rj]').forEach((b) => { b.onclick = () => rejeitarNotion(+b.dataset.rj); });
}
async function aprovarNotion(id) {
  const r = await api(lq(`api/notion/entradas/${id}/aprovar`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (r && r.erro) return alert('Erro: ' + r.erro);
  modalNotionEntradas(); render();   // atualiza a fila e o caixa (o lançamento já entra como orçado)
}
async function rejeitarNotion(id) {
  const motivo = prompt('Motivo da rejeição (vai para o card da Márcia no Notion):');
  if (motivo == null || !motivo.trim()) return;
  const r = await api(lq(`api/notion/entradas/${id}/rejeitar`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ motivo: motivo.trim() }) });
  if (r && r.erro) return alert('Erro: ' + r.erro);
  modalNotionEntradas();
}

function openModal(html) { $('#modalBox').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); }
window.closeModal = closeModal;

function ccOptions(sel) {
  // preserva o centro atual mesmo que não esteja no cadastro (ex.: centros da ponte de Vendas),
  // senão o select "perde" o valor ao editar e cai no 1º centro — invertendo o sinal do lançamento
  const nomes = META.centros_custo.map((c) => c.nome);
  const extra = sel && !nomes.includes(sel) ? `<option value="${sel}" selected>${capCC(sel)}</option>` : '';
  return extra + ordenaCC(nomes).map((n) => `<option value="${n}" ${n === sel ? 'selected' : ''}>${capCC(n)}</option>`).join('') + '<option value="__novo__">➕ novo centro…</option>';
}
// cria um centro de custo na hora, quando o usuário escolhe "➕ novo centro…" no dropdown
window.onCentroSelect = async function (sel) {
  if (sel.value !== '__novo__') return;
  const prev = sel.dataset.prev || '';
  const nome = (prompt('Nome do novo centro de custo:\n(para RECEITA, comece com "receita · ")') || '').trim();
  if (!nome) { sel.value = prev; return; }
  const ehRec = /receita/i.test(nome) || confirm('É uma RECEITA (entrada)?\n\nOK = receita (entra positivo)\nCancelar = despesa (sai negativo)');
  try {
    await api('api/centros_custo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome, eh_receita: ehRec ? 1 : 0 }) });
    META = await api('api/meta');                       // recarrega a lista de centros
    const temBlank = sel.options[0] && sel.options[0].value === '';
    sel.innerHTML = (temBlank ? '<option value="">— centro —</option>' : '') + ccOptions(nome);
    sel.value = nome;                                   // já seleciona o novo
    if (typeof status === 'function') status(`Centro "${nome}" criado`);
  } catch (e) { alert('Erro ao criar centro: ' + e.message); sel.value = prev; }
}

function modalLancamento(l = null) {
  const ed = !!l;
  // movível p/ pendências: qualquer um exceto gerenciado (venda/pendência/reembolso); [R] pode ir
  const movivel = ed && !['venda', 'pendencia', 'pendencia_par', 'reembolso'].includes(l.origem);   // [R] pode ir p/ pendências
  const temReemb = ed && l.origem === 'reembolso';                   // já é um abatimento da retirada?
  const showReemb = !ed || l.valor < 0 || temReemb;                  // aparece em despesa (ou p/ desmarcar um abatimento)
  openModal(`<h2>${ed ? 'Editar' : 'Novo'} lançamento</h2>
    <div class="field"><label>Descrição</label><input id="f_nome" value="${ed ? l.nome.replace(/"/g, '&quot;') : ''}" placeholder="Ex.: Comissão venda apto 101"></div>
    <div class="field"><label>Centro de custo</label><select id="f_cc" onfocus="this.dataset.prev=this.value" onchange="onCentroSelect(this)">${ccOptions(ed ? l.centro_custo : '')}</select></div>
    <div class="row">
      <div class="field"><label>Tipo</label><select id="f_tipo">
        <option value="orçado" ${ed && l.tipo === 'orçado' ? 'selected' : ''}>orçado</option>
        <option value="real" ${ed && l.tipo === 'real' ? 'selected' : ''}>real</option></select></div>
      <div class="field"><label>Data</label><input id="f_data" type="date" value="${ed ? l.data : refDate}"></div>
    </div>
    <div class="row">
      <div class="field"><label>Valor (R$ — sinal automático)</label><input id="f_valor" type="number" step="0.01" value="${ed ? Math.abs(l.valor) : ''}" placeholder="0,00"></div>
      <div class="field"><label>Prioridade</label><select id="f_prio">
        <option value="">—</option>
        <option value="P1" ${ed && l.prioridade === 'P1' ? 'selected' : ''}>🔴 P1</option>
        <option value="P2" ${ed && l.prioridade === 'P2' ? 'selected' : ''}>🔵 P2</option></select></div>
    </div>
    ${showReemb ? `<div class="field" style="background:rgba(212,175,55,.06);border:1px solid var(--line);border-radius:8px;padding:8px 10px">
      <label style="cursor:pointer"><input type="checkbox" id="f_reembolso" ${temReemb ? 'checked' : ''} style="width:auto;margin-right:8px">💳 Paguei pela minha conta pessoal <span style="color:var(--ink-dim);font-weight:400">(vira um abatimento direto na Retirada Dutra — não gera despesa)</span></label></div>` : ''}
    ${!ed ? `<div class="field" style="padding:2px 0">
      <label style="cursor:pointer"><input type="checkbox" id="f_parc_on" style="width:auto;margin-right:8px">🔀 Parcelar em várias datas <span style="color:var(--ink-dim);font-weight:400">(divide o valor em parcelas, cada uma na sua data)</span></label></div>
    <div id="f_parc" style="display:none;border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-top:2px">
      <table style="width:100%"><thead><tr><th></th><th class="l" style="font-size:11px;color:var(--ink-dim)">Data</th><th class="l" style="font-size:11px;color:var(--ink-dim)">Valor</th><th></th></tr></thead><tbody id="f_parc_body"></tbody></table>
      <div class="row" style="margin-top:6px;align-items:center;gap:12px"><button type="button" class="ghost" id="f_parc_add">+ parcela</button><span id="f_parc_soma" style="font-size:12px"></span></div>
    </div>` : ''}
    <div class="field" style="padding:2px 0">
      <label style="cursor:pointer"><input type="checkbox" id="f_rep_on" style="width:auto;margin-right:8px">🔁 Repetir em datas futuras <span style="color:var(--ink-dim);font-weight:400">(cria a mesma conta em intervalos, até uma data)</span></label></div>
    <div id="f_rep" style="display:none;border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-top:2px">
      <div class="row">
        <div class="field"><label>Intervalo</label><select id="f_rep_freq">
          <option value="semanal">7 em 7 dias (semanal)</option>
          <option value="quinzenal">15 em 15 dias (quinzenal)</option>
          <option value="mensal" selected>Mensal</option>
          <option value="anual">Anual</option></select></div>
        <div class="field"><label>Repetir até</label><input id="f_rep_ate" type="date"></div>
      </div>
      <label style="cursor:pointer;font-size:13px"><input type="checkbox" id="f_rep_esc" style="width:auto;margin-right:8px">Valores diferentes por data (escalonar)</label>
      <div id="f_rep_prev" style="margin-top:8px;font-size:12px;color:var(--ink-dim)"></div>
    </div>
    <div class="modal-actions">
      ${ed ? '<button class="warn" onclick="delLanc(' + l.id + ')">Excluir</button>' : ''}
      ${ed ? `<button class="ghost" onclick="toggleGhostModal(${l.id})" title="Tira/põe o lançamento na conta da semana (modo ghost)">${isGhosted(l) ? '👁️ Tirar do ghost' : '👻 Ghost'}</button>` : ''}
      ${ed && movivel ? '<button class="ghost" onclick="modalMoverPendencia(window.__lancEdit)" title="Sai do orçado e vira orçamento de pendências, no caixa">🧭 Pendências</button>' : ''}
      <button class="ghost" onclick="closeModal()">Cancelar</button>
      <button class="primary" onclick="saveLanc(${ed ? l.id : 'null'})">Salvar</button>
    </div>`);
  window.__lancEdit = l;   // stash p/ o botão "Mover para pendências" pegar o objeto completo
  if (!ed) ligarParcelamento();
  ligarRepeticao();
}

// cadência no front (espelha o servidor): próxima data a partir de 'iso'
function proxDataSerieJS(iso, freq) {
  const [y, m, d] = iso.split('-').map(Number);
  const ultimo = (yy, mm) => new Date(yy, mm, 0).getDate();
  const p = (n) => String(n).padStart(2, '0');
  if (freq === 'semanal' || freq === 'quinzenal') {
    const base = new Date(iso + 'T00:00:00'); base.setDate(base.getDate() + (freq === 'semanal' ? 7 : 14));
    return `${base.getFullYear()}-${p(base.getMonth() + 1)}-${p(base.getDate())}`;
  }
  if (freq === 'anual') return `${y + 1}-${p(m)}-${p(Math.min(d, ultimo(y + 1, m)))}`;
  let ny = y, nm = m + 1; if (nm > 12) { nm = 1; ny += 1; }   // mensal
  return `${ny}-${p(nm)}-${p(Math.min(d, ultimo(ny, nm)))}`;
}
// datas FUTURAS da série (exclui a data-base: essa é o próprio lançamento)
function datasFuturasSerie(baseData, freq, ate) {
  const out = []; if (!baseData || !ate || ate <= baseData) return out;
  let cur = proxDataSerieJS(baseData, freq); let g = 0;
  while (cur <= ate && g++ < 400) { out.push(cur); cur = proxDataSerieJS(cur, freq); }
  return out;
}
// editor da repetição (série) — uniforme por padrão, escalonável por data
function ligarRepeticao() {
  const chk = $('#f_rep_on'); if (!chk) return;
  const box = $('#f_rep'), prev = $('#f_rep_prev'), esc = $('#f_rep_esc');
  const freqEl = $('#f_rep_freq'), ateEl = $('#f_rep_ate'), reemb = $('#f_reembolso'), parc = $('#f_parc_on');
  const fmtBR = (iso) => iso.split('-').reverse().join('/');
  const refresh = () => {
    const base = $('#f_data').value, freq = freqEl.value, ate = ateEl.value;
    const valorBase = Math.abs(parseFloat($('#f_valor').value || '0')) || 0;
    const datas = datasFuturasSerie(base, freq, ate);
    if (!ate) { prev.innerHTML = 'Escolha até quando repetir.'; return; }
    if (!datas.length) { prev.innerHTML = '<span class="neg">A data-fim precisa ser depois da data do lançamento.</span>'; return; }
    if (esc.checked) {
      prev.innerHTML = `<div style="max-height:180px;overflow:auto"><table style="width:100%">
        <thead><tr><th class="l" style="font-size:11px">Data</th><th class="l" style="font-size:11px">Valor</th></tr></thead><tbody id="f_rep_body">
        ${datas.map((d) => `<tr><td style="padding:2px 6px">${fmtBR(d)}</td>
          <td><input type="number" step="0.01" class="fr_val" data-data="${d}" value="${valorBase.toFixed(2)}" style="width:120px;text-align:right"></td></tr>`).join('')}
        </tbody></table></div><div style="margin-top:4px">${datas.length} repetição(ões), além desta.</div>`;
    } else {
      prev.innerHTML = `<b>${datas.length}</b> repetição(ões) de <b>${BRL(valorBase)}</b>, além desta — ${fmtBR(datas[0])} até ${fmtBR(datas[datas.length - 1])}.`;
    }
  };
  chk.onchange = () => {
    box.style.display = chk.checked ? '' : 'none';
    if (chk.checked) {
      if (parc) parc.checked = false, (parc.dispatchEvent(new Event('change')));   // não combina com parcelar
      if (reemb) reemb.closest('.field').style.display = 'none';
      if (!ateEl.value) { // sugere um fim ~6 meses à frente
        const b = new Date(($('#f_data').value || refDate) + 'T00:00:00'); b.setMonth(b.getMonth() + 6);
        const p = (n) => String(n).padStart(2, '0'); ateEl.value = `${b.getFullYear()}-${p(b.getMonth() + 1)}-${p(b.getDate())}`;
      }
      refresh();
    } else if (reemb) { reemb.closest('.field').style.display = ''; }
  };
  [freqEl, ateEl, esc, $('#f_valor'), $('#f_data')].forEach((el) => el && el.addEventListener('input', () => { if (chk.checked) refresh(); }));
  esc.addEventListener('change', () => { if (chk.checked) refresh(); });
}

// editor de parcelamento do NOVO lançamento (divide o valor em parcelas com datas próprias)
function ligarParcelamento() {
  const chk = $('#f_parc_on'), box = $('#f_parc'), body = $('#f_parc_body'), somaEl = $('#f_parc_soma'), reemb = $('#f_reembolso');
  const totalAtual = () => Math.abs(parseFloat($('#f_valor').value || '0')) || 0;
  const linha = (data, valor) => { const tr = document.createElement('tr');
    tr.innerHTML = `<td style="width:34px;color:var(--ink-dim);text-align:center;font-size:12px">${body.children.length + 1}ª</td>
      <td><input type="date" class="fp_data" value="${data}" style="width:100%"></td>
      <td><input type="number" step="0.01" class="fp_val" value="${valor.toFixed(2)}" style="width:110px;text-align:right"></td>
      <td style="width:28px;text-align:center"><button type="button" class="fp_del" tabindex="-1" style="background:none;border:none;color:var(--neg);cursor:pointer">✕</button></td>`;
    body.appendChild(tr); return tr; };
  const rows = () => [...body.querySelectorAll('tr')];
  const vals = () => rows().map((r) => Math.abs(parseFloat(r.querySelector('.fp_val').value) || 0));
  const rebalance = () => { const rr = rows(); if (rr.length < 2) return; const t = totalAtual(); const outros = rr.slice(0, -1).reduce((s, r) => s + Math.abs(parseFloat(r.querySelector('.fp_val').value) || 0), 0); rr[rr.length - 1].querySelector('.fp_val').value = (t - outros).toFixed(2); };
  const refresh = () => { const t = totalAtual(); const s = vals().reduce((a, b) => a + b, 0); const ok = t > 0 && Math.abs(s - t) < 0.01 && vals().every((v) => v > 0); somaEl.innerHTML = `soma <b class="${ok ? 'pos' : 'neg'}">${BRL(s)}</b> / ${BRL(t)}` + (ok ? ' ✓' : ''); rows().forEach((r) => r.querySelector('.fp_del').style.visibility = rows().length > 2 ? 'visible' : 'hidden'); };
  const wire = () => rows().forEach((r, i, arr) => { r.querySelector('.fp_val').oninput = () => { if (i < arr.length - 1) rebalance(); refresh(); }; r.querySelector('.fp_del').onclick = () => { if (rows().length > 2) { r.remove(); rebalance(); wire(); refresh(); } }; });
  chk.onchange = () => {
    box.style.display = chk.checked ? '' : 'none';
    if (reemb) reemb.closest('.field').style.display = chk.checked ? 'none' : '';   // reembolso não combina com parcelar
    if (chk.checked && !body.children.length) { const t = totalAtual(), m = +(t / 2).toFixed(2), d = $('#f_data').value; linha(d, m); linha(d, +(t - m).toFixed(2)); wire(); refresh(); }
  };
  $('#f_parc_add').onclick = () => { linha($('#f_data').value, 0); rebalance(); wire(); refresh(); };
  $('#f_valor').addEventListener('input', () => { if (chk.checked) { rebalance(); refresh(); } });
}

window.saveLanc = async (id) => {
  const reembCb = $('#f_reembolso');
  const nome = $('#f_nome').value.trim(), centro_custo = $('#f_cc').value, tipo = $('#f_tipo').value, prioridade = $('#f_prio').value || null;
  if (!nome) return alert('Informe a descrição');
  const parcOn = $('#f_parc_on');
  if (!id && parcOn && parcOn.checked) {
    // PARCELADO: cria N lançamentos (desc "(i/N)"), cada um na sua data/valor
    const parcelas = [...document.querySelectorAll('#f_parc_body tr')].map((r) => ({ data: r.querySelector('.fp_data').value, valor: Math.abs(parseFloat(r.querySelector('.fp_val').value) || 0) }));
    const total = Math.abs(parseFloat($('#f_valor').value || '0'));
    const soma = parcelas.reduce((s, p) => s + p.valor, 0);
    if (parcelas.some((p) => !p.data || !p.valor)) return alert('Preencha data e valor de todas as parcelas.');
    if (Math.abs(soma - total) > 0.01) return alert(`A soma das parcelas (${BRL(soma)}) precisa bater com o valor (${BRL(total)}).`);
    for (let i = 0; i < parcelas.length; i++) {
      await api(lq('api/lancamentos'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome: `${nome} (${i + 1}/${parcelas.length})`, centro_custo, tipo, data: parcelas[i].data, valor: parcelas[i].valor, prioridade }) });
    }
    closeModal(); render(); return;
  }
  const repCb = $('#f_rep_on');
  const repOn = repCb && repCb.checked;
  const body = {
    nome, centro_custo, tipo, data: $('#f_data').value, valor: parseFloat($('#f_valor').value || '0'),
    prioridade, reembolso_pf: (reembCb && !repOn) ? reembCb.checked : false,
  };
  await api(lq(id ? `api/lancamentos/${id}` : 'api/lancamentos'), {
    method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  // REPETIR: cria a série (ocorrências futuras, além deste lançamento-base)
  if (repOn) {
    const freq = $('#f_rep_freq').value, ate = $('#f_rep_ate').value;
    const baseData = $('#f_data').value, valorBase = Math.abs(parseFloat($('#f_valor').value || '0')) || 0;
    let itens;
    if ($('#f_rep_esc').checked) {
      itens = [...document.querySelectorAll('#f_rep_body .fr_val')].map((i) => ({ data: i.dataset.data, valor: Math.abs(parseFloat(i.value) || 0) }));
    } else {
      itens = datasFuturasSerie(baseData, freq, ate).map((d) => ({ data: d, valor: valorBase }));
    }
    itens = itens.filter((it) => it.data && it.valor > 0);
    if (!ate || !itens.length) { alert('Defina "Repetir até" com pelo menos uma data futura.'); return; }
    await api(lq('api/series'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome, centro_custo, tipo, frequencia: freq, fim: ate, valor: valorBase, prioridade, itens }) });
  }
  closeModal(); render();
};
window.delLanc = async (id) => {
  if (!confirm('Excluir este lançamento?')) return;
  await fetch(lq(`api/lancamentos/${id}`), { method: 'DELETE' });
  if (ghost.delete(id)) saveGhost();   // se estava fantasmado, tira do ghost (senão fica id órfão)
  closeModal(); render();
};

function modalMover() {
  openModal(`<h2>Reagendar ${sel.size} lançamento(s)</h2>
    <p style="color:var(--ink-dim);font-size:13px">Todos os selecionados serão movidos para a mesma data.</p>
    <div class="field"><label>Nova data</label><input id="f_nova" type="date" value="${refDate}"></div>
    <div class="modal-actions"><button class="ghost" onclick="closeModal()">Cancelar</button>
      <button class="primary" onclick="doMover()">Mover</button></div>`);
}
window.doMover = async () => {
  await api(lq('api/lancamentos/mover'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [...sel], nova_data: $('#f_nova').value }),
  });
  closeModal(); render();
};

async function modalConsolidado() {
  const data = await api(lq('api/consolidado'));
  const tot = data.reduce((a, r) => ({ receita: a.receita + r.receita, despesa: a.despesa + r.despesa, saldo: a.saldo + r.saldo }), { receita: 0, despesa: 0, saldo: 0 });
  const cls = (n) => n < 0 ? 'money neg' : 'money pos';
  openModal(`<h2>Consolidado mensal 2026 <small style="color:var(--ink-dim);font-weight:400">(calculado)</small></h2>
    <table><thead><tr><th>Mês</th><th>Receitas</th><th>Despesas</th><th>Saldo</th></tr></thead><tbody>
    ${data.map((r) => `<tr><td>${r.mes}</td><td class="money pos">${BRL(r.receita)}</td>
      <td class="money neg">${BRL(r.despesa)}</td><td class="${cls(r.saldo)}">${BRL(r.saldo)}</td></tr>`).join('')}
    <tr class="tot"><td>TOTAL</td><td class="money pos">${BRL(tot.receita)}</td>
      <td class="money neg">${BRL(tot.despesa)}</td><td class="${cls(tot.saldo)}">${BRL(tot.saldo)}</td></tr>
    </tbody></table>
    <div class="modal-actions"><button class="primary" onclick="closeModal()">Fechar</button></div>`);
}

async function modalReceitas() {
  const [{ meses, por_origem }, hz] = await Promise.all([
    api(lq('api/receitas')), api(lq('api/receita-horizonte?ref=' + refDate)),
  ]);
  const hzLinhas = hz.buckets.map((b) => `<tr>
      <td>${b.label}</td>
      <td style="color:var(--ink-dim);font-size:11px">${b.ate ? fmtData(b.de) + '–' + fmtData(b.ate) : 'a partir de ' + fmtData(b.de)}</td>
      <td class="money pos">${b.total ? BRL(b.total) : '<span style="color:var(--ink-dim)">—</span>'}</td>
    </tr>`).join('');
  const tot = meses.reduce((a, r) => ({ realizado: a.realizado + r.realizado, previsto: a.previsto + r.previsto, total: a.total + r.total }), { realizado: 0, previsto: 0, total: 0 });
  const maxTotal = Math.max(1, ...meses.map((m) => m.total));
  const barras = meses.map((m) => {
    const wReal = (m.realizado / maxTotal) * 100, wPrev = (m.previsto / maxTotal) * 100;
    return `<div class="recrow">
      <div class="recmes">${m.mes.slice(0, 3)}</div>
      <div class="recbar"><span class="bReal" style="width:${wReal}%"></span><span class="bPrev" style="width:${wPrev}%"></span></div>
      <div class="recval">${m.total ? BRL(m.total) : '<span style="color:var(--ink-dim)">—</span>'}</div>
    </div>`;
  }).join('');
  const origens = por_origem.filter((o) => o.realizado + o.previsto > 0)
    .map((o) => `<tr><td>${o.origem.replace('receita · ', '')}</td>
      <td class="money pos">${BRL(o.realizado)}</td><td class="money pos">${BRL(o.previsto)}</td>
      <td class="money pos">${BRL(o.realizado + o.previsto)}</td></tr>`).join('');
  openModal(`<div class="modal-wide"><h2>📈 Previsão de receita</h2>
    <h3 style="font-size:13px;color:var(--gold);margin:0 0 6px">💵 Receita a entrar — por horizonte <small style="color:var(--ink-dim);font-weight:400">(a partir da semana exibida)</small></h3>
    <table><thead><tr><th>Horizonte</th><th>Período</th><th>A entrar</th></tr></thead><tbody>
      ${hzLinhas}
      <tr class="tot"><td>Total a entrar</td><td></td><td class="money pos">${BRL(hz.total)}</td></tr>
    </tbody></table>
    <h3 style="font-size:13px;color:var(--ink-dim);margin:18px 0 6px">Ano (mês a mês)</h3>
    <div class="reclegend"><span><i class="bReal"></i> realizado ${BRL(tot.realizado)}</span>
      <span><i class="bPrev"></i> previsto ${BRL(tot.previsto)}</span>
      <span><b>total ${BRL(tot.total)}</b></span></div>
    <div class="recchart">${barras}</div>
    <h3 style="font-size:13px;color:var(--ink-dim);margin:16px 0 6px">Por origem (ano)</h3>
    <table><thead><tr><th>Origem</th><th>Realizado</th><th>Previsto</th><th>Total</th></tr></thead>
      <tbody>${origens || '<tr><td colspan="4" style="color:var(--ink-dim)">sem receitas lançadas</td></tr>'}</tbody></table>
    <p style="color:var(--ink-dim);font-size:12px;margin-top:12px">Dica: lance a receita esperada como <b>orçado</b> (tipo) num centro <b>receita ·</b> — ela entra como “previsto” e já projeta no caixa futuro.</p>
    <div class="modal-actions"><button class="primary" onclick="closeModal()">Fechar</button></div></div>`);
}

function mensalEquiv(r) {
  const v = Math.abs(r.valor);
  switch ((r.frequencia || '').toLowerCase()) {
    case 'quinzenal': return v * 2;
    case 'semanal': return v * 4;
    case 'anual': return v / 12;
    default: return v; // mensal
  }
}
function quandoRec(r) {
  switch ((r.frequencia || '').toLowerCase()) {
    case 'mensal': return `dia ${r.dia_mes ?? '?'}`;
    case 'semanal': return r.dia_semana || 'semanal';
    case 'quinzenal': return 'a cada 14d';
    case 'anual': return 'anual';
    default: return r.frequencia;
  }
}
const fmtPeriodo = (ini, fim) => `${ini ? fmtData(ini) + '/' + ini.slice(2, 4) : '—'} → ${fim ? fmtData(fim) + '/' + fim.slice(2, 4) : '—'}`;

async function modalRecorrentes(livroFixo) {
  if (livroFixo) { recFiltroLivro = livroFixo; recFiltroCC = null; }
  const lv = recFiltroLivro || 'empresa';
  const recs = await api('api/recorrencias?livro=' + lv);
  window.__recs = recs;
  const centros = ordenaCC([...new Set(recs.map((r) => r.centro_custo))]);
  window.__recCentros = centros;
  const lista = recFiltroCC ? recs.filter((r) => r.centro_custo === recFiltroCC) : recs;
  const ativos = lista.filter((r) => r.ativo);
  const totMes = ativos.reduce((a, r) => a + (ehReceitaCC(r.centro_custo) ? 0 : mensalEquiv(r)), 0);
  const totRecMes = ativos.reduce((a, r) => a + (ehReceitaCC(r.centro_custo) ? mensalEquiv(r) : 0), 0);
  const chips = `<button class="ccchip ${!recFiltroCC ? 'active' : ''}" onclick="filtrarRecCC(-1)">Todos (${recs.length})</button>` +
    centros.map((c, i) => {
      const n = recs.filter((r) => r.centro_custo === c).length;
      return `<button class="ccchip ${recFiltroCC === c ? 'active' : ''}" onclick="filtrarRecCC(${i})">${capCC(c)} (${n})</button>`;
    }).join('');
  const linhas = lista.map((r) => `<tr class="rec-row ${r.ativo ? '' : 'inativa'}" onclick="editRec(${r.id})" title="Clique p/ editar">
      <td>${r.descricao}</td>
      <td>${capCC(r.centro_custo)}</td>
      <td>${r.frequencia}</td>
      <td style="text-align:center">${quandoRec(r)}</td>
      <td class="money ${ehReceitaCC(r.centro_custo) ? 'pos' : 'neg'}">${BRL(ehReceitaCC(r.centro_custo) ? Math.abs(r.valor) : -Math.abs(r.valor))}</td>
      <td class="money">${BRL(mensalEquiv(r))}</td>
      <td style="font-size:11px;color:var(--ink-dim)">${fmtPeriodo(r.inicio, r.fim)}</td>
      <td style="text-align:center">${r.ativo ? '<span class="badge on">ativo</span>' : '<span class="badge off">inativo</span>'}</td>
    </tr>`).join('');
  const titulo = lv === 'dutra' ? '🔁 Recorrentes Dutra <small style="color:var(--gold)">· despesas pessoais</small>' : '🔁 Recorrentes';
  openModal(`<div class="modal-wide"><h2>${titulo} <small style="color:var(--ink-dim);font-weight:400">(${ativos.length} ativos)</small></h2>
    <div class="ccfilter">${chips}</div>
    <div class="reclegend">
      <span>Despesa recorrente / mês${recFiltroCC ? ' (filtro)' : ''}: <b class="money neg">${BRL(-totMes)}</b></span>
      ${totRecMes ? `<span>Receita recorrente / mês: <b class="money pos">${BRL(totRecMes)}</b></span>` : ''}
      <span class="spacer" style="flex:1"></span>
      <button class="ghost" onclick="reaplicarRecs()" title="Regenera os recorrentes pra frente (preenche meses novos, ex.: 2027)">↻ Gerar à frente</button>
      <button class="primary" onclick="editRec(0)">+ Novo</button>
    </div>
    <div style="max-height:46vh;overflow:auto">
    <table><thead><tr><th>Descrição</th><th>Centro de custo</th><th>Frequência</th><th>Quando</th><th>Valor</th><th>Equiv./mês</th><th>Período</th><th>Ativo</th></tr></thead>
      <tbody>${linhas}</tbody></table></div>
    <p style="color:var(--ink-dim);font-size:12px;margin-top:10px">Editar aqui <b>atualiza só o que está pra frente</b> (de hoje em diante), sem mexer no que já é <b>real</b> nem no que você <b>remanejou</b> na grade. As ocorrências aparecem com o prefixo <b>[R]</b>.</p>
    <div class="modal-actions"><button class="primary" onclick="closeModal()">Fechar</button></div></div>`);
}

window.editRec = (id) => {
  const r = id ? (window.__recs || []).find((x) => x.id === id) : null;
  const ed = !!r;
  const ccSel = (v) => ordenaCC(META.centros_custo.map((c) => c.nome)).map((n) => `<option value="${n}" ${n === v ? 'selected' : ''}>${capCC(n)}</option>`).join('');
  const freq = (f) => ['mensal', 'semanal', 'quinzenal', 'anual'].map((x) => `<option value="${x}" ${ed && r.frequencia === x ? 'selected' : (!ed && x === 'mensal' ? 'selected' : '')}>${x}</option>`).join('');
  const ds = (v) => ['segunda', 'terça', 'quarta', 'quinta', 'sexta'].map((x) => `<option value="${x}" ${v === x ? 'selected' : ''}>${x}</option>`).join('');
  const livroAtual = ed ? (r.livro || 'empresa') : (recFiltroLivro || 'empresa');
  openModal(`<h2>${ed ? 'Editar' : 'Novo'} recorrente</h2>
    <div class="field"><label>Caixa</label><select id="r_livro" ${ed ? 'disabled' : ''}>
      <option value="empresa" ${livroAtual === 'dutra' ? '' : 'selected'}>🏢 Empresa</option>
      <option value="dutra" ${livroAtual === 'dutra' ? 'selected' : ''}>👤 Dutra (pessoal)</option></select></div>
    <div class="field"><label>Descrição</label><input id="r_desc" value="${ed ? r.descricao.replace(/"/g, '&quot;') : ''}" placeholder="Ex.: Aluguel Escritório SP"></div>
    <div class="field"><label>Centro de custo</label><select id="r_cc">${ccSel(ed ? r.centro_custo : '')}</select></div>
    <div class="row">
      <div class="field"><label>Valor (R$)</label><input id="r_valor" type="number" step="0.01" value="${ed ? Math.abs(r.valor) : ''}"></div>
      <div class="field"><label>Frequência</label><select id="r_freq" onchange="recFreqUI()">${freq()}</select></div>
    </div>
    <div class="row">
      <div class="field" id="r_diames_wrap"><label>Dia do mês (1-31)</label><input id="r_diames" type="number" min="1" max="31" value="${ed ? (r.dia_mes ?? '') : ''}"></div>
      <div class="field" id="r_diasem_wrap"><label>Dia da semana</label><select id="r_diasem"><option value="">—</option>${ds(ed ? r.dia_semana : '')}</select></div>
    </div>
    <div class="row">
      <div class="field"><label>Início</label><input id="r_inicio" type="date" value="${ed && r.inicio ? r.inicio : '2026-01-01'}"></div>
      <div class="field"><label>Fim</label><input id="r_fim" type="date" value="${ed && r.fim ? r.fim : '2026-12-31'}"></div>
    </div>
    <div class="field"><label><input type="checkbox" id="r_ativo" ${!ed || r.ativo ? 'checked' : ''} style="width:auto;margin-right:6px">Ativo</label></div>
    <div class="modal-actions">
      ${ed ? `<button class="warn" onclick="delRec(${r.id})">Excluir</button>` : ''}
      <button class="ghost" onclick="modalRecorrentes()">Voltar</button>
      <button class="primary" onclick="saveRec(${ed ? r.id : 'null'})">Salvar e aplicar</button>
    </div>`);
  recFreqUI();
};
window.recFreqUI = () => {
  const f = $('#r_freq').value;
  $('#r_diames_wrap').style.display = f === 'mensal' ? '' : 'none';
  $('#r_diasem_wrap').style.display = f === 'semanal' ? '' : 'none';
};
window.saveRec = async (id) => {
  const body = {
    descricao: $('#r_desc').value.trim(), centro_custo: $('#r_cc').value,
    valor: parseFloat($('#r_valor').value || '0'), frequencia: $('#r_freq').value,
    dia_mes: $('#r_freq').value === 'mensal' ? parseInt($('#r_diames').value || '0') || null : null,
    dia_semana: $('#r_freq').value === 'semanal' ? ($('#r_diasem').value || null) : null,
    inicio: $('#r_inicio').value || null, fim: $('#r_fim').value || null, ativo: $('#r_ativo').checked,
    livro: $('#r_livro').value,
  };
  if (!body.descricao) return alert('Informe a descrição');
  await api(lq(id ? `api/recorrencias/${id}` : 'api/recorrencias'), {
    method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  await render(); modalRecorrentes();
};
window.delRec = async (id) => {
  if (!confirm('Excluir este recorrente? As ocorrências futuras (não confirmadas) saem da grade.')) return;
  await fetch(lq(`api/recorrencias/${id}`), { method: 'DELETE' });
  await render(); modalRecorrentes();
};
window.reaplicarRecs = async () => {
  const url = recFiltroLivro ? 'api/recorrencias/reaplicar?livro=' + recFiltroLivro : 'api/recorrencias/reaplicar';
  await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await render(); modalRecorrentes();
};
const ehReceitaCC = (cc) => String(cc || '').toLowerCase().includes('receita');
window.modalRecorrentes = modalRecorrentes;

// ---------- MAPA DE PENDÊNCIAS ----------
async function modalPendencias(livroFixo) {
  if (livroFixo) { pendLivro = livroFixo; pendFiltroCat = null; }
  const lv = pendLivro;
  const [lista, cons] = await Promise.all([
    api('api/pendencias?livro=' + lv), api('api/pendencias/consolidado?livro=' + lv),
  ]);
  window.__pends = lista;
  const catOf = (p) => p.categoria || '(sem categoria)';
  const cats = [...new Set(lista.map(catOf))].sort((a, b) => a.localeCompare(b, 'pt'));
  window.__pendCats = cats;
  const filtrada = pendFiltroCat ? lista.filter((p) => catOf(p) === pendFiltroCat) : lista;
  const chips = `<button class="ccchip ${!pendFiltroCat ? 'active' : ''}" onclick="filtrarPendCat(-1)">Todas (${lista.length})</button>` +
    cats.map((c, i) => `<button class="ccchip ${pendFiltroCat === c ? 'active' : ''}" onclick="filtrarPendCat(${i})">${c} (${lista.filter((p) => catOf(p) === c).length})</button>`).join('');
  const lancada = (p) => p.ativo && p.data;
  const linhas = filtrada.map((p) => `<tr class="rec-row ${p.ativo ? '' : 'inativa'}" onclick="editPend(${p.id})" title="Clique p/ editar">
      <td>${p.descricao}</td>
      <td>${p.categoria || '<span style="color:var(--ink-dim)">—</span>'}</td>
      <td class="money neg">${BRL(-Math.abs(p.valor))}</td>
      <td style="text-align:center">${p.data ? fmtData(p.data) : '<span style="color:var(--ink-dim)">—</span>'}</td>
      <td style="text-align:center">${lancada(p)
        ? `<span class="badge on" style="cursor:pointer" title="Clique para virar flutuante (tira do calendário)" onclick="togglePendFlutua(${p.id},1,event)">lançada</span>`
        : `<span class="badge off" style="cursor:pointer" title="Clique para agendar uma data" onclick="togglePendFlutua(${p.id},0,event)">pendente</span>`}</td>
    </tr>`).join('');
  const consLinhas = cons.categorias.map((c) => `<tr><td>${c.categoria}</td><td style="text-align:center">${c.n}</td><td class="money neg">${BRL(-c.total)}</td></tr>`).join('')
    || '<tr><td colspan="3" style="color:var(--ink-dim)">nada pendente</td></tr>';
  const titulo = lv === 'dutra' ? '👤 Mapa Pendências Dutra' : '🧭 Mapa de Pendências';
  const centro = lv === 'dutra' ? 'Retirada Dutra' : 'amortizações';
  openModal(`<div class="modal-wide"><h2>${titulo}</h2>
    <div class="reclegend">
      <span>🔸 Pendente (não lançado): <b class="money neg">${BRL(-cons.total_pendente)}</b></span>
      <span>✅ Já no calendário: <b class="money neg">${BRL(-cons.total_lancado)}</b></span>
      <span class="spacer" style="flex:1"></span>
      <button class="primary" onclick="editPend(0)">+ Nova pendência</button>
    </div>
    <h3 style="font-size:13px;color:var(--gold);margin:4px 0 6px">Consolidado pendente (por categoria)</h3>
    <table><thead><tr><th>Categoria</th><th>Qtd</th><th>Total</th></tr></thead><tbody>${consLinhas}
      <tr class="tot"><td>TOTAL pendente</td><td></td><td class="money neg">${BRL(-cons.total_pendente)}</td></tr></tbody></table>
    <h3 style="font-size:13px;color:var(--ink-dim);margin:16px 0 6px">Pendências (clique p/ editar)</h3>
    <div class="ccfilter">${chips}</div>
    <div style="max-height:36vh;overflow:auto">
    <table><thead><tr><th>Descrição</th><th>Categoria</th><th>Valor</th><th>Data</th><th>Status</th></tr></thead>
      <tbody>${linhas || '<tr><td colspan="5" style="color:var(--ink-dim)">nenhuma pendência ainda</td></tr>'}</tbody></table></div>
    <p style="color:var(--ink-dim);font-size:12px;margin-top:10px">Marque <b>Ativa</b> e ponha uma <b>data</b> pra a pendência virar lançamento no calendário (centro <b>${centro}</b>). Sem data ou inativa, fica só no consolidado acima.</p>
    <div class="modal-actions"><button class="primary" onclick="closeModal()">Fechar</button></div></div>`);
}
window.modalPendencias = modalPendencias;
// clica no status: "lançada" → tira a data (vira flutuante); "pendente" → pede data pra agendar
window.togglePendFlutua = async (id, lancada, ev) => {
  if (ev) ev.stopPropagation();                                 // não abre o editor da linha
  try {
    if (lancada) {
      await api(lq(`api/pendencias/${id}`), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: null }) });
    } else {
      const d = prompt('Data para agendar no calendário (AAAA-MM-DD):', hojeISO());
      if (!d) return;
      if (!/^\d{4}-\d\d-\d\d$/.test(d.trim())) return alert('Data inválida. Use AAAA-MM-DD.');
      await api(lq(`api/pendencias/${id}`), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: d.trim(), ativo: 1 }) });
    }
    await modalPendencias();  // re-renderiza o mapa
    render();                 // e o calendário (a pendência entrou/saiu do caixa)
  } catch (e) { alert('Erro: ' + e.message); }
};

// Fechamento de mês: repasse + encargos adm em aberto (orçado) viram amortização consolidada.
async function modalFecharMes(mes) {
  mes = mes || refDate.slice(0, 7);
  const r = await api(`api/fechamento/preview?mes=${mes}`);
  const itens = r.itens || [];
  const linhas = itens.map((l) => `<tr><td>${l.data.slice(8)}/${l.data.slice(5, 7)}</td><td>${l.nome}</td><td>${l.centro_custo}</td><td class="money neg">${BRL(l.valor)}</td></tr>`).join('')
    || '<tr><td colspan="4" style="color:var(--ink-dim)">nada em aberto neste mês ✓</td></tr>';
  const [yy, mm] = mes.split('-');
  openModal(`<div class="modal-wide"><h2>🔒 Fechar mês</h2>
    <div class="field" style="max-width:200px"><label>Mês a fechar</label><input id="fm_mes" type="month" value="${mes}" onchange="modalFecharMes(this.value)"></div>
    <p style="color:var(--ink-dim);font-size:12px;margin:8px 0">Repasse e encargos adm <b>em aberto</b> (ainda orçado, não pagos) de <b>${MESNOME[+mm - 1]}/${yy}</b> serão <b>removidos</b> e somados numa <b>amortização</b> (centro <b>amortizações</b>), datada no 1º dia útil do mês seguinte.</p>
    <div style="max-height:40vh;overflow:auto"><table><thead><tr><th>Data</th><th>Descrição</th><th>Centro</th><th>Valor</th></tr></thead>
      <tbody>${linhas}</tbody>
      ${itens.length ? `<tfoot><tr class="tot"><td colspan="3">Total em aberto → amortização</td><td class="money neg">${BRL(r.total)}</td></tr></tfoot>` : ''}</table></div>
    ${r.ja_fechado ? '<p style="color:var(--gold);font-size:12px;margin-top:8px">⚠️ Este mês já foi fechado (a amortização já existe).</p>' : ''}
    <div class="modal-actions">
      <button class="ghost" onclick="closeModal()">Cancelar</button>
      <button class="primary" ${(!itens.length || r.ja_fechado) ? 'disabled' : ''} onclick="confirmarFecharMes('${mes}')">Confirmar fechamento</button>
    </div></div>`);
}
window.modalFecharMes = modalFecharMes;
window.confirmarFecharMes = async (mes) => {
  const r = await api('api/fechamento', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mes, livro: 'empresa' }) });
  if (r.erro) return alert('Erro: ' + r.erro);
  closeModal(); await render();
  alert(`Mês ${mes} fechado: ${r.removidos} item(ns) em aberto viraram amortização de ${BRL(r.total)}.`);
};
window.filtrarPendCat = (i) => { pendFiltroCat = i < 0 ? null : (window.__pendCats || [])[i]; modalPendencias(); };

window.editPend = (id) => {
  const p = id ? (window.__pends || []).find((x) => x.id === id) : null;
  const ed = !!p;
  const catList = (window.__pendCats || []).filter((c) => c !== '(sem categoria)');
  openModal(`<h2>${ed ? 'Editar' : 'Nova'} pendência <small style="color:var(--ink-dim);font-weight:400">(${pendLivro === 'dutra' ? 'Dutra' : 'Empresa'})</small></h2>
    <div class="field"><label>Descrição</label><input id="p_desc" value="${ed ? p.descricao.replace(/"/g, '&quot;') : ''}" placeholder="Ex.: Parcela acordo Itaú"></div>
    <div class="row">
      <div class="field"><label>Categoria</label><input id="p_cat" list="p_catlist" value="${ed && p.categoria ? p.categoria.replace(/"/g, '&quot;') : ''}" placeholder="Ex.: Bancos / Fornecedores">
        <datalist id="p_catlist">${catList.map((c) => `<option value="${c}">`).join('')}</datalist></div>
      <div class="field"><label>Valor (R$)</label><input id="p_valor" type="number" step="0.01" value="${ed ? Math.abs(p.valor) : ''}"></div>
    </div>
    <div class="row">
      <div class="field"><label>Data (vazio = não agendada)</label><input id="p_data" type="date" value="${ed && p.data ? p.data : ''}"></div>
      <div class="field" style="justify-content:flex-end"><label><input type="checkbox" id="p_ativo" ${!ed || p.ativo ? 'checked' : ''} style="width:auto;margin-right:6px">Ativa</label></div>
    </div>
    <div class="modal-actions">
      ${ed ? `<button class="warn" onclick="delPend(${p.id})">Excluir</button>` : ''}
      <button class="ghost" onclick="modalPendencias()">Voltar</button>
      <button class="primary" onclick="savePend(${ed ? p.id : 'null'})">Salvar</button>
    </div>`);
};
window.savePend = async (id) => {
  const body = {
    descricao: $('#p_desc').value.trim(), categoria: $('#p_cat').value.trim() || null,
    valor: parseFloat($('#p_valor').value || '0'), data: $('#p_data').value || null,
    ativo: $('#p_ativo').checked, livro: pendLivro,
  };
  if (!body.descricao) return alert('Informe a descrição');
  await api(id ? `api/pendencias/${id}` : 'api/pendencias', {
    method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  await render(); modalPendencias();
};
window.delPend = async (id) => {
  if (!confirm('Excluir esta pendência? (se estiver lançada, sai do calendário)')) return;
  await fetch(`api/pendencias/${id}?livro=${pendLivro}`, { method: 'DELETE' });
  await render(); modalPendencias();
};
window.filtrarRecCC = (i) => { recFiltroCC = i < 0 ? null : (window.__recCentros || [])[i]; modalRecorrentes(); };
window.filtrarRecLivro = (lv) => { recFiltroLivro = lv || null; recFiltroCC = null; modalRecorrentes(); };

boot();
