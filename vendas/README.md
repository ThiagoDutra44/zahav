# Vendas · ImovelUm

Sistema de vendas da ImovelUm, migrado da planilha **VENDAS 2026.xlsm**.
Segue o mesmo padrão do [fluxo-caixa](../fluxo-caixa): Node + `node:sqlite` no
backend, SPA vanilla no frontend, sem build e sem dependências pesadas.

## O que faz

- **Funil de vendas** — registro de cada venda (cliente, produto, filial, corretor,
  opcionista, gerente, VGV, faturamento, status, mapa de calor), agrupado por mês.
  O status é o funil: `INTERESSE → CRÉDITO → PROPOSTA → MINUTA → ASSINADA`.
- **Dashboard** — KPIs do ano: VGV realizado (assinadas), faturamento, pipeline em
  aberto, % da meta, ticket médio, projeção anual, VGV por mês e funil.
- **Ranking** — por corretor, filial e gerente (só vendas assinadas).
- **Cadastros e metas** — listas de apoio e metas anuais de VGV/faturamento, editáveis.

`faturamento = VGV × margem%` (a "comissão IMOVELUM" da planilha) é calculado
automaticamente.

## Como rodar

```bash
npm install
npm run extract   # lê VENDAS 2026.xlsm -> data/seed.json  (primeira carga)
npm run seed      # cria data/vendas.db a partir do seed.json
npm start         # http://localhost:5181
```

No Windows: duplo-clique em **`Iniciar Vendas.bat`** (sobe o servidor e abre o navegador).

Para re-importar a planilha apontando outro arquivo:
`npm run extract -- "C:/caminho/para/VENDAS 2026.xlsm"`

## Ponte com o Fluxo de Caixa

A comissão (faturamento) de cada venda **ASSINADA** é receita que pertence ao
fluxo de caixa. O script `ponte-fluxo.js` empurra essas comissões como lançamentos
de receita no banco do fluxo-caixa.

```bash
npm run ponte             # SIMULAÇÃO: só mostra o que faria (não grava nada)
npm run ponte -- --apply  # grava de verdade no fluxo-caixa
```

- Roda em **simulação por padrão** — nada é gravado sem `--apply`.
- É **idempotente**: só sincroniza vendas com `fluxo_sync=0`; cada lançamento criado
  é marcado com `[V<id>]` e `origem='venda'` (rastreável e reversível).
- Lança no centro de custo `receita · Comissão de Vendas`, livro `empresa`, como
  `orçado` (previsto). Confirme/edite o recebimento no próprio fluxo-caixa.
- O caminho do banco do fluxo-caixa é `../fluxo-caixa/data/fluxo.db`
  (ajuste com a variável `FLUXO_DB` se necessário).

> Caminho para unificar os dois sistemas no futuro: banco SQLite compartilhado ou
> um app único com as duas seções. Hoje vivem separados e conversam por esta ponte.

## Estrutura

```
vendas/
├── src/
│   ├── db.js        # conexão SQLite + schema (vendas, cadastros, metas, config)
│   └── server.js    # API Express + serve o frontend + backup automático
├── public/
│   ├── index.html   # SPA (abas Dashboard / Funil / Ranking)
│   ├── app.js       # toda a lógica de UI
│   └── styles.css   # tema visual ImovelUm
├── scripts/
│   ├── extract.js     # VENDAS 2026.xlsm -> data/seed.json
│   ├── seed.js        # seed.json -> data/vendas.db
│   └── ponte-fluxo.js # ponte de comissões -> fluxo-caixa
└── data/
    ├── vendas.db    # SQLite
    ├── seed.json    # snapshot de carga
    └── backups/     # snapshots automáticos (30 mais recentes)
```

## API

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/meta` | listas de apoio (cadastros, funil, anos) |
| GET | `/api/vendas?ano=&status=&corretor=&filial=&mes=` | lista vendas |
| POST | `/api/vendas` | cria venda |
| PUT | `/api/vendas/:id` | edita venda |
| PUT | `/api/vendas/:id/status` | muda status no funil |
| DELETE | `/api/vendas/:id` | exclui venda |
| GET | `/api/dashboard?ano=` | KPIs, por mês e funil |
| GET | `/api/ranking?ano=` | ranking corretor/filial/gerente |
| GET/POST/DELETE | `/api/cadastros` | gerentes/corretores/opcionistas/filiais |
| GET/PUT | `/api/metas[/:ano]` | metas anuais |
