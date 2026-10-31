// ===== Viabilidade ImovelUm — frontend =====
const $ = (s, el = document) => el.querySelector(s);
const api = (u, o) => fetch(u, o).then((r) => r.json());
const post = (u, b) => api(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const put = (u, b) => api(u, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const del = (u) => api(u, { method: 'DELETE' });

// padrão único de moeda: R$ 19.512,33 (R$, milhar com ponto, 2 casas decimais), sem abreviar
const brl = (n) => (n < 0 ? '-' : '') + 'R$ ' + Math.abs(Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const brlk = (n) => brl(n);
const pct = (n) => (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 }) + '%';
// aceita "R$ 19.512,33" (formatado) e número cru "19512.33" (durante a edição) -> número
const parseMoney = (s) => { let t = String(s).replace(/[^\d.,-]/g, ''); if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.'); const n = Number(t); return isNaN(n) ? 0 : n; };
// campo de dinheiro editável: exibe "R$ 19.512,33"; ao focar mostra o número cru p/ digitar
const moneyInp = (val, attrs = '', cls = '') => `<input type="text" inputmode="decimal" class="moneyinp ${cls}" value="${val ? brl(val) : ''}" ${attrs}>`;
const cls = (n) => (Number(n) >= 0 ? 'pos' : 'neg');

const State = { ano: new Date().getFullYear(), tab: 'dashboard', meta: null };
const view = $('#view');
let statusT;
function status(msg) { $('#status').textContent = msg; clearTimeout(statusT); statusT = setTimeout(() => ($('#status').textContent = ''), 2500); }

const ADD_LABEL = { orcado: '+ Custo', folha: '+ Colaborador', previsao: '+ Previsão', dashboard: '', cenarios: '' };

// ---------- bootstrap ----------
async function boot() {
  State.meta = await api('api/meta');
  const sel = $('#anoSel');
  sel.innerHTML = State.meta.anos.map((a) => `<option ${a === State.ano ? 'selected' : ''}>${a}</option>`).join('');
  sel.onchange = () => { State.ano = parseInt(sel.value); render(); };
  $('#tabs').onclick = (e) => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    [...$('#tabs').children].forEach((x) => x.classList.toggle('active', x === b));
    State.tab = b.dataset.tab; render();
  };
  $('#btnAdd').onclick = () => openAdd();
  render();
}

async function render() {
  $('#anoTitulo').textContent = State.ano;
  const btn = $('#btnAdd');
  btn.textContent = ADD_LABEL[State.tab] || '';
  btn.style.display = ADD_LABEL[State.tab] ? '' : 'none';
  if (State.tab === 'dashboard') return renderDashboard();
  if (State.tab === 'orcado') return renderOrcado();
  if (State.tab === 'folha') return renderFolha();
  if (State.tab === 'previsao') return renderPrevisao();
  if (State.tab === 'cenarios') return renderCenarios();
}

// ---------- DASHBOARD ----------
async function renderDashboard() {
  const d = await api(`api/dashboard?ano=${State.ano}`);
  $('#cards').innerHTML = `
    <div class="card"><div class="lbl">Custo / mês</div><div class="val">${brl(d.custo_mensal)}</div><div class="sub">fixo ${brlk(d.custo_fixo)} · var ${brlk(d.custo_variavel)}</div></div>
    <div class="card gold"><div class="lbl">Faturamento proj. (ano)</div><div class="val">${brl(d.faturamento_anual)}</div><div class="sub">${brl(d.faturamento_mensal_medio)}/mês</div></div>
    <div class="card ${d.resultado_anual >= 0 ? 'pos' : ''}"><div class="lbl">Resultado (ano)</div><div class="val">${brl(d.resultado_anual)}</div><div class="sub">margem ${pct(d.margem_pct)}</div></div>`;

  const maxRec = Math.max(1, ...d.por_mes.map((m) => m.receita));
  const mesBars = d.por_mes.map((m) => `
    <div class="mes-row">
      <span class="mes-lbl">${m.nome}</span>
      <div class="mes-bar"><i style="width:${(m.receita / maxRec * 100).toFixed(1)}%"></i></div>
      <span class="mes-val">${brlk(m.receita)}</span>
      <span class="mes-val ${cls(m.resultado)}">${brlk(m.resultado)}</span>
    </div>`).join('');

  const maxCen = Math.max(1, ...d.por_centro.map((c) => c.total));
  const centroBars = d.por_centro.sort((a, b) => b.total - a.total).map((c) => `
    <div class="mes-row"><span class="mes-lbl" style="width:120px">${c.centro_custo}</span>
      <div class="mes-bar"><i style="width:${(c.total / maxCen * 100).toFixed(1)}%"></i></div>
      <span class="mes-val">${brlk(c.total)}</span></div>`).join('');

  const grupoLbl = { venda: 'Vendas (comissão)', locacao: 'Locação', adm: 'Administração' };
  const grupos = d.por_grupo.filter((g) => g.faturamento).map((g) =>
    `<div class="mes-row"><span class="mes-lbl" style="width:150px">${grupoLbl[g.grupo] || g.grupo}</span>
      <span class="mes-val" style="width:auto;flex:1;text-align:left;color:var(--gold)">${brl(g.faturamento)}</span></div>`).join('');

  view.innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="lbl">Custo mensal</div><div class="val">${brl(d.custo_mensal)}</div><div class="sub">${brl(d.custo_anual)}/ano</div></div>
      <div class="kpi gold"><div class="lbl">VGV projetado (ano)${d.vgv_ano_fonte === 'real' ? ' 🔗' : ''}</div><div class="val">${brlk(d.vgv_anual)}</div><div class="sub">${d.vgv_ano_fonte === 'real' ? `realizado ${brlk(d.realizado_ytd)} + run-rate · com. ${pct(d.comissao_ano_pct)}` : `comissão média ${pct(d.comissao_media_pct)}`}</div></div>
      <div class="kpi"><div class="lbl">Break-even de VGV / mês</div><div class="val">${brlk(d.breakeven_vgv)}</div><div class="sub">${d.atual_fonte === 'real' ? 'mix real · cobre o custo' : 'VGV p/ cobrir o custo'}</div></div>
      <div class="kpi ${cls(d.resultado_anual)}"><div class="lbl">Resultado anual</div><div class="val">${brl(d.resultado_anual)}</div><div class="sub">margem ${pct(d.margem_pct)}</div></div>
    </div>
    ${d.breakeven_por_unidade && d.breakeven_por_unidade.length ? `<div class="panel">
      <h3>🎯 Break-even por unidade <span class="hint">(cota e comissão REAIS da média dos 2 meses fechados · quanto cada uma precisa vender p/ empatar)</span></h3>
      <div class="tbl-scroll"><table><thead><tr><th class="l">Unidade</th><th>Cota</th><th>Comissão</th><th>Vende hoje/mês</th><th>Precisa vender</th><th>Falta</th></tr></thead>
      <tbody>${d.breakeven_por_unidade.map((u) => `<tr>
        <td class="l">${u.unidade}</td><td>${pct(u.cota)}</td><td>${pct(u.comissao_pct)}</td>
        <td>${brl(u.vgv_atual)}</td><td><b>${brl(u.breakeven)}</b></td>
        <td style="color:${u.falta > 0 ? '#f87171' : '#34d399'}">${u.falta > 0 ? brl(u.falta) : '✓ ok'}</td></tr>`).join('')}
        <tr class="subtot"><td class="l">TOTAL</td><td>100%</td><td>${pct(d.comissao_media_pct)}</td><td>${brl(d.vgv_atual)}</td><td><b>${brl(d.breakeven_vgv)}</b></td><td>${brl(Math.max(0, d.breakeven_vgv - d.vgv_atual))}</td></tr>
      </tbody></table></div>
      <p class="hint">"Atual" = média real de ${d.atual_meses ? d.atual_meses.map((m) => ['', 'jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][m.mes] + '/' + m.ano).reverse().join(' + ') : '2 meses'} (só assinadas, do sistema de Vendas). O mês em curso fica de fora e rola sozinho todo mês.</p>
    </div>` : ''}
    ${d.breakeven_caixa ? (() => {
      const M = ['', 'jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
      const nm = (ym) => { const [y, m] = ym.split('-'); return M[+m] + '/' + y; };
      const c = d.breakeven_caixa.corrente, an = d.breakeven_caixa.anterior;
      return `<div class="panel">
      <h3>⚖️ Break-even de caixa <span class="hint">(custo real do Cash Flow, sem repasses · previsão de recebimento, sem PJ Bank)</span></h3>
      <div class="two-col" style="margin-top:8px">
        <div><div class="hint" style="margin-bottom:4px">Mês corrente · ${nm(c.ym)}</div>
          <table style="width:100%"><tbody>
            <tr><td>Custo real (já saiu)</td><td class="num" style="color:#f87171">${brl(c.custo_real)}</td></tr>
            <tr><td>Custo orçado (previsto)</td><td class="num" style="color:#f87171">${brl(c.custo_orcado)}</td></tr>
            <tr style="font-weight:700;border-top:1px solid var(--line)"><td>Custo total</td><td class="num">${brl(c.custo_total)}</td></tr>
            <tr><td>Previsão de recebimento</td><td class="num" style="color:#34d399">${brl(c.receb_total)}</td></tr>
            <tr style="font-weight:800;border-top:2px solid var(--gold)"><td>Resultado previsto</td><td class="num ${cls(c.resultado)}">${brl(c.resultado)}</td></tr>
          </tbody></table></div>
        <div><div class="hint" style="margin-bottom:4px">Último mês fechado · ${nm(an.ym)}</div>
          <table style="width:100%"><tbody>
            <tr><td>Custo real</td><td class="num" style="color:#f87171">${brl(an.custo)}</td></tr>
            <tr><td>Recebido (real)</td><td class="num" style="color:#34d399">${brl(an.recebimento)}</td></tr>
            <tr style="font-weight:800;border-top:2px solid var(--gold)"><td>Resultado</td><td class="num ${cls(an.resultado)}">${brl(an.resultado)} ${an.resultado >= 0 ? '🟢' : '🔴'}</td></tr>
          </tbody></table></div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;background:rgba(212,175,55,.08);border:1px solid var(--gold);border-radius:10px;padding:11px 14px;margin-top:14px">
        <span style="font-size:13px">📊 <b>Acúmulo de caixa</b> · ${nm(an.ym)} (realizado) + ${nm(c.ym)} (projetado)</span>
        <b style="font-size:20px" class="${cls(d.breakeven_caixa.acumulo)}">${brl(d.breakeven_caixa.acumulo)}</b>
      </div>
      <p class="hint">🎯 Precisa receber <b style="color:var(--gold)">${brl(c.breakeven)}</b> pra empatar ${nm(c.ym)}${c.falta > 0 ? ` · faltam <b style="color:#f87171">${brl(c.falta)}</b> vs a previsão de recebimento` : ` · <b style="color:#34d399">a previsão já cobre</b>`}.</p>
    </div>`; })() : ''}
    <div class="two-col">
      <div class="panel"><h3>Receita projetada × resultado por mês <span class="hint">(barra = receita · nº azul = receita · nº colorido = resultado)</span></h3><div class="mes-chart">${mesBars}</div></div>
      <div class="panel">
        <h3>Custo por centro</h3><div class="mes-chart">${centroBars}</div>
        <h3 style="margin-top:18px">Faturamento por origem</h3><div class="mes-chart">${grupos || '<div class="empty">sem previsões</div>'}</div>
      </div>
    </div>`;
}

// ---------- ORÇADO ----------
let custosCache = [];
async function renderOrcado() {
  $('#cards').innerHTML = '';
  custosCache = await api(`api/custos?ano=${State.ano}`);
  const centros = State.meta.centros;
  const porCentro = {}; centros.forEach((c) => (porCentro[c] = []));
  custosCache.forEach((c) => { (porCentro[c.centro_custo] ||= []).push(c); });
  const total = custosCache.filter((c) => c.ativo).reduce((a, c) => a + c.valor, 0);
  const nOff = custosCache.filter((c) => !c.ativo).length;

  let rows = '';
  for (const centro of Object.keys(porCentro)) {
    const itens = porCentro[centro];
    if (!itens.length) continue;
    const sub = itens.filter((c) => c.ativo).reduce((a, c) => a + c.valor, 0);
    rows += `<tr class="grouphdr"><td class="l" colspan="5">${centro}</td></tr>`;
    rows += itens.map((c) => rowCusto(c)).join('');
    rows += `<tr class="subtot"><td class="l" colspan="3">Subtotal ${centro}</td><td class="num">${brl(sub)}</td><td></td></tr>`;
  }
  view.innerHTML = `
    <div class="panel">
      <h3>Orçamento mensal — total ${brl(total)} <span class="hint">(${brl(total * 12)}/ano${nOff ? ` · ${nOff} despesa(s) desligada(s), fora da conta` : ''} · edite direto na tabela)</span></h3>
      <div class="tbl-scroll"><table class="editable">
        <thead><tr><th></th><th class="l">Categoria</th><th class="l">Tipo</th><th>Valor / mês</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
}
function rowCusto(c) {
  const folha = c.origem === 'folha';
  return `<tr data-id="${c.id}" class="${c.ativo ? '' : 'off'}">
    <td style="text-align:center">${toggleBtn(c.ativo)}</td>
    <td class="l"><input value="${c.categoria}" data-f="categoria" ${folha ? 'disabled title="Sincronizado pela aba Folha"' : ''}></td>
    <td class="l"><select data-f="tipo"><option value="fixo" ${c.tipo === 'fixo' ? 'selected' : ''}>fixo</option><option value="variavel" ${c.tipo === 'variavel' ? 'selected' : ''}>variável</option></select></td>
    <td class="num">${moneyInp(c.valor, `data-f="valor" ${folha ? 'disabled' : ''}`)}</td>
    <td>${folha ? '<span class="hint">folha</span>' : `<button class="icon-btn danger" data-del>✕</button>`}</td>
  </tr>`;
}
// botão liga/desliga: verde "ON" = ativo, cinza "OFF" = desligado
function toggleBtn(ativo) {
  return `<button class="icon-btn tgl ${ativo ? 'on' : ''}" data-toggle title="${ativo ? 'Desligar (tira da conta)' : 'Ligar (volta para a conta)'}">${ativo ? 'ON' : 'OFF'}</button>`;
}

// ---------- FOLHA ----------
async function renderFolha() {
  $('#cards').innerHTML = '';
  const rows = await api(`api/colaboradores?ano=${State.ano}`);
  const total = rows.filter((r) => r.ativo).reduce((a, r) => a + r.salario, 0);
  view.innerHTML = `
    <div class="panel">
      <h3>Folha de pagamento — ${brl(total)}/mês <span class="hint">(alimenta a categoria FOLHA DE PAGAMENTO no Orçado)</span></h3>
      <div class="tbl-scroll"><table class="editable">
        <thead><tr><th class="l">Nome</th><th class="l">Cargo</th><th>Salário</th><th>Ativo</th><th></th></tr></thead>
        <tbody>${rows.map((c) => `<tr data-id="${c.id}">
          <td class="l"><input value="${c.nome}" data-f="nome"></td>
          <td class="l"><input value="${c.cargo || ''}" data-f="cargo"></td>
          <td class="num">${moneyInp(c.salario, 'data-f="salario"')}</td>
          <td style="text-align:center"><input type="checkbox" style="width:auto" ${c.ativo ? 'checked' : ''} data-f="ativo"></td>
          <td style="white-space:nowrap">
            <span class="grip" title="Arraste para reordenar">⠿</span>
            <button class="icon-btn danger" data-del>✕</button></td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`;
  ligarArrasteFolha();
}

// arrastar para reordenar a folha (pega pelo "punho" ⠿; solta = grava a nova ordem)
function ligarArrasteFolha() {
  const tbody = view.querySelector('.editable tbody'); if (!tbody) return;
  tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
    const grip = tr.querySelector('.grip'); if (!grip) return;
    // só arrasta quando pega no punho (senão o arraste "rouba" o clique dos inputs)
    grip.addEventListener('mousedown', () => { tr.draggable = true; });
    grip.addEventListener('touchstart', () => { tr.draggable = true; }, { passive: true });
    tr.addEventListener('dragstart', (e) => { tr.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    tr.addEventListener('dragend', async () => {
      tr.draggable = false; tr.classList.remove('dragging');
      const ids = [...tbody.querySelectorAll('tr[data-id]')].map((r) => +r.dataset.id);
      try { await post('api/colaboradores/reordenar', { ids }); status('Reordenado ✓'); }
      catch { status('Erro ao reordenar'); renderFolha(); }
    });
  });
  tbody.addEventListener('dragover', (e) => {
    e.preventDefault();
    const arrastando = tbody.querySelector('tr.dragging'); if (!arrastando) return;
    const alvo = [...tbody.querySelectorAll('tr[data-id]:not(.dragging)')].find((r) => {
      const b = r.getBoundingClientRect(); return e.clientY < b.top + b.height / 2;
    });
    if (alvo) tbody.insertBefore(arrastando, alvo); else tbody.appendChild(arrastando);
  });
}

// ---------- PREVISIBILIDADE ----------
async function renderPrevisao() {
  $('#cards').innerHTML = '';
  const rows = await api(`api/previsoes?ano=${State.ano}`);
  const meses = State.meta.meses;
  const grupoLbl = { venda: 'Vendas (VGV → comissão)', locacao: 'Locação', adm: 'Administração' };
  const porGrupo = {}; rows.forEach((r) => (porGrupo[r.grupo] ||= []).push(r));
  const totFat = rows.filter((r) => r.ativo).reduce((a, r) => a + r.faturamento, 0);
  const nOff = rows.filter((r) => !r.ativo).length;
  const colspan = meses.length + 5;

  let body = '';
  for (const g of State.meta.grupos) {
    const itens = porGrupo[g]; if (!itens || !itens.length) continue;
    body += `<tr class="grouphdr"><td class="l" colspan="${colspan}">${grupoLbl[g] || g}</td></tr>`;
    body += itens.map((p) => `<tr data-id="${p.id}" class="${p.ativo ? '' : 'off'}">
      <td style="text-align:center">${toggleBtn(p.ativo)}</td>
      <td class="l"><input value="${p.canal}" data-f="canal" style="width:140px"></td>
      ${meses.map((_, i) => { const f = 'm' + String(i + 1).padStart(2, '0'); return `<td class="num">${moneyInp(p[f], `data-f="${f}"`, 'mes')}</td>`; }).join('')}
      <td class="num"><b>${brlk(p.total)}</b></td>
      <td class="num"><input type="number" step="0.1" value="${p.comissao_pct}" data-f="comissao_pct" style="width:60px"></td>
      <td class="num" style="color:var(--gold)"><b>${brlk(p.faturamento)}</b></td>
    </tr>`).join('');
  }
  view.innerHTML = `
    <div class="panel">
      <h3>Previsibilidade de receita — faturamento projetado ${brl(totFat)}/ano <span class="hint">(VGV mês a mês × comissão · locação/adm usam 100%${nOff ? ` · ${nOff} canal(is) desligado(s)` : ''})</span></h3>
      <div class="tbl-scroll"><table class="editable">
        <thead><tr><th></th><th class="l">Canal</th>${meses.map((m) => `<th>${m}</th>`).join('')}<th>Total</th><th>%</th><th>Fatur.</th></tr></thead>
        <tbody>${body || `<tr><td class="empty" colspan="${colspan}">sem previsões</td></tr>`}</tbody>
      </table></div>
    </div>`;
}

// ---------- CENÁRIOS ----------
async function renderCenarios() {
  $('#cards').innerHTML = '';
  const cens = await api(`api/cenarios?ano=${State.ano}`);
  view.innerHTML = `<div class="cenarios">${cens.map((c) => cardCenario(c)).join('')}</div>
    <div class="panel"><h3>Como ler</h3><p class="hint">Cada cenário é uma meta de VGV mensal por unidade. Receita = Σ(VGV × comissão) + receitas fixas (adm/locação). Resultado = receita − custo mensal (puxado do Orçado, ${brl(cens[0]?.custo || 0)}). Edite o VGV ou a % de cada linha para simular.</p></div>`;
}
function cardCenario(c) {
  const ro = c.readonly;
  const MES = ['', 'jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const linhas = c.linhas.map((l) => {
    const ehFixa = l.receita_fixa > 0 || (!l.vgv && !l.comissao_pct);
    if (ro && !ehFixa) { // linha real (vinda do Vendas): read-only
      return `<tr><td class="l">${l.unidade}</td><td class="num">${brl(l.vgv)}</td><td class="num">${pct(l.comissao_pct)}</td></tr>`;
    }
    return `<tr data-lin="${l.id}">
      <td class="l">${l.unidade}</td>
      ${ehFixa
        ? `<td colspan="2" class="num">${moneyInp(l.receita_fixa, 'data-f="receita_fixa" style="width:110px"')}</td>`
        : `<td class="num">${moneyInp(l.vgv, 'data-f="vgv" style="width:120px"')}</td>
           <td class="num"><input type="number" step="0.1" value="${l.comissao_pct}" data-f="comissao_pct" style="width:55px"></td>`}
    </tr>`;
  }).join('');
  const selo = ro ? `<span class="hint" style="font-weight:400;font-size:11px">· 🔗 real (média ${c.meses ? c.meses.map((m) => MES[m.mes]).reverse().join('+') : '2m'}, do Vendas)</span>` : '';
  return `<div class="cenario ${ro ? '' : 'editable'}" data-cen="${c.id}">
    <h3>${c.nome} ${selo}<span class="res ${cls(c.resultado)}">${brlk(c.resultado)}</span></h3>
    <table><thead><tr><th class="l">Unidade</th><th>VGV</th><th>%</th></tr></thead><tbody>${linhas}</tbody></table>
    <div class="foot-res">
      <div><span>VGV total</span><b>${brlk(c.vgv)}</b></div>
      <div><span>Receita</span><b style="color:var(--gold)">${brl(c.receita)}</b></div>
      <div><span>Custo</span><b>${brl(c.custo)}</b></div>
      <div class="big"><span>Resultado</span><b class="${cls(c.resultado)}">${brl(c.resultado)}</b></div>
    </div>
  </div>`;
}

// ---------- edição inline (event delegation) ----------
view.addEventListener('change', async (e) => {
  const inp = e.target.closest('input,select'); if (!inp) return;
  const f = inp.dataset.f; if (!f) return;
  const val = inp.type === 'checkbox' ? (inp.checked ? 1 : 0)
    : inp.classList.contains('moneyinp') ? parseMoney(inp.value)
    : (inp.type === 'number' ? Number(inp.value) : inp.value);
  const trCusto = inp.closest('tr[data-id]');
  const linCen = inp.closest('tr[data-lin]');
  try {
    if (linCen) { await put(`api/cenario_linhas/${linCen.dataset.lin}`, { [f]: val }); status('Cenário atualizado'); return renderCenarios(); }
    if (!trCusto) return;
    const id = trCusto.dataset.id;
    const ep = State.tab === 'orcado' ? 'custos' : State.tab === 'folha' ? 'colaboradores' : 'previsoes';
    await put(`api/${ep}/${id}`, { [f]: val });
    status('Salvo ✓');
    // recalcula totais nas abas que dependem de soma
    if (State.tab === 'previsao') renderPrevisao();
    else if (State.tab === 'folha' && f === 'salario') { /* folha sincroniza no back */ }
    else if (State.tab === 'orcado') renderOrcado();
  } catch { status('Erro ao salvar'); }
});
// campo de dinheiro: ao focar mostra o número cru p/ editar; ao sair, reformata "R$ ..."
view.addEventListener('focusin', (e) => { const i = e.target; if (i.classList && i.classList.contains('moneyinp')) { const n = parseMoney(i.value); i.value = n ? String(n) : ''; if (i.select) i.select(); } });
view.addEventListener('focusout', (e) => { const i = e.target; if (i.classList && i.classList.contains('moneyinp')) { const n = parseMoney(i.value); i.value = n ? brl(n) : ''; } });
view.addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-id]'); if (!tr) return;
  const ep = State.tab === 'orcado' ? 'custos' : State.tab === 'folha' ? 'colaboradores' : 'previsoes';
  // liga/desliga (preserva o valor, só muda se entra na conta)
  const tgl = e.target.closest('[data-toggle]');
  if (tgl) {
    const ativo = tr.classList.contains('off') ? 1 : 0;
    await put(`api/${ep}/${tr.dataset.id}`, { ativo });
    status(ativo ? 'Ligado ✓' : 'Desligado (fora da conta)');
    return render();
  }
  if (e.target.closest('[data-del]')) {
    await del(`api/${ep}/${tr.dataset.id}`); status('Removido');
    render();
  }
});

// ---------- modal de adição ----------
function openAdd() {
  const box = $('#modalBox');
  const cfg = {
    orcado: { titulo: 'Novo custo', campos: `
      <div class="field"><label>Categoria</label><input id="m_categoria" placeholder="ex.: GOOGLE ADS"></div>
      <div class="row">
        <div class="field"><label>Centro de custo</label><select id="m_centro">${State.meta.centros.map((c) => `<option>${c}</option>`).join('')}</select></div>
        <div class="field"><label>Tipo</label><select id="m_tipo"><option value="fixo">fixo</option><option value="variavel">variável</option></select></div>
      </div>
      <div class="field"><label>Valor mensal</label><input id="m_valor" type="number" step="0.01" value="0"></div>` },
    folha: { titulo: 'Novo colaborador', campos: `
      <div class="field"><label>Nome</label><input id="m_nome"></div>
      <div class="field"><label>Cargo</label><input id="m_cargo"></div>
      <div class="field"><label>Salário</label><input id="m_salario" type="number" step="0.01" value="0"></div>` },
    previsao: { titulo: 'Nova previsão', campos: `
      <div class="field"><label>Canal</label><input id="m_canal" placeholder="ex.: BARRA CEO"></div>
      <div class="row">
        <div class="field"><label>Grupo</label><select id="m_grupo"><option value="venda">Vendas</option><option value="locacao">Locação</option><option value="adm">Administração</option></select></div>
        <div class="field"><label>Comissão %</label><input id="m_comissao_pct" type="number" step="0.1" value="2"></div>
      </div>
      <p class="hint">Os valores mês a mês você preenche direto na tabela depois de criar.</p>` },
  }[State.tab];
  if (!cfg) return;
  box.innerHTML = `<h2>${cfg.titulo}</h2>${cfg.campos}
    <div class="modal-actions"><button class="ghost" id="m_cancel">Cancelar</button><button class="primary" id="m_ok">Salvar</button></div>`;
  $('#modal').classList.remove('hidden');
  $('#m_cancel').onclick = () => $('#modal').classList.add('hidden');
  $('#m_ok').onclick = async () => {
    const v = (id) => { const el = $('#' + id); return el ? el.value : undefined; };
    let body = { ano: State.ano };
    if (State.tab === 'orcado') body = { ...body, categoria: v('m_categoria'), centro_custo: v('m_centro'), tipo: v('m_tipo'), valor: v('m_valor') };
    if (State.tab === 'folha') body = { ...body, nome: v('m_nome'), cargo: v('m_cargo'), salario: v('m_salario') };
    if (State.tab === 'previsao') body = { ...body, canal: v('m_canal'), grupo: v('m_grupo'), comissao_pct: v('m_comissao_pct') };
    const ep = State.tab === 'orcado' ? 'custos' : State.tab === 'folha' ? 'colaboradores' : 'previsoes';
    const r = await post(`api/${ep}`, body);
    if (r.erro) return status(r.erro);
    $('#modal').classList.add('hidden'); status('Adicionado ✓'); render();
  };
}

boot();
