# Auditoria de dependências — 5 de novembro de 2026

O `npm audit` inicial encontrou sete pacotes vulneráveis: uma ocorrência moderada, cinco altas e uma crítica. Nenhuma correção com `--force` foi executada.

| Pacote | Relação | Severidade agregada | Risco principal | Versão corrigida no lockfile |
| --- | --- | --- | --- | --- |
| `proxy-addr` | transitiva do Express | crítica | falsificação de IP em sub-redes IPv4 mapeadas em IPv6 | 2.0.8 |
| `body-parser` | transitiva do Express | alta | negação de serviço no processamento de corpos | 2.4.0 |
| `jws` | transitiva de `jsonwebtoken` | alta | verificação imprópria de assinatura HMAC | 4.0.1 |
| `multer` | direta | alta | esgotamento de recursos e limpeza incompleta de uploads | 2.5.0 |
| `mysql2` | direta | alta | downgrade de autenticação e descompressão sem limite | 3.24.6 |
| `path-to-regexp` | transitiva do roteador Express | alta | ReDoS na avaliação de rotas | 8.4.2 |
| `qs` | transitiva do Express | moderada | negação de serviço durante parsing/serialização | 6.17.1 |

## Correção aplicada

- `multer`: `2.0.2` → `2.5.0`.
- `mysql2`: `3.14.3` → `3.24.6`.
- Dependências transitivas foram atualizadas dentro das faixas compatíveis já declaradas.
- Nenhuma dependência recebeu atualização de versão principal.
- `npm audit fix --force` não foi utilizado.

## Validação obrigatória

```bash
cd "backend/node modules"
npm ci
npm audit
npm test
```

Os testes opt-in com MySQL devem ser repetidos pelo proprietário no banco descartável após revisar este PR, porque este ambiente não acessa o MySQL local do proprietário.

O repositório legado ainda contém `node_modules` rastreado pelo Git. A regra de ignore impede novos arquivos, mas a remoção dos arquivos antigos deve ocorrer em uma entrega separada para evitar misturar milhares de exclusões com esta atualização. Até lá, todo ambiente deve executar `npm ci` e não reutilizar a cópia versionada.
