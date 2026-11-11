# Consolidação técnica M0–M3

## Estado auditado

As PRs 39 a 47 foram integradas antes desta revisão. Não havia PR aberta em 10 de novembro de 2026. A `master` auditada iniciou em `32fbe3f`.

## Correções de segurança

- CORS limitado às origens explícitas em `CORS_ORIGINS`; curingas são recusados.
- Corpo JSON e formulários limitados a 1 MiB.
- Upload limitado a PDF, JPEG e PNG, com conferência de extensão, MIME e assinatura binária.
- Arquivos inválidos são removidos antes de qualquer consulta ou gravação no banco.
- Dependências e uploads de execução deixam de ser rastreados pelo Git.
- CI reproduzível usa Node.js 22, `npm ci`, testes, varredura de segredos e auditoria de dependências.

## Limites desta consolidação

- Nenhum banco, migration ou seed foi executado.
- A validação MySQL de duas clínicas em `vitalis_m3_validacao` permanece pendente de confirmação explícita do banco conectado e autorização específica.
- Não existe endpoint de download de documentos; os arquivos permanecem privados no armazenamento local e não são servidos estaticamente.
- A rotação externa das credenciais que apareceram no histórico antigo continua sendo responsabilidade operacional do proprietário.
- CSP, cookies HttpOnly/refresh token, proteção CSRF, rate limiting e armazenamento privado externo continuam pendentes antes de produção.
