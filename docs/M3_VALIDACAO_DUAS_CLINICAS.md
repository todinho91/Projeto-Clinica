# M1–M3 — validação de isolamento entre duas clínicas

## Estado e limites

Este roteiro usa exclusivamente dados fictícios. O banco permitido é
`vitalis_m3_validacao`, mas sua existência e isolamento precisam ser comprovados
antes de qualquer gravação. Não use `vitalis_dev`, produção ou os bancos de teste
históricos.

Os quatro testes MySQL existentes não devem ser executados nesse banco: eles
removem tabelas conhecidas e exigem bancos descartáveis terminados em `_test`.
O seed atual também não deve ser usado, pois faz upsert e reativa/atualiza dados
existentes, inclusive a Clínica Aurora Demo.

## Diagnóstico read-only

Configure somente no terminal local, sem salvar credenciais no repositório:

```bash
export M3_VALIDATION_DB_HOST='<host-local>'
export M3_VALIDATION_DB_PORT='3306'
export M3_VALIDATION_DB_USER='<usuario-somente-leitura>'
export M3_VALIDATION_DB_PASSWORD='<senha-local>'
export M3_VALIDATION_DB_DATABASE='vitalis_m3_validacao'

cd "backend/node modules"
npm run m3:diagnose
```

O diagnóstico recusa qualquer outro nome de banco e executa apenas `SELECT`.
Ele informa versão do MySQL, existência do schema, migrations, tabelas, clínicas
e contagens por tenant. Não imprime usuário, host, senha, JWT ou e-mail.

## Tabelas envolvidas

| Tabela | Uso na validação |
| --- | --- |
| `clinicas` | Aurora e Horizonte, com slugs distintos |
| `usuarios` | identidades globais fictícias |
| `clinica_usuarios` | papel, status e acesso a uma ou duas clínicas |
| `especialidades` | catálogo isolado e desativação lógica |
| `profissionais` | perfil por clínica e vínculo com usuário |
| `profissional_especialidades` | associações e histórico inativo |
| `pacientes` | alvos fictícios de autorização |
| `consultas` | vínculo profissional/paciente e histórico |
| `documentos_clinicos` | metadados privados e acesso autorizado |
| `auditoria` | evidência das operações administrativas |
| `schema_migrations` | versões e checksums aplicados |

## Dados que devem ser preservados

- todos os registros e identificadores atuais da Clínica Aurora Demo;
- vínculos ativos e inativos de `clinica_usuarios`;
- profissionais, especialidades e associações históricas inativas;
- consultas, documentos e eventos de auditoria existentes;
- checksums de `schema_migrations`.

Nenhum preparador pode atualizar, reativar, renomear ou substituir registros da
Aurora. A Horizonte deve usar somente e-mails `example.test` e dados claramente
fictícios.

## Backup e restauração antes da escrita

1. Confirmar `SELECT DATABASE()` igual a `vitalis_m3_validacao`.
2. Gerar dump consistente com `mysqldump --single-transaction --routines --triggers`.
3. Calcular SHA-256 do dump e armazená-lo fora do repositório.
4. Restaurar primeiro em um schema descartável separado e comparar tabelas e
   contagens com o diagnóstico.
5. Somente após o ensaio de restauração, iniciar a preparação transacional.
6. Em falha, executar rollback; se houver falha após commit, restaurar o dump em
   um schema novo, validar e então decidir a troca controlada.

O dump contém dados e hashes de senha e nunca deve ser versionado ou anexado a
issues. A senha MySQL deve ser solicitada interativamente ou fornecida por
variável protegida, sem aparecer na linha de comando ou nos logs.

## Matriz de validação

| Cenário | Resultado esperado |
| --- | --- |
| administrador Aurora lista profissionais/especialidades | somente Aurora |
| administrador Horizonte lista profissionais/especialidades | somente Horizonte |
| usuário exclusivo tenta selecionar a outra clínica | `403` |
| usuário com dois vínculos troca a clínica ativa | novo token e dados do tenant escolhido |
| payload envia `clinica_id` diferente | valor ignorado pelo servidor |
| GET/PUT/PATCH com ID de outra clínica | `404`, sem alteração |
| profissional acessa paciente sem consulta vinculada | `404` |
| paciente acessa registro de terceiro | `404` ou `403` conforme a rota |
| paciente tenta rota administrativa ou upload | `403` |
| documento usa paciente de outra clínica | `404` e arquivo temporário removido |
| profissional/especialidade é desativado | some das novas opções; histórico permanece |
| nova associação usa especialidade inativa | `400`; associação não criada |
| vínculo é revogado após emissão do token | próxima chamada rejeitada pelo middleware |

## Execução visual

1. Iniciar o backend na porta 3000 com `DB_DATABASE=vitalis_m3_validacao` somente
   depois da autorização e da preparação concluída.
2. Servir o frontend pelo Go Live em `http://127.0.0.1:5500`.
3. Entrar separadamente com os usuários fictícios de Aurora e Horizonte.
4. Capturar evidências das listas antes e depois da troca de clínica.
5. Repetir em 360 px e desktop, usando teclado para navegação e verificando foco.
6. Confirmar no backend, por IDs cruzados, que a UI não é a única barreira.

## Barreiras para autorização de escrita

Antes de qualquer preparação devem ser apresentados: diagnóstico read-only,
inventário das tabelas, contagens iniciais, identificação da Aurora, dump com
checksum, restauração ensaiada, SQL/rotas que serão usados e plano de rollback.
