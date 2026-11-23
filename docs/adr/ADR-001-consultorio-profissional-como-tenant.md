# ADR-001 — Consultório profissional como tenant explícito

- Status: proposto na issue #59
- Data: 2026-11-22
- Escopo: M3-04 — Vitalis Profissional

## Contexto

O Vitalis já usa `clinicas` como raiz de isolamento de pacientes, profissionais, agenda,
documentos e auditoria. Um médico autônomo precisa operar o próprio consultório sem uma
identidade administrativa artificial e continuar usando a mesma conta nas clínicas às
quais foi convidado.

Um local físico de atendimento não equivale a uma clínica/tenant. Além disso, as clínicas
institucionais existentes não podem ser reclassificadas automaticamente por uma migration.

## Decisão

1. `clinicas` continua sendo a raiz técnica de isolamento para todo workspace clínico.
2. A tabela aditiva `consultorios_profissionais` marca exclusivamente os novos tenants
   individuais. A ausência desta linha significa que o tenant continua institucional.
3. O titular mantém o papel `profissional` em `clinica_usuarios`. Sua capacidade de gestão
   resulta da combinação transacional entre vínculo ativo e titularidade ativa, nunca de
   uma promoção para `administrador`.
4. A identidade profissional global e sua verificação ficam em
   `identidades_profissionais`; perfis clínicos continuam locais a cada tenant.
   O cadastro global não cria perfil de paciente, vínculo clínico nem tenant.
5. Endereços físicos ficam em `consultorio_locais` e não criam novos tenants.
6. Secretárias usam o fluxo existente de convite, com papel `secretaria`, e podem ser
   revogadas. Somente o titular gerencia a equipe do consultório e só pode administrar
   esse papel; a secretária não pode cadastrar médicos nem administradores.
7. O catálogo futuro começa como `privado`. `publicavel` representa apenas prontidão;
   descoberta, consentimento público e busca pertencem à issue #67.
8. Pacientes e prontuários não são unidos ou transferidos entre vínculos. Toda consulta
   clínica permanece filtrada por `clinica_id`.
9. Especialidades criadas no consultório são associadas ao perfil clínico do titular na
   mesma transação. Vínculos históricos permanecem preservados quando uma especialidade
   é desativada.

## Provisionamento e segurança

O cadastro independente cria usuário e identidade `pendente` em uma transação. Um operador
ativo da plataforma revisa o registro por um fluxo autenticado, com bloqueio transacional e
auditoria da decisão. O provisionamento exige token de identidade, usuário ativo e identidade
profissional `verificada`. Uma única transação cria tenant, vínculo profissional, perfil clínico,
marcador de consultório e auditoria. Slug, titular e conselho possuem restrições únicas.
Qualquer falha provoca rollback.

Autorizações de gestão aceitam:

- administrador ou secretaria nos fluxos institucionais já existentes; ou
- profissional que seja o titular ativo do consultório ativo selecionado.

O backend revalida a capacidade; `tipo_contexto` e `titular` enviados ao frontend servem
apenas à experiência de navegação.

## Titularidade, custódia e cobrança

Titularidade do workspace, acesso aos dados clínicos, custódia legal e responsabilidade
de pagamento são conceitos distintos. Esta etapa implementa apenas titularidade e acesso.
Suspensão comercial futura não deve apagar históricos nem decidir, sozinha, a custódia.
Cobrança não faz parte desta ADR.

## Consequências

- Clínicas atuais e migrations 001–011 permanecem intactas.
- A migration 012 é aditiva e não é executada automaticamente.
- Um usuário pode alternar entre seu consultório e clínicas autorizadas com uma só conta.
- A arquitetura comporta múltiplos locais, mas limita um consultório titular por identidade
  nesta etapa; expansão futura deve ser uma decisão explícita.
- A publicação em catálogo e notificações móveis permanecem desligadas.
