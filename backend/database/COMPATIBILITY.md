# DB-01 — compatibilidade com o backend atual

## Estado

As migrations e o seed da DB-01 preparam o banco multi-tenant, mas o backend atual **ainda não funciona integralmente com esse esquema**. Não há teste real de integração entre as rotas existentes e o novo modelo.

## Diferenças que bloqueiam o uso imediato

| Backend atual | DB-01 | Alteração necessária |
| --- | --- | --- |
| `usuarios.senha` | `usuarios.senha_hash` | Atualizar cadastro e login |
| `usuarios.tipo` | `clinica_usuarios.papel` | Resolver papel no contexto da clínica |
| `medicos` | `profissionais` | Atualizar controllers e nomes de chaves |
| `medicos.especialidade_id` | `profissional_especialidades` | Tratar relação muitos-para-muitos |
| `consultas.data_hora` | `consultas.inicio_em` e `fim_em` | Atualizar agenda e validações |
| `consultas.medico_id` | `consultas.profissional_id` | Atualizar agendamento e joins |
| `exames` | `documentos_clinicos` | Atualizar upload e armazenamento |
| Sem tenant | `clinica_id` obrigatório | Aplicar escopo em toda leitura e escrita |

## Mudanças obrigatórias no backend

1. Criar um contexto de clínica confiável a partir do usuário autenticado e de seus vínculos.
2. Não aceitar `clinica_id` do corpo da requisição como fonte de autorização.
3. Atualizar o JWT ou a sessão para representar a clínica ativa sem permitir falsificação.
4. Alterar cadastro e login para `senha_hash` e vínculos em `clinica_usuarios`.
5. Remover a escolha pública de papéis privilegiados.
6. Aplicar `clinica_id` em todas as consultas SQL e usar as chaves compostas.
7. Atualizar `medicoController`, `consultaController`, `pacienteController` e `exameController`.
8. Usar transação para criar usuário, vínculo e perfil.
9. Substituir caminhos locais de arquivos por `storage_key` privado.
10. Criar testes integrados das rotas com duas clínicas fictícias.

## Problemas atuais relacionados

- A listagem de médicos retorna `usuarios.id` como `id`, enquanto o agendamento espera o identificador de `medicos`.
- Rotas protegidas validam autenticação, mas não papel, propriedade ou clínica.
- O diretório salvo pelo Multer não é o mesmo diretório publicado pelo servidor.
- O cadastro de usuário e paciente não é transacional.
- Não existe health check que valide a conexão MySQL.

## Critério para declarar compatibilidade

Somente considerar o backend compatível quando testes reais contra MySQL 8 comprovarem:

- cadastro, login e seleção de clínica;
- papéis e permissões por clínica;
- agenda, pacientes e documentos escopados pelo tenant;
- bloqueio de acesso cruzado entre duas clínicas;
- transações e integridade em falhas parciais;
- conexão, health check e recuperação de indisponibilidade do banco.
