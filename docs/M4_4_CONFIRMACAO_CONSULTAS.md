# M4-04 — Confirmação inteligente de consultas

## Modelo de segurança

A confirmação de intenção é independente do estado clínico da consulta. Uma resposta
`confirmada` ou `recusada` nunca marca atendimento como realizado, cancelado ou não
comparecimento.

A migration aditiva `010_appointment_confirmations.sql`:

- registra a preferência explícita de contato do paciente;
- cria solicitações por canal, incluindo os canais futuros `aplicativo` e `push`;
- persiste somente o hash SHA-256 do token aleatório de 256 bits;
- separa estado da resposta de estado de entrega;
- mantém eventos imutáveis e auditoria por clínica;
- usa chaves estrangeiras compostas para impedir referências entre tenants.

O link expira no menor prazo entre `CONFIRMATION_TTL_HOURS` e o início da consulta.
Nova solicitação, cancelamento, conclusão, falta ou reagendamento revogam links pendentes.
Requisições concorrentes são serializadas com `FOR UPDATE`; apenas a primeira resposta é
aceita. O token puro existe somente no link devolvido uma vez ao operador autorizado.

## Estados

`preparada` significa somente que a solicitação e a mensagem foram preparadas. O Vitalis
não registra a abertura do WhatsApp como envio e mantém `estado_entrega = nao_enviado`.
Os estados `aceito_provedor` e `entrega_confirmada` ficam reservados para uma integração
futura que possua evidência real do provedor.

Respostas possíveis:

- `confirmada`: paciente pretende comparecer;
- `recusada`: paciente informou impossibilidade;
- `expirada`: prazo encerrado;
- `revogada`: consulta mudou ou outra solicitação substituiu o link.

Administrador e secretaria também podem registrar uma resposta recebida por telefone ou
presencialmente. Esse registro usa canal `manual`, identifica o operador e não cria token.

A migration aditiva `011_authenticated_patient_confirmations.sql` não modifica a migration
010. Ela distingue `portal_vitalis` de `aplicativo` e `push`, pois uma conta vinculada não
comprova aplicativo instalado, dispositivo autorizado nem entrega de notificação. O portal
fica efetivamente disponível quando o próprio paciente entra em uma sessão autenticada; a
resposta continua sem alterar o estado clínico da consulta.

## APIs

- `POST /api/consultas/:id/confirmacoes`: prepara link e URL do WhatsApp;
- `POST /api/consultas/:id/confirmacoes/manual`: registra resposta manual;
- `POST /api/consultas/:id/confirmacoes/minha-resposta`: registra a resposta do paciente
  autenticado somente para a própria consulta;
- `GET /api/consultas/:id/confirmacoes`: histórico administrativo sem token;
- `POST /api/confirmacoes-consulta/consultar`: recebe o token no corpo e retorna somente clínica e horário;
- `POST /api/confirmacoes-consulta/responder`: recebe token e resposta no corpo, de forma atômica.

O token fica no fragmento (`#token=`) do link público, é removido do endereço pelo navegador
assim que a página inicia e nunca é enviado em caminhos de requisição. As respostas usam
`no-store`, `no-referrer` e `noindex`. Fora de `localhost`, `127.0.0.1` e `::1`,
`APP_PUBLIC_ORIGIN` aceita somente HTTPS.

Solicitações repetidas para a mesma versão são idempotentes e não revogam o link pendente.
Gerar outro link e corrigir uma resposta administrativa exigem ações explícitas, preservadas
no histórico e na auditoria.

A reemissão compara o identificador que a tela observou, de modo que duas abas não substituam
o mesmo link sucessivamente. Depois de uma resposta definitiva, não há reemissão: qualquer
alteração deve usar a correção administrativa auditável. A agenda e o calendário priorizam a
resposta definitiva da versão atual, mesmo que existam eventos posteriores de expiração ou
revogação. Alterar o telefone, retirar a preferência WhatsApp ou inativar o paciente revoga
links pendentes na mesma transação; consulta e resposta públicas revalidam essas condições.

Na agenda e no calendário, a única ação destacada é **Solicitar confirmação**. Reagendamento,
cancelamento, histórico e correção administrativa ficam no menu contextual. Depois de uma
resposta definitiva, a solicitação deixa de ser oferecida e permanece apenas o indicador da
resposta, com eventuais correções restritas ao menu auditável.

Hoje não existe cadastro confiável de instalação do aplicativo, dispositivo ou caixa de
notificações. Por isso, o backend não trata `usuario_id` como disponibilidade de canal e não
afirma envio pelo Vitalis. Para solicitações externas, usa WhatsApp somente quando há telefone
válido e preferência explícita. A M11 poderá fornecer a evidência de dispositivo/assinatura
necessária para priorizar aplicativo e push sem alterar a semântica das respostas.

## Pré-voo das migrations 010 e 011

Não aplique a migration em banco existente sem autorização. Em uma cópia descartável:

```sql
SELECT DATABASE();
SELECT VERSION();
SELECT COUNT(*) AS pacientes_preservados FROM pacientes;
SELECT COUNT(*) AS consultas_preservadas FROM consultas;
```

Após backup testado, aplique as migrations pelo executor oficial e confirme que as contagens
anteriores não mudaram. A migration 010 não contém `DROP TABLE`, `TRUNCATE`, `DELETE`, seed
ou atualização dos pacientes existentes; a preferência começa como `nenhum`. A migration 011
altera apenas os enums e a restrição de token da confirmação, sem inserir ou atualizar dados.

## Integração MySQL 8 descartável

O teste de agendamento foi ampliado com confirmação, hash, resposta única, isolamento e
revogação. Ele recusa bancos que não comecem com `vitalis_agendamento` e terminem em `_test`.

```bash
cd "/home/joao/Projeto-Clinica-m3-validacao/backend/node modules"
export TEST_DB_HOST=127.0.0.1
export TEST_DB_PORT=3306
export TEST_DB_USER="usuario_de_teste"
export TEST_DB_PASSWORD="<defina somente no terminal>"
export TEST_DB_DATABASE=vitalis_agendamento_confirmacoes_test
npm ci
npm run test:appointments:integration
```

O teste confirma `SELECT DATABASE()` e `SELECT VERSION()` antes de limpar exclusivamente o
banco descartável. Não use `vitalis_m3_validacao`, `vitalis_dev` ou bancos de demonstração.

## Validação local sem envio real

1. Configure `APP_PUBLIC_ORIGIN=http://127.0.0.1:5500` e mantenha o backend na porta 3000.
2. Sirva o frontend pelo Go Live e edite um paciente fictício, informando telefone de teste e
   preferência WhatsApp.
3. Abra `agenda.html`, solicite confirmação e confira a mensagem preparada. Não envie.
4. Copie apenas no ambiente local o link da mensagem e abra `confirmacao-consulta.html`.
5. Responda e confira a atualização automática da agenda e do calendário.
6. Reagende ou cancele e confirme que o link anterior deixa de aceitar respostas.
7. Repita em Aurora e Horizonte usando somente dados fictícios e confirme o isolamento.
8. Entre como paciente, responda pela própria consulta em `dashboard-paciente.html` e confira
   que a agenda e o calendário atualizam; tente repetir e responder consulta de outro paciente.

Validar também 1366×768, 1280×720, 390×844 e 360×800. Nenhum provedor, API paga, push ou
envio automático faz parte desta entrega.
