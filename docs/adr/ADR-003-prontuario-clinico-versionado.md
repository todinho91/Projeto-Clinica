# ADR-003 — Prontuário clínico longitudinal, versionado e isolado

- Status: proposto para revisão técnica e assistencial; não autoriza produção.
- Data: 2026-11-26.
- Escopo: M5-02A / #19.
- Base técnica examinada: `d508d993c90bcca46c0831d81b49a0097216573d`.
- Dependências: #18 (fechada), #16 (agenda), #59 (ADR-001, homologação pendente), #31 (auditoria), #32 (privacidade e requisitos profissionais).
- Relacionados: #20, #21, #56, #57, #58, #62, #66.

## 1. Contexto e evidência da leitura

O Vitalis usa `clinicas` como raiz do tenant, inclusive consultórios próprios marcados em `consultorios_profissionais` (ADR-001). Locais físicos não são tenants. A migration 002 define chaves compostas por clínica para pacientes, profissionais, consultas e documentos; 003 define auditoria; 012/013 definem consultórios e delegações; 014 protege identificação administrativa; 015 trata e-mail compartilhado.

Arquivos analisados: migrations 002, 003 e 012; `middleware/tenant.js`, `middleware/clinicalDocumentAccess.js`, `routes/index.js`, `controllers/pacienteController.js` (getPacienteDetails), `controllers/consultaController.js` (lockedAppointment, changeStatus, audit, history), ADR-001 e requisitos das issues #19, #31, #32, #59, #18 e #62.

O middleware de tenant revalida sessão, vínculo, clínica e usuário ativos. A autorização de detalhes de paciente e a de agenda atendem também administradores, secretaria e paciente. Não são autorização clínica suficiente. O endpoint existente de detalhes retorna metadados de documentos em contextos institucionais; revisar essa exposição na #20/#31, sem ampliá-la nesta etapa. Não inserir conteúdo de prontuário em respostas administrativas, agenda, documentos, buscas ou dashboard.

## 2. Decisões propostas — fronteira de confiança e guarda

- Usar exclusivamente o tenant do token validado no servidor. Não aceitar clinica_id, autor, perfil, titularidade, timestamps ou permissões como fatos fornecidos pelo cliente.
- Registros pertencem ao contexto assistencial de origem. Pacientes de duas clínicas continuam separados, mesmo com identidade global, CPF ou contato coincidente. Não fazer cópia, fusão ou transferência implícita.
- O consultório individual segue as mesmas regras; o médico titular não ganha acesso clínico por ser gestor/pagador. Múltiplos locais do mesmo consultório podem compartilhar a linha do tempo autorizada; registrar o local quando comprovado, sem inferir pelo endereço atual.
- Saída do profissional, revogação, suspensão e encerramento do workspace não apagam registros. O profissional não leva automaticamente o histórico institucional. Custódia legal, continuidade e acesso extraordinário dependem de política aprovada em #32/#58. Suspensão comercial não deve eliminar o acesso legalmente necessário.
- Nenhum acesso extraordinário, delegação clínica, suporte com impersonação, integração IA ou liberação automática ao paciente nesta primeira implementação. Definir fluxos próprios e auditados posteriormente.

## 3. Modelo lógico (proposta, não DDL)

A migration seguinte pode ser 016, se ainda livre quando implementada. Somente aditiva; não editar migrations anteriores. Confirmar tipos, índices e constraints no código da etapa B.

| Entidade proposta | Invariantes |
| --- | --- |
| prontuario_registros | id, clinica_id, paciente_id, consulta_id, profissional_id, autor_usuario_id, criado_em, estado, versão corrente; vínculo com consulta/paciente/profissional da mesma clínica; no MVP um registro por consulta; sem DELETE físico |
| prontuario_versoes | clinica_id, registro_id, versão crescente, tipo (rascunho, finalização, adendo, descarte de rascunho), versão anterior, autoria, horário servidor UTC, snapshot de conteúdo e identificação profissional aplicável; append-only; UNIQUE (clinica_id, registro_id, versao) |
| auditoria (existente) | ação, tenant, ator, alvo e metadados mínimos; sem payload clínico |

