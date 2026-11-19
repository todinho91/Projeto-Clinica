# M4-02 — Agendamento e confirmação de consultas

## Arquitetura

A agenda usa o `clinica_id` do token de clínica validado pelo middleware. IDs enviados pelo
navegador nunca escolhem o tenant. A migration aditiva `009_appointment_management.sql`:

- associa a consulta a uma especialidade da mesma clínica;
- adiciona versão otimista e uma reserva ativa gerada para impedir início duplicado;
- cria `consultas_historico`, com versão, período, situação e operador de cada alteração;
- preserva consultas existentes, mantendo `especialidade_id` nulo para dados históricos.

A prevenção de sobreposição parcial ocorre dentro da transação. O backend bloqueia o perfil
do profissional com `FOR UPDATE`, valida grade semanal, descanso, bloqueios e consultas
ativas, e somente então grava consulta, histórico e auditoria. Requisições concorrentes do
mesmo profissional são serializadas; qualquer falha desfaz todas as escritas.

Bloqueios novos são recusados quando cruzam uma consulta agendada ou confirmada. Alterações
da grade semanal também são recusadas quando deixariam uma consulta futura fora do período
de atendimento ou dentro de um descanso. Nenhuma dessas operações cancela ou modifica uma
consulta silenciosamente.

Horários recorrentes continuam como horário civil da clínica. Datas de consultas e bloqueios
são convertidas do fuso IANA de `clinicas.timezone` para UTC antes da persistência.

## Permissões e estados

| Operação | Administrador | Secretaria | Profissional | Paciente |
|---|---:|---:|---:|---:|
| Gerenciar agenda da clínica | Sim | Sim | Não | Não |
| Agendar | Sim | Sim | Não | Próprio perfil |
| Confirmar/realizar/não compareceu | Sim | Sim | Somente consulta própria, quando autorizado pela rota | Não |
| Cancelar | Sim | Sim | Consulta própria | Consulta própria |
| Reagendar | Sim | Sim | Não | Não |
| Consultar histórico | Sim | Sim | Consulta própria | Não |

As transições aceitas são explícitas:

- `agendada` → `confirmada`, `realizada`, `cancelada` ou `nao_compareceu`;
- `confirmada` → `realizada`, `cancelada` ou `nao_compareceu`;
- `realizada`, `cancelada` e `nao_compareceu` são terminais.

Além da matriz, existem limites temporais no backend: `realizada` somente a partir do início,
`nao_compareceu` somente após o fim, e confirmação/cancelamento somente antes do fim. Toda
alteração recebe a `versao` exibida pela API; uma tela desatualizada recebe conflito e precisa
recarregar a agenda.

## APIs

- `GET /api/consultas/contexto`: especialidades e profissionais ativos da clínica;
- `GET /api/consultas/horarios`: horários livres após grade, descanso, bloqueios e reservas;
- `GET /api/consultas/gestao`: agenda paginada e filtrada;
- `POST /api/consultas`: criação transacional;
- `PUT /api/consultas/:id/status`: transição explícita com versão esperada;
- `PUT /api/consultas/:id/concluir`: conclusão pelo profissional responsável, com versão
  esperada e somente a partir do início da consulta;
- `PATCH /api/consultas/:id/reagendar`: alteração transacional do período/profissional com
  paciente original e versão esperada obrigatórios;
- `DELETE /api/consultas/:id`: cancelamento com versão esperada no corpo;
- `GET /api/consultas/:id/historico`: trilha versionada autorizada.

## Preparação para confirmação multicanal

Esta entrega não envia WhatsApp, e-mail, push nem afirma entrega de comunicação. O histórico
versionado e os estados da consulta são independentes de canal, permitindo que a issue #55
adicione solicitações e respostas idempotentes em tabelas próprias, sem alterar a reserva.
Tokens públicos de confirmação, tentativas, expiração e estado de entrega devem ser tratados
na PR específica da comunicação, depois das dependências #16 e #17.

## Migration 009

Não execute a migration automaticamente. Antes da aplicação supervisionada:

1. confirme o banco com `SELECT DATABASE()` e a versão com `SELECT VERSION()`;
2. faça backup testado e defina o procedimento de restauração;
3. verifique se `uk_consultas_inicio_profissional` existe;
4. confira consultas simultâneas já existentes e referências de profissionais;
5. aplique primeiro em cópia descartável e valide rollback operacional.

A migration não contém `DROP TABLE`, `TRUNCATE`, `DELETE`, seed ou alteração de dados de
demonstração. Ela remove apenas o índice legado de início, substituindo-o pelo índice de
reserva ativa e pela validação transacional de intervalos.

## Integração MySQL 8 em Ubuntu

Use exclusivamente um banco descartável vazio cujo nome comece com `vitalis_agendamento`
e termine com `_test`. O teste recusa `vitalis_m3_validacao`, `vitalis_dev` e nomes fora do
padrão, e confirma banco e MySQL 8 antes de qualquer limpeza.

```bash
cd "/home/joao/Projeto-Clinica-m3-validacao/backend/node modules"
export TEST_DB_HOST=127.0.0.1
export TEST_DB_PORT=3306
export TEST_DB_USER="usuario_de_teste"
export TEST_DB_PASSWORD="<defina somente no terminal>"
export TEST_DB_DATABASE=vitalis_agendamento_m4_test
npm ci
npm run test:appointments:integration
```

O cenário cria somente dados sintéticos, agenda duas requisições concorrentes, exige um único
sucesso, testa sobreposição parcial, versão desatualizada, paciente inativo, ID de outro
tenant, bloqueio e grade incompatíveis, cancelamento/reagendamento concorrentes,
histórico/auditoria e rollback depois da inserção da consulta, provocado por uma restrição
SQL real no histórico. Não exige `SUPER`, trigger ou mudança global.

## Validação visual

Com o backend em `http://localhost:3000`, sirva o frontend pelo Go Live em
`http://127.0.0.1:5500` e abra `agenda.html` com administrador ou secretaria. Verifique:

- busca de paciente ativo, especialidade, profissional, data, duração e horários livres;
- confirmação, cancelamento, reagendamento, realização e não comparecimento;
- filtros, paginação e atualização após cada operação;
- bloqueios, descanso e sobreposição parcial;
- troca Aurora/Horizonte sem reaproveitar opções ou consultas;
- layouts 1366×768, 1280×720, 390×844 e 360×800.

O painel legado do paciente usa o mesmo contexto e endpoint de horários da agenda: escolhe
especialidade e profissional, recebe somente slots válidos no fuso da clínica e preserva o
autoagendamento. As issues #55, #59 e #60 permanecem fora desta PR.

Na área profissional, somente o médico/profissional vinculado à consulta pode concluir o
atendimento. Identidade, vínculo, perfil, clínica, autoria e versão são revalidados dentro da
transação; histórico e auditoria permanecem obrigatórios. A gestão não pode marcar uma
consulta como realizada. A agenda administrativa pode registrar não comparecimento somente
após o término informado pelo servidor e se atualiza sob demanda, ao retornar à aba e a cada
30 segundos enquanto a página estiver visível.
