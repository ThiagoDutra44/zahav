# Fluxo de Caixa · ImovelUm 2026

Sistema de fluxo de caixa diário da ImovelUm — migração da planilha `Cash Flow v1.xlsm`
(Excel + VBA) para um app web com banco de dados, preservando todas as regras de negócio
descritas na aba `DOC_PARA_O_CODE` da planilha.

## Stack
- **Node.js** + **Express** (API)
- **SQLite** embutido do Node 24 (`node:sqlite`) — sem instalar nada nativo
- Frontend em HTML/CSS/JS puro (tema escuro da planilha)

## Como rodar (uso diário — local)
**Duplo-clique em `Iniciar Fluxo de Caixa.bat`** — ele abre o navegador em
http://localhost:5180 e sobe o servidor. Deixe a janela preta aberta enquanto usa;
feche-a pra encerrar.

Ou pelo terminal:
```bash
npm start         # http://localhost:5180
```

### Backup automático
A cada vez que o sistema é aberto (e de 6 em 6h enquanto roda), o banco é copiado
para `data/backups/fluxo-<data>.db` — guarda os **30 snapshots** mais recentes.
Pra restaurar: feche o sistema e copie um backup por cima de `data/fluxo.db`.

### Primeira instalação / reconstruir do zero
```bash
npm install
npm run extract   # lê o .xlsm -> data/seed.json   (só quando a planilha mudar)
npm run seed      # monta data/fluxo.db a partir do seed.json (APAGA edições!)
node scripts/migrate-livros.js   # adiciona o conceito de caixa (empresa/dutra)
```
> `extract` aponta por padrão para `C:/FINANCEIRO 2026/Cash Flow v1.xlsm`.

## Subir pra internet (quando precisar — acesso remoto / sócios)
O código está pronto, mas pra ir pra nuvem faltam 2 coisas (é dado financeiro):
1. **Login** — adicionar autenticação (hoje é aberto, ok só em rede local).
2. **Host com disco persistente** — Render / Railway / Fly.io (SQLite precisa de disco
   que não some) **ou** migrar SQLite → Postgres e usar Vercel.
3. Backup automático pra nuvem (ex.: enviar `data/backups/` pra um storage).

## Estrutura
```
scripts/extract.js   extrai dados do .xlsm -> data/seed.json
scripts/seed.js      cria/popula data/fluxo.db
src/db.js            conexão + schema (lancamentos, recorrencias, excecoes, feriados, ...)
src/rules.js         regras portadas do VBA (sinal, dia útil, recorrências, exceções)
src/server.js        API REST + serve o frontend
public/              interface (grade semanal)
```

## Regras de negócio (porte do VBA)
- **Sinal:** centro de custo contém `receita` → valor positivo; resto → negativo.
- **Dia útil:** recorrência em fim de semana/feriado (Nacional + RJ + SP) → próximo dia útil.
- **Recorrências:** mensal / semanal / quinzenal / anual, com início/fim e ativo.
- **Exceções:** MOVER (remarca) ou CANCELAR uma ocorrência específica, persistentes.
- **Prioridade P1/P2:** campo no lançamento (substitui a "soma por cor" do Excel).
- **Consolidado mensal:** calculado na hora (não armazenado).

## Já implementado (MVP)
Grade semanal seg–sex, 508 lançamentos migrados da grade real (FLUXO 2026 v2),
**entrada rápida inline** (digita na grade e dá Enter, sem modal), CRUD de lançamento,
reagendar em lote (Shift+clique), caixa ancorado no saldo real, cards Dutra/P1/P2,
consolidado mensal calculado. Validação `npm run validar` bate 261/261 dias com a planilha.

### Entrada rápida (igual à planilha)
No rodapé de cada dia: `descrição → Tab → centro → Tab → tipo → Tab → valor → Enter`.
Salva, atualiza o caixa e devolve o cursor pro mesmo dia — fluxo só de teclado.

## Próximos passos
- Botão para **regenerar recorrentes** na interface (motor já existe em `src/rules.js`).
- Tela de **exceções** e **fechamento de mês + pendências**.
- Deploy em nuvem (Vercel + Postgres) com login, quando validado.
