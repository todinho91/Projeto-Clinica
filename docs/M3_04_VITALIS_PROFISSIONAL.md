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
- delegação opcional de alteração da disponibilidade, sem retirar capacidades do titular;
- acesso aos demais vínculos ativos pela seleção de contexto.

O titular não pode criar administradores, outros profissionais, promover papéis,
provisionar clínicas institucionais nem administrar profissionais em clínicas de terceiros.
A secretária do consultório também não recebe acesso às rotas institucionais de cadastro de
profissionais ou administração de equipe. Ela gerencia dados administrativos de pacientes e
agenda, mas só altera horários quando o titular concede a permissão. Documentos clínicos
permanecem restritos ao profissional titular.

## Migration 012

Cria apenas:

- `identidades_profissionais`;
- `consultorios_profissionais`;
- `consultorio_locais`.

Não altera registros existentes. A migration deve ser aplicada posteriormente somente em
banco MySQL 8 descartável com sufixo `_test`, depois de conferir `SELECT DATABASE()` e
`SELECT VERSION()`.

## Migration 013

`013_practice_delegations.sql` cria somente `consultorio_delegacoes`, com chave composta do
tenant e do vínculo da secretária. A concessão e a retirada da permissão de disponibilidade:

- aceitam apenas secretária ativa do mesmo consultório;
- revalidam o titular dentro da transação;
- incrementam a versão da sessão do vínculo afetado;
- registram auditoria sem dados clínicos;
- são removidas logicamente quando o acesso é desativado.

## Pacientes: limite seguro desta entrega

O formulário atual é um **cadastro rápido administrativo**: nome completo, nascimento e
contatos opcionais, preferência explícita de contato e situação ativa/arquivada. Arquivar é
uma alteração lógica e auditada: bloqueia novos agendamentos, revoga confirmações pendentes e
preserva consultas e históricos. Não há exclusão física de pacientes.

A identificação clínica completa foi separada em uma PR dependente porque envolve decisões
mais amplas de finalidade, acesso, validação de CPF/CNS, responsáveis e endereço. Adicionar
esses campos diretamente ao cadastro administrativo aumentaria a coleta antes de existir o
módulo assistencial e contrariaria o princípio da necessidade. O desenho separado deve:

- manter dados administrativos distintos de anamnese, diagnósticos e evolução;
- admitir informação desconhecida quando aplicável e não impedir urgências;
- não transformar requisitos operacionais do SUS em regra universal de consultório privado;
- definir validação, proteção e unicidade de CPF antes de persistir o valor;
- usar somente migration aditiva e nunca unir prontuários automaticamente.

Referências oficiais consultadas:

- [Resolução CFM nº 1.638/2002](https://sistemas.cfm.org.br/normas/visualizar/resolucoes/BR/2002/1638);
- [Lei nº 13.787/2018](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13787.htm);
- [LGPD — Lei nº 13.709/2018](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709compilado.htm);
- [Guia de segurança da ANPD para agentes de pequeno porte](https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia-orientativo-sobre-seguranca-da-informacao-para-agentes-de-tratamento-de-pequeno-porte);
- [Cadastro Individual do e-SUS APS](https://sisaps.saude.gov.br/sistemas/esusaps/docs/manual/PEC/PEC_04_cidadao/),
  usado apenas como referência contextual de campos do SUS.

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

O teste opt-in cobre também aceite do convite da secretária, delegação, arquivamento e
reativação de paciente, revogação do acesso e tentativa de escrita com sessão revogada.

Depois, inicie `npm start` na porta 3000 e sirva o frontend pelo Go Live. Valide em desktop,
390 × 844 e 360 × 800 sem executar seeds. Confirme que o menu permanece igual entre todas
as páginas, que a troca de contexto só aparece com mais de um vínculo e que uma secretária
sem delegação não vê nem altera a disponibilidade.
