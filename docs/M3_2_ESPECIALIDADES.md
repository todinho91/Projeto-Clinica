# M3.2 — Gestão multi-tenant de especialidades

## Escopo entregue

- listagem das especialidades ativas e inativas da clínica selecionada;
- cadastro e edição de nome, com normalização de espaços e limite de 120 caracteres;
- ativação e desativação lógica, sem exclusão física;
- contagem dos profissionais associados;
- seleção somente de especialidades ativas nos formulários da gestão de profissionais;
- preservação das associações históricas inativas durante a edição do profissional;
- página administrativa responsiva e acessível integrada ao menu M2;
- auditoria de criação, edição e mudanças de status.

O esquema existente já contém `especialidades` e `profissional_especialidades`, com `clinica_id`, unicidade por clínica e chaves estrangeiras compostas. Nenhuma migration foi necessária.

## Endpoints e permissões

| Método | Rota | Papéis autorizados |
|---|---|---|
| `GET` | `/api/especialidades/gestao` | administrador, secretaria |
| `POST` | `/api/especialidades` | administrador, secretaria |
| `PUT` | `/api/especialidades/:id` | administrador, secretaria |
| `PATCH` | `/api/especialidades/:id/status` | administrador, secretaria |

Profissional e paciente recebem `403` nessas rotas. Todas as consultas e escritas usam exclusivamente `req.tenant.clinicId`; um `clinica_id` eventualmente enviado no corpo é ignorado. IDs de outra clínica não podem ser listados, editados, ativados, desativados ou associados.

## Integridade e preservação histórica

- a chave única `(clinica_id, nome)` rejeita duplicidades usando a collation do MySQL 8;
- desativar uma especialidade mantém os registros de `profissional_especialidades`;
- especialidades inativas deixam de aparecer como novas opções de associação;
- ao editar um profissional, somente associações com especialidades atualmente ativas são substituídas; vínculos inativos históricos permanecem intactos;
- não há endpoint de exclusão física;
- cada escrita administrativa gera um evento em `auditoria` com o tenant e usuário autenticados.

## Testes automatizados

Em 6 de novembro de 2026, `npm test` executou 68 testes: 64 aprovados, zero falhas e quatro suítes de integração opt-in ignoradas por padrão. A cobertura da M3.2 inclui cadastro, edição, status, duplicidade, dados inválidos, autorização, isolamento, associação cruzada, preservação de vínculos, auditoria, interface e compatibilidade com a M3.1.

Também passaram:

```bash
node --check controllers/especialidadeController.js
node --check test/specialty-management.integration.test.js
```

## Integração opt-in com MySQL 8

A suíte `test/specialty-management.integration.test.js` valida o ciclo completo em banco real, incluindo isolamento entre duas clínicas e preservação do vínculo após desativar uma especialidade e editar o profissional.

Antes de qualquer `DROP TABLE`, ela:

1. carrega a conexão exclusivamente de `TEST_DB_*`;
2. exige nome iniciado por `vitalis_especialidades` e terminado em `_test`;
3. conecta ao banco explicitamente informado;
4. confirma `SELECT DATABASE()` e exige correspondência exata;
5. confirma `SELECT VERSION()` e exige MySQL 8;
6. limita a limpeza à lista conhecida de tabelas dentro desse banco exclusivo.

O executor da PR não possuía cliente/servidor MySQL, Docker, Podman nem variáveis `TEST_DB_*`. A tentativa real foi interrompida antes da conexão com `Configuração obrigatória ausente: TEST_DB_HOST`; portanto, nenhum banco foi acessado ou modificado e não se declara aprovação da integração real neste ambiente. A recusa preventiva foi exercitada com o nome inseguro `vitalis_dev` e ocorreu antes de qualquer conexão.

Para executar localmente, crie um banco novo e exclusivo, nunca reutilize outro banco de teste:

```bash
mysql -u root -p -e "CREATE DATABASE vitalis_especialidades_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"

export TEST_DB_HOST=127.0.0.1
export TEST_DB_PORT=3306
export TEST_DB_USER='<usuario-local-de-teste>'
export TEST_DB_PASSWORD='<senha-local-de-teste>'
export TEST_DB_DATABASE=vitalis_especialidades_test

cd "backend/node modules"
npm ci
npm run test:specialties:integration
```

O comando destrói somente as tabelas conhecidas de `vitalis_especialidades_test`. Use um usuário MySQL restrito a esse banco e remova o banco descartável manualmente após a validação, se desejado.

## Issue #14

A M3.1 e a M3.2, em conjunto, cobrem o diretório por clínica, distinção entre ID de usuário e ID profissional, especialidade desativada e bloqueio de vínculo cruzado descritos na issue #14. A PR da M3.2 pode encerrá-la quando for revisada, validada no MySQL 8 e integrada. A issue não deve ser encerrada antes disso.

## Riscos e pendências

- a suíte real MySQL 8 ainda precisa ser executada pelo proprietário ou por CI isolada com credenciais de teste;
- o banco usa a collation `utf8mb4_0900_ai_ci`, portanto nomes que diferem apenas por maiúsculas/minúsculas ou acentos podem ser considerados iguais; esse comportamento é intencional para evitar duplicidades ambíguas;
- especialidades inativas permanecem visíveis na gestão e no histórico do profissional, mas não podem ser escolhidas para novas associações;
- não há deploy, merge, alteração da `master` ou acesso a bancos reais nesta entrega.
