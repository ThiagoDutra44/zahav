// Regras de negócio portadas do VBA (ver DOC_PARA_O_CODE no .xlsm).

// ---------- Feriados 2026 (Nacional + RJ + SP) — seção 3 da especificação ----------
export const FERIADOS_2026 = [
  ['2026-01-01', 'Confraternização', 'Nacional'],
  ['2026-01-20', 'São Sebastião', 'RJ'],
  ['2026-01-25', 'Aniversário de São Paulo', 'SP'],
  ['2026-02-16', 'Carnaval', 'Nacional'],
  ['2026-02-17', 'Carnaval', 'Nacional'],
  ['2026-04-03', 'Sexta-feira Santa', 'Nacional'],
  ['2026-04-21', 'Tiradentes', 'Nacional'],
  ['2026-04-23', 'São Jorge', 'RJ'],
  ['2026-05-01', 'Dia do Trabalho', 'Nacional'],
  ['2026-06-04', 'Corpus Christi', 'Nacional'],
  ['2026-09-07', 'Independência', 'Nacional'],
  ['2026-10-12', 'N. S. Aparecida', 'Nacional'],
  ['2026-11-02', 'Finados', 'Nacional'],
  ['2026-11-15', 'Proclamação da República', 'Nacional'],
  ['2026-11-20', 'Consciência Negra', 'Nacional'],
  ['2026-12-25', 'Natal', 'Nacional'],
];

// ---------- Feriados 2027 (Nacional + RJ + SP) ----------
// Móveis a partir da Páscoa 2027 = 28/03: Carnaval = Páscoa−47, Sexta Santa = Páscoa−2,
// Corpus Christi = Páscoa+60. (Mesma conta confere com a lista de 2026: Páscoa 05/04.)
export const FERIADOS_2027 = [
  ['2027-01-01', 'Confraternização', 'Nacional'],
  ['2027-01-20', 'São Sebastião', 'RJ'],
  ['2027-01-25', 'Aniversário de São Paulo', 'SP'],
  ['2027-02-08', 'Carnaval', 'Nacional'],
  ['2027-02-09', 'Carnaval', 'Nacional'],
  ['2027-03-26', 'Sexta-feira Santa', 'Nacional'],
  ['2027-04-21', 'Tiradentes', 'Nacional'],
  ['2027-04-23', 'São Jorge', 'RJ'],
  ['2027-05-01', 'Dia do Trabalho', 'Nacional'],
  ['2027-05-27', 'Corpus Christi', 'Nacional'],
  ['2027-09-07', 'Independência', 'Nacional'],
  ['2027-10-12', 'N. S. Aparecida', 'Nacional'],
  ['2027-11-02', 'Finados', 'Nacional'],
  ['2027-11-15', 'Proclamação da República', 'Nacional'],
  ['2027-11-20', 'Consciência Negra', 'Nacional'],
  ['2027-12-25', 'Natal', 'Nacional'],
];

// ---------- Regra de SINAL (VBA ValorComSinal) ----------
// receita · ... => positivo; todo o resto => negativo
export function ehReceita(centroCusto) {
  return String(centroCusto || '').toLowerCase().includes('receita');
}
// Centro NEUTRO de conciliação: não é receita nem despesa — só corrige o caixa.
// Aceita o sinal que o usuário digitar (+ sobra na conta / − falta na conta).
export const CENTRO_AJUSTE = 'ajuste de caixa';
export function ehAjuste(centroCusto) {
  return String(centroCusto || '').trim().toLowerCase() === CENTRO_AJUSTE;
}
export function valorComSinal(centroCusto, valor) {
  if (ehAjuste(centroCusto)) return Number(valor) || 0;   // respeita o sinal digitado
  const v = Math.abs(Number(valor) || 0);
  return ehReceita(centroCusto) ? v : -v;
}

