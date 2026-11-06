# M3.1 — Gestão de profissionais

## Auditoria da base

O esquema já possuía `profissionais`, `especialidades` e `profissional_especialidades`, todas com `clinica_id` e chaves estrangeiras compostas. O cadastro de profissional exige `usuario_id` associado a um vínculo da mesma clínica. Antes desta entrega, a API expunha somente a listagem dos profissionais ativos usada por agenda e pacientes.

## Modelo adotado

- administrador e secretária podem listar, cadastrar, editar, ativar e desativar;
- cadastro aceita apenas usuário ativo que já tenha vínculo ativo com papel `profissional` na clínica atual;
- o vínculo do usuário é imutável durante a edição do cadastro profissional;
- especialidades são opcionais, mas, quando informadas, devem estar ativas e pertencer à clínica atual;
- desativação é lógica e não remove consultas, documentos ou históricos;
- reativação exige que usuário e vínculo profissional continuem ativos;
- operações de escrita geram eventos na tabela `auditoria`.

Não são criadas contas, senhas temporárias ou papéis privilegiados nesta tela. Convites e gestão de vínculos pertencem a uma entrega posterior da M3.

## Rotas

| Método | Rota | Papéis |
|---|---|---|
| GET | `/api/profissionais` | todos os papéis autenticados da clínica; somente ativos |
| GET | `/api/profissionais/gestao` | administrador, secretária |
| GET | `/api/profissionais/opcoes` | administrador, secretária |
| POST | `/api/profissionais` | administrador, secretária |
| PUT | `/api/profissionais/:id` | administrador, secretária |
| PATCH | `/api/profissionais/:id/status` | administrador, secretária |

Todas as consultas usam `req.tenant.clinicId`; valores de `clinica_id` enviados pelo cliente não são utilizados.

## Validação manual recomendada

1. entrar como administrador ou secretária em uma clínica fictícia;
2. confirmar que somente vínculos profissionais ainda não cadastrados aparecem no seletor;
3. cadastrar um profissional com especialidade da clínica ativa;
4. editar nome, conselho e especialidades;
5. desativar e confirmar que ele deixa de aparecer no agendamento;
6. confirmar que consultas antigas continuam preservadas;
7. reativar o profissional com vínculo ativo;
8. trocar de clínica e confirmar que a listagem muda sem reaproveitar registros anteriores;
9. entrar como profissional ou paciente e confirmar que `profissionais.html` redireciona para o painel permitido e que as rotas administrativas retornam 403.

## Integração real com MySQL 8

A suíte `test/professional-management.integration.test.js` executa o ciclo completo contra um banco descartável e valida:

- cadastro e edição sem aceitar troca de clínica ou usuário pelo payload;
- ativação e desativação lógica;
- preservação de consulta histórica após desativação;
- remoção do profissional inativo da lista usada em agendamentos;
- eventos de auditoria para criação, edição e mudanças de status;
- bloqueio de edição, cadastro e listagem entre clínicas.

Antes de qualquer `DROP TABLE`, a suíte:

1. carrega a conexão exclusivamente das variáveis `TEST_DB_*`;
2. exige um banco dedicado cujo nome comece com `vitalis_profissionais` e termine em `_test`;
3. consulta `SELECT DATABASE()` e exige correspondência exata;
4. consulta a versão e exige MySQL 8.

Exemplo de execução local, sem gravar credenciais no repositório:

```bash
export TEST_DB_HOST=127.0.0.1
export TEST_DB_PORT=3306
export TEST_DB_USER='<usuario-local-de-teste>'
export TEST_DB_PASSWORD='<senha-local-de-teste>'
export TEST_DB_DATABASE=vitalis_profissionais_test
npm run test:professionals:integration
```

O banco deve existir previamente e ser exclusivo para essa suíte. Não reutilize `vitalis_dev`, bancos de produção ou outro banco de teste compartilhado.