Usar FKs compostas por tenant, incluindo correspondência da consulta com seu paciente e profissional (avaliar chave candidata composta em consultas sem alterar dados). Não permitir troca de paciente, consulta ou autor em registro existente; conferir invariantes no banco e no serviço. FKs históricas não devem excluir registros em cascata. Usar snapshot de nome e conselho do autor, tipo/número/UF quando disponíveis e aplicáveis, sem inventar registro profissional; distinguir identidade informada de identidade verificada. Falta de identificação exigida para finalização deve bloquear, com erro operacional claro; política por profissão a definir com #32.

Conteúdo inicial estruturado: queixa, anamnese, antecedentes, alergias, medicamentos, avaliação/evolução, diagnóstico quando aplicável e conduta. Sem inferir ausência de alergia a partir de campo vazio; diferenciar desconhecido/não informado de ausência declarada. Campos textuais em texto simples, tamanho máximo por campo e tamanho total, sem HTML ativo; permitir caracteres legítimos e Unicode. Diagnósticos e terminologias padronizadas, modelos por especialidade, anexos e documentos são evoluções separadas (#21/#20/#56/#57). Versionar a estrutura do conteúdo (schema_version) e a versão do modelo quando existir; versões antigas não dependem de modelo mutável.

## 4. Ciclo de vida e concorrência

1. Criar rascunho somente pelo profissional responsável por consulta elegível, em contexto ativo; não basta estar na mesma clínica ou conhecer o ID. Derivar paciente e profissional da consulta.
2. Salvar rascunho cria versão nova (não sobrescreve versão anterior). Não exibir rascunho a outros profissionais, secretaria ou paciente. Em caso de descarte, registrar evento/versão sem eliminar histórico; política de retenção de rascunhos em #32.
3. Finalizar gera versão imutável, autoria e horário de finalização; exigir validação de conteúdo mínimo e identificação profissional aplicável. Finalizar não é assinar digitalmente; não exibir selos de assinatura, ICP-Brasil ou certificação.
4. Adendo/retificação é nova versão vinculada ao registro finalizado, com motivo clínico preservado no conteúdo restrito; original permanece acessível ao autorizado. MVP: somente autor ainda autorizado pode retificar; correção por sucessor ou outro profissional exige política própria, sem falsificar autoria.
5. Não criar, finalizar ou retificar a partir de consulta cancelada ou não comparecida. Rascunhos anteriores a cancelamento permanecem retidos, sem publicação; reabertura depende de decisão explícita. Nunca invalidar automaticamente registros já finalizados. Definir comportamento de anomalias de agenda antes da etapa B.
6. Proposta conservadora de elegibilidade: agendada/confirmada somente a partir do horário de início validado no servidor; realizada permite documentação posterior pelo responsável ainda ativo. Reusar regras de transição/horário existentes, não confiar no relógio do navegador. Finalização do prontuário não muda o status da consulta automaticamente; conclusão de atendimento já existe e permanece operação distinta nesta entrega.
7. Todas as mutações exigem versão esperada, inclusive finalização e adendo. Transação revalida usuário, vínculo, sessão, clínica, perfil profissional, consulta e recurso; bloquear linhas relevantes e conferir estado/versão novamente antes da escrita. Alinhar ordem de locks com agenda, revogação e gestão de clínica; revisar deadlocks e índices antes da implementação. Versão concorrente retorna 409 sem perda de dados; duas criações concorrentes protegidas também por chave única. Rollback inclui registro, versão e auditoria.
8. Não implementar DELETE, atualização direta de versões, alterações em massa ou endpoint de exportação nesta fase. A imutabilidade proposta é da aplicação e das permissões de banco a projetar; não alegar prova criptográfica ou inviolabilidade contra administrador MySQL. Definir usuário de runtime de privilégio mínimo, backup e recuperação de versões em #31/#32.

## 5. Matriz de acesso inicial (negação por padrão)

| Ator | Rascunho | Versões finalizadas / adendos | Escrever |
| --- | --- | --- | --- |
| Profissional responsável, perfil e vínculo ativos, consulta elegível | próprio | próprios, no contexto e paciente autorizados | próprio |
| Outro profissional da mesma clínica com atendimento elegível ao mesmo paciente | não | não no MVP; compartilhamento assistencial específico a aprovar | não |
| Profissional sem atendimento elegível ou vínculo revogado | não | não | não |
| Titular de consultório próprio | mesmas regras de profissional, não de gestão | mesmas regras | mesmas regras |
| Administrador, secretaria, suporte, cobrança, operador da plataforma | não | não | não |
| Paciente/representante | não | não neste endpoint; fluxo de direitos e cópia em #32/#58 | não |

A linha do tempo inicial é deliberadamente limitada aos registros próprios autorizados no tenant. Não representa prontuário institucional compartilhado completo. Discutir continuidade assistencial, substituição e compartilhamento explícito por recurso antes de ampliar a leitura. Esta escolha reduz exposição enquanto #59/#32 estão abertas, mas é uma decisão de produto pendente, não exigência legal. Vínculo genérico de profissional não habilita consulta de todos os registros.

Consultar com predicados tenant+recurso+autoria+vínculo ativo, inclusive contagens e paginação. Negar 403 para papel/contexto sem capacidade clínica; 404 para recurso inexistente ou fora do escopo, sem distinguir existência em outro tenant. Revalidar autorização na mesma unidade transacional da leitura auditada. Se auditoria de acesso autorizado falhar, não retornar conteúdo. Não expor existência via busca, total, mensagens de erro ou diferenças de payload.

## 6. Contrato de API proposto

Rotas exclusivas autenticadas sob /api; nenhuma rota pública.

| Método e rota | Finalidade |
| --- | --- |
| GET /prontuarios/pacientes/:pacienteId | linha do tempo paginada dentro do escopo autorizado |
| POST /prontuarios/consultas/:consultaId | iniciar rascunho; servidor deriva contexto |
| GET /prontuarios/:id | detalhe autorizado e versão atual |
| GET /prontuarios/:id/versoes | histórico paginado de versões autorizadas |
| PATCH /prontuarios/:id/rascunho | salvar nova versão com versão esperada |
| POST /prontuarios/:id/finalizar | finalizar com versão esperada |
| POST /prontuarios/:id/adendos | incluir adendo com versão esperada |
| POST /prontuarios/:id/descartar-rascunho | marcar descarte sem apagar |

Usar validação de IDs, schema e allowlist de campos. Não aceitar alterações de identidade via mass assignment. Respostas clínicas com Cache-Control: no-store; sem payload em URLs, analytics, logs, notificações, localStorage ou service worker. Não expandir GET /pacientes/:id. Revisar CORS, TLS, XSS, CSP, autenticação e proteção de sessão antes de piloto. Tokens existentes não são evidência de autorização clínica por si sós.

## 7. Interface proposta (etapa C)

Entrada pelo atendimento do profissional autenticado; cabeçalho com contexto, paciente, data e consulta; editor de texto simples, estado de rascunho/finalizado, aviso de alterações não salvas, histórico cronológico paginado, identificação de autoria e adendos separados. Confirmação explícita para finalizar; conflitos de versão não sobrescrevem dados. Não persistir rascunho localmente; limpar memória/DOM ao sair ou trocar clínica, abortar requisições pendentes e descartar respostas de contexto anterior. Sem menu de prontuário para secretaria/administrador; backend independente da ocultação visual. Acessibilidade e responsividade 360 px e desktop; sem exibir conteúdo sensível em atalhos ou prévias.

## 8. Auditoria e proteção operacional

Eventos propostos: prontuario_criado, prontuario_rascunho_versionado, prontuario_finalizado, prontuario_adendo, prontuario_rascunho_descartado, prontuario_lido, prontuario_historico_lido e acesso_negado. Metadados mínimos: ator autenticado, tenant confiável, alvo autorizado, versão, resultado, request_id e horário; negar sem registrar alvo de outro tenant nem conteúdo submetido. Caso não exista vínculo válido para FK da auditoria, usar canal de segurança separado e sanitizado a definir na #31. Um request_id pode agrupar eventos; rever UNIQUE atual de (clinica_id, request_id) antes de assumir múltiplos eventos com mesmo ID.

Proibir CPF, nome, diagnóstico, narrativa, tokens e conteúdo de adendo nos logs. Auditoria de leitura e escrita testada, acesso aos eventos restrito. Não confundir auditoria de acesso com histórico clínico. Criptografia em trânsito, em repouso e de backups, gestão e rotação de chaves, restauração e gestão de incidentes são requisitos operacionais a definir e comprovar antes de dados reais; não presumir que a proteção específica do CPF já protege prontuário.

Exportabilidade futura: IDs estáveis, contexto, autoria, timestamps, schema_version, sequência e relações entre versões, incluindo adendos; #58 define autorização e formato. Sem exportação intertenant por padrão.

## 9. Matriz mínima de testes da etapa B/D

| Cenário | Resultado esperado |
| --- | --- |
| Rascunho, salvar, finalizar, adendo | sequência completa, original e autoria preservados |
| Dois POST concorrentes na mesma consulta | um registro; conflito controlado |
| Duas escritas/finalizações na mesma versão | uma escrita; outra 409; sem versão parcial |
| Falha de auditoria/constraint | rollback de todas as escritas; leitura sem vazamento |
| Troca de tenant e IDs cruzados inclusive históricos | 404/403, nenhuma leitura, contagem ou escrita indevida |
| Secretaria, administrador, operador e paciente | 403 inclusive URLs diretas |
| Mesmo médico em duas clínicas/consultório próprio | contextos e históricos separados |
| Outro médico mesma clínica e mesmo paciente | sem acesso às versões de terceiros na política MVP |
| Vínculo, sessão ou perfil revogado; clínica inativa | acesso seguinte negado; histórico preservado |
| Revogação/cancelamento concorrente com mutação | resultado serializável conforme ordem de locks; sem escrita após revogação efetiva |
| Consulta cancelada, futura ou não comparecida | criação/finalização bloqueada conforme regra; sem apagar histórico |
| Alteração de nome/conselho/perfil ou modelo | snapshot anterior preservado |
| Campos extras, HTML, payload grande e versão inválida | rejeição ou renderização segura; sem log sensível |
| Troca de clínica com resposta assíncrona antiga | conteúdo antigo não reaparece |
| Teste de migração | instalar do zero e atualizar fixture 015 com dados; checksums antigos e contagens preservados; reaplicar sem alterar dados |
| Backup/restauração isolados | versões, autoria e relações preservadas |
| Chrome desktop/360 px, teclado e foco | fluxo funcional sem vazamento |

Testes unitários, rotas, integração MySQL 8 com schema descartável exclusivo e CI dedicado. Proteções contra DROP de bases existentes, inclusive bancos de homologação. Atualizar suites que contam migrations e tabelas de reset sem ampliar permissões de ambientes reais. Testar upgrade 015 -> próxima migration, não somente banco novo. Nenhum dado real nas fixtures.

## 10. Gates e pendências

- A: revisão e aprovação explícita desta ADR e da política de acesso inicial; alinhar #59 e #31 antes de consolidar schema.
- B: migration aditiva, API e testes em branch separada, sem aplicar em banco existente; revisar ordem de locks, autorização por recurso, auditoria, privilégios e política de compartilhamento antes de merge.
- C: interface e testes próprios, sem acoplar prescrições, documentos, IA ou exportação.
- D: CI, integração, upgrade/restauração e homologação visual direcionada, com evidências sanitizadas; #32 valida responsabilidades, guarda, retenção, direitos, assinatura e requisitos profissionais antes de qualquer piloto real.

Decisões ainda não aprovadas: acesso por equipe clínica/continuidade, encerramento/custódia, retenção de rascunhos e versões, validação profissional por especialidade, assinatura e chaves de prontuário. Não fixar prazo legal de retenção nem declarar conformidade jurídica nesta ADR. #59 e #31 continuam abertas; #62 ainda tem homologação visual/upgrade pendentes. A etapa A não fecha nenhuma issue, não cria migration, não modifica código executável e não autoriza deploy.
