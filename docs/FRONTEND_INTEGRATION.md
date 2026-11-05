# Integração do frontend multi-tenant

## Fluxo implementado

1. O login armazena temporariamente o token de identidade e os vínculos em `sessionStorage`.
2. O usuário é direcionado para `select-clinic.html`.
3. A seleção chama `POST /api/auth/select-clinic` com o token de identidade.
4. O token de clínica e a identidade visual da clínica ativa ficam restritos à aba atual.
5. O papel devolvido pelo servidor direciona o usuário ao painel permitido.
6. Respostas `401` encerram a sessão local. Respostas `403` relacionadas a vínculo ou clínica removem apenas o contexto da clínica e exigem nova seleção.

Não há renovação silenciosa: o backend ainda não oferece refresh token seguro. Quando o token expira, o usuário entra novamente. Não é correto simular renovação ou guardar a senha no navegador.

## Papéis e interface inicial

| Papel | Painel | Funções atuais |
| --- | --- | --- |
| administrador | administração | documento clínico e seleção de clínica |
| secretaria | administração | documento clínico e seleção de clínica |
| profissional | profissional | agenda própria e conclusão de consulta |
| paciente | paciente | agenda própria, agendamento e cancelamento |

O servidor continua sendo a autoridade. Ocultar botões no navegador melhora a experiência, mas não substitui as verificações de papel e tenant do backend.

## Contrato atualizado

- Profissionais: `GET /api/profissionais`.
- Agenda: `GET /api/consultas/minha-agenda`.
- Agendamento: `profissional_id`, `inicio_em` e `fim_em` em ISO 8601.
- Documentos: `POST /api/documentos/upload` com o campo de arquivo `documento`.
- O frontend não envia `clinica_id` nas operações clínicas.

## Armazenamento da sessão

Tokens não são gravados em `localStorage`. `sessionStorage` reduz persistência entre reinicializações e abas, mas continua acessível a JavaScript. Antes da comercialização, o fluxo deve migrar para cookies `HttpOnly`, `Secure` e `SameSite`, com proteção CSRF e rotação controlada de refresh token.

## Testes automatizados

`npm test` valida:

- separação entre token de identidade e token de clínica;
- limpeza completa da sessão;
- redirecionamento por papel;
- bloqueio de painel incompatível;
- transformação de horário local em intervalo UTC;
- ausência de `localStorage` no cliente;
- presença da etapa de seleção de clínica.

## Roteiro manual com dados fictícios

1. Inicie backend e frontend localmente.
2. Entre com cada usuário sintético do seed.
3. Confirme que a lista mostra apenas os vínculos daquele usuário.
4. Selecione a clínica e confirme nome e papel no painel.
5. Como paciente, liste profissionais, agende e cancele uma consulta.
6. Como profissional, confirme que somente a agenda própria aparece.
7. Como secretaria e administrador, valide o painel administrativo.
8. Troque IDs e tokens entre as duas clínicas e confirme `403` ou `404`.
9. Inative um vínculo no banco descartável e confirme que a próxima chamada exige nova seleção.
10. Expire ou adultere um token e confirme retorno ao login sem mostrar detalhes técnicos.

## Próximas entregas

- Criar painel central do administrador SaaS separado da administração da clínica.
- Criar convites e gestão de vínculos/papéis.
- Substituir IDs manuais de pacientes por busca autorizada.
- Adicionar estado de carregamento, paginação e acessibilidade completa.
- Implementar refresh token seguro no backend antes de qualquer renovação automática.
- Migrar arquivos clínicos para armazenamento privado com download autorizado.
- Separar configurações de API por ambiente sem colocar segredos no frontend.
- Restringir CORS por ambiente e adicionar uma Content Security Policy antes da publicação.
