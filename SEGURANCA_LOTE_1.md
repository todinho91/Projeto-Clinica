# Clínica Vitalis — configuração e rotação

## Desenvolvimento

1. Entre em `backend/node modules` e copie `.env.example` para `.env`.
2. Preencha `DB_HOST`, `DB_USER`, `DB_PASSWORD` e `DB_DATABASE` para um MySQL de desenvolvimento. Use uma conta com os privilégios necessários ao backend.
3. Gere uma chave independente por ambiente com `openssl rand -hex 32`. Coloque-a em `JWT_SECRET` sem copiá-la para logs, tickets ou commits.
4. Use `PORT` entre 1 e 65535. O padrão é 3000. Execute `npm ci`, `npm test` e `npm start` na pasta do backend. Os testes usam configurações sintéticas e simulam as consultas ao banco.

O backend carrega o `.env` ao lado de `server.js`. Variáveis fornecidas pelo ambiente do processo têm precedência. A inicialização falha se faltar uma configuração obrigatória, a chave tiver menos de 32 bytes após ignorar espaços nas extremidades ou a porta for inválida.

## Rotação em ambiente existente

1. Confirme com o proprietário quais instâncias executam a API, quais contas MySQL estão em uso e quais outros processos dependem delas. Autorize a janela e defina quem pode restringir o acesso ao backend se houver falha.
2. Prepare uma nova credencial MySQL de privilégio mínimo. Configure os consumidores autorizados pelo mecanismo de segredos do ambiente. Valide a API e os demais consumidores e revogue a credencial publicada. Se houver evidência de uso indevido, priorize a contenção e a revogação.
3. Configure um `JWT_SECRET` novo em todas as réplicas antes de reabrir o tráfego. Faça a transição sem réplicas aceitando a chave anterior. Valide novo login e recusa de tokens anteriores. Usuários precisarão entrar novamente.
4. Monitore erros de inicialização, conexão ao MySQL e autenticação. Em falha, mantenha o backend restrito e restaure uma versão que aceite segredos externos. Emita outra credencial segura se necessário. Mantenha os valores publicados revogados.
5. Trate a limpeza do histórico Git como decisão separada. A remoção do `.env` da árvore da branch mantém as cópias dos commits anteriores e possíveis clones.

A publicação estática do GitHub Pages e a configuração do backend são operações distintas. Segredos do backend ficam no ambiente do processo Node.js.
