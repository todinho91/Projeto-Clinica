# M5 — Prevenção reforçada de pacientes duplicados

Esta entrega trata a issue #62 sem alterar migrations, prontuários ou consultas existentes.
O sistema nunca funde pacientes automaticamente e nunca pesquisa registros fora da clínica
ativa.

## Regras aplicadas

- nome é normalizado por espaços, caixa e acentuação para localizar candidatos;
- e-mail, telefone e nome com nascimento ajudam a classificar possíveis duplicidades;
- nome igual sem e-mail, telefone ou nascimento é bloqueado até que existam dados adicionais;
- e-mail igual, nome com nascimento igual ou nome e telefone iguais são bloqueios fortes;
- homônimos com dados distintos e contatos compartilhados exigem revisão explícita por um
  administrador ou pela secretaria;
- a revisão registra somente um motivo controlado na auditoria, sem copiar dados pessoais;
- candidatos exibem apenas nome, ano de nascimento, situação e contatos mascarados;
- a ação **Usar paciente existente** abre o cadastro já existente para edição;
- a linha da clínica é bloqueada antes da busca e da inserção, serializando cadastros
  concorrentes na mesma clínica.

## Compatibilidade com a migration 008

A chave `UNIQUE (clinica_id, email)` foi preservada. Portanto, um e-mail não pode ser
compartilhado por dois pacientes da mesma clínica, mesmo após revisão. Como famílias podem
compartilhar e-mail, essa limitação precisa de uma decisão de produto e migração específica
antes de ser alterada; a PR da issue #62 não remove essa proteção de forma preventiva.

Nenhuma chave única por nome foi criada, porque pessoas homônimas são válidas. Também não há
mesclagem automática: uma futura função de fusão deve ser separada, autorizada, transacional,
auditada e preservar consultas, documentos e prontuários.

## Integração MySQL 8 preparada

Use somente banco descartável autorizado cujo nome comece com `vitalis_pacientes` e termine
com `_test`. O teste confirma `SELECT DATABASE()` e `SELECT VERSION()` antes de limpar o
schema.

```bash
cd "backend/node modules"
export TEST_DB_HOST=127.0.0.1
export TEST_DB_PORT=3306
export TEST_DB_USER="usuario_de_teste"
export TEST_DB_PASSWORD="<defina somente no terminal>"
export TEST_DB_DATABASE=vitalis_pacientes_m5_test
npm run test:patients:integration
```

Os cenários incluem dados incompletos concorrentes, homônimos, contato familiar compartilhado,
isolamento entre clínicas, rollback e preservação do cadastro público. O teste não deve ser
executado em `vitalis_m3_validacao`, `vitalis_dev` ou bancos de demonstração.
