# M5-02B.3 — Auditoria criptográfica e recuperação de DDL

Estado: proposta experimental, não autoriza produção. Complementa ADR-003 (PR #72, pendente de integração) e ADR-004 (PR #73). Não fecha #19, #31, #32, #59 ou #62.

## Correções
- Migration 018 amplia somente os códigos de eventos da tabela prontuario_negativas. 016 e 017 ficam intactas. Falhas de resolução/wrapping da DEK e cifra são classificadas separadamente; rollback antes de registrar evento, sem segredo ou conteúdo. Falha de auditoria gera aviso sanitizado e a operação permanece negada. Não é trilha completa de incidentes: persistência anterior ao tenant, correlação e proteção externa seguem em #31.
- O provedor sintético exige autorização explícita em memória por teste Node além da configuração de ambiente e schema. Nenhuma rota de ativação, nenhuma chamada no servidor normal. Não representa mecanismo de produção nem defesa contra execução arbitrária de código.
- CI com bancos descartáveis exclusivos para agenda e profissionais; nenhum banco existente deve receber os testes que executam DROP TABLE.

## Reconciliação da migration 017
MySQL confirma DDL implicitamente. Sob o lock do migrator, pré-verificação consulta metadados e recusa qualquer sinal de 017 não registrada: alteração de nulabilidade/constraint (primeiro ALTER), índice de profissional (segundo ALTER), FK (terceiro ALTER), ou presença de qualquer das três tabelas (CREATEs seguintes). Também recusa versões legadas existentes. Não grava checksum 017 se falhar, não tenta corrigir objetos nem eliminar dados. A ledger já registrada continua sujeita à verificação de checksum; não é prova de integridade de todo o schema.

Procedimento de recuperação operacional proposto: interromper escritores e migrações, preservar estado parcial e logs sem payload, inventariar schema_migrations, constraints, índices, tabelas e colunas, comparar com snapshot pré-017 verificado; restaurar o snapshot consistente em outro schema isolado; comparar checksums, contagens, relações, chaves e registros; validar upgrade e aplicação em ambiente descartável antes de autorização para substituir ambiente afetado. Não repetir 017, remover objetos ou inserir checksum manualmente. Não há autorização para recuperação de banco existente. Se existirem versões clínicas legadas, planejar conversão separada. Migration 018 é um ALTER único; falha entre DDL e ledger também exige diagnóstico antes de reexecução.

O CI simula somente a primeira DDL confirmada de 017, exige recusa, verifica ledger e contagens, desfaz exclusivamente a alteração injetada em tabela sintética vazia e testa upgrade limpo. Não comprova restauração de backup operacional nem todas as falhas. Ensaios de recuperação, KMS, privacidade, guarda, identificação profissional e limites de chaves continuam pendentes. ADR-003 e ADR-004 devem ser integradas mediante revisão formal, sem presumir aprovação comercial.
