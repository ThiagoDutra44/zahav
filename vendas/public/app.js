const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = async (url, opts) => {
  const r = await fetch(url, opts && { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || r.statusText);
  return r.json();
};
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const fmt = (n) => (n < 0 ? '-' : '') + 'R$ ' + Math.abs(Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// padrão único de moeda: R$ 19.512,33 (R$, milhar com ponto, 2 casas decimais), sem abreviar
const fmtMM = (n) => fmt(n);

const esc = (s) => String(s == null ? '' : s).replace(/"/g, '&quot;');
// data LOCAL em ISO (nunca toISOString: em UTC-3 o dia "virava" às 21h)
const dLocal = (d = new Date()) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
// aceita "R$ 4.150.520,00" (formatado) e "4150520" (inteiro cru, durante a edição) -> número
const parseMoneyStr = (s) => {
  let t = String(s).replace(/[^\d.,-]/g, '');
  t = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/\./g, '');
  const n = Number(t); return isNaN(n) ? 0 : n;
};
const state = { meta: null, ano: new Date().getFullYear(), tab: 'funil', segmento: 'venda', soQuentes: true };
const sq = () => 'segmento=' + state.segmento; // sufixo de query p/ separar venda x locacao

// (re)carrega listas de apoio do segmento atual e reconstrói o seletor de ano
async function carregarMeta() {
  state.meta = await api('api/meta?' + sq());
  const sel = $('#anoSel');
  const anos = [...new Set([...(state.meta.anos || []), state.ano, state.ano + 1])].sort((a, b) => b - a);
  state.ano = anos.includes(state.ano) ? state.ano : anos[0];
  sel.innerHTML = anos.map((a) => `<option ${a === state.ano ? 'selected' : ''}>${a}</option>`).join('');
}
function atualizarTitulo() {
  const loc = state.segmento === 'locacao';
  document.body.classList.toggle('loc', loc);
  $('#tituloSeg').textContent = loc ? 'Locações' : 'Vendas';
  $('#btnAdd').textContent = loc ? '+ Nova locação' : '+ Nova venda';
  { const fab = $('#fabAdd'); if (fab) fab.title = loc ? 'Nova locação' : 'Nova venda'; }
}

async function boot() {
  await carregarMeta();
  $('#anoSel').onchange = (e) => { state.ano = +e.target.value; render(); };

  $$('#segsw button').forEach((b) => b.onclick = async () => {
    if (state.segmento === b.dataset.seg) return;
    state.segmento = b.dataset.seg;
    $$('#segsw button').forEach((x) => x.classList.toggle('active', x === b));
    await carregarMeta();
    atualizarTitulo();
    render();
  });
  $$('#tabs button').forEach((b) => b.onclick = () => {
    state.tab = b.dataset.tab;
    $$('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
    render();
  });
  $('#btnAdd').onclick = () => modalVenda();
  $('#fabAdd').onclick = () => modalVenda();
  // modo privacidade: escurece/borra a tela e um holofote (~5 linhas) revela onde o mouse está
  { let privOn = false; const film = $('#privacyFilm');
    $('#btnPriv').onclick = () => { privOn = !privOn; document.documentElement.classList.toggle('privacy', privOn); $('#btnPriv').classList.toggle('on', privOn); };
    window.addEventListener('mousemove', (e) => { if (!privOn) return; film.style.setProperty('--mx', e.clientX + 'px'); film.style.setProperty('--my', e.clientY + 'px'); }, { passive: true }); }
  $('#btnCadastros').onclick = () => modalCadastros();
  $('#btnMetas').onclick = () => modalMetas();
  $('#btnDesist').onclick = () => modalDesistencias();
  $('#btnPonte').onclick = () => modalPonte();
  atualizarTitulo();
  render();
}

// ============ MODAL: PONTE COM FLUXO DE CAIXA ============
async function modalPonte() {
  const s = await api('api/ponte/status');
  openModal(`
    <h2>🔗 Ponte com o Fluxo de Caixa</h2>
    <div class="hint" style="margin-bottom:14px">${s.ativa
      ? 'Ligada e <b>automática</b>: cada venda/locação reflete no fluxo-caixa na hora.'
      : 'Desligada — o banco do fluxo-caixa não foi encontrado.'}</div>
    ${s.ativa ? `
      <div class="field"><label>Lançamentos espelhados no caixa agora</label><input disabled value="${s.lancamentos}"></div>
      <div class="hint">Previsão (firme + quentes habilitados) entra como <b>previsto</b>; ao marcar recebido vira <b>real</b>; o repasse de corretores espelha entrada e saída no caixa.</div>
      <div class="modal-actions">
        <button class="danger" id="p_limpar">Desconectar</button>
        <button class="ghost" id="p_close">Fechar</button>
        <button class="primary" id="p_sync">Sincronizar tudo</button>
      </div>` : `<div class="modal-actions"><button class="ghost" id="p_close">Fechar</button></div>`}
  `);
  $('#p_close').onclick = closeModal;
  if (s.ativa) {
    $('#p_sync').onclick = async () => { const r = await api('api/ponte/sincronizar', { method: 'POST' }); alert(`Sincronizado: ${r.lancamentos} lançamentos no fluxo-caixa.`); modalPonte(); };
    $('#p_limpar').onclick = async () => { if (!confirm('Remover TODOS os lançamentos de vendas/locações do fluxo-caixa? (reversível: é só sincronizar de novo)')) return; const r = await api('api/ponte/limpar', { method: 'DELETE' }); alert(`Removidos ${r.removidos} lançamentos do fluxo-caixa.`); modalPonte(); };
  }
}

// troca rótulos no contexto de Locação, só em nós de texto (não toca em inputs/atributos)
const REPL_LOC = [[/VGV/g, 'VGL'], [/Margem/g, 'Comissão'], [/venda\(s\)/g, 'locação(ões)'],
  [/Vendas assinadas/g, 'Locações assinadas'], [/vendas assinadas/g, 'locações assinadas']];
function relabelLoc(root) {
  if (!root || state.segmento !== 'locacao') return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    let t = n.nodeValue, o = t;
    for (const [re, to] of REPL_LOC) t = t.replace(re, to);
    if (t !== o) n.nodeValue = t;
  }
}

async function render() {
  $('#anoTitulo').textContent = state.ano;
  atualizarFatAno();
  if (state.tab === 'dashboard') await renderDashboard();
  else if (state.tab === 'funil') await renderFunil();
  else if (state.tab === 'ranking') await renderRanking();
  else if (state.tab === 'recebiveis') await renderRecebiveis();
  relabelLoc($('#view')); relabelLoc($('#cards'));
}
// consolidado do ano na barra do topo: faturamento REAL do ano (tudo já faturado, todos os segmentos)
async function atualizarFatAno() {
  const el = $('#fatAno'); if (!el) return;
  try { const r = await api('api/faturamento-mes?ano=' + state.ano); el.innerHTML = `<span class="fa-lbl">Faturado ${state.ano}</span><b>${fmt(r.total || 0)}</b>`; }
  catch { el.innerHTML = ''; }
}

// ============ DASHBOARD (reproduz a aba DASHBOARD 2026) ============
const fmtK = (n) => (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); // número cheio com centavos, sem "R$"
const kpi = (emoji, lbl, val, cls = '') => `<div class="kc ${cls}">
  <div class="kc-l">${emoji} ${lbl}</div><div class="kc-v">${val}</div></div>`;
// faixa de meses à frente, ex.: ['Setembro','Outubro','Novembro','Dezembro'] -> "Set–Dez"
const frenteLabel = (meses) => !meses || !meses.length ? '' : meses.length === 1 ? meses[0].slice(0, 3) : `${meses[0].slice(0, 3)}–${meses[meses.length - 1].slice(0, 3)}`;

const CORES = ['#D4AF37', '#3b6fe0', '#34d399', '#f87171', '#a78bfa', '#fbbf24', '#60a5fa', '#fb923c', '#f472b6'];

// gráfico "cebola" (rosca/donut) em SVG puro + legenda com valores
function donut(items, centroLabel, centroVal) {
  const total = items.reduce((a, i) => a + i.value, 0) || 1;
  const cx = 90, cy = 90, r = 64, sw = 24, circ = 2 * Math.PI * r;
  let off = 0;
  const segs = items.map((it, i) => {
    const len = it.value / total * circ;
    const s = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${CORES[i % CORES.length]}"
      stroke-width="${sw}" stroke-dasharray="${len} ${circ - len}" stroke-dashoffset="${-off}"
      transform="rotate(-90 ${cx} ${cy})"><title>${it.label}: ${fmt(it.value)}</title></circle>`;
    off += len; return s;
  }).join('');
  const legenda = items.map((it, i) => `<div class="lg-row">
    <span class="lg-dot" style="background:${CORES[i % CORES.length]}"></span>
    <span class="lg-nm">${it.label}</span>
    <span class="lg-vl">${fmt(it.value)}</span>
    <span class="lg-pct">${(it.value / total * 100).toFixed(1)}%</span></div>`).join('');
  return `<div class="donut-wrap">
    <svg viewBox="0 0 180 180" class="donut">${segs || `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#1b2540" stroke-width="${sw}"/>`}
      <text x="${cx}" y="${cy - 6}" text-anchor="middle" class="donut-cl">${centroLabel}</text>
      <text x="${cx}" y="${cy + 16}" text-anchor="middle" class="donut-cv">${centroVal}</text></svg>
    <div class="legend">${legenda}</div></div>`;
}

// gráfico de linha: evolução de VGV e faturamento ao longo dos meses (eixos independentes)
function evolucao(meses) {
  const W = 720, H = 170, padX = 36, padTop = 14, padBot = 24;
  const vgv = meses.map((m) => m.vgv), fat = meses.map((m) => m.fat);
  const maxV = Math.max(1, ...vgv), maxF = Math.max(1, ...fat);
  const x = (i) => padX + i * (W - 2 * padX) / 11;
  const yV = (v) => H - padBot - v / maxV * (H - padTop - padBot);
  const yF = (v) => H - padBot - v / maxF * (H - padTop - padBot);
  const ptsV = vgv.map((v, i) => `${x(i)},${yV(v)}`).join(' ');
  const ptsF = fat.map((v, i) => `${x(i)},${yF(v)}`).join(' ');
  const area = `${x(0)},${H - padBot} ${ptsV} ${x(11)},${H - padBot}`;
  const grid = [0.25, 0.5, 0.75, 1].map((g) => `<line x1="${padX}" x2="${W - padX + 8}" y1="${H - padBot - g * (H - padTop - padBot)}" y2="${H - padBot - g * (H - padTop - padBot)}" class="lc-grid"/>`).join('');
  const dots = vgv.map((v, i) => v ? `<circle cx="${x(i)}" cy="${yV(v)}" r="3.5" class="lc-dotv"><title>${meses[i].nome}: ${fmt(v)} · ${meses[i].qtd} venda(s)</title></circle>` : '').join('');
  const dotsF = fat.map((v, i) => v ? `<circle cx="${x(i)}" cy="${yF(v)}" r="2.5" class="lc-dotf"/>` : '').join('');
  const labels = meses.map((m, i) => `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="lc-x">${m.nome.slice(0, 3)}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="linechart" preserveAspectRatio="xMidYMid meet">
    ${grid}<polygon points="${area}" class="lc-area"/>
    <polyline points="${ptsV}" class="lc-line-v"/><polyline points="${ptsF}" class="lc-line-f"/>
    ${dots}${dotsF}${labels}</svg>`;
}

async function renderDashboard() {
  const d = await api(`api/dashboard?ano=${state.ano}&${sq()}`);
  const faltaVgv = Math.max(0, d.meta_vgv - d.realizado.vgv);
  const faltaFat = Math.max(0, d.meta_fat - d.realizado.fat);

  $('#cards').innerHTML = `
    <div class="card gold"><div class="lbl">🎯 Meta VGV ${d.ano}</div><div class="val">${fmtMM(d.meta_vgv)}</div><div class="sub">${d.pct_meta_vgv}% atingido</div></div>
    <div class="card gold"><div class="lbl">🎯 Meta Faturamento ${d.ano}</div><div class="val">${fmtMM(d.consol.meta_fat)}</div><div class="sub">${d.consol.pct_meta_fat}% atingido</div></div>
    <div class="card"><div class="lbl">📅 Ano decorrido</div><div class="val">${d.decorrido.pct_ano}%</div><div class="sub">${d.decorrido.dias} de 365 dias</div></div>
    <div class="card pos"><div class="lbl">🔒 Vendas fechadas</div><div class="val">${d.realizado.qtd}</div><div class="sub">+${d.pipeline.qtd} no funil</div></div>`;

  const maxMes = Math.max(1, ...d.por_mes.map((m) => m.vgv));
  const maxFil = Math.max(1, ...d.por_filial.map((f) => f.vgv));
  const maxFunil = Math.max(1, ...d.funil.map((f) => f.qtd));

  $('#view').innerHTML = `
    <div class="kpi-grid">
      ${kpi('💰', 'VGV Total', 'R$ ' + fmtK(d.realizado.vgv), 'gold')}
      ${kpi('📈', 'Faturamento atual', 'R$ ' + fmtK(d.consol.fat), 'pos')}
      ${kpi('💵', 'Fat médio mensal', 'R$ ' + fmtK(d.fat_medio_mensal))}
      ${kpi('📅', 'Fat médio/dia', fmt(d.fat_medio_dia))}
      ${kpi('📆', 'VGV/mês (média)', 'R$ ' + fmtK(d.vgv_medio_mensal))}
      ${kpi('📅', 'VGV/dia', 'R$ ' + fmtK(d.vgv_medio_dia))}
      ${kpi('⏱️', 'Cadência · ano', d.cadencia.ano.qtd ? '1 venda / ' + d.cadencia.ano.por_venda + ' dias' : '—', 'pos')}
      ${kpi('⏱️', 'Cadência · últ. 3 meses', d.cadencia.tri.qtd ? '1 venda / ' + d.cadencia.tri.por_venda + ' dias' : '—', 'pos')}
      ${kpi('📊', 'VGV atual × projetado', 'R$ ' + fmtK(d.realizado.vgv) + ' / ' + fmtK(d.projecao_vgv))}
      ${kpi('🎯', 'Ticket médio VGV', 'R$ ' + fmtK(d.ticket_medio))}
      ${kpi('🎯', 'Ticket mediano VGV', 'R$ ' + fmtK(d.ticket_mediano))}
      ${kpi('💵', 'Fat médio/venda', fmt(d.fat_medio_venda))}
      ${kpi('💵', 'Fat mediano/venda', fmt(d.fat_mediano_venda))}
      ${kpi('🎯', '% Meta VGV', d.pct_meta_vgv + '%')}
      ${kpi('🎯', '% Meta faturamento', d.consol.pct_meta_fat + '%')}
      ${kpi('🛒', 'VGV/mês p/ meta VGV', 'R$ ' + fmtK(d.necessario.vgv_mes))}
      ${kpi('🛒', 'VGV/mês p/ meta Fat', 'R$ ' + fmtK(d.consol.vgv_p_fat_mes))}
      ${kpi('📊', '% Margem (fat/VGV)', d.margem_media + '%')}
      ${kpi('📈', 'Fat atual × projetado', 'R$ ' + fmtK(d.consol.fat) + ' / ' + fmtK(d.consol.projecao_fat))}
      ${d.consol.meses_rest_cal > 0 ? kpi('🎯', (d.consol.mes_atual_nome || 'Mês') + ' — tem / falta', 'R$ ' + fmtK(d.consol.mes_ja) + ' / ' + fmtK(d.consol.mes_falta), 'gold') : ''}
      ${d.consol.frente_n > 0 ? kpi('🎯', frenteLabel(d.consol.frente_meses) + ' /mês', 'R$ ' + fmtK(d.consol.alvo_mes) + (d.consol.frente_n > 1 ? ` × ${d.consol.frente_n}` : ''), 'gold') : ''}
    </div>

    <div class="two-col">
      <div class="panel"><h3>🎯 Metas & ritmo necessário</h3>
        <div class="goal">
          <div class="goal-top"><span>VGV — ${fmtMM(d.realizado.vgv)} de ${fmtMM(d.meta_vgv)}</span><b>${d.pct_meta_vgv}%</b></div>
          <div class="bar"><i style="width:${Math.min(100, d.pct_meta_vgv)}%"></i></div>
          <div class="goal-need"><span>📆 VGV/mês necessário</span><b>${fmtMM(d.necessario.vgv_mes)}</b></div>
          <div class="goal-need dim"><span>📅 VGV/dia necessário</span><b>${fmt(d.necessario.vgv_dia)}</b></div>
        </div>
        <div class="goal" style="margin-top:14px">
          <div class="goal-top"><span>Faturamento <span class="dim">(consolidado)</span> — ${fmtMM(d.consol.fat)} de ${fmtMM(d.consol.meta_fat)}</span><b>${d.consol.pct_meta_fat}%</b></div>
          <div class="bar"><i class="green" style="width:${Math.min(100, d.consol.pct_meta_fat)}%"></i></div>
          <div class="goal-need"><span>📆 Fat/mês necessário</span><b>${fmtMM(d.consol.fat_mes)}</b></div>
          <div class="goal-need dim"><span>📅 Fat/dia necessário</span><b>${fmt(d.consol.fat_dia)}</b></div>
          <div class="goal-need" title="Quanto de VGV vender no mês para, à sua margem carregada de ${d.consol.margem_carregada}%, fechar a meta de faturamento"><span>🛒 VGV/mês p/ meta fat. <span class="dim">(margem ${d.consol.margem_carregada}%)</span></span><b>${fmtMM(d.consol.vgv_p_fat_mes)}</b></div>
        </div>
      </div>
      <div class="panel"><h3>📋 Funil do ano</h3>
        <div class="funnel">${d.funil.map((f) => `
          <div class="fstep"><div class="fl"><span class="chip st-${f.status}">${f.status}</span></div>
            <div class="fbar"><i style="width:${f.qtd / maxFunil * 100}%"></i><b>${f.qtd} · ${fmtMM(f.vgv)}</b></div></div>`).join('')}</div>
        <div class="pipe-note">Pipeline em aberto: <b>${fmtMM(d.pipeline.vgv)}</b> · faturamento potencial ${fmtMM(d.pipeline.fat)}</div>
      </div>
    </div>

    <div class="two-col">
      <div class="panel"><h3>🧅 VGV por filial</h3>
        ${d.por_filial.length ? donut(d.por_filial.map((f) => ({ label: f.nome, value: f.vgv })), 'VGV total', fmt(d.realizado.vgv)) : '<div class="empty">Sem vendas assinadas.</div>'}</div>
      <div class="panel"><h3>🧅 Faturamento por filial</h3>
        ${d.por_filial.length ? donut(d.por_filial.map((f) => ({ label: f.nome, value: f.fat })), 'Fat. total', fmt(d.realizado.fat)) : '<div class="empty">Sem vendas assinadas.</div>'}</div>
    </div>

    <div class="two-col">
      <div class="panel"><h3>📈 Evolução de vendas no ano</h3>
        <div class="lc-legend"><span><i class="lk-v"></i> VGV</span><span><i class="lk-f"></i> Faturamento</span></div>
        ${evolucao(d.por_mes)}</div>
      <div class="panel" style="padding:0;overflow:auto">
        <h3 style="padding:16px 16px 0">🏢 Métricas mensais por filial</h3>
        ${d.por_filial.length ? `<table style="margin-top:8px"><thead><tr>
          <th class="l">Filial</th><th>VGV/mês</th><th>Fat/mês</th><th>Marg.</th><th>Un.</th><th>Ticket</th></tr></thead>
          <tbody>${d.por_filial.map((f) => `<tr>
            <td class="l cli">${f.nome}</td><td>${fmt(f.vgv_mes)}</td><td>${fmt(f.fat_mes)}</td>
            <td>${f.margem}%</td><td>${f.unidades}</td><td>${fmt(f.ticket)}</td></tr>`).join('')}</tbody></table>` : ''}
      </div>
    </div>

    <div class="panel" style="margin-top:16px;overflow:auto">
      <h3>📅 VGV e faturamento mês a mês</h3>
      <p class="hint" style="margin:0 0 6px">Na coluna Faturamento: em cima o <b>total do mês</b> (vendas + locações + receita marginal, todos os segmentos); embaixo, só o <b>assinado deste segmento</b>.</p>
      <table style="margin-top:4px"><thead><tr>
        <th class="l">Mês</th><th>VGV</th><th style="text-align:right">Faturamento do mês</th><th>Vendas</th></tr></thead>
        <tbody>${d.por_mes.map((m) => `<tr>
          <td class="l">${m.nome}</td><td>${m.vgv ? fmt(m.vgv) : '—'}</td>
          <td style="text-align:right">${m.fat_consol ? `<b style="color:var(--gold)">${fmt(m.fat_consol)}</b>${m.fat && Math.abs(m.fat_consol - m.fat) > 0.01 ? `<div class="hint" style="font-size:11px">assinado ${fmt(m.fat)}</div>` : ''}` : '—'}</td>
          <td style="text-align:center">${m.qtd || '—'}</td></tr>`).join('')}
          <tr style="font-weight:800;border-top:2px solid var(--gold);color:var(--gold)"><td class="l">Total do ano</td><td>${fmt(d.por_mes.reduce((a, m) => a + m.vgv, 0))}</td><td style="text-align:right">${fmt(d.por_mes.reduce((a, m) => a + m.fat_consol, 0))}</td><td style="text-align:center">${d.por_mes.reduce((a, m) => a + m.qtd, 0)}</td></tr>
        </tbody></table>
    </div>`;
}

// ============ FUNIL (registro de vendas — edição inline estilo Excel) ============
let filtros = { status: '', corretor: '', filial: '' };

// <select> de célula: garante que o valor atual apareça mesmo se não estiver no cadastro
const cellSelect = (field, arr, sel, cls = '') => {
  const list = [...arr];
  if (sel && !list.includes(sel)) list.unshift(sel);
  return `<select class="cell-sel ${cls}" data-field="${field}">
    <option value=""${!sel ? ' selected' : ''}>—</option>
    ${list.map((x) => `<option${x === sel ? ' selected' : ''}>${x}</option>`).join('')}</select>`;
};
const cellInput = (field, val, type = 'text', step = '') => `<input class="cell-inp" data-field="${field}"
  type="${type}"${step ? ` step="${step}"` : ''} value="${esc(val || '')}">`;
// campo monetário: exibe "R$ 4.150.520"; ao focar mostra o número cru p/ digitar
const cellMoney = (field, val) => `<input class="cell-inp money" data-field="${field}" inputmode="numeric" value="${val ? esc(fmt(val)) : ''}">`;

// ---- card de pipeline do mês: duas leituras, REAL x POTENCIAL ----
let vendasFunil = [];   // última lista carregada (p/ repintar o card sem re-renderizar a tabela)
// REAL = o que já conta no caixa, ou seja, bolinha acesa: vendida/recebida (verde) ou quente marcada (vermelha)
const contaNoCaixa = (v) => v.recebido || v.status === 'ASSINADA' || (v.mapa_calor === 'QUENTE' && v.prever_caixa);
function pipeInner(mesAlvo = new Date().getMonth() + 1) {
  const perdidos = (state.meta && state.meta.perdidos) || [];
  const nomeMes = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][mesAlvo - 1];
  const doMes = vendasFunil.filter((v) => !perdidos.includes(v.status) && v.mes === mesAlvo);
  // 4 grupos por faturamento (mutuamente exclusivos):
  // a = já assinado/recebido (Faturado) · b = por assinar (🔴 prever_caixa) ·
  // c = com chances (🔵 previsão) · d = dúvida (sem bolinha marcada)
  const firme = (v) => v.recebido || v.status === 'ASSINADA';
  const a = doMes.filter(firme);
  const b = doMes.filter((v) => !firme(v) && v.prever_caixa);
  const c = doMes.filter((v) => !firme(v) && !v.prever_caixa && v.prever_fat);
  const dv = doMes.filter((v) => !firme(v) && !v.prever_caixa && !v.prever_fat);
  const fat = (arr) => arr.reduce((s, v) => s + (v.faturamento || 0), 0);
  const Fa = fat(a), Fb = fat(b), Fc = fat(c), Fd = fat(dv);
  const linha = (cls, rot, qt, val) => `<div class="pln ${cls}"><span>${rot} <span class="qt">(${qt})</span></span><b>${fmt(val)}</b></div>`;
  // VGV real já assinado no mês (firme)
  const vgvMesReal = a.reduce((s, v) => s + (v.vgv || 0), 0);
  return `<div class="ptt">🔥 Pipeline · ${nomeMes} · ${doMes.length} neg.</div>
    <div class="pln feito"><span>VGV assinado</span><b>${fmt(vgvMesReal)}</b></div>
    <div class="pln-sep"></div>
    ${linha('feito', 'a · Faturado', a.length, Fa)}
    ${linha('red', 'b · Por assinar 🔴', b.length, Fb)}
    ${linha('prev', 'c · Com chances 🔵', c.length, Fc)}
    ${linha('pot', 'd · Dúvida (s/ marca)', dv.length, Fd)}
    <div class="pln-sep"></div>
    ${linha('tot', 'a+b', a.length + b.length, Fa + Fb)}
    ${linha('tot', 'a+b+c', a.length + b.length + c.length, Fa + Fb + Fc)}
    ${linha('tot gi', 'Geral', doMes.length, Fa + Fb + Fc + Fd)}`;
}
// repinta só o card (a bolinha/status/VGV mudam o "real" e os números ficariam velhos na tela)
function repintarPipe() { const def = new Date().getMonth() + 1; $$('.pipebox').forEach((b) => { b.innerHTML = pipeInner(+b.dataset.mes || def); }); }
function sincronizarVendaLocal(v) { const i = vendasFunil.findIndex((x) => x.id === v.id); if (i >= 0) vendasFunil[i] = { ...vendasFunil[i], ...v }; repintarPipe(); }

let mostrarFuturos = false;   // meses à frente do corrente começam ocultos (botão revela)
async function renderFunil() {
  $('#cards').innerHTML = '';
  const q = new URLSearchParams({ ano: state.ano, segmento: state.segmento, ...Object.fromEntries(Object.entries(filtros).filter(([, v]) => v)) });
  const [vendas, fatMes] = await Promise.all([api('api/vendas?' + q), api('api/faturamento-mes?ano=' + state.ano)]);
  // "futuro" = mês depois do mês corrente (no ano em curso) ou qualquer mês de um ano futuro
  const _now = new Date(), nowY = _now.getFullYear(), nowM = _now.getMonth() + 1;
  const ehFuturo = (mes) => state.ano > nowY || (state.ano === nowY && mes > nowM);
  const futVendas = vendas.filter((v) => ehFuturo(v.mes));
  const futQtd = futVendas.length, futMeses = new Set(futVendas.map((v) => v.mes)).size;
  const futMesesList = [...new Set(futVendas.map((v) => v.mes))].sort((a, b) => a - b);
  const mesAtualNum = new Date().getMonth() + 1;
  const fatConsolMes = fatMes.meses || {};   // faturamento consolidado (todos os segmentos + marginal) por mês
  const m = state.meta;
  vendasFunil = vendas;   // alimenta o card de pipeline do mês (real x potencial) — ver pipeInner()
  const optList = (arr, sel) => ['<option value="">Todos</option>', ...arr.map((x) => `<option ${x === sel ? 'selected' : ''}>${x}</option>`)].join('');

  // cabeçalho de colunas repetido no início de cada mês
  const COLHEAD = `<tr class="colhead">
    <td class="l">Cliente</td><td class="l">Bairro / Produto</td><td class="l">Filial</td><td class="l">Corretor</td>
    <td class="l">Opcionista</td><td class="l">Gerente</td><td></td><td></td><td></td><td class="l">Prev. receb.</td><td></td><td></td><td></td></tr>`;

  // atalhos = próximas sextas a partir de hoje (a sexta que já passou "vira" a próxima)
  const sextaISO = (off) => { const t = new Date(); const dd = (5 - t.getDay() + 7) % 7; const f = new Date(t); f.setDate(t.getDate() + dd + off * 7); return dLocal(f); };
  const S0 = sextaISO(0), S1 = sextaISO(1), S2 = sextaISO(2), S28 = sextaISO(3);
  const hojeF = dLocal();
  const recCell = (v) => {
    // comissão parcelada: recebimento é gerenciado pelas parcelas (na ficha) — não usa a data única
    if (v.parcelas_qtd > 0) {
      const done = v.parcelas_rec >= v.parcelas_qtd;
      return `<div class="recwrap ${done ? 'recebido' : ''}">
        <span class="recok" style="cursor:pointer;${done ? '' : 'background:none;color:var(--gold)'}" data-edit-parc="${v.id}"
          title="Comissão em ${v.parcelas_qtd} parcelas — ${v.parcelas_rec} recebida(s). Clique para editar na ficha.">🧩 ${v.parcelas_rec}/${v.parcelas_qtd} parcela(s)</span></div>`;
    }
    if (v.recebido) {
      const total = v.valor_recebido || v.faturamento;
      const repasse = Math.max(0, total - v.faturamento);
      if (v.fora_caixa) return `<div class="recwrap recebido">
        <span class="recok fora" title="Recebido (fora do fluxo-caixa — financeiro antigo)">✓ ${v.data_recebido ? fmtData(v.data_recebido) : 'recebido'}</span>
        <button class="rqundo" data-id="${v.id}" title="Desfazer recebido">↩</button></div>`;
      const tip = `Recebido em ${fmtData(v.data_recebido)} · comissão ${fmt(v.faturamento)}` + (repasse > 0 ? ` · entrou ${fmt(total)} (repasse ${fmt(repasse)} a corretores)` : '');
      return `<div class="recwrap recebido">
        <span class="recok" title="${esc(tip)}">✓ ${v.data_recebido ? fmtData(v.data_recebido) : 'recebido'}${repasse > 0 ? ' ⤴' : ''}</span>
        <button class="rqundo" data-id="${v.id}" title="Desfazer recebido">↩</button></div>`;
    }
    const cur = v.data_recebimento || '';
    return `<div class="recwrap">
      <select class="recq" data-id="${v.id}">
        <option value="">${cur ? '📅 ' + fmtData(cur) : '— definir'}</option>
        <option value="${S0}">7 · sex ${fmtData(S0)}</option>
        <option value="${S1}">14 · sex ${fmtData(S1)}</option>
        <option value="${S2}">21 · sex ${fmtData(S2)}</option>
        <option value="28">📅 escolher data…</option>
        <option value="recebido">✓ Recebido…</option>
      </select>
      <input type="date" class="recq-date" data-id="${v.id}" value="${cur}" hidden></div>`;
  };
  // mover a venda p/ outro mês (postergar) ou ano (prever futuro)
  const mesMoveOpts = (v) => [state.ano, state.ano + 1].map((y) =>
    `<optgroup label="${y}">` + MESES.map((nm, i) =>
      `<option value="${y}-${i + 1}"${y === v.ano && i + 1 === v.mes ? ' selected' : ''}>${nm.slice(0, 3).toLowerCase()}/${String(y).slice(2)}</option>`).join('') + `</optgroup>`).join('');

  let rows = '';
  let mesAtivo = 0;
  // mês mais recente em cima (decrescente); dentro do mês, ordem natural por id
  const ordenadas = [...vendas].sort((a, b) => (b.mes - a.mes) || (a.id - b.id));
  for (const v of ordenadas) {
    const fut = ehFuturo(v.mes) ? ' futuro' : '';
    if (v.mes !== mesAtivo) {
      mesAtivo = v.mes;
      const doMes = vendas.filter((x) => x.mes === mesAtivo);
      const vgvMes = doMes.reduce((a, x) => a + x.vgv, 0);
      const fatAssMes = doMes.filter((x) => x.status === 'ASSINADA').reduce((a, x) => a + (x.faturamento || 0), 0);
      const fatCons = fatConsolMes[mesAtivo] || 0;   // consolidado: todos os segmentos + marginal
      rows += `<tr class="mesrow${fut}" data-mes="${mesAtivo}"><td class="l" colspan="6">${MESES[mesAtivo - 1]}</td>
        <td class="num" data-mestot>${fmtMM(vgvMes)}</td>
        <td colspan="6"><b style="color:var(--gold)">${fmt(fatCons)}</b>${fatCons && Math.abs(fatCons - fatAssMes) > 0.01 ? ` <span class="hint">(assinado ${fmt(fatAssMes)})</span>` : ''} · ${doMes.length} VENDAS</td></tr>`;
      rows += COLHEAD.replace('class="colhead"', `class="colhead${fut}"`);
    }
    rows += `<tr data-id="${v.id}" data-mes="${v.mes}" class="vrow${fut}">
      <td class="l">${cellInput('cliente', v.cliente)}</td>
      <td class="l">${cellInput('produto', v.produto)}</td>
      <td class="l">${cellSelect('filial', m.filiais, v.filial)}</td>
      <td class="l">${cellSelect('corretor', m.corretores, v.corretor)}</td>
      <td class="l">${cellSelect('opcionista', m.opcionistas, v.opcionista)}</td>
      <td class="l">${cellSelect('gerente', m.gerentes, v.gerente)}</td>
      <td class="num">${cellMoney('vgv', v.vgv)}</td>
      <td class="num">${(() => {
        const firme = v.recebido || v.status === 'ASSINADA';
        const on = firme || v.prever_fat;
        const t = firme ? 'Venda feita' : 'Previsão de faturamento (azul) — só p/ você se orientar, NÃO entra no caixa. Clique p/ alternar (desliga a vermelha)';
        return `<button class="prevfat ${on ? 'on' : ''}${firme ? ' firme' : ''}" data-id="${v.id}" ${firme ? 'disabled' : ''} title="${t}"></button>`;
      })()}${cellInput('margem_pct', v.margem_pct, 'number', '0.1')}</td>
      <td class="num" data-fat><span class="fatv">${fmt(v.faturamento)}</span>${(() => {
        const firme = v.recebido || v.status === 'ASSINADA';
        const quenteAberta = !firme && v.mapa_calor === 'QUENTE';
        const on = firme || (quenteAberta && v.prever_caixa);
        const t = firme ? 'Valor firme — sempre conta no caixa' : (quenteAberta ? 'Conta na previsão de caixa — clique p/ alternar' : 'Só vendas quentes em aberto entram na previsão');
        return `<button class="prevtog ${on ? 'on' : ''}${firme ? ' firme' : ''}" data-id="${v.id}" ${quenteAberta ? '' : 'disabled'} title="${t}"></button>`;
      })()}</td>
      <td class="l recq-cell">${recCell(v)}</td>
      <td class="l">${cellSelect('status', [...m.funil, ...m.perdidos, m.desistencia], v.status, 'st-sel st-' + v.status)}</td>
      <td class="l">${cellSelect('mapa_calor', m.calores, v.mapa_calor, 'calor ' + (v.mapa_calor || ''))}</td>
      <td><div class="row-actions">
        <select class="mesmove" data-id="${v.id}" title="Mover p/ outro mês ou ano">${mesMoveOpts(v)}</select>
        <button class="icon-btn" data-act="edit" title="Editar (abre ficha completa)">✏️</button>
        <button class="icon-btn danger" data-act="del" title="Excluir">🗑️</button>
      </div></td></tr>`;
  }

  $('#view').innerHTML = `
    <div class="toolbar">
      <select id="fStatus">${optList(['', ...m.funil, ...m.perdidos].filter(Boolean), filtros.status).replace('value=""', `value="" ${!filtros.status ? 'selected' : ''}`)}</select>
      <select id="fCorretor">${optList(m.corretores, filtros.corretor)}</select>
      <select id="fFilial">${optList(m.filiais, filtros.filial)}</select>
      <button id="btnLote" class="ghost">✓ Confirmar recebidos (lote)</button>
      <span class="hint">${vendas.length} registro(s) · edite direto na linha — salva sozinho</span>
      <div class="pipecluster">
        <div class="pipebox" data-mes="${mesAtualNum}" title="Real = vendas assinadas + quentes com a bolinha vermelha marcada (o que conta na previsão de caixa). Potencial = todas as vendas do mês.">
          ${pipeInner(mesAtualNum)}
        </div>
        ${futMesesList.length ? `<button id="btnPipeFut" class="ghost pipefutbtn" title="Ver o pipeline de um mês à frente (oculto por padrão)">🔮 mês futuro ▸</button>
        ${futMesesList.length > 1 ? `<select id="selPipeFut" class="pipefutsel hidden">${futMesesList.map((mo) => `<option value="${mo}">${MESES[mo - 1]}</option>`).join('')}</select>` : ''}
        <div class="pipebox pipe-fut hidden" data-mes="${futMesesList[0]}">${pipeInner(futMesesList[0])}</div>` : ''}
      </div>
    </div>
    ${futQtd ? `<div class="futtoggle"><button id="btnFuturos" class="ghost" title="Meses à frente do mês atual ficam ocultos. Clique p/ mostrar/ocultar.">${mostrarFuturos ? '▾' : '▸'} Meses futuros · ${futQtd} venda${futQtd > 1 ? 's' : ''} em ${futMeses} ${futMeses > 1 ? 'meses' : 'mês'}</button></div>` : ''}
    <div class="panel" style="padding:0;overflow:auto">
      ${vendas.length ? `<table class="editable${mostrarFuturos ? ' show-futuro' : ''}"><tbody>${rows}</tbody></table>`
        : `<div class="empty">Nenhum registro neste filtro. Use <b>${state.segmento === 'locacao' ? '+ Nova locação' : '+ Nova venda'}</b>.</div>`}
    </div>`;

  $('#fStatus').onchange = (e) => { filtros.status = e.target.value; renderFunil(); };
  $('#fCorretor').onchange = (e) => { filtros.corretor = e.target.value; renderFunil(); };
  $('#fFilial').onchange = (e) => { filtros.filial = e.target.value; renderFunil(); };
  $('#btnLote').onclick = modalConfirmarLote;
  const bf = $('#btnFuturos');
  if (bf) bf.onclick = () => {
    mostrarFuturos = !mostrarFuturos;
    const t = $('#view table.editable'); if (t) t.classList.toggle('show-futuro', mostrarFuturos);
    bf.textContent = `${mostrarFuturos ? '▾' : '▸'} Meses futuros · ${futQtd} venda${futQtd > 1 ? 's' : ''} em ${futMeses} ${futMeses > 1 ? 'meses' : 'mês'}`;
  };
  // pipe de mês futuro: botão revela/oculta o pipebox futuro (e o seletor, se houver vários meses)
  const bpf = $('#btnPipeFut');
  if (bpf) bpf.onclick = () => {
    const box = $('.pipebox.pipe-fut'), sel = $('#selPipeFut');
    const abrir = box.classList.contains('hidden');
    box.classList.toggle('hidden', !abrir);
    if (sel) sel.classList.toggle('hidden', !abrir);
    bpf.textContent = `🔮 mês futuro ${abrir ? '▾' : '▸'}`;
  };
  const spf = $('#selPipeFut');
  if (spf) spf.onchange = () => { const box = $('.pipebox.pipe-fut'); box.dataset.mes = spf.value; box.innerHTML = pipeInner(+spf.value); };

  $$('#view tbody tr[data-id]').forEach((tr) => {
    const id = +tr.dataset.id;
    $$('[data-field]', tr).forEach((el) => {
      el.addEventListener('change', () => salvarCampo(id, el, tr));
      if (el.tagName === 'INPUT') el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
      if (el.classList.contains('money')) {
        el.addEventListener('focus', () => { const n = parseMoneyStr(el.value); el.value = n ? String(n) : ''; el.select(); });
        el.addEventListener('blur', () => { const n = parseMoneyStr(el.value); el.value = n ? fmt(n) : ''; }); // reformata ao sair, mesmo sem editar (senão fica "390000" cru)
      }
    });
    const ptog = $('.prevtog', tr);
    if (ptog && !ptog.disabled) ptog.onclick = async () => {
      const on = !ptog.classList.contains('on');
      ptog.classList.toggle('on', on);
      const body = { prever_caixa: on ? 1 : 0 };
      if (on) { body.prever_fat = 0; const pf = $('.prevfat', tr); if (pf) pf.classList.remove('on'); }   // exclusivas
      const v = await api(`api/vendas/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      sincronizarVendaLocal(v);   // a bolinha muda o "real" — o card tem que acompanhar
      flashRow(tr);
    };
    const pfat = $('.prevfat', tr);
    if (pfat && !pfat.disabled) pfat.onclick = async () => {
      const on = !pfat.classList.contains('on');
      pfat.classList.toggle('on', on);
      const body = { prever_fat: on ? 1 : 0 };
      if (on) { body.prever_caixa = 0; const pt = $('.prevtog', tr); if (pt) pt.classList.remove('on'); }   // exclusivas
      const v = await api(`api/vendas/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      sincronizarVendaLocal(v);   // azul muda a previsão de faturamento — o card acompanha
      flashRow(tr);
    };
    $('[data-act=edit]', tr).onclick = () => modalVenda(vendas.find((x) => x.id === id));
    $('[data-act=del]', tr).onclick = async () => {
      const cli = $('[data-field=cliente]', tr)?.value || 'este registro';
      if (!confirm(`Excluir o registro de ${cli}?`)) return;
      await api(`api/vendas/${id}`, { method: 'DELETE' });
      renderFunil();
    };
  });

  // atalhos de previsão de recebimento (7/14/21/28+) e marcação de recebido
  const abrirPicker = (di) => { di.hidden = false; if (di.showPicker) { try { di.showPicker(); } catch (e) { di.focus(); } } else di.focus(); };
  $$('#view .recq').forEach((sel) => {
    sel.onchange = async () => {
      const val = sel.value;
      if (!val) return;
      const wrap = sel.closest('.recwrap');
      if (val === '28') { sel.selectedIndex = 0; abrirPicker(wrap.querySelector('.recq-date')); return; }
      if (val === 'recebido') { sel.selectedIndex = 0; modalReceber(vendas.find((x) => x.id === +sel.dataset.id)); return; }
      sel.options[0].textContent = '📅 ' + fmtData(val);
      sel.selectedIndex = 0;
      await api(`api/vendas/${sel.dataset.id}`, { method: 'PUT', body: JSON.stringify({ data_recebimento: val }) });
      flashRow(sel.closest('tr'));
    };
  });
  $$('#view .recq-date').forEach((di) => {
    di.onchange = async () => {
      if (!di.value) return;
      const sel = di.closest('.recwrap').querySelector('.recq');
      sel.options[0].textContent = '📅 ' + fmtData(di.value);
      di.hidden = true;
      await api(`api/vendas/${di.dataset.id}`, { method: 'PUT', body: JSON.stringify({ data_recebimento: di.value }) });
      flashRow(di.closest('tr'));
    };
  });
  $$('#view .rqundo').forEach((b) => b.onclick = async () => {
    await api(`api/vendas/${b.dataset.id}`, { method: 'PUT', body: JSON.stringify({ recebido: 0, data_recebido: null, valor_recebido: 0 }) });
    renderFunil();
  });
  // badge de comissão parcelada -> abre a ficha (aba de parcelas)
  $$('#view [data-edit-parc]').forEach((el) => el.onclick = () => modalVenda(vendas.find((x) => x.id === +el.dataset.editParc)));
  // mover venda para outro mês/ano
  $$('#view .mesmove').forEach((sel) => sel.onchange = async () => {
    const [ano, mes] = sel.value.split('-').map(Number);
    await api(`api/vendas/${sel.dataset.id}`, { method: 'PUT', body: JSON.stringify({ ano, mes }) });
    if (ano !== state.ano) $('#status').textContent = `Venda movida para ${MESES[mes - 1].toLowerCase()}/${ano} (troque o ano no topo para vê-la).`;
    renderFunil();
  });
}

// salva um campo editado inline; atualiza faturamento, subtotal do mês e pisca a linha
async function salvarCampo(id, el, tr) {
  const campo = el.dataset.field;
  // cancelar (desistência) abre o modal de motivo antes de salvar — a linha sai da planilha
  if (campo === 'status' && el.value === state.meta.desistencia) return modalCancelar(id, tr);
  let valor;
  if (campo === 'vgv') valor = parseMoneyStr(el.value);
  else if (campo === 'margem_pct') valor = +el.value || 0;
  else valor = el.value;
  try {
    const v = await api(`api/vendas/${id}`, { method: 'PUT', body: JSON.stringify({ [campo]: valor }) });
    const fatv = $('[data-fat] .fatv', tr); if (fatv) fatv.textContent = fmt(v.faturamento);
    if (campo === 'vgv') { el.value = v.vgv ? fmt(v.vgv) : ''; atualizarSubtotalMes(tr); }
    if (campo === 'status') { el.className = 'cell-sel st-sel st-' + v.status; }
    if (campo === 'mapa_calor') return renderFunil(); // re-render p/ atualizar o botão de previsão
    sincronizarVendaLocal(v);   // status/VGV/margem mexem no real x potencial do card
    flashRow(tr);
  } catch (e) { alert('Erro ao salvar: ' + e.message); }
}
function atualizarSubtotalMes(tr) {
  const mes = tr.dataset.mes;
  const soma = $$(`#view tbody tr[data-id][data-mes="${mes}"] [data-field=vgv]`).reduce((a, el) => a + parseMoneyStr(el.value), 0);
  const cell = $(`#view tbody tr.mesrow[data-mes="${mes}"] [data-mestot]`);
  if (cell) cell.textContent = fmtMM(soma);
}
function flashRow(tr) { tr.classList.add('row-saved'); setTimeout(() => tr.classList.remove('row-saved'), 700); }

// ============ RANKING ============
async function renderRanking() {
  $('#cards').innerHTML = '';
  const r = await api(`api/ranking?ano=${state.ano}&${sq()}`);
  const tabela = (titulo, rows) => `
    <div class="panel"><h3>${titulo}</h3>
      ${rows.length ? `<table><thead><tr><th class="l">#</th><th class="l">Nome</th><th>VGV</th><th>%</th><th>Unid.</th></tr></thead>
      <tbody>${rows.map((x) => `<tr>
        <td class="l"><span class="rank-pos ${x.pos <= 3 ? 'p' + x.pos : ''}">${x.pos}</span></td>
        <td class="l cli">${x.nome}</td><td>${fmtMM(x.vgv)}</td><td>${x.pct}%</td><td>${x.unidades}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">Sem vendas assinadas ainda.</div>'}
    </div>`;
  $('#view').innerHTML = `<div class="two-col">
    ${tabela('🏆 Corretores', r.corretores)}
    ${tabela('🏢 Filiais', r.filiais)}
  </div>
  ${tabela('👔 Gerentes', r.gerentes)}`;
}

// ============ RECEBÍVEIS (previsão de entrada do faturamento) ============
const fmtData = (iso) => iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : '';
let recebSel = 'esta';
async function renderRecebiveis() {
  const d = await api(`api/recebiveis?ano=${state.ano}&${sq()}`);
  const ON = state.soQuentes;
  const potForecast = ON ? d.total_pot_quente : 0;      // só quentes entram na previsão (quando ligado)
  const marg = d.total_marginal_prev || 0;              // receita marginal a receber
  const previsaoCaixa = d.total_confirmado + potForecast + marg; // firme + quentes + marginal
  $('#cards').innerHTML = `
    <div class="card pos"><div class="lbl">💵 Já recebido (comissão)</div><div class="val">${fmt(d.total_recebido)}</div><div class="sub">${d.total_repasse > 0 ? 'entrou ' + fmt(d.total_entrada) + ' · repasse ' + fmt(d.total_repasse) : 'receita realizada'}</div></div>
    <div class="card"><div class="lbl">✅ Confirmado a receber</div><div class="val">${fmt(d.total_confirmado)}</div><div class="sub">assinadas, ainda não recebidas</div></div>
    ${(marg || d.total_marginal_rec) ? `<div class="card"><div class="lbl">🎁 Receita marginal</div><div class="val">${fmt(marg)}</div><div class="sub">a receber${d.total_marginal_rec > 0 ? ' · já entrou ' + fmt(d.total_marginal_rec) : ''}</div></div>` : ''}
    <div class="card gold"><div class="lbl">🔥 Previsão de caixa</div><div class="val">${fmt(previsaoCaixa)}</div><div class="sub">${ON ? 'firme + quentes' : 'só firme'}${marg > 0 ? ' + marginal (' + fmt(marg) + ')' : ''}</div></div>`;

  if (!d.buckets.some((b) => b.chave === recebSel)) recebSel = 'esta';
  const sel = d.buckets.find((b) => b.chave === recebSel);

  $('#view').innerHTML = `
    <div class="receb-toolbar">
      <button id="toggleQuentes" class="toggle ${ON ? 'on' : ''}" role="switch" aria-checked="${ON}">
        <span class="knob"></span></button>
      <span class="toggle-lbl">🔥 Incluir quentes na previsão de caixa</span>
      <span class="hint">${ON ? 'ligado — morno/frio ficam de fora' : 'desligado — só assinadas firmes contam'}${d.total_pot_outro > 0 ? ` · ${fmt(d.total_pot_outro)} em morno/frio (sempre fora)` : ''}</span>
    </div>
    <div class="receb-cards">${d.buckets.map((b) => {
      const range = !b.de ? 'até ' + fmtData(b.ate) : (b.ate ? fmtData(b.de) + ' – ' + fmtData(b.ate) : 'de ' + fmtData(b.de) + ' em diante');
      const pot = ON ? b.pot_quente : 0;
      return `<button class="rc ${b.chave === recebSel ? 'active' : ''} ${b.chave === 'anterior' ? 'past' : ''}" data-bucket="${b.chave}">
        <div class="rc-l">${b.label}</div>
        <div class="rc-range">${range}</div>
        <div class="rc-conf">${fmt(b.confirmado + pot + b.marginal_prev)}</div>
        <div class="rc-pot">${ON && b.pot_quente > 0 ? '🔥 ' + fmt(b.pot_quente) + ' · ' : ''}${b.marginal_prev > 0 ? '🎁 ' + fmt(b.marginal_prev) + ' · ' : ''}${b.qtd} venda(s)</div>
      </button>`; }).join('')}${(() => {
        const fut = d.buckets.filter((b) => b.chave !== 'anterior');
        const firme = fut.reduce((s, b) => s + b.confirmado, 0);
        const quentes = ON ? fut.reduce((s, b) => s + b.pot_quente, 0) : 0;
        const marg = fut.reduce((s, b) => s + b.marginal_prev, 0);
        const tr = firme + quentes + marg;
        const qt = fut.reduce((s, b) => s + b.qtd, 0);
        return `<div class="rc rc-total" style="cursor:default;border-color:var(--gold);background:rgba(212,175,55,.08)">
          <div class="rc-l" style="color:var(--gold)">💰 TOTAL A RECEBER</div>
          <div class="rc-range" title="firme = assinadas · 🔥 quentes = provável · 🎁 marginal">✅ ${fmt(firme)}${quentes ? ' · 🔥 ' + fmt(quentes) : ''}${marg ? ' · 🎁 ' + fmt(marg) : ''}</div>
          <div class="rc-conf" style="color:var(--gold)">${fmt(tr)}</div>
          <div class="rc-pot">${qt} venda(s)</div></div>`;
      })()}</div>

    <div class="panel" style="padding:0;overflow:auto">
      <h3 style="padding:16px 16px 6px">📅 ${sel.label} — ${sel.qtd} venda(s)${(sel.marginal_prev || sel.marginal_rec) ? ' · 🎁 ' + fmt(sel.marginal_prev) + ' marginal' : ''} · previsão ${fmt(sel.confirmado + (ON ? sel.pot_quente : 0) + sel.marginal_prev)}</h3>
      <div class="hint" style="padding:0 16px 10px">Ajuste a previsão direto na data. 🎁 = receita marginal (premiação, comissão de financiamento…). Itens fora da previsão aparecem esmaecidos.</div>
      ${sel.itens.length ? `<table><thead><tr>
        <th class="l">Previsão</th><th class="l">Cliente</th><th class="l">Filial</th><th class="l">Status</th><th class="l">Calor</th><th>Valor</th></tr></thead>
        <tbody>${sel.itens.map((v) => {
          if (v.marginal) return `<tr data-marg="${v.id}" class="margrow">
            <td class="l"><input class="cell-inp recdata-marg" data-marg="${v.id}" type="date" value="${v.data_efetiva}"></td>
            <td class="l cli">🎁 ${esc(v.tipo)}<div class="prod">${esc(v.cliente)}${v.produto ? ' · ' + esc(v.produto) : ''}</div></td>
            <td class="l">${v.filial || '—'}</td>
            <td class="l" colspan="2"><span class="chip marg-chip">marginal${v.recebido ? ' · recebida' : ''}</span></td>
            <td class="money ${v.recebido ? 'pos' : ''}">${fmt(v.valor)} ${v.recebido ? `<button class="rqundo marg-undo" data-marg="${v.id}" title="Desfazer recebido">↩</button>` : `<button class="rqundo marg-receb" data-marg="${v.id}" title="Marcar recebido">✓</button>`}</td></tr>`;
          const foraPrev = !v.recebido && !v.confirmada && !v.quente; // morno/frio em aberto = fora da previsão
          // parcela de comissão: data e recebido editam a PARCELA, não a venda
          if (v.parcela_id) return `<tr data-parc="${v.parcela_id}" class="${foraPrev ? 'foraprev' : ''}">
          <td class="l"><input class="cell-inp recdata-parc" data-parc="${v.parcela_id}" type="date" value="${v.data_efetiva}"></td>
          <td class="l cli">🧩 ${v.cliente} <span class="hint">· parcela ${v.parcela}</span><div class="prod">${v.produto || ''}</div></td>
          <td class="l">${v.filial || '—'}</td>
          <td class="l" colspan="2"><span class="chip st-${v.status}">${v.status}</span>${v.recebido ? ' <span class="chip marg-chip">recebida</span>' : ''}</td>
          <td class="money ${v.recebido ? 'pos' : ''}">${fmt(v.faturamento)} ${v.recebido ? `<button class="rqundo parc-undo" data-parc="${v.parcela_id}" title="Desfazer recebido">↩</button>` : `<button class="rqundo parc-receb" data-parc="${v.parcela_id}" title="Marcar recebido">✓</button>`}</td></tr>`;
          return `<tr data-id="${v.id}" class="${foraPrev ? 'foraprev' : ''}">
          <td class="l"><input class="cell-inp recdata" type="date" value="${v.data_efetiva}"></td>
          <td class="l cli">${v.cliente}<div class="prod">${v.produto || ''}</div></td>
          <td class="l">${v.filial || '—'}</td>
          <td class="l"><span class="chip st-${v.status}">${v.status}</span></td>
          <td class="l"><span class="calor ${v.mapa_calor || ''}">${v.mapa_calor === 'QUENTE' ? '🔥' : v.mapa_calor === 'MORNO' ? '🌤️' : v.mapa_calor === 'FRIO' ? '❄️' : ''} ${v.mapa_calor || ''}</span></td>
          <td class="${v.recebido ? 'money pos' : v.confirmada ? 'money pos' : 'money'}">${fmt(v.faturamento)}</td></tr>`; }).join('')}</tbody>
        <tfoot><tr style="font-weight:800;border-top:2px solid var(--gold)">
          <td colspan="5" class="l">Total previsto neste período <span class="hint" style="font-weight:400">(firme${ON ? ' + quentes' : ''}${sel.marginal_prev ? ' + marginal' : ''})</span></td>
          <td class="money pos">${fmt(sel.confirmado + (ON ? sel.pot_quente : 0) + sel.marginal_prev)}</td></tr></tfoot></table>`
        : '<div class="empty">Nada previsto nesta janela.</div>'}
    </div>`;

  $('#toggleQuentes').onclick = () => { state.soQuentes = !state.soQuentes; renderRecebiveis(); };
  $$('.receb-cards .rc').forEach((b) => b.onclick = () => { recebSel = b.dataset.bucket; renderRecebiveis(); });
  $$('#view tbody tr[data-id]').forEach((tr) => {
    const id = +tr.dataset.id;
    $('.recdata', tr).addEventListener('change', async (e) => {
      await api(`api/vendas/${id}`, { method: 'PUT', body: JSON.stringify({ data_recebimento: e.target.value }) });
      renderRecebiveis();
    });
  });
  // receitas marginais: editar data prevista, marcar/desfazer recebido
  const hojeISO = state.meta.hoje || dLocal();
  $$('#view .recdata-marg').forEach((inp) => inp.addEventListener('change', async () => {
    await api(`api/marginais/${inp.dataset.marg}`, { method: 'PUT', body: JSON.stringify({ data_prevista: inp.value }) });
    renderRecebiveis();
  }));
  $$('#view .marg-receb').forEach((b) => b.onclick = async () => {
    await api(`api/marginais/${b.dataset.marg}`, { method: 'PUT', body: JSON.stringify({ recebido: 1, data_recebido: hojeISO }) });
    renderRecebiveis();
  });
  $$('#view .recdata-parc').forEach((inp) => inp.addEventListener('change', async () => {
    await api(`api/parcelas/${inp.dataset.parc}`, { method: 'PUT', body: JSON.stringify({ data_prevista: inp.value }) });
    renderRecebiveis();
  }));
  $$('#view .parc-receb').forEach((b) => b.onclick = async () => {
    await api(`api/parcelas/${b.dataset.parc}`, { method: 'PUT', body: JSON.stringify({ recebido: 1, data_recebido: hojeISO }) });
    renderRecebiveis();
  });
  $$('#view .parc-undo').forEach((b) => b.onclick = async () => {
    await api(`api/parcelas/${b.dataset.parc}`, { method: 'PUT', body: JSON.stringify({ recebido: 0 }) });
    renderRecebiveis();
  });
  $$('#view .marg-undo').forEach((b) => b.onclick = async () => {
    await api(`api/marginais/${b.dataset.marg}`, { method: 'PUT', body: JSON.stringify({ recebido: 0 }) });
    renderRecebiveis();
  });
}

// ============ MODAL: CONFIRMAR RECEBIMENTO EM LOTE ============
function modalConfirmarLote() {
  const optMes = MESES.map((nm, i) => `<option value="${i + 1}" ${i + 1 === 5 ? 'selected' : ''}>${nm}</option>`).join('');
  const termo = state.segmento === 'locacao' ? 'locações' : 'vendas';
  openModal(`
    <h2>✓ Confirmar recebimento em lote</h2>
    <div class="hint" style="margin-bottom:14px">Marca como <b>recebidas</b> todas as ${termo} <b>ASSINADAS</b> de ${state.ano} até o mês escolhido que ainda não foram confirmadas.</div>
    <div class="field"><label>Até o mês (inclusive)</label><select id="cl_mes">${optMes}</select></div>
    <div class="field"><label style="display:flex;align-items:center;gap:8px;cursor:pointer">
      <input type="checkbox" id="cl_fora" checked style="width:auto"> Não lançar no fluxo-caixa (financeiro antigo já conciliado)</label></div>
    <div class="hint">Recomendado deixar marcado para os meses já fechados — assim o sistema mostra como recebido, mas não mexe no caixa.</div>
    <div class="modal-actions"><button class="ghost" id="cl_cancel">Cancelar</button><button class="primary" id="cl_ok">Confirmar</button></div>
  `);
  $('#cl_cancel').onclick = closeModal;
  $('#cl_ok').onclick = async () => {
    const r = await api('api/vendas/confirmar-lote', { method: 'POST', body: JSON.stringify({ ano: state.ano, segmento: state.segmento, mes_ate: +$('#cl_mes').value, fora_caixa: $('#cl_fora').checked }) });
    closeModal();
    alert(`${r.confirmadas} ${termo} confirmadas como recebidas${r.fora_caixa ? ' (fora do fluxo-caixa)' : ''}.`);
    renderFunil();
  };
}

// ============ MODAL: CONFIRMAR RECEBIMENTO ============
function modalReceber(v) {
  if (!v) return;
  const hoje = dLocal();
  const adAtual = (v.valor_recebido && v.valor_recebido > v.faturamento) ? (v.valor_recebido - v.faturamento) : '';
  openModal(`
    <h2>Confirmar recebimento</h2>
    <div class="hint" style="margin:-6px 0 14px">${v.cliente}${v.produto ? ' · ' + v.produto : ''} · comissão prevista ${fmt(v.faturamento)}</div>
    <div class="field"><label>Data do recebimento</label><input id="r_data" type="date" value="${v.data_recebido || hoje}"></div>
    <div class="row">
      <div class="field"><label>Nossa comissão (entra como receita)</label><input id="r_com" disabled value="${fmt(v.faturamento)}"></div>
      <div class="field"><label>Valor adicional / repasse de corretores</label><input id="r_add" type="number" step="100" placeholder="0" value="${adAtual}"></div>
    </div>
    <div class="field"><label>Total que entrou na conta</label><input id="r_total" disabled value="${fmt(v.valor_recebido || v.faturamento)}"></div>
    <div class="hint">O adicional passa pelo caixa e depois é repassado aos corretores (não é receita de vocês).</div>
    <div class="modal-actions"><button class="ghost" id="r_cancel">Cancelar</button><button class="primary" id="r_save">Confirmar recebimento</button></div>
  `);
  const calc = () => { $('#r_total').value = fmt((v.faturamento || 0) + (+$('#r_add').value || 0)); };
  $('#r_add').oninput = calc;
  $('#r_cancel').onclick = closeModal;
  $('#r_save').onclick = async () => {
    const total = (v.faturamento || 0) + (+$('#r_add').value || 0);
    await api(`api/vendas/${v.id}`, { method: 'PUT', body: JSON.stringify({ recebido: 1, data_recebido: $('#r_data').value || hoje, valor_recebido: total }) });
    closeModal(); renderFunil();
  };
}

// ============ MODAL: VENDA ============
async function modalVenda(v = null) {
  const m = state.meta;
  const editing = !!v;
  const marginais = editing ? await api(`api/vendas/${v.id}/marginais`).catch(() => []) : [];
  const parcelas = editing ? await api(`api/vendas/${v.id}/parcelas`).catch(() => []) : [];
  v = v || { ano: state.ano, mes: new Date().getMonth() + 1, status: 'INTERESSE', mapa_calor: 'QUENTE', margem_pct: 3 };
  const opt = (arr, sel) => ['<option value="">—</option>', ...arr.map((x) => `<option ${x === sel ? 'selected' : ''}>${x}</option>`)].join('');
  const optMes = MESES.map((nm, i) => `<option value="${i + 1}" ${i + 1 === v.mes ? 'selected' : ''}>${nm}</option>`).join('');
  const anosMod = [...new Set([state.ano, state.ano + 1, state.ano + 2, v.ano].filter(Boolean))].sort((a, b) => a - b);
  const optAno = anosMod.map((y) => `<option ${y === (v.ano || state.ano) ? 'selected' : ''}>${y}</option>`).join('');
  const optStatus = [...m.funil, ...m.perdidos, m.desistencia].map((s) => `<option ${s === v.status ? 'selected' : ''}>${s}</option>`).join('');
  const optCalor = m.calores.map((c) => `<option ${c === v.mapa_calor ? 'selected' : ''}>${c}</option>`).join('');
  openModal(`
    <h2>${editing ? 'Editar venda' : 'Nova venda'}</h2>
    <div class="row">
      <div class="field"><label>Cliente *</label><input id="v_cliente" value="${v.cliente || ''}"></div>
      <div class="field" style="flex:0 0 104px"><label>Mês</label><select id="v_mes">${optMes}</select></div>
      <div class="field" style="flex:0 0 86px"><label>Ano</label><select id="v_ano">${optAno}</select></div>
    </div>
    <div class="field"><label>Bairro / Produto</label><input id="v_produto" value="${v.produto || ''}"></div>
    <div class="row">
      <div class="field"><label>Filial</label><select id="v_filial">${opt(m.filiais, v.filial)}</select></div>
      <div class="field"><label>Corretor</label><select id="v_corretor">${opt(m.corretores, v.corretor)}</select></div>
    </div>
    <div class="row">
      <div class="field"><label>Opcionista</label><select id="v_opcionista">${opt(m.opcionistas, v.opcionista)}</select></div>
      <div class="field"><label>Gerente</label><select id="v_gerente">${opt(m.gerentes, v.gerente)}</select></div>
    </div>
    <div class="row">
      <div class="field"><label>VGV (R$)</label><input id="v_vgv" type="number" step="1000" value="${v.vgv || ''}"></div>
      <div class="field"><label>Margem % (IUM)</label><input id="v_margem" type="number" step="0.1" value="${v.margem_pct || ''}"></div>
      <div class="field"><label>Faturamento</label><input id="v_fat" disabled value="${v.faturamento ? fmt(v.faturamento) : ''}"></div>
    </div>
    <div class="row">
      <div class="field"><label>Status (funil)</label><select id="v_status">${optStatus}</select></div>
      <div class="field"><label>Mapa de calor</label><select id="v_calor">${optCalor}</select></div>
      <div class="field"><label>📅 Previsão receb. (comissão)</label><input id="v_datarec" type="date" value="${v.data_recebimento || ''}"></div>
    </div>
    <div class="field" id="v_motivo_wrap" style="display:none"><label>Motivo do cancelamento</label>
      <textarea id="v_motivo" rows="2" placeholder="Ex.: crédito negado, cliente desistiu, comprou de outro...">${esc(v.motivo || '')}</textarea></div>
    ${state.segmento === 'locacao' ? `<div class="row">
      <div class="field"><label>Administra o imóvel?</label>
        <select id="v_adm"><option value="0"${!v.administra ? ' selected' : ''}>Não</option><option value="1"${v.administra ? ' selected' : ''}>Sim</option></select></div>
      <div class="field" id="v_taxa_wrap"><label>Taxa de adm % (sobre o aluguel)</label>
        <input id="v_taxaadm" type="number" step="0.1" value="${v.taxa_adm || ''}"></div>
    </div>` : ''}
    <div class="marg-section">
      <div class="marg-head">
        <label>🎁 Receita marginal</label>
        <span class="hint">premiação, comissão de financiamento, etc. — entra nos Recebíveis pela data prevista</span>
        <button type="button" class="ghost marg-add" id="v_marg_add">+ Adicionar</button>
      </div>
      <div id="v_marg_list"></div>
    </div>
    <div class="marg-section">
      <div class="marg-head">
        <label>🧩 Comissão em parcelas</label>
        <span class="hint">quando a comissão entra em 2+ momentos (ex.: 50% assinatura, 50% registro) — a soma fecha o faturamento</span>
        <button type="button" class="ghost marg-add" id="v_parc_add">+ Adicionar</button>
      </div>
      <div id="v_parc_list"></div>
      <div id="v_parc_sum" class="hint" style="margin-top:6px"></div>
    </div>
    <div class="modal-actions">
      <button class="ghost" id="v_cancel">Cancelar</button>
      <button class="primary" id="v_save">${editing ? 'Salvar' : 'Adicionar'}</button>
    </div>`);
  const recalc = () => {
    const fat = (+$('#v_vgv').value || 0) * (+$('#v_margem').value || 0) / 100;
    $('#v_fat').value = fat ? fmt(fat) : '';
  };
  $('#v_vgv').oninput = recalc; $('#v_margem').oninput = recalc;
  const admToggle = () => { const w = $('#v_taxa_wrap'); if (w) w.style.opacity = $('#v_adm').value === '1' ? '1' : '.4'; };
  if ($('#v_adm')) { $('#v_adm').onchange = admToggle; admToggle(); }
  // mostra o campo de motivo só quando o status escolhido é CANCELADA
  const motToggle = () => { const w = $('#v_motivo_wrap'); if (w) w.style.display = $('#v_status').value === m.desistencia ? 'flex' : 'none'; };
  $('#v_status').onchange = motToggle; motToggle();
  // ----- receita marginal (várias por venda) -----
  const margList = $('#v_marg_list');
  const addMargRow = (mg = {}) => {
    const row = document.createElement('div');
    row.className = 'marg-row';
    row.dataset.recebido = mg.recebido ? '1' : '0';
    row.dataset.dataRecebido = mg.data_recebido || '';
    row.innerHTML = `<input class="m-tipo" placeholder="Tipo (ex.: Premiação)" value="${esc(mg.tipo || '')}">
      <input class="m-valor" type="number" step="100" placeholder="Valor R$" value="${mg.valor || ''}">
      <input class="m-data" type="date" title="Previsão de recebimento" value="${mg.data_prevista || ''}">
      ${mg.recebido ? '<span class="m-rec" title="Já recebido">✓</span>' : ''}
      <button type="button" class="m-del" title="Remover">×</button>`;
    row.querySelector('.m-del').onclick = () => row.remove();
    margList.appendChild(row);
    return row;
  };
  marginais.forEach(addMargRow);
  $('#v_marg_add').onclick = () => addMargRow().querySelector('.m-tipo').focus();
  // ----- parcelas da comissão -----
  const parcList = $('#v_parc_list'), parcSum = $('#v_parc_sum');
  const fatAtual = () => (+$('#v_vgv').value || 0) * (+$('#v_margem').value || 0) / 100 || +v.faturamento || 0;
  const parcRows = () => $$('#v_parc_list .marg-row');
  const parcSoma = () => parcRows().reduce((s, r) => s + (+r.querySelector('.p-valor').value || 0), 0);
  const parcRefresh = () => {
    const rows = parcRows();
    if (!rows.length) { parcSum.innerHTML = ''; return; }
    const soma = parcSoma(), fat = fatAtual(), ok = Math.abs(soma - fat) < 0.01;
    parcSum.innerHTML = `soma das parcelas <b style="color:${ok ? 'var(--pos)' : 'var(--neg)'}">${fmt(soma)}</b> / faturamento ${fmt(fat)}` + (ok ? ' ✓' : ` · <b style="color:var(--neg)">difere ${fmt(Math.abs(soma - fat))}</b>`);
  };
  const addParcRow = (p = {}) => {
    const row = document.createElement('div');
    row.className = 'marg-row';
    row.innerHTML = `<input class="p-valor" type="number" step="0.01" placeholder="Valor R$" value="${p.valor || ''}">
      <input class="p-data" type="date" title="Data (previsão ou, se recebida, do recebimento)" value="${p.data_recebido || p.data_prevista || ''}">
      <label class="hint" style="display:flex;align-items:center;gap:4px;white-space:nowrap"><input type="checkbox" class="p-rec" ${p.recebido ? 'checked' : ''}> recebida</label>
      <button type="button" class="m-del" title="Remover">×</button>`;
    row.querySelector('.m-del').onclick = () => { row.remove(); parcRefresh(); };
    row.querySelector('.p-valor').oninput = parcRefresh;
    parcList.appendChild(row);
    return row;
  };
  parcelas.forEach(addParcRow);
  parcRefresh();
  $('#v_parc_add').onclick = () => {
    // primeira vez: já sugere 2 parcelas (metade cada) para o caso clássico
    if (!parcRows().length) {
      const fat = fatAtual(), meta = +(fat / 2).toFixed(2);
      addParcRow({ valor: meta, data_prevista: $('#v_datarec').value || '' });
      addParcRow({ valor: +(fat - meta).toFixed(2), data_prevista: '' });
    } else addParcRow();
    parcRefresh();
    parcRows().slice(-1)[0].querySelector('.p-valor').focus();
  };
  $('#v_cancel').onclick = closeModal;
  $('#v_save').onclick = async () => {
    const body = {
      ano: +$('#v_ano').value || state.ano, mes: +$('#v_mes').value, segmento: state.segmento,
      cliente: $('#v_cliente').value.trim(), produto: $('#v_produto').value.trim(),
      filial: $('#v_filial').value, corretor: $('#v_corretor').value,
      opcionista: $('#v_opcionista').value, gerente: $('#v_gerente').value,
      vgv: +$('#v_vgv').value || 0, margem_pct: +$('#v_margem').value || 0,
      status: $('#v_status').value, mapa_calor: $('#v_calor').value,
      data_recebimento: $('#v_datarec').value || null,
    };
    if (body.status === m.desistencia) body.motivo = ($('#v_motivo')?.value || '').trim();
    if (state.segmento === 'locacao' && $('#v_adm')) {
      body.administra = $('#v_adm').value === '1' ? 1 : 0;
      body.taxa_adm = body.administra ? (+$('#v_taxaadm').value || 0) : 0;
    }
    if (!body.cliente) return alert('Informe o cliente.');
    let vid = v.id;
    if (editing) await api(`api/vendas/${v.id}`, { method: 'PUT', body: JSON.stringify(body) });
    else { const nova = await api('api/vendas', { method: 'POST', body: JSON.stringify(body) }); vid = nova.id; }
    // salva as receitas marginais (substitui todas as da venda)
    const margs = $$('#v_marg_list .marg-row').map((r) => ({
      tipo: r.querySelector('.m-tipo').value.trim(),
      valor: +r.querySelector('.m-valor').value || 0,
      data_prevista: r.querySelector('.m-data').value || null,
      recebido: r.dataset.recebido === '1' ? 1 : 0,
      data_recebido: r.dataset.dataRecebido || null,
    })).filter((mg) => mg.valor > 0);
    await api(`api/vendas/${vid}/marginais`, { method: 'PUT', body: JSON.stringify(margs) });
    // salva as parcelas da comissão (substitui todas as da venda)
    const parcs = $$('#v_parc_list .marg-row').map((r) => {
      const rec = r.querySelector('.p-rec').checked;
      const data = r.querySelector('.p-data').value || null;
      return { valor: +r.querySelector('.p-valor').value || 0, data_prevista: data, recebido: rec ? 1 : 0, data_recebido: rec ? data : null };
    }).filter((p) => p.valor > 0);
    await api(`api/vendas/${vid}/parcelas`, { method: 'PUT', body: JSON.stringify(parcs) });
    closeModal();
    state.meta = await api('api/meta?' + sq()); // anos podem ter mudado
    if (body.ano !== state.ano) { // cadastrou em outro ano -> vai pra lá pra você ver
      state.ano = body.ano;
      const selAno = $('#anoSel');
      if (![...selAno.options].some((o) => +o.value === body.ano)) selAno.add(new Option(body.ano, body.ano));
      selAno.value = body.ano;
    }
    render();
  };
}

// ============ MODAL: REGISTRAR DESISTÊNCIA (cancelar proposta) ============
function modalCancelar(id, tr) {
  const cli = $('[data-field=cliente]', tr)?.value?.trim() || 'esta proposta';
  const prod = $('[data-field=produto]', tr)?.value?.trim() || '';
  openModal(`
    <h2>🚫 Registrar desistência</h2>
    <div class="hint" style="margin:-6px 0 14px"><b>${esc(cli)}</b>${prod ? ' · ' + esc(prod) : ''} — a linha sai da planilha de vendas e passa para o relatório de desistências.</div>
    <div class="field"><label>Motivo da desistência / cancelamento</label>
      <textarea id="ca_motivo" rows="3" placeholder="Ex.: crédito negado, cliente desistiu, comprou de outro, etc."></textarea></div>
    <div class="modal-actions">
      <button class="ghost" id="ca_cancel">Voltar</button>
      <button class="danger" id="ca_ok">Confirmar desistência</button></div>`);
  $('#ca_motivo').focus();
  // "Voltar" sem confirmar: re-renderiza p/ devolver o select de status ao valor original
  $('#ca_cancel').onclick = () => { closeModal(); renderFunil(); };
  $('#ca_ok').onclick = async () => {
    await api(`api/vendas/${id}`, { method: 'PUT', body: JSON.stringify({ status: state.meta.desistencia, motivo: $('#ca_motivo').value.trim() }) });
    closeModal();
    $('#status').textContent = `${cli} movida para o relatório de desistências.`;
    renderFunil();
  };
}

// ============ MODAL: RELATÓRIO DE DESISTÊNCIAS ============
async function modalDesistencias() {
  const rows = await api(`api/desistencias?ano=${state.ano}&${sq()}`);
  const termo = state.segmento === 'locacao' ? 'locações' : 'vendas';
  const corpo = rows.length ? `
    <table><thead><tr>
      <th class="l">Mês</th><th class="l">Cliente</th><th class="l">Corretor</th><th>VGV</th><th class="l">Motivo</th><th></th></tr></thead>
    <tbody>${rows.map((v) => `<tr data-id="${v.id}">
      <td class="l">${MESES[v.mes - 1].slice(0, 3)}</td>
      <td class="l cli">${esc(v.cliente)}<div class="prod">${esc(v.produto || '')}</div></td>
      <td class="l">${esc(v.corretor || '—')}</td>
      <td class="money">${v.vgv ? fmt(v.vgv) : '—'}</td>
      <td class="l"><input class="cell-inp d-motivo" data-id="${v.id}" value="${esc(v.motivo || '')}" placeholder="motivo…"></td>
      <td><div class="row-actions">
        <button class="icon-btn d-revert" data-id="${v.id}" title="Retornar ao quadro de vendas (mês atual, status INTERESSE)">↩</button>
        <button class="icon-btn danger d-del" data-id="${v.id}" title="Excluir definitivamente">🗑️</button>
      </div></td></tr>`).join('')}</tbody></table>`
    : `<div class="empty">Nenhuma desistência registrada em ${state.ano}.</div>`;
  openModal(`<h2>🚫 Desistências ${state.ano} · ${termo === 'locações' ? 'Locações' : 'Vendas'}</h2>
    <div class="hint" style="margin-bottom:12px">Propostas canceladas — saíram da planilha de ${termo}. Edite o motivo direto na linha; <b>↩</b> devolve a linha ao funil, <b>🗑️</b> exclui de vez. ${rows.length ? `${rows.length} registro(s).` : ''}</div>
    <div class="modal-wide" style="overflow:auto;max-height:60vh">${corpo}</div>
    <div class="modal-actions"><button class="ghost" id="d_close">Fechar</button></div>`);
  $('#d_close').onclick = closeModal;
  $$('.d-motivo').forEach((inp) => inp.onchange = async () => {
    await api(`api/vendas/${inp.dataset.id}`, { method: 'PUT', body: JSON.stringify({ motivo: inp.value.trim() }) });
    inp.classList.add('saved'); setTimeout(() => inp.classList.remove('saved'), 700);
  });
  $$('.d-revert').forEach((b) => b.onclick = async () => {
    if (!confirm('Retornar esta venda ao quadro de vendas? Ela volta para o mês atual com status INTERESSE.')) return;
    const hoje = new Date();
    await api(`api/vendas/${b.dataset.id}`, { method: 'PUT', body: JSON.stringify({ status: 'INTERESSE', ano: hoje.getFullYear(), mes: hoje.getMonth() + 1, motivo: '' }) });
    modalDesistencias(); render();
  });
  $$('.d-del').forEach((b) => b.onclick = async () => {
    if (!confirm('Excluir este registro definitivamente? Não dá para desfazer.')) return;
    await api(`api/vendas/${b.dataset.id}`, { method: 'DELETE' });
    modalDesistencias();
  });
}

// ============ MODAL: CADASTROS ============
async function modalCadastros() {
  const cads = await api('api/cadastros');
  const tipos = [['gerente', 'Gerentes'], ['corretor', 'Corretores'], ['opcionista', 'Opcionistas'], ['filial', 'Filiais']];
  const render = () => tipos.map(([tipo, titulo]) => `
    <div class="cadcol"><h4>${titulo}</h4>
      <div class="tag-list" data-tipo="${tipo}">
        ${cads.filter((c) => c.tipo === tipo).map((c) => `<span class="t">${c.nome} <b data-del="${c.id}">×</b></span>`).join('')}
      </div>
      <div class="row"><input placeholder="Adicionar ${titulo.toLowerCase().slice(0, -1)}..." data-add="${tipo}"></div>
    </div>`).join('');
  openModal(`<h2>👥 Cadastros</h2><div class="modal-wide">${render()}</div>
    <div class="modal-actions"><button class="ghost" id="c_close">Fechar</button></div>`);
  $('#c_close').onclick = closeModal;
  $$('[data-del]').forEach((b) => b.onclick = async () => {
    await api(`api/cadastros/${b.dataset.del}`, { method: 'DELETE' });
    state.meta = await api('api/meta'); modalCadastros();
  });
  $$('[data-add]').forEach((inp) => inp.onkeydown = async (e) => {
    if (e.key !== 'Enter' || !inp.value.trim()) return;
    await api('api/cadastros', { method: 'POST', body: JSON.stringify({ tipo: inp.dataset.add, nome: inp.value.trim() }) });
    state.meta = await api('api/meta'); modalCadastros();
  });
}

// ============ MODAL: METAS ============
async function modalMetas() {
  const d = await api(`api/dashboard?ano=${state.ano}&${sq()}`);
  openModal(`<h2>🎯 Metas ${state.ano} · ${state.segmento === 'locacao' ? 'Locações' : 'Vendas'}</h2>
    <div class="field"><label>Meta anual de VGV (R$)</label><input id="m_vgv" type="number" value="${d.meta_vgv || 0}"></div>
    <div class="field"><label>Meta anual de faturamento (R$)</label><input id="m_fat" type="number" value="${d.meta_fat || 0}"></div>
    <div class="modal-actions"><button class="ghost" id="m_close">Cancelar</button><button class="primary" id="m_save">Salvar</button></div>`);
  $('#m_close').onclick = closeModal;
  $('#m_save').onclick = async () => {
    await api(`api/metas/${state.ano}`, { method: 'PUT', body: JSON.stringify({ segmento: state.segmento, meta_vgv: +$('#m_vgv').value || 0, meta_fat: +$('#m_fat').value || 0 }) });
    closeModal(); render();
  };
}

// ============ modal helpers ============
function openModal(html) { $('#modalBox').innerHTML = html; relabelLoc($('#modalBox')); $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

boot().catch((e) => { $('#view').innerHTML = `<div class="empty">Erro ao carregar: ${e.message}</div>`; });
