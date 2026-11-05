# Vitalis — banco MySQL 8 de desenvolvimento

Esta estrutura é exclusiva para desenvolvimento com dados sintéticos. Não execute o seed em produção e não utilize dados reais de pacientes.

## 1. Instalar MySQL 8 no Ubuntu 24.04

```bash
sudo apt update
sudo apt install mysql-server
sudo systemctl enable --now mysql
sudo mysql_secure_installation
```

Confirme a versão:

```bash
mysql --version
```

## 2. Criar o banco e o usuário local

Abra o cliente administrativo:

```bash
sudo mysql
```

Execute os comandos abaixo substituindo o marcador por uma senha local forte. Não copie essa senha para arquivos versionados, issues ou logs.

```sql
CREATE DATABASE vitalis_dev
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_0900_ai_ci;

CREATE USER 'vitalis_dev'@'localhost'
    IDENTIFIED BY '<SENHA_LOCAL_NAO_VERSIONADA>';

GRANT ALL PRIVILEGES ON vitalis_dev.* TO 'vitalis_dev'@'localhost';
FLUSH PRIVILEGES;
```

Saia com `exit`.

## 3. Configurar o backend no VS Code

Abra o terminal integrado na raiz do repositório:

```bash
cd "backend/node modules"
npm ci
cp .env.example .env
```

Preencha o `.env` somente na sua máquina. As chaves necessárias para DB-01 são:

```dotenv
DB_HOST=localhost
DB_PORT=3306
DB_USER=vitalis_dev
DB_PASSWORD=<SENHA_LOCAL_NAO_VERSIONADA>
DB_DATABASE=vitalis_dev
SEED_PASSWORD=<SENHA_FICTICIA_LOCAL_COM_12_OU_MAIS_CARACTERES>
SEED_BCRYPT_ROUNDS=10
```

O `.env` está ignorado pelo Git. `SEED_PASSWORD` define a senha local dos oito usuários fictícios e nunca deve ser adicionada ao código ou às migrations.

Para iniciar o backend atual também são necessários `JWT_SECRET` e `PORT`. Gere o segredo somente na sua máquina:

```bash
openssl rand -hex 32
```

## 4. Executar migrations e seed

Somente migrations:

```bash
npm run db:migrate
```

Somente dados sintéticos:

```bash
npm run db:seed
```

Preparação completa:

```bash
npm run db
```

O executor registra cada arquivo em `schema_migrations`, com checksum SHA-256. Uma migration aplicada não pode ser editada; correções posteriores devem usar um novo arquivo numerado.

O seed é idempotente: pode ser repetido sem duplicar clínicas, usuários, consultas ou documentos sintéticos.

## 5. Dados fictícios criados

- Clínica Aurora Demo
- Espaço Horizonte Saúde Demo
- Oito usuários com e-mails no domínio reservado `example.test`
- Dois profissionais, dois pacientes, duas consultas e dois registros de documentos sem conteúdo clínico
- Uma entrada sintética de auditoria por clínica

Nenhum CPF, telefone, conselho profissional ou arquivo clínico real é criado.

## 6. Testes

Testes unitários e estruturais, sem banco real:

```bash
npm test
```

### Integração opcional com MySQL local

O teste de integração apaga somente as tabelas conhecidas dentro de um banco cujo nome comece com `vitalis_` e termine com `_test`. Nunca use `vitalis_dev` ou qualquer banco real.

Crie um banco descartável:

```sql
CREATE DATABASE vitalis_db01_test
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_0900_ai_ci;
```

No terminal, configure variáveis exclusivas de teste sem gravá-las no repositório:

```bash
export TEST_DB_HOST=localhost
export TEST_DB_PORT=3306
export TEST_DB_USER=vitalis_dev
export TEST_DB_PASSWORD='<SENHA_LOCAL_NAO_VERSIONADA>'
export TEST_DB_DATABASE=vitalis_db01_test
export SEED_PASSWORD='<SENHA_FICTICIA_LOCAL_COM_12_OU_MAIS_CARACTERES>'
npm run test:db:integration
```

O teste executa as migrations duas vezes, executa o seed duas vezes e tenta inserir uma consulta que combina paciente e profissional de clínicas diferentes. A chave estrangeira composta deve bloquear a operação.

## 7. Iniciar o projeto local

Depois de preparar o banco:

```bash
npm start
```

O backend atual ainda não é compatível com as novas tabelas. Consulte `COMPATIBILITY.md` antes de testar login ou rotas clínicas.

## Segurança operacional

- Use apenas dados fictícios.
- Nunca execute o seed em produção.
- Não compartilhe `.env`.
- Não altere migrations já aplicadas.
- Faça backup antes de futuras migrations em ambientes persistentes.
