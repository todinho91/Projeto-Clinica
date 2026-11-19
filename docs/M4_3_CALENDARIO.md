# M4-03 — Calendário e agenda por perfil

## Escopo

A página `calendario.html` oferece visualizações diária, semanal e mensal das consultas da
clínica ativa. A navegação entre períodos, o botão **Hoje**, os filtros e a atualização
automática trabalham com datas locais produzidas pelo backend no fuso IANA da clínica.

O calendário é somente leitura. A criação, confirmação, reagendamento, cancelamento e
conclusão continuam nos fluxos transacionais da M4-02.

## Autorização e isolamento

- `administrador` e `secretaria` consultam a agenda autorizada da clínica ativa;
- `profissional` consulta exclusivamente as consultas associadas ao próprio perfil ativo;
- `paciente` não possui acesso às rotas nem à página desta etapa;
- `clinica_id` e o perfil do médico nunca são aceitos do navegador como fonte de autoridade;
- clínica, identidade e vínculo são revalidados na consulta SQL que lê os eventos;
- filtros de profissional e especialidade nunca removem o filtro obrigatório do tenant;
- cada leitura cobre no máximo 42 dias e 1.000 eventos, evitando extração excessiva.

## API

- `GET /api/consultas/calendario/contexto`: retorna fuso, data atual da clínica e filtros
  autorizados para o papel ativo;
- `GET /api/consultas/calendario`: retorna somente os campos necessários para os cartões,
  com `data_inicio`, `data_fim`, `status`, `profissional_id` e `especialidade_id` opcionais.

Os horários `inicio_local` e `fim_local` são convertidos no backend. O frontend não converte
os eventos usando o fuso do computador do usuário.

## Acessibilidade e responsividade

Todos os controles são botões ou campos nativos. Eventos recebem foco e podem ser percorridos
com setas, `Home` e `End`. Mudanças de período e mensagens usam regiões anunciadas por leitores
de tela. No desktop o calendário usa sete colunas; no tablet, duas; e no celular, uma coluna,
sem exigir rolagem horizontal da página.

## Preparação para a issue #55

Cada cartão expõe apenas o identificador interno da consulta em `data-consulta-id`. Esse ponto
estável permitirá conectar futuramente o histórico e a situação de solicitações de confirmação,
independentemente do canal. Esta etapa não cria tokens públicos, não abre WhatsApp, não chama
provedores e não apresenta envio ou entrega simulados.

## Validação local

```bash
git fetch origin
git switch feature/vitalis-m4-calendario-agenda
git pull --ff-only
cd "backend/node modules"
nvm use 22
npm ci
npm test
npm run check:secrets
npm audit --audit-level=high
npm start
```

Com o frontend servido pelo Go Live, validar `calendario.html` em desktop, tablet, 390 × 844 e
360 × 800. Testar administrador, secretaria e profissional, troca de clínica, três visões,
filtros, botão Hoje, teclado e atualização automática. Integrações que gravem no MySQL devem
usar somente banco descartável `_test` explicitamente autorizado.
