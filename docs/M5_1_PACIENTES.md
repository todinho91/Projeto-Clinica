# M5-01 — Cadastro de pacientes

## Escopo

A gestão permite que administrador, secretaria e o titular verificado de um consultório cadastrem, listem, busquem e editem a identificação administrativa de um paciente no tenant ativo. O `clinica_id` é sempre obtido do token de clínica validado no backend e nunca do navegador.

A listagem administrativa devolve somente nome, ano de nascimento, situação e contato mascarado. A consulta de edição, que contém os dados completos, é individual e restrita aos mesmos papéis. A busca preparada para a M4-02 devolve apenas `id`, nome e ano de nascimento de pacientes ativos.

O cadastro administrativo cria `pacientes.usuario_id = NULL`. E-mail semelhante a uma identidade global não vincula nem apropria uma conta existente. Um fluxo futuro de convite/reivindicação deverá comprovar a titularidade antes de preencher esse vínculo.

Novos cadastros rotineiros exigem nome, CPF válido, nascimento e endereço completo. Telefone, e-mail e complemento permanecem opcionais, e a preferência de contato é explícita. Pacientes históricos sem esses campos continuam visíveis como pendentes de complementação. Exceções para ausência de CPF, endereço não convencional e urgência são tipificadas e auditadas, sem documentos fictícios.

Antes do lançamento público, o Vitalis deverá definir e validar um processo de verificação de titularidade para vincular com segurança um perfil clínico preexistente a uma identidade global. Essa revisão é requisito do piloto real e está registrada na [issue #33 — M9-04](https://github.com/todinho91/Projeto-Clinica/issues/33). Até sua conclusão, conflitos do cadastro público usam uma resposta neutra e não informam se os dados correspondem a uma identidade global ou a um perfil clínico.

## Migration 008

`008_patient_management.sql` é aditiva e cria:

- unicidade de e-mail por clínica;
- índice de situação e nome por clínica;
- índice de nascimento e nome por clínica.

Antes de aplicá-la em qualquer base existente, faça backup verificado e execute uma verificação somente leitura de e-mails duplicados por clínica:

```sql
SELECT clinica_id, MIN(email) AS email_exemplo, COUNT(*) AS total
FROM pacientes
WHERE email IS NOT NULL
GROUP BY clinica_id, email
HAVING COUNT(*) > 1;
```

Esta consulta usa a mesma collation da coluna e inclui e-mails vazios (`''`), diferenças apenas de maiúsculas/minúsculas e espaços finais que possam colidir com o índice. Se houver resultados, interrompa a migration e trate-os manualmente; não escolha nem mescle identidades automaticamente.

## Migration 014

`014_patient_administrative_identity.sql` é exclusivamente aditiva e cria a tabela
`pacientes_identificacao_administrativa`. A tabela histórica `pacientes` não recebe colunas
obrigatórias nem atualização global.

O CPF usa AES-256-GCM e índice HMAC tenant-aware. Antes de iniciar o backend com esse fluxo,
provisione por gerenciador de segredos:

- `PATIENT_CPF_KEY_ID`;
- `PATIENT_CPF_ENCRYPTION_KEY`, com 32 bytes em Base64;
- `PATIENT_CPF_INDEX_KEY`, com outros 32 bytes em Base64.

Não registre os valores em documentação, Git, shell compartilhado ou logs. A estratégia de
rotação, retenção e recuperação está definida na
`docs/adr/ADR-002-identificacao-clinica-paciente.md`.

## Migration 015 — e-mail de contato compartilhado

A migration 015 troca o índice único de e-mail administrativo por índice de busca não único,
sem modificar a migration 008 ou os registros existentes. E-mails compartilhados exigem
revisão auditada; CPF por clínica e e-mail de login permanecem únicos. O cadastro público
continua conservador até a verificação de titularidade (#33). Consulte
`docs/M5_DUPLICIDADE_PACIENTES.md` para aplicação e reversão seguras.

## Validação MySQL 8 em banco descartável

Nunca execute esta integração em `vitalis_m3_validacao`, `vitalis_dev` ou bancos de demonstração. Crie um banco vazio e exclusivo cujo nome comece com `vitalis_pacientes` e termine com `_test`, por exemplo `vitalis_pacientes_m5_test`.

No Ubuntu, com Node.js 22 e credenciais exclusivas desse banco:

```bash
cd "backend/node modules"
export TEST_DB_HOST=127.0.0.1
export TEST_DB_PORT=3306
export TEST_DB_USER='<usuario_descartavel>'
export TEST_DB_PASSWORD='<defina somente no terminal local>'
export TEST_DB_DATABASE=vitalis_pacientes_m5_test
export PATIENT_CPF_KEY_ID='teste-local-v1'
read -rsp 'Chave de cifra Base64: ' PATIENT_CPF_ENCRYPTION_KEY; export PATIENT_CPF_ENCRYPTION_KEY; echo
read -rsp 'Chave de índice Base64: ' PATIENT_CPF_INDEX_KEY; export PATIENT_CPF_INDEX_KEY; echo
npm run test:patients:integration
unset TEST_DB_PASSWORD PATIENT_CPF_ENCRYPTION_KEY PATIENT_CPF_INDEX_KEY
```

O teste confirma `SELECT DATABASE()` e `SELECT VERSION()` antes de qualquer limpeza, exige MySQL 8 e recusa nomes fora do padrão. Ele recria somente o schema descartável indicado, testa concorrência, duplicidade dentro e entre clínicas, acesso cruzado, exposição mínima e rollback por `CHECK` temporário, sem triggers ou privilégios globais.

## Teste visual

1. Inicie o backend na porta 3000 com a configuração local aprovada.
2. Sirva o frontend pelo Go Live em `http://127.0.0.1:5500`.
3. Entre como administrador ou secretaria e abra `pacientes.html`.
4. Cadastre dados inteiramente fictícios e confirme CPF, nascimento e endereço obrigatórios.
5. Digite um CEP válido e confirme o preenchimento editável; repita com CEP inexistente e backend sem acesso ao ViaCEP, verificando que os campos manuais não são apagados.
6. Confirme que a listagem mostra apenas contatos mascarados e o estado completo, por exceção ou pendente.
7. Edite um paciente histórico pendente sem perder consultas e depois complete sua identificação.
8. Troque de clínica e confirme que o perfil e o índice de CPF não aparecem nem são acessíveis pelo identificador anterior.
9. Verifique o layout em 1366 × 768, 1024, 768, 390 × 844 e 360 × 800.

Nenhuma migration, seed ou teste MySQL é executado automaticamente pela suíte padrão.
