# M3-01 — Provisionamento de clínicas

## Escopo

O fluxo cria, em uma única transação, a clínica ativa, o vínculo pendente do primeiro
administrador, o convite com token armazenado somente como SHA-256 e os registros de
auditoria. O envio ocorre depois do commit e registra separadamente se o provedor apenas
aceitou a solicitação, confirmou a entrega, falhou ou não está configurado.

Usuários já ativos preservam nome, senha e vínculos anteriores. O convite deve ser aceito
com um token de identidade da própria conta. Para uma identidade nova, a senha é definida
pelo titular durante o aceite. Contas inativas ou bloqueadas por segurança são recusadas.

Se o convite inicial expirar ou a solicitação de envio falhar, um operador ativo da
plataforma pode gerar outro pela página de provisionamento. A operação exige o ID da
clínica e do convite atualmente exibido, bloqueia o registro durante a transação, revoga
todos os tokens pendentes daquele vínculo e registra o novo convite em
`auditoria_plataforma`. Vínculos já ativos e identidades bloqueadas por segurança não
podem usar esse fluxo.

## Autorização da plataforma

A migration `006_clinic_provisioning.sql` cria `operadores_plataforma`. A tabela não recebe
seed e não concede acesso automaticamente a administradores de clínicas. A habilitação de
um operador deve ser feita por um administrador do ambiente, depois de confirmar a
identidade global existente, e registrada pelo procedimento operacional da instalação.

As rotas de provisionamento exigem JWT de identidade e revalidam, dentro da transação,
que o usuário e o registro de operador continuam ativos. Um administrador de clínica não
se torna operador da plataforma por possuir esse papel em um tenant.

## Migration proposta

A migration 006 é aditiva e:

- cria `operadores_plataforma` e `auditoria_plataforma`;
- permite que um convite identifique, de forma mutuamente exclusiva, um administrador da
  clínica ou um operador da plataforma como criador;
- preserva as migrations 001 a 005 e os convites existentes.

Ela não foi executada por esta implementação.

## Validação segura no Ubuntu

1. Atualize a branch sem alterar a `master`:

   ```bash
   git fetch origin
   git switch feature/vitalis-m3-provisionamento-clinicas
   git pull --ff-only
   ```

2. Instale e execute os testes sem MySQL:

   ```bash
   cd "backend/node modules"
   npm ci
   npx --yes node@22 --test
   npm run check:secrets
   npm audit --audit-level=high
   ```

3. Para a integração MySQL, crie e autorize previamente um banco descartável cujo nome
   comece com `vitalis_provisionamento` e termine com `_test`. Nunca aponte as variáveis
   `TEST_DB_*` para `vitalis_m3_validacao`, `vitalis_dev` ou outro banco preservado.

4. Confirme o banco antes de executar:

   ```sql
   SELECT DATABASE() AS banco_efetivo;
   ```

5. Somente após autorização explícita, configure `TEST_DB_HOST`, `TEST_DB_PORT`,
   `TEST_DB_USER`, `TEST_DB_PASSWORD` e `TEST_DB_DATABASE`, e execute:

   ```bash
   npm run test:provisioning:integration
   ```

   O teste recusa nomes fora do padrão descartável e recria somente o schema desse banco.

6. Antes de aplicar a migration 006 em qualquer ambiente persistente, gere backup lógico,
   valide a restauração em instância separada e registre a contagem das tabelas
   `clinicas`, `usuarios`, `clinica_usuarios`, `convites_clinica` e `auditoria`.

7. Depois da migration autorizada, um administrador do banco deve habilitar um usuário
   global já verificado em `operadores_plataforma`. Não use senha compartilhada, não crie
   operador por seed e não exponha credenciais no histórico do terminal.

8. Inicie o backend e o frontend:

   ```bash
   cd "backend/node modules"
   npm start
   ```

   No VS Code, abra `select-clinic.html` com Go Live em `http://127.0.0.1:5500`.
   O botão **Provisionar clínica** aparece apenas para um operador autorizado. Para um
   administrador de clínica, a página **Configurações** permite alterar nome e fuso da
   clínica ativa; o slug permanece imutável.

## Cenários manuais

- provisionar uma clínica com slug inédito e aceitar o convite do primeiro administrador;
- expirar o convite inicial, reenviar e confirmar que somente o novo token funciona;
- provocar falha de envio e confirmar que o botão de reenvio fica disponível;
- tentar dois reenvios simultâneos por operadores distintos e confirmar somente um novo convite;
- repetir o slug e confirmar resposta de conflito sem registros parciais;
- usar uma conta já vinculada a outra clínica e confirmar que a senha e o vínculo anterior
  permanecem intactos;
- tentar acessar o provisionamento como usuário comum;
- editar nome/fuso como administrador e repetir como secretaria;
- alternar entre clínicas e confirmar que as configurações exibidas pertencem apenas ao
  tenant ativo;
- conferir as telas em desktop, 390 px e 360 px.
