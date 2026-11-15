# M4-01 — Disponibilidade e bloqueios

## Decisão de arquitetura

A grade semanal é armazenada como horário civil da clínica (`TIME` e dia da semana). Ela
não deve ser convertida permanentemente para UTC, pois representa uma regra recorrente no
fuso IANA configurado em `clinicas.timezone`. Bloqueios datados são recebidos como horário
local da clínica, validados contra horários inexistentes ou ambíguos de mudança de horário
e persistidos em UTC (`DATETIME(6)`).

As tabelas aditivas da migration `007_professional_availability.sql` são:

- `disponibilidades_profissional`: segmentos semanais de atendimento ou descanso;
- `bloqueios_profissional`: férias, feriados e indisponibilidades datadas, com cancelamento
  lógico e autoria.

Ambas usam chaves compostas com `clinica_id` e `profissional_id`. Isso permite que a M4-02
valide, dentro da mesma transação da consulta, se o intervalo solicitado está coberto por um
segmento de atendimento e não cruza descanso, bloqueio ou outra consulta ativa.

## Segurança e permissões

- administrador e secretaria gerenciam profissionais ativos da clínica selecionada;
- profissional gerencia somente o próprio perfil ativo;
- paciente não acessa as rotas;
- o backend ignora qualquer `clinica_id` do navegador e usa apenas `req.tenant.clinicId`;
- gravações bloqueiam o perfil profissional com `FOR UPDATE`, evitando corridas na troca da
  grade e na criação de bloqueios;
- sobreposições são recusadas; intervalos adjacentes são permitidos;
- alterações registram auditoria sem dados sensíveis.

## Compatibilidade com a M4-02

A M4-01 não altera ainda o endpoint legado `POST /consultas`. A M4-02 deverá substituir a
restrição que hoje evita apenas inícios idênticos por validação transacional de intervalos,
consultando:

1. disponibilidade semanal local no fuso da clínica;
2. segmentos de descanso;
3. bloqueios ativos em UTC;
4. consultas ativas parcialmente sobrepostas;
5. transições de status autorizadas e trilha de cancelamento.

## Validação MySQL 8 posterior

Não execute contra `vitalis_m3_validacao`, `vitalis_dev` ou bancos de demonstração. Crie um
banco descartável cujo nome comece com `vitalis_disponibilidade` e termine com `_test`.

```bash
cd "backend/node modules"
export TEST_DB_HOST=127.0.0.1
export TEST_DB_PORT=3306
export TEST_DB_USER="usuario_de_teste"
export TEST_DB_PASSWORD="<defina localmente>"
export TEST_DB_DATABASE=vitalis_disponibilidade_m4_test
npm run test:availability:integration
```

O teste opt-in confirma o banco selecionado antes de limpar o schema descartável. Ele aplica
as migrations 001–007, valida isolamento entre duas clínicas sintéticas, conversão de fuso,
concorrência de bloqueios e rollback por restrição SQL real. Nenhuma credencial deve ser
registrada em arquivo ou commit.

## Teste visual

Com backend em `http://localhost:3000`, abra `disponibilidade.html` pelo Go Live. Valide:

- administrador/secretaria selecionando profissionais da clínica ativa;
- profissional visualizando somente o próprio cadastro;
- grade dividida em atendimento, descanso e atendimento sem sobreposição;
- férias, feriado e indisponibilidade no fuso exibido na tela;
- cancelamento lógico de bloqueio;
- comportamento em desktop, 390 px e 360 px;
- troca de clínica sem reaproveitar profissionais ou horários do tenant anterior.
