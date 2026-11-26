# ADR-004 — Proteção criptográfica de prontuários

Status: proposta implementada parcialmente para testes sintéticos; não autoriza produção. Complementa ADR-003 (PR #72) e #19. Dependências #31, #32, #59.

## Decisão

AES-256-GCM, DEK aleatória de 32 bytes por tenant e geração, IV aleatório de 12 bytes, tag de 16 bytes. Conteúdo e snapshot de autoria no mesmo envelope. AAD versão 1 é uma tupla JSON ordenada: domínio, versão, ambiente, clínica, paciente, consulta, profissional, registro, versão, versão anterior, autor, tipo, versão do schema e ID da chave. IDs decimais canônicos sem conversão insegura. O timestamp não integra o AAD neste protótipo. A DEK é protegida por uma KEK separada de CPF/JWT. AAD de wrapping inclui domínio, ambiente, clínica e ID da chave. Não reutilizar chaves entre finalidades ou ambientes.

## Entrega experimental

Migration 017 mantém 016 intacta; rejeita versões existentes com JSON em texto puro por CHECK antes de criar as demais estruturas. Não contém conversão de registros antigos, nem exclusão. Colunas JSON legadas permanecem NULL. Novas tabelas: prontuario_chaves, prontuario_envelopes, prontuario_negativas. FK composta profissional/autor impede divergência entre identidade e perfil. FK envelope/versão e envelope/chave asseguram o mesmo tenant. Apenas uma chave ativa por tenant; versões antigas leem pela chave histórica. Colisão de nonce persistido rejeitada por índice único. Criação de versão, envelope e auditoria na mesma transação; leitura sem conteúdo até autenticação GCM e commit de auditoria. API não retorna material criptográfico.

O provedor local usa KEK efêmera aleatória definida exclusivamente pela fixture, jamais pelo Git. Exige NODE_ENV=test, flag de integração e de habilitação, host loopback e nome exato de schema descartável. O controlador verifica SELECT DATABASE() na conexão. Não há implementação comercial, KMS ou fallback em texto puro. Chaves não são mantidas em cache. Limpeza de buffers é esforço parcial, não garantia de apagamento de objetos JS. A rotação demonstrada em teste desativa a chave anterior e a próxima gravação cria outra. Não é procedimento operacional. AAD não detecta rollback integral do banco.

Negativas de papel após tenant validado e erros de autorização/integridade no controlador são persistidos com código e horário, sem IDs submetidos nem payload. Falhas do log não concedem acesso. Eventos anteriores à autorização (autenticação, middleware de tenant), correlação de ator, trilha externa e proteção contra adulteração/abuso dependem da #31. Concorrência entre revogação/cancelamento e gravação é exercitada por transações de fixture; não é prova exaustiva. Regra profissional de finalização permanece provisória; descarte retido e consultável pelo autor autorizado, não aparece na linha do tempo normal.

## Antes de qualquer dado real

Implementar provedor KMS gerenciado, identidades temporárias/IAM mínimo, KEKs separadas por finalidade e ambiente, wrapping vinculado ao tenant, inventário e recuperação de chaves, rotação de DEKs/KEKs e recifragem com controle de geração. Definir e impor orçamento de uso da chave (incluindo tentativas/rollback, não somente envelopes persistidos); rotacionar antes de excedê-lo. O índice de nonce persistido não comprova unicidade de tentativas descartadas. Definir versão de AAD de produção separada da fixture. Testar comprometimento, indisponibilidade, recuperação e rotação. Não destruir chaves históricas sem política de guarda e prova de ausência de dependências. Backup completo cifrado com chave independente, TLS, recuperação temporal, privilégios mínimos, restauração em ambiente isolado e validação de versões históricas. Sem assinatura digital, compartilhamento assistencial ou conformidade jurídica demonstrada. #31/#32/#59 permanecem abertas.

## Migração e operação

Não executar migration 017 em bancos existentes sem inventário, autorização específica, backup e ensaio de restauração. DDL MySQL faz commits implícitos: falha parcial exige diagnóstico, não repetição automática. Se houver versões em texto puro, planejar conversão separada, sem apagar histórico, antes de aplicar a restrição. Não considerar exclusão de colunas como eliminação de backups antigos. Nenhuma migração operacional autorizada por esta ADR.

Referências: NIST SP 800-38D, SP 800-57; Node.js crypto; OWASP Cryptographic Storage e Key Management; AWS KMS e Google Cloud KMS envelope encryption. Proposta comercial depende de revisão de segurança e infraestrutura.
