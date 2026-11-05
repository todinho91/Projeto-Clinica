# Vitalis — validação do backend multi-tenant

Esta etapa depende, nesta ordem, do Lote 1 de segurança e da DB-01. Ela não deve ser aplicada diretamente sobre a `master` enquanto os PRs anteriores estiverem abertos.

## Fluxo de autenticação

1. `POST /api/auth/login` valida `email` e `senha` e devolve um token de identidade e os vínculos ativos.
2. `POST /api/auth/select-clinic`, com o token de identidade, recebe `clinica_id` e valida o vínculo no servidor.
3. O token de clínica devolvido é usado nas rotas clínicas.
4. Em cada requisição, o servidor consulta novamente usuário, clínica e vínculo ativos. O papel vem do banco, não do corpo, cabeçalho ou papel gravado no token.

Um `clinica_id` enviado no corpo de uma rota clínica é ignorado. O tenant efetivo é exclusivamente o `clinic_id` assinado no token e revalidado no banco.

## Cadastro público

`POST /api/auth/register` exige `nome`, `email`, `senha` e `clinica_slug`. O cadastro sempre cria vínculo e perfil de `paciente`. Tentativas de enviar `papel`, `tipo` ou `role` privilegiado recebem `403`.

Criação de administradores, secretárias e profissionais não possui endpoint público. Um fluxo administrativo de convites deverá ser implementado separadamente.

## Matriz atual de permissões

| Operação | Administrador | Secretaria | Profissional | Paciente |
| --- | --- | --- | --- | --- |
| Listar profissionais | sim | sim | sim | sim |
| Agendar consulta | sim | sim | não | somente para si |
| Consultar agenda | clínica | clínica | somente a própria | somente a própria |
| Alterar status | sim | sim | somente consulta própria | não |
| Cancelar consulta | sim | sim | não | somente consulta própria |
| Ver paciente | sim | sim | somente vinculado à própria agenda | somente o próprio perfil |
| Enviar documento | sim | sim | somente para paciente da própria agenda | não |

Todas as consultas SQL clínicas incluem `clinica_id`. IDs de outra clínica retornam `404` ou `403` sem revelar a existência do recurso.

## Teste automatizado sem MySQL

Na pasta `backend/node modules`:

```bash
npm ci
npm test
```

Esses testes simulam dois tenants, tentativas de trocar `clinica_id`, token de clínica sem vínculo, papel insuficiente e referências cruzadas.

## Integração com MySQL 8 descartável

Nunca execute o teste em `vitalis_dev`, produção ou banco com dados importantes. O comando apaga as tabelas conhecidas. O nome deve começar com `vitalis_` e terminar com `_test`.

Crie um banco exclusivo:

```sql
CREATE DATABASE vitalis_backend_test
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_0900_ai_ci;
```

Configure somente no terminal local:

```bash
export TEST_DB_HOST=localhost
export TEST_DB_PORT=3306
export TEST_DB_USER=vitalis_dev
export TEST_DB_PASSWORD='<SENHA_LOCAL_NAO_VERSIONADA>'
export TEST_DB_DATABASE=vitalis_backend_test
export SEED_PASSWORD='<SENHA_FICTICIA_COM_12_OU_MAIS_CARACTERES>'
export SEED_BCRYPT_ROUNDS=4
npm run test:backend:integration
```

O teste recria o esquema, aplica o seed, faz login como paciente sintético, seleciona a clínica Aurora e comprova que o paciente da clínica Horizonte não pode ser lido. Também assina um token com outra clínica e confirma que a ausência de vínculo ativo bloqueia a requisição.

## Validação manual local

Depois de executar `npm run db` no `vitalis_dev`, inicie o servidor com `npm start`. Use apenas contas do seed. O cliente deve substituir o token de identidade pelo token devolvido em `select-clinic` antes de chamar as rotas clínicas.

## Riscos e trabalhos posteriores

- O frontend ainda precisa adotar a seleção de clínica e os novos nomes de campos.
- Convites, gestão de vínculos e alteração de papéis ainda não foram implementados.
- Ainda faltam rate limiting, recuperação de senha, revogação de tokens e trilha de auditoria para cada ação.
- A agenda bloqueia horários iniciais iguais, mas a camada de serviço ainda não detecta todos os intervalos parcialmente sobrepostos.
- Uploads não são públicos e são separados por clínica, porém ainda faltam lista de MIME permitidos, antivírus e armazenamento privado em nuvem.
- Antes de qualquer ambiente persistente, faça backup e valide migrations, autenticação, autorização e recuperação em um banco descartável.
