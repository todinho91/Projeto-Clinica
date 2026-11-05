# Integração do backend com a DB-01

## Estado

O backend foi adaptado ao esquema multi-tenant nesta branch. Os testes unitários e de isolamento simulados estão ativos. O teste real da DB-01 informado pelo proprietário valida migrations, seed e integridade do banco, mas não substitui o novo teste de ponta a ponta do backend.

Não declare a integração pronta para uso persistente até executar `npm run test:backend:integration` em MySQL 8 descartável.

## Mapeamento implementado

| Modelo legado | DB-01 | Estado nesta branch |
| --- | --- | --- |
| `usuarios.senha` | `usuarios.senha_hash` | login e cadastro atualizados |
| `usuarios.tipo` | `clinica_usuarios.papel` | papel revalidado por clínica |
| `medicos` | `profissionais` | listagem e agenda atualizadas |
| especialidade única | `profissional_especialidades` | listagem muitos-para-muitos |
| `consultas.data_hora` | `inicio_em` e `fim_em` | API e queries atualizadas |
| `consultas.medico_id` | `profissional_id` | API e joins atualizados |
| `exames` | `documentos_clinicos` | metadados e storage key atualizados |
| sem tenant | `clinica_id` obrigatório | middleware e queries escopados |

## Controles aplicados

- Login devolve token de identidade e vínculos ativos.
- Seleção explícita da clínica valida o vínculo no servidor.
- Token de clínica não é suficiente sozinho: usuário, clínica e vínculo são revalidados em cada requisição.
- O papel usado para autorização vem do banco.
- Cadastro público cria somente paciente.
- Paciente e profissional acessam somente seus próprios recursos quando a operação exige propriedade.
- Consultas, pacientes, profissionais e documentos sempre usam `clinica_id`.
- Uploads deixaram de ser publicados por rota estática.

## Alterações necessárias no cliente

1. Após o login, apresentar as clínicas devolvidas em `clinicas`.
2. Chamar `POST /api/auth/select-clinic` e substituir o token anterior.
3. Usar `profissional_id`, `inicio_em` e `fim_em` no agendamento.
4. Tratar `documentos` no lugar de `exames` nas novas respostas.
5. Não enviar nem confiar em `clinica_id` nas operações clínicas.

Os campos `inicio_em` e `fim_em` devem ser enviados em ISO 8601 com fuso, por exemplo `2032-01-01T10:00:00-03:00`. O backend normaliza os valores para UTC antes de gravar.

## Critério para declarar compatibilidade

- `npm test` sem falhas.
- `npm run test:backend:integration` aprovado em MySQL 8 descartável.
- Login, seleção de clínica, agenda, paciente e documento validados manualmente com dados sintéticos.
- Tentativas de token e IDs cruzados entre duas clínicas rejeitadas.
- Frontend atualizado para o novo contrato.
- Backup e recuperação ensaiados antes de qualquer banco persistente.
