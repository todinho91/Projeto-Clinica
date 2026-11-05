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