// ---------- Datas (UTC, sem depender de fuso) ----------
const pad = (n) => String(n).padStart(2, '0');
export function isoToParts(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}
export function partsToISO(y, m, d) {
  return `${y}-${pad(m)}-${pad(d)}`;
}
export function isoToUTC(iso) {
  const { y, m, d } = isoToParts(iso);
  return Date.UTC(y, m - 1, d);
}
export function utcToISO(ms) {
  const dt = new Date(ms);
  return partsToISO(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
export function addDays(iso, n) {
  return utcToISO(isoToUTC(iso) + n * 86400000);
}
export function weekday(iso) {
  return new Date(isoToUTC(iso)).getUTCDay(); // 0 dom .. 6 sáb
}
export function ultimoDiaDoMes(ano, mes) {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

// ---------- Próximo dia útil (VBA ProximoDiaUtil + EhFeriado) ----------
export function ehFeriado(iso, feriadosSet) {
  return feriadosSet.has(iso);
}
export function proximoDiaUtil(iso, feriadosSet) {
  let cur = iso;
  for (let i = 0; i < 14; i++) {
    const wd = weekday(cur);
    if (wd !== 0 && wd !== 6 && !ehFeriado(cur, feriadosSet)) return cur;
    cur = addDays(cur, 1);
  }
  return cur;
}

// Soma N dias úteis a uma data (avança, pulando fim de semana e feriados).
// Usado p/ recebimento (venc + 2 úteis) e repasse (venc + 7 úteis = 2+5), recalculado por mês.
export function addDiasUteis(iso, n, feriadosSet) {
  let cur = iso, c = 0;
  while (c < n) {
    cur = addDays(cur, 1);
    const wd = weekday(cur);
    if (wd !== 0 && wd !== 6 && !ehFeriado(cur, feriadosSet)) c++;
  }
  return cur;
}

const DIAS_SEMANA = { domingo: 0, segunda: 1, seg: 1, terça: 2, terca: 2, ter: 2, quarta: 3, qua: 3, quinta: 4, qui: 4, sexta: 5, sex: 5, sábado: 6, sabado: 6 };

// ---------- Geração de ocorrências (VBA GerarDatas) ----------
// Produz as datas-base de uma recorrência dentro de [janelaInicio, janelaFim].
export function gerarDatasBase(rec, janelaInicio, janelaFim) {
  const ini = rec.inicio && rec.inicio > janelaInicio ? rec.inicio : janelaInicio;
  const fim = rec.fim && rec.fim < janelaFim ? rec.fim : janelaFim;
  if (ini > fim) return [];
  const out = [];
  const freq = String(rec.frequencia || 'mensal').toLowerCase();

  if (freq === 'mensal' || freq === 'anual') {
    const startInicio = rec.inicio || janelaInicio;
    let { y, m } = isoToParts(ini);
    const step = freq === 'anual' ? 12 : 1;
    // p/ anual usa o mês do "início"; p/ mensal todos os meses
    if (freq === 'anual') ({ m } = isoToParts(startInicio));
    while (true) {
      const dia = Math.min(rec.dia_mes || isoToParts(startInicio).d || 1, ultimoDiaDoMes(y, m));
      const iso = partsToISO(y, m, dia);
      if (iso > fim) break;
      if (iso >= ini) out.push(iso);
      m += step;
      while (m > 12) { m -= 12; y += 1; }
    }
  } else if (freq === 'semanal') {
    const alvo = DIAS_SEMANA[String(rec.dia_semana || '').toLowerCase()] ?? 5;
    let cur = ini;
    while (weekday(cur) !== alvo) cur = addDays(cur, 1);
    while (cur <= fim) { out.push(cur); cur = addDays(cur, 7); }
  } else if (freq === 'quinzenal') {
    let cur = rec.inicio || ini;
    while (cur < ini) cur = addDays(cur, 14);
    while (cur <= fim) { out.push(cur); cur = addDays(cur, 14); }
  }
  return out;
}

// ---------- Aplica exceções + dia útil e gera lançamentos prontos ----------
// excecoes: lista {descricao, dia_original, mes_original, acao, dia_nova, mes_nova}
export function gerarLancamentosRecorrencia(rec, janelaInicio, janelaFim, feriadosSet, excecoes) {
  const base = gerarDatasBase(rec, janelaInicio, janelaFim);
  const exDe = (desc, dia, mes) =>
    excecoes.find(
      (e) =>
        e.descricao.toLowerCase() === desc.toLowerCase() &&
        e.dia_original === dia &&
        e.mes_original === mes,
    );
  const out = [];
  for (const isoBase of base) {
    const { y, m, d } = isoToParts(isoBase);
    const ex = exDe(rec.descricao, d, m);
    let dataFinal;
    if (ex) {
      if (ex.acao === 'CANCELAR') continue;
      // MOVER: usa a data informada (ano herdado da ocorrência base)
      dataFinal = partsToISO(y, ex.mes_nova, ex.dia_nova);
    } else if (Number(rec.offset_uteis) > 0) {
      // recebimento/repasse: se o vencimento cai em fim de semana/feriado, o pagamento só
      // ocorre no próximo dia útil — daí contam os N dias úteis. Recalculado por mês.
      const baseUtil = proximoDiaUtil(isoBase, feriadosSet);
      dataFinal = addDiasUteis(baseUtil, Number(rec.offset_uteis), feriadosSet);
    } else {
      dataFinal = proximoDiaUtil(isoBase, feriadosSet);
    }
    out.push({
      data: dataFinal,
      nome: `[R] ${rec.descricao}`,
      centro_custo: rec.centro_custo,
      tipo: rec.tipo,
      valor: valorComSinal(rec.centro_custo, rec.valor),
      origem: 'recorrente',
      recorrencia_id: rec.id ?? null,
    });
  }
  return out;
}
