# M2 — redesign do dashboard administrativo

## Objetivo

Evoluir o painel administrativo para uma interface SaaS responsiva e profissional, mantendo os contratos de autenticação, seleção de clínica, autorização por papel e isolamento multi-tenant já existentes.

## Entrega visual

- menu lateral responsivo com visão geral, agenda e documentos;
- cabeçalho com a clínica ativa e acesso à troca de vínculo;
- indicadores auditados da clínica ativa;
- agenda resumida limitada a cinco horários futuros agendados ou confirmados;
- ações rápidas vinculadas somente a funcionalidades existentes;
- formulário de documentos preservado;
- navegação por teclado, títulos semânticos, regiões identificadas e suporte a redução de movimento.

## Privacidade

A agenda resumida não renderiza nome, ID ou outro identificador de paciente. O helper do frontend cria uma projeção segura contendo apenas horário, profissional e status antes da renderização. Não são exibidos indicadores financeiros nem valores fictícios.

## Responsividade

Em telas grandes, o menu permanece lateral. Em telas menores, transforma-se em painel recolhível do Bootstrap. Os indicadores passam de três colunas para uma coluna e os formulários reorganizam seus campos sem sobreposição.

## Continuidade recomendada

1. validar contraste e navegação com leitor de tela;
2. criar busca autorizada de pacientes para substituir a digitação manual de ID;
3. adicionar paginação e filtros de agenda por API, sem carregar registros clínicos desnecessários;
4. aplicar o mesmo sistema visual aos painéis de profissional e paciente em PRs separados.
