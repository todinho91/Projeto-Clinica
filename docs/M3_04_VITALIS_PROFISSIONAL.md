# M3-04 — Vitalis Profissional

Implementação vinculada à issue #59 e dependente da branch da PR #65 enquanto ela não
estiver integrada.

## Fluxo preparado

1. O profissional pode criar sua conta diretamente em `cadastro-profissional.html`, sem
   vínculo prévio com clínica e sem perfil de paciente.
2. A conta nasce com identidade profissional `pendente`, sem tenant e sem privilégios.
3. Um operador ativo da plataforma revisa o registro em
   `verificacao-profissionais.html`; a autorização é revalidada dentro da transação e a
   decisão fica na auditoria da plataforma.
4. Somente após `verificada`, o profissional cria seu consultório.
5. O provisionamento transacional cria o tenant, o vínculo `profissional`, seu perfil e a
   auditoria. Nenhuma conta `administrador` é necessária.
6. Ao selecionar o consultório, o usuário entra em `consultorio.html`; ao selecionar uma
   clínica institucional, mantém o painel médico existente.

## Capacidades do titular

- configurações básicas do consultório;
- pacientes, agenda, calendário e disponibilidade;
- criação de especialidades, vinculadas automaticamente ao perfil do titular;
- locais físicos de atendimento;
- convite e revogação de uma secretária pelo fluxo seguro existente;
- acesso aos demais vínculos ativos pela seleção de contexto.

O titular não pode criar administradores, outros profissionais, promover papéis,
provisionar clínicas institucionais nem administrar profissionais em clínicas de terceiros.
A secretária do consultório também não recebe acesso às rotas institucionais de cadastro de
profissionais ou administração de equipe.

## Migration 012

Cria apenas:

- `identidades_profissionais`;
- `consultorios_profissionais`;
- `consultorio_locais`.

Não altera registros existentes. A migration deve ser aplicada posteriormente somente em
banco MySQL 8 descartável com sufixo `_test`, depois de conferir `SELECT DATABASE()` e
`SELECT VERSION()`.

## Validação local segura

```bash
cd "/home/joao/Projeto-Clinica-m3-validacao/backend/node modules"
npm ci
npm test
npm run check:secrets
npm audit --omit=dev
```

Para a integração opt-in, configure `TEST_DB_HOST`, `TEST_DB_PORT`, `TEST_DB_USER`,
`TEST_DB_PASSWORD` e `TEST_DB_DATABASE` para um banco descartável dedicado cujo nome
comece com `vitalis_consultorios` e termine em `_test`. Não use `DB_DATABASE`,
`vitalis_m3_validacao` nem os bancos Aurora/Horizonte. Execute somente o script de integração
M3-04 documentado no `package.json` após autorização específica:

```bash
PRACTICE_INTEGRATION_TEST=1 \
TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=3306 \
TEST_DB_USER="usuario_de_teste" TEST_DB_PASSWORD="<defina-localmente>" \
TEST_DB_DATABASE=vitalis_consultorios_local_test \
npm run test:practices:integration
```

Depois, inicie `npm start` na porta 3000 e sirva o frontend pelo Go Live. Valide em desktop,
390 × 844 e 360 × 800 sem executar seeds.
