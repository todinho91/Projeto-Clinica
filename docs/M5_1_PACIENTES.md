# M5-01 — Cadastro de pacientes

## Escopo

A gestão permite que administrador e secretaria cadastrem, listem, busquem e editem o perfil clínico mínimo de um paciente na clínica ativa. O `clinica_id` é sempre obtido do token de clínica validado no backend e nunca do navegador.

A listagem administrativa devolve somente nome, ano de nascimento, situação e contato mascarado. A consulta de edição, que contém os dados completos, é individual e restrita aos mesmos papéis. A busca preparada para a M4-02 devolve apenas `id`, nome e ano de nascimento de pacientes ativos.

O cadastro administrativo cria `pacientes.usuario_id = NULL`. E-mail semelhante a uma identidade global não vincula nem apropria uma conta existente. Um fluxo futuro de convite/reivindicação deverá comprovar a titularidade antes de preencher esse vínculo.

## Migration 008

`008_patient_management.sql` é aditiva e cria:

- unicidade de e-mail por clínica;
- índice de situação e nome por clínica;
- índice de nascimento e nome por clínica.

Antes de aplicá-la em qualquer base existente, faça backup verificado e execute uma verificação somente leitura de e-mails duplicados por clínica:

```sql
SELECT clinica_id, LOWER(TRIM(email)) AS email_normalizado, COUNT(*) AS total
FROM pacientes
WHERE email IS NOT NULL AND TRIM(email) <> ''
GROUP BY clinica_id, LOWER(TRIM(email))
HAVING COUNT(*) > 1;
```

Se houver resultados, interrompa a migration e trate-os manualmente; não escolha nem mescle identidades automaticamente.

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
npm run test:patients:integration
```

O teste confirma `SELECT DATABASE()` e `SELECT VERSION()` antes de qualquer limpeza, exige MySQL 8 e recusa nomes fora do padrão. Ele recria somente o schema descartável indicado, testa concorrência, duplicidade dentro e entre clínicas, acesso cruzado, exposição mínima e rollback por `CHECK` temporário, sem triggers ou privilégios globais.

## Teste visual

1. Inicie o backend na porta 3000 com a configuração local aprovada.
2. Sirva o frontend pelo Go Live em `http://127.0.0.1:5500`.
3. Entre como administrador ou secretaria e abra `pacientes.html`.
4. Cadastre dados inteiramente fictícios e confirme a máscara dos contatos na listagem.
5. Busque, edite e altere a situação do perfil.
6. Troque de clínica e confirme que o perfil não aparece nem é acessível pelo identificador anterior.
7. Verifique o layout em 390 × 844 e 360 × 800, incluindo formulário, filtros, cartões e paginação.

Nenhuma migration, seed ou teste MySQL é executado automaticamente pela suíte padrão.
