# PR #43 — auditoria dos indicadores administrativos

## Escopo verificado

- **Profissionais:** usa `GET /profissionais`, que retorna somente profissionais ativos e filtra por `req.tenant.clinicId`.
- **Consultas de hoje:** considera registros com data válida no dia local exibido ao usuário e exclui apenas `cancelada`. Assim, o total diário mantém consultas agendadas, confirmadas, realizadas e faltas.
- **Próximas consultas:** considera somente horários posteriores ao instante atual com status `agendada` ou `confirmada`.

## Autorização e isolamento

`GET /consultas/minha-agenda` permanece atrás dos middlewares de autenticação e contexto de tenant. A rota aceita administrador, secretária, profissional e paciente. O controller sempre usa a clínica validada no servidor (`req.tenant.clinicId`) e ignora qualquer `clinica_id` enviado pelo cliente.

Para administrador e secretária, a consulta retorna a agenda da clínica ativa. Para profissional e paciente, acrescenta o filtro pelo usuário vinculado ao respectivo registro. Os joins também incluem `clinica_id`, evitando associação entre entidades de clínicas diferentes.

## Datas e status

Os horários recebidos pela API são normalizados para UTC antes da gravação. O pool MySQL foi configurado com `timezone: 'Z'` para interpretar os campos `DATETIME` de maneira consistente, independentemente do fuso do servidor Node.js. O navegador converte esses instantes para o fuso local para apresentação e para a definição de “hoje”.

O enum vigente de consultas é: `agendada`, `confirmada`, `realizada`, `cancelada` e `nao_compareceu`.

## Testes automatizados

Foram adicionadas verificações para:

1. status aceitos em cada indicador e descarte de datas inválidas;
2. papéis autorizados na rota de agenda;
3. rejeição de papel não previsto;
4. uso exclusivo da clínica ativa no SQL da agenda administrativa;
5. interpretação UTC dos campos de data pelo driver MySQL.

Os testes de integração com MySQL continuam opcionais e exigem um banco local descartável configurado explicitamente. Nenhum banco real é acessado pela suíte padrão.
