# Vitalis — revisão de produto e roadmap M0–M11

Repositório de destino [todinho91/Projeto-Clinica](https://github.com/todinho91/Projeto-Clinica). Plano para aprovação e criação posterior. Em 3 de novembro de 2026 a consulta retornou zero milestones e zero issues. As labels padrão existentes ficam preservadas. Antes de publicar, repetir a consulta incluindo itens fechados, reutilizar correspondências e substituir os IDs de dependência deste documento pelos números reais do GitHub. Criar milestones e labels antes das issues. Evitar datas até validar capacidade, dependências e escopo do piloto.

## Diagnóstico e decisões propostas

- **Aproveitar** páginas HTML/CSS, protótipos de painel, rotas Express e a experiência inicial com MySQL e bcrypt. Usar a auditoria existente e revisar o Lote 1 local `0710776` antes de integrá-lo. Seus 12 testes são uma base para CI.
- **Corrigir** cadastro público permissivo, acesso por IDs sem vínculo, upload e exposição de arquivos, configuração web e inconsistências de identificação de profissionais. O SQL versionado vazio impede inferir o esquema implantado ou propor conversão automática.
- **Arquitetura**. Começar com monólito modular Node/Express e API versionada. MySQL relacional com migrações, transações, chaves de escopo composto, índices por clínica e limites de escrita. Usar armazenamento privado com metadados no banco e autorização no download. Documentar sessões, revogação e identidade antes de ampliar a API. Avaliar evolução do frontend após mapear os fluxos que podem ser reaproveitados.
- **Operação**. O GitHub Pages publicou o frontend estático e o JavaScript aponta para uma API local. A implantação de backend e banco permanece desconhecida. Planejar desenvolvimento, homologação sintética e produção separados, segredos externos, TLS, backups de banco e arquivos, recuperação ensaiada e alertas com logs minimizados.
- **Privacidade**. Dados de saúde são sensíveis. Validar responsabilidades por fluxo, base legal, finalidade, retenção e descarte, atendimento aos titulares, comunicação de incidentes, fornecedores e regras profissionais com responsáveis jurídicos e clínicos. A política de acesso clínico precisa de aceite antes de dados reais. [LGPD e agentes de tratamento](https://www.gov.br/saude/pt-br/acesso-a-informacao/lgpd)
- **Comercialização**. Separar cobrança da assinatura Vitalis do financeiro de cada clínica. Definir planos, limites, suspensão e saída de cliente. Integrar primeiro em sandbox, com conciliação, idempotência e suporte. Confirmar preços e escopo com clínicas-piloto antes de liberar cobrança comercial.

## Modelo de identidade e acesso

| Camada | Responsabilidade |
|---|---|
| Marca Vitalis | Identidade pública, títulos, login da plataforma, documentação e apresentação do SaaS. |
| Administração central | Provisionamento, planos, suporte e operação com permissões próprias e trilha. Acesso clínico de suporte exige política explícita, escopo, prazo e auditoria. |
| Clínica cliente | Nome, marca opcional, slug, fuso, agenda, configurações e dados próprios. |
| Usuário e vínculo | Identidade global com vínculo, papel e estado por clínica. A clínica ativa é validada no servidor. A mesma conta pode ter papéis distintos. |
| Profissional e especialidade | Perfil profissional e disponibilidade por vínculo clínico. Definir catálogo global de referência e configurações locais em ADR. |
| Paciente e dados clínicos | Cadastro e registros por clínica, com permissões por recurso e finalidade, histórico de autoria e arquivos privados. Evitar compartilhar ou deduplicar registros entre clínicas automaticamente. |

A transição da marca começa por inventário de títulos, metadados, login e documentação. Depois atualiza navegação e painéis e usa o nome da clínica a partir das suas configurações. Preserva dados de clientes, referências históricas, funcionalidades e o nome atual do repositório nesta etapa.

## Sequência e bloqueios

- **Primeiro** M0 e desenho de M8/M9 em paralelo. Confirmar hospedagem e consumidores de segredos, revisar o Lote 1 e conter exposição.
- **Fundação** M1 com homologação sintética de M8 e testes de isolamento de M9. O desenho de marca em M2 pode avançar cedo. A troca de clínica depende do controle de acesso.
- **Fluxos centrais** M3 e cadastro mínimo M5-01 antes do agendamento M4-02. Prontuário e documentos seguem com auditoria e armazenamento privado. M6 e M7 avançam após as dependências específicas.
- **Piloto e lançamento** M8 com recuperação verificada e M9 com aceite jurídico/profissional e revisão técnica antes do uso real. M10 começa sintético e usa dados reais somente após liberação. M11 vem após estabilidade web e contrato da API.

## Labels propostas

| Label | Uso |
|---|---|
| `P0` · `P1` · `P2` · `P3` | Bloqueio de segurança/lançamento · fundação ou fluxo essencial · complemento planejado · pós-MVP |
| `security` · `privacy` · `migration` | Controle de segurança · tratamento de dados · migração e retorno |
| `backend` · `frontend` · `infra` · `quality` | API e banco · interface · operação · verificação |
| `billing` · `product` · `mobile` | Assinaturas · onboarding e lançamento · aplicativos |

## Milestones e issues prontas para cadastro

### M0 — Segurança e estabilização

**Objetivo** · Conter os riscos do protótipo e estabelecer uma base testável.

**Dependências** · —

**Conclusão** · Segredos expostos tratados ou comprovadamente inativos, acessos indevidos e publicação de arquivos bloqueados, CI verde.

#### M0-00 — Inventariar instalações e decidir a contenção

- **Labels** · `P0`, `security`
- **Objetivo** · Identificar consumidores da API, MySQL e publicação estática.
- **Dependências** · —
- **Aceite** · Inventário aprovado, responsável e janela definidos, arquivo público classificado por pessoal autorizado e contenção registrada.
- **Risco de segurança ou migração** · Exposição clínica e dependências desconhecidas.
- **Testes** · Conferir inventário e evidências por ambiente, sem usar credenciais publicadas.

#### M0-01 — Revisar e integrar o Lote 1 de configuração

- **Labels** · `P0`, `security`
- **Objetivo** · Reusar o commit local 0710776 após revalidação e coordenar a troca autorizada de segredos ativos.
- **Dependências** · M0-00
- **Aceite** · CI reproduz os 12 testes, configuração obrigatória validada e tokens da chave anterior rejeitados após a troca.
- **Risco de segurança ou migração** · Interrupção de sessão e de consumidores MySQL, retorno com segredo seguro.
- **Testes** · Login sintético, chave antiga, expiração, algoritmo, ausência de configuração e smoke test em homologação.

#### M0-02 — Fechar cadastro privilegiado e acessos diretos

- **Labels** · `P0`, `security`
- **Objetivo** · Fixar perfil público e aplicar política por papel e recurso nas rotas atuais.
- **Dependências** · M0-01
- **Aceite** · Cadastro não concede papel privilegiado e é transacional. Pacientes, consultas e exames sem vínculo comprovado são bloqueados.
- **Risco de segurança ou migração** · Contas legadas privilegiadas e regressão de permissões legítimas.
- **Testes** · Escalada por payload, erro parcial, leitura e alteração por ID de terceiro.

#### M0-03 — Bloquear publicação estática e endurecer uploads

- **Labels** · `P0`, `security`
- **Objetivo** · Retirar acesso anônimo e validar autorização antes de persistir arquivo.
- **Dependências** · M0-02
- **Aceite** · Arquivos privados, limites e tipos válidos, sem resíduos após falha.
- **Risco de segurança ou migração** · Arquivos públicos, órfãos e perda de vínculo legado.
- **Testes** · Download anônimo, MIME falso, tamanho, falha de banco e armazenamento.

#### M0-04 — Rodar CI reproduzível do backend

- **Labels** · `P1`, `quality`
- **Objetivo** · Fixar runtime suportado, instalar pelo lockfile e rodar testes e varredura de segredos.
- **Dependências** · M0-01
- **Aceite** · Checkout limpo executa instalação e testes sem credenciais reais e bloqueia regressões conhecidas.
- **Risco de segurança ou migração** · Dependências vendorizadas e falso positivo em histórico.
- **Testes** · CI limpo e fixture de segredo sintético detectado.

### M1 — Fundação SaaS multi-tenant

**Objetivo** · Estabelecer fronteira de acesso e integridade por clínica.

**Dependências** · M0

**Conclusão** · Todas as rotas e escritas escopadas e matriz entre duas clínicas aprovada antes de dados reais.

#### M1-01 — Definir esquema de clínicas, identidade e vínculos

- **Labels** · `P0`, `backend`
- **Objetivo** · Especificar usuário global, vínculo clínico e papéis por clínica, com administração central separada.
- **Dependências** · M0-02
- **Aceite** · ADR e esquema aprovados, índices e chaves impedem vínculos inconsistentes.
- **Risco de segurança ou migração** · SQL legado vazio e papéis ambíguos.
- **Testes** · Banco vazio e schema sintético legado, chave estrangeira cruzada rejeitada.

#### M1-02 — Resolver a clínica ativa e autorizar por recurso

- **Labels** · `P0`, `security`
- **Objetivo** · Verificar vínculo ativo no servidor e escopar leituras, escritas e arquivos.
- **Dependências** · M1-01, M0-03
- **Aceite** · Cabeçalhos e IDs do cliente não ampliam acesso. Toda rota protegida passa pela política.
- **Risco de segurança ou migração** · Acesso cruzado, cache obsoleto e revogação.
- **Testes** · Duas clínicas, usuário em ambas, vínculo revogado, ID cruzado e chamada direta.

#### M1-03 — Ensaiar preenchimento de clínica e retorno

- **Labels** · `P0`, `migration`
- **Objetivo** · Criar migrações aditivas, conciliar registros e separar os ambíguos.
- **Dependências** · M1-01, M8-02
- **Aceite** · Contagens conciliadas, reexecução idempotente e restauração ensaiada.
- **Risco de segurança ou migração** · Atribuição incorreta de dados clínicos e perda após rollback.
- **Testes** · Dados sintéticos legados, duplicados, órfãos e recuperação.

### M2 — Identidade Vitalis e experiência de usuário

**Objetivo** · Unificar a experiência web e separar marca SaaS de identidade clínica.

**Dependências** · M1-02 para troca de clínica

**Conclusão** · Marca Vitalis em pontos ativos, contexto clínico explícito, navegação responsiva e acessível.

#### M2-01 — Inventariar e substituir referências de marca

- **Labels** · `P1`, `frontend`
- **Objetivo** · Atualizar gradualmente título, login, metadados, painéis e documentação por área.
- **Dependências** · —
- **Aceite** · Marca Vitalis nos pontos da plataforma, nome da clínica vindo de configuração. Dados e referências históricas preservados.
- **Risco de segurança ou migração** · Confundir clínica e plataforma ou sobrescrever identidade de cliente.
- **Testes** · Busca de textos em superfícies ativas e screenshots de duas clínicas fictícias.

#### M2-02 — Construir navegação e troca de clínica

- **Labels** · `P1`, `frontend`
- **Objetivo** · Criar shell acessível com clínica ativa e áreas conforme permissão.
- **Dependências** · M1-02, M2-01
- **Aceite** · Troca invalida estado anterior. Login e navegação funcionam em celular e desktop.
- **Risco de segurança ou migração** · Cache de clínica anterior e componentes que insinuam acesso.
- **Testes** · Teclado, foco, contraste, 360 px e teste de troca de clínica.

#### M2-03 — Ajustar painéis por perfil

- **Labels** · `P2`, `frontend`
- **Objetivo** · Padronizar carregamento, vazio, erros e permissões nos painéis existentes.
- **Dependências** · M2-02
- **Aceite** · Cada perfil vê seus atalhos e chamadas autorizadas.
- **Risco de segurança ou migração** · Dados injetados na interface e exposição em erro.
- **Testes** · E2E por perfil, dados de entrada renderizados como texto e regressão responsiva.

### M3 — Gestão de clínicas

**Objetivo** · Permitir configurar clínicas, equipe e catálogo profissional.

**Dependências** · M1, M2-02 para UI

**Conclusão** · Admin autorizado configura sua clínica, convida equipe e mantém profissionais e especialidades.

#### M3-01 — Provisionar clínica e configurações básicas

- **Labels** · `P1`, `backend`
- **Objetivo** · Criar clínica e primeiro administrador com estado inicial explícito.
- **Dependências** · M1-01, M1-02
- **Aceite** · Criação transacional, slug único e nome/fuso editáveis por admin autorizado.
- **Risco de segurança ou migração** · Provisionamento duplicado e identidade misturada.
- **Testes** · Falha parcial, repetição, permissões e isolamento das configurações.

#### M3-02 — Convidar e revogar membros de equipe

- **Labels** · `P1`, `security`
- **Objetivo** · Gerenciar vínculo e papel dentro da clínica ativa.
- **Dependências** · M3-01
- **Aceite** · Convites expiram e são de uso único, revogação bloqueia sessão e papel superior exige autorização.
- **Risco de segurança ou migração** · Elevação de privilégio e perda do último admin.
- **Testes** · Convite reutilizado, revogado, cross-tenant e último admin.

#### M3-03 — Manter profissionais e especialidades da clínica

- **Labels** · `P1`, `backend`
- **Objetivo** · Vincular perfis e especialidades ao contexto clínico.
- **Dependências** · M3-01
- **Aceite** · Diretório mostra só profissionais vinculados e usa ID profissional consistente.
- **Risco de segurança ou migração** · Confusão entre ID de usuário e profissional e referências legadas.
- **Testes** · IDs distintos, especialidade desativada e vínculo cruzado.

### M4 — Agenda e consultas

**Objetivo** · Entregar agenda confiável para clínicas e profissionais.

**Dependências** · M1, M3-03, M5-01

**Conclusão** · Agendar, confirmar e cancelar com permissões, concorrência e fuso verificados.

#### M4-01 — Modelar disponibilidade e bloqueios

- **Labels** · `P1`, `backend`
- **Objetivo** · Definir horários por profissional e clínica com fuso configurado.
- **Dependências** · M3-03
- **Aceite** · Horários e exceções consistentes e protegidos por clínica.
- **Risco de segurança ou migração** · Conversão de fuso e regra legada ambígua.
- **Testes** · Limites do dia, sobreposição e fusos diferentes.

#### M4-02 — Agendar e aplicar transições de consulta

- **Labels** · `P1`, `backend`
- **Objetivo** · Controlar criação, confirmação, cancelamento e status sem dupla reserva.
- **Dependências** · M4-01, M5-01
- **Aceite** · Transições autorizadas e atômicas, concorrência permite uma reserva por horário definido.
- **Risco de segurança ou migração** · Dupla reserva e perda de trilha em cancelamento.
- **Testes** · Concorrência, repetição, transição inválida e ID cruzado.

#### M4-03 — Exibir calendário e agenda por papel

- **Labels** · `P2`, `frontend`
- **Objetivo** · Oferecer calendário e listas com estados claros.
- **Dependências** · M4-02, M2-02
- **Aceite** · Filtros por clínica e profissional, uso por teclado e tela pequena.
- **Risco de segurança ou migração** · Excesso de dados no calendário e cache após troca.
- **Testes** · E2E de agenda, filtros e acessibilidade.

### M5 — Pacientes e prontuários

**Objetivo** · Entregar cadastro, histórico e documentação clínica com acesso restrito.

**Dependências** · M1, M8-02, M9 para piloto real

**Conclusão** · Cadastro e histórico isolados, prontuário versionado, arquivos privados e fluxos clínicos aprovados para o escopo piloto.

#### M5-01 — Cadastrar paciente e vincular à clínica

- **Labels** · `P1`, `backend`
- **Objetivo** · Criar perfil mínimo, busca e edição com regras para duplicidade.
- **Dependências** · M1-02, M3-01
- **Aceite** · Clínicas têm cadastros isolados e busca retorna campos mínimos.
- **Risco de segurança ou migração** · Fusão indevida e deduplicação de identidade sem autorização.
- **Testes** · Duplicata dentro e entre clínicas, busca e acesso por ID.

#### M5-02 — Registrar histórico e versões do prontuário

- **Labels** · `P0`, `security`
- **Objetivo** · Definir autoria, acesso clínico, revisões e trilha de alterações.
- **Dependências** · M5-01, M9-02
- **Aceite** · Versões e autoria preservadas, papéis administrativos sem acesso clínico padrão.
- **Risco de segurança ou migração** · Perda de histórico e leitura indevida por equipe de apoio.
- **Testes** · Alteração concorrente, histórico, papéis e acesso cruzado.

#### M5-03 — Anexar e baixar documentos clínicos privados

- **Labels** · `P0`, `security`
- **Objetivo** · Ligar armazenamento privado ao paciente e à clínica e tratar metadados legados.
- **Dependências** · M0-03, M5-01, M8-02
- **Aceite** · Links expiram ou downloads são autorizados, falhas não deixam órfãos e arquivos legados são conciliados.
- **Risco de segurança ou migração** · URL reutilizada, documento trocado e migração sem vínculo.
- **Testes** · Expiração, tipo real do arquivo, falha parcial e dois tenants.

#### M5-04 — Validar modelos de prontuário por especialidade

- **Labels** · `P2`, `backend`
- **Objetivo** · Criar piloto de modelos versionados com revisão profissional.
- **Dependências** · M5-02, M9-03
- **Aceite** · Dois modelos sintéticos validados e registros antigos continuam legíveis após revisão.
- **Risco de segurança ou migração** · Campos excessivos e alteração retroativa.
- **Testes** · Validação por versão e migração de modelo sem perda.

### M6 — Financeiro

**Objetivo** · Controlar as movimentações internas da clínica.

**Dependências** · M1, M3, M4-02 quando ligado a consultas

**Conclusão** · Receitas e despesas conciliáveis, relatórios isolados e reversões auditáveis.

#### M6-01 — Registrar recebimentos, despesas e estornos

- **Labels** · `P2`, `backend`
- **Objetivo** · Criar lançamentos por clínica, com valores em centavos e trilha de reversão.
- **Dependências** · M1-02, M3-01
- **Aceite** · Lançamentos têm autoria, saldo reproduzível e reversão auditável.
- **Risco de segurança ou migração** · Duplicidade, arredondamento e permissões financeiras.
- **Testes** · Repetição, estorno e concorrência com valores sintéticos.

#### M6-02 — Emitir relatórios e exportações financeiras

- **Labels** · `P2`, `frontend`
- **Objetivo** · Exibir totais por período e exportar para perfis autorizados.
- **Dependências** · M6-01
- **Aceite** · Totais conferem com lançamentos e exportação não atravessa clínica.
- **Risco de segurança ou migração** · Vazamento em exportação e fórmulas em CSV.
- **Testes** · Conciliação, fuso, isolamento e neutralização de fórmulas.

### M7 — Assinaturas SaaS

**Objetivo** · Cobrar da clínica pelo Vitalis e controlar o acesso ao plano.

**Dependências** · M3, M8-02 e revisão comercial de M9-03

**Conclusão** · Planos, cobrança de teste e gestão comercial reconciliados com regras de suspensão seguras.

#### M7-01 — Modelar planos, limites e estados da assinatura

- **Labels** · `P2`, `billing`
- **Objetivo** · Separar assinatura SaaS do financeiro da clínica.
- **Dependências** · M3-01
- **Aceite** · Limites são aplicados no servidor e suspensão preserva acesso previsto pela política aprovada.
- **Risco de segurança ou migração** · Bloqueio indevido de dados clínicos e concorrência no limite.
- **Testes** · Upgrade, downgrade, suspensão e uso simultâneo.

#### M7-02 — Integrar cobrança recorrente em sandbox

- **Labels** · `P2`, `billing`
- **Objetivo** · Validar assinatura de webhooks e processar eventos de forma idempotente.
- **Dependências** · M7-01, M8-02
- **Aceite** · Eventos repetidos e fora de ordem não duplicam cobranças ou estados. Vitalis não armazena dados de cartão.
- **Risco de segurança ou migração** · Fraude de webhook e divergência de faturamento.
- **Testes** · Evento inválido, repetido, atrasado e conciliação sintética.

#### M7-03 — Disponibilizar faturamento e operação comercial

- **Labels** · `P2`, `billing`
- **Objetivo** · Criar visão central de planos, cobranças e histórico administrativo.
- **Dependências** · M7-02
- **Aceite** · Faturas e estado conciliados, acesso comercial separado de prontuários.
- **Risco de segurança ou migração** · Acesso indevido por admin central e erro de cobrança.
- **Testes** · Matriz de papéis, conciliação e trilha de alteração.

### M8 — Cloud e operação

**Objetivo** · Planejar cedo e entregar operação isolada e recuperável.

**Dependências** · Começa em paralelo com M0. Ambientes reais exigem decisão do proprietário.

**Conclusão** · Ambientes segregados, segredos externos, recuperação ensaiada e monitoramento ativo antes do piloto real.

#### M8-01 — Definir arquitetura e orçamento de ambientes

- **Labels** · `P1`, `infra`
- **Objetivo** · Planejar web, API, MySQL e armazenamento privado com ambientes separados.
- **Dependências** · M0-00
- **Aceite** · ADR lista custos, responsáveis, limites e escolha a aprovar, sem contratação nesta etapa.
- **Risco de segurança ou migração** · Dependência de provedor e gastos inesperados.
- **Testes** · Revisão da topologia e simulação de custo e capacidade.

#### M8-02 — Preparar homologação, pipeline e armazenamento privado

- **Labels** · `P1`, `infra`
- **Objetivo** · Separar identidades, segredos e dados por ambiente, com deploy aprovado e TLS.
- **Dependências** · M8-01, M0-01
- **Aceite** · Homologação usa dados sintéticos e pipeline exige aprovação para produção.
- **Risco de segurança ou migração** · Credenciais cruzadas e armazenamento público.
- **Testes** · Smoke test, autenticação, política de bucket e isolamento de ambiente.

#### M8-03 — Ensaiar backup, restauração e alertas

- **Labels** · `P0`, `infra`
- **Objetivo** · Definir RPO/RTO, restaurar em ambiente isolado e testar alertas sem dados sensíveis.
- **Dependências** · M8-02
- **Aceite** · Tempos registrados, recuperação de banco e arquivos verificada e alertas chegam aos responsáveis.
- **Risco de segurança ou migração** · Backup inconsistente e logs sensíveis.
- **Testes** · Restauração completa, verificação referencial e simulação de falhas.

### M9 — Qualidade, segurança e conformidade

**Objetivo** · Consolidar critérios de segurança, testes e privacidade ao longo do desenvolvimento.

**Dependências** · Começa em M0, fecha antes do piloto real e lançamento.

**Conclusão** · Matriz de isolamento aprovada, trilha revisada e aceite jurídico/profissional documentado.

#### M9-01 — Automatizar regressões entre duas clínicas

- **Labels** · `P0`, `quality`
- **Objetivo** · Executar matriz de acesso por recurso e papel continuamente.
- **Dependências** · M0-04, M1-02
- **Aceite** · CI cobre lista, leitura, escrita, arquivo e exportação quando disponíveis.
- **Risco de segurança ou migração** · Testes com mocks ocultam falha de banco ou storage.
- **Testes** · Integração com banco e armazenamento sintéticos, testes negativos e positivos.

#### M9-02 — Definir eventos de auditoria e resposta a incidentes

- **Labels** · `P0`, `privacy`
- **Objetivo** · Registrar ações clínicas e administrativas com autoria, clínica e alvo mínimos.
- **Dependências** · M1-01
- **Aceite** · Eventos acessíveis só a perfis previstos, sem conteúdo clínico, e simulado de incidente concluído.
- **Risco de segurança ou migração** · Logs virarem fonte de dados sensíveis.
- **Testes** · Alteração de registro, acesso negado, retenção e simulado de incidente.

#### M9-03 — Validar tratamento de dados e requisitos profissionais

- **Labels** · `P0`, `privacy`
- **Objetivo** · Mapear finalidades, bases, retenção, direitos, contratos e responsabilidades por fluxo.
- **Dependências** · M8-01, com validação antes de M10-02 real
- **Aceite** · Pareceres e decisões assinados pelos responsáveis, pendências impeditivas tratadas.
- **Risco de segurança ou migração** · Usar base, prazo ou regra profissional inadequada.
- **Testes** · Exercício de solicitação de titular, exportação, retenção e análise de incidente.

#### M9-04 — Revisar segurança antes do piloto real

- **Labels** · `P0`, `security`
- **Objetivo** · Revisar autenticação, acesso cruzado, dependências, arquivos e recuperação.
- **Dependências** · M9-01, M9-02, M8-03 e fluxos do piloto
- **Aceite** · Nenhum achado crítico ou alto aberto no escopo do piloto.
- **Risco de segurança ou migração** · Falhas de autorização e recuperação não reproduzível.
- **Testes** · Revisão independente e reteste com dados sintéticos.

### M10 — MVP comercial

**Objetivo** · Validar operação e proposta comercial em clínicas-piloto.

**Dependências** · M0–M5 essenciais, M7 e M8 operacionais, M9 aprovado. M6 conforme escopo comercial.

**Conclusão** · Onboarding e suporte ensaiados, piloto aceito e decisão formal de lançamento.

#### M10-01 — Preparar onboarding, suporte e documentação

- **Labels** · `P1`, `product`
- **Objetivo** · Definir checklist de implantação de uma clínica, canal e tempos de resposta.
- **Dependências** · M3-02, M8-02
- **Aceite** · Clínica fictícia consegue entrar e completar os fluxos principais com a documentação.
- **Risco de segurança ou migração** · Provisionar tenant incorreto ou pedir dados clínicos por suporte.
- **Testes** · Ensaio de onboarding e simulado de chamado.

#### M10-02 — Executar piloto controlado

- **Labels** · `P1`, `product`
- **Objetivo** · Começar com dados sintéticos e habilitar dados reais só após aprovação de segurança e privacidade.
- **Dependências** · M10-01, M8-03, M9-03, M9-04, M4-03 e M5 no escopo
- **Aceite** · Critérios de piloto e feedback registrados, plano de saída testado.
- **Risco de segurança ou migração** · Exposição clínica, migração irreversível e suporte insuficiente.
- **Testes** · E2E, simulado de incidente, saída e exportação autorizada.

#### M10-03 — Decidir lançamento com critérios verificáveis

- **Labels** · `P1`, `product`
- **Objetivo** · Revisar resultados do piloto, cobrança, suporte e recuperação.
- **Dependências** · M10-02, M7-03
- **Aceite** · Decisão registrada, responsável por cada pendência e condições de suspensão acordadas.
- **Risco de segurança ou migração** · Lançar com falha grave ou cobrança não reconciliada.
- **Testes** · Checklist de lançamento, evidência de restauração e smoke test comercial.

### M11 — Aplicativo mobile

**Objetivo** · Avaliar Android e iOS após estabilização do produto web.

**Dependências** · M10 e contrato estável da API

**Conclusão** · Decisão registrada, escopo inicial estimado e requisitos mobile documentados.

#### M11-01 — Validar demanda e prontidão da API

- **Labels** · `P3`, `mobile`
- **Objetivo** · Priorizar casos mobile por perfil e avaliar contratos reutilizáveis.
- **Dependências** · M10-03
- **Aceite** · Decisão Android/iOS e escopo inicial fundamentados em uso do web.
- **Risco de segurança ou migração** · Duplicar regra de negócio e introduzir divergências na API.
- **Testes** · Provas de contrato com cliente sintético.

#### M11-02 — Planejar sessão, cache e distribuição

- **Labels** · `P3`, `mobile`
- **Objetivo** · Definir armazenamento de sessão, limpeza de cache, notificações e requisitos de lojas.
- **Dependências** · M11-01
- **Aceite** · Plano descreve logout, revogação, troca de clínica e política offline.
- **Risco de segurança ou migração** · Dados clínicos em dispositivo, cache ou push.
- **Testes** · Protótipo com dados fictícios em perda de rede, troca de conta e revogação.

