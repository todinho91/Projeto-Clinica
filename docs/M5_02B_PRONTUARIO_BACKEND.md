# M5-02B — Backend experimental do prontuário versionado (#19)

Base d508d993. A arquitetura aprovada pelo responsável está na ADR-003, PR #72 (ainda não integrada). Esta branch depende da revisão documental; não fecha #19.

## Entrega

Migration 016 aditiva, registros por consulta e versões append-only na aplicação; referências compostas à consulta com paciente/profissional e tenant. O autor é derivado do profissional ativo e seu vínculo, nunca do corpo. Uma versão anterior é referenciada pelas versões seguintes. A versão corrente avança em transação com auditoria. A API está desativada por padrão (VITALIS_CLINICAL_RECORDS_ENABLED=1 somente em homologação sintética autorizada).

Rotas sob /api/prontuarios: GET pacientes/:pacienteId, POST consultas/:consultaId, GET :id, GET :id/versoes, PATCH :id/rascunho, POST :id/finalizar, POST :id/adendos e POST :id/descartar-rascunho. GET lista/versões aceita pagina e limite (máximo 50), sem contagem global. POST inicial aceita conteudo opcional (objeto); mutações aceitam versao esperada; rascunho recebe snapshot completo em conteudo, adendo recebe conteudo.texto e conteudo.motivo. Finalizar e descartar só aceitam versao. Conteúdo com campos desconhecidos ou acima dos limites é rejeitado. Valores nulos representam não informado; ausência declarada deve ser registrada explicitamente. Texto puro, não HTML para renderização futura.

Acesso somente ao profissional responsável ativo, na clínica do token, com sessão e vínculo revalidados e consulta elegível. Consultório próprio exige titular ativo e identidade verificada. Registros finalizados permanecem legíveis ao autor autorizado mesmo em anomalia posterior da agenda; mutação exige consulta elegível. Rascunhos cancelados permanecem armazenados, não são publicados nem acessíveis pelo fluxo normal. Descarte preserva versões e impede reabertura nesta fase. O índice composto impede trocar o profissional de consulta com prontuário (409 no reagendamento); reagendamento do mesmo profissional mantém o snapshot do início original. Finalizar não muda o status da agenda. Adendo é versão separada, não substitui conteúdo final anterior. O detalhe retorna a última versão (que pode ser adendo); a interface deve buscar histórico para exibir original. Sem assinatura digital. Regra mínima provisória para finalizar: evolução, conduta, tipo e número de conselho do perfil local. Identidade global e conselho informado são distinguidos no snapshot; não constitui validação jurídica ou profissional.

## Limites e gates

- Conteúdo clínico JSON ainda sem cifra de aplicação; é exclusivo de fixtures até aprovação de proteção em repouso, chaves, TLS, backup, runtime de mínimo privilégio, custódia, retenção e revisão #31/#32/#59. O flag não é autorização para produção. Não confundir histórico append-only pela API com imutabilidade perante administrador do banco.
- Sem compartilhamento entre profissionais, acesso de paciente/representante, assinatura, interface ou exportação. Continuidade assistencial deve ser definida antes do piloto real.
- A auditoria grava somente metadados mínimos; falha de auditoria bloqueia leitura e desfaz escrita. Negativas registram aviso sanitizado sem alvo; canal de segurança completo depende da #31. Locks de vínculo, clínica, perfil e consulta reduzem janelas de revogação; deadlocks retornam conflito e exigem nova leitura. Não há prova formal de ausência de deadlocks.
- A migration adiciona índice a consultas; DDL MySQL pode fazer commit implícito. Em falha parcial, não reexecutar às cegas: conferir information_schema e schema_migrations, restaurar ou reconciliar com autorização. Não aplicar em base existente sem backup/restauração validados e janela própria.
- CI dedicado exige schema vazio com nome exato vitalis_prontuarios_ci_test, MySQL 8 local, sem reset destrutivo. Testa upgrade de 015 com fixtures, checksums, versão concorrente, roles, isolamento e rollback. Suites antigas continuam sob seus próprios guards; não executar em bancos visuais/operacionais.
- Esta etapa não aprova dados reais nem encerra M5. Revisar logs de CI, testes omitidos e casos de concorrência revogação/cancelamento, política de compartilhamento, e homologação visual nas etapas seguintes.

## Complemento M5-02B.1/B.2

Este documento descreve a entrega inicial 016. A migration 017 e a ADR-004 complementam e substituem a descrição de armazenamento JSON e de habilitação do backend: o conteúdo e autoria passam a envelope cifrado e o acesso é exclusivo do schema sintético de CI. A flag isolada não habilita a API. Ver docs/adr/ADR-004-protecao-criptografica-prontuarios.md para limites e requisitos pendentes. Nenhum ambiente persistente deve receber a migration sem autorização específica.
