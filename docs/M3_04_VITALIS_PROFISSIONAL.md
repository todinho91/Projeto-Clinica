# M3-04 — Vitalis Profissional

Implementação vinculada à issue #59 e dependente da branch da PR #65 enquanto ela não
estiver integrada.

## Fluxo preparado

1. O profissional entra com sua identidade global.
2. Em `vitalis-profissional.html`, cadastra conselho e registro para verificação.
3. Um operador ativo da plataforma altera a verificação por endpoint autenticado.
4. Somente após `verificada`, o profissional cria seu consultório.
5. O provisionamento transacional cria o tenant, o vínculo `profissional`, seu perfil e a
   auditoria. Nenhuma conta `administrador` é necessária.
6. Ao selecionar o consultório, o usuário entra em `consultorio.html`; ao selecionar uma
   clínica institucional, mantém o painel médico existente.

## Capacidades do titular

- configurações básicas do consultório;
- pacientes, agenda, calendário, disponibilidade e especialidades;
- locais físicos de atendimento;
- convite e revogação de uma secretária pelo fluxo seguro existente;
- acesso aos demais vínculos ativos pela seleção de contexto.

O titular não pode criar administradores, promover papéis, provisionar clínicas
institucionais nem administrar profissionais em clínicas de terceiros.

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

Para a integração opt-in, configure credenciais de um banco descartável dedicado terminado
em `_test`; não use `vitalis_m3_validacao` nem os bancos Aurora/Horizonte. Execute somente
o script de integração M3-04 documentado no `package.json` após autorização específica.

Depois, inicie `npm start` na porta 3000 e sirva o frontend pelo Go Live. Valide em desktop,
390 × 844 e 360 × 800 sem executar seeds.
