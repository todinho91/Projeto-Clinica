# M5-02E — implementação e limites atuais

## Entregue nesta etapa

- A página experimental usa o shell profissional do Vitalis (menu lateral, contexto ativo, cabeçalho e painéis) e mantém os campos já suportados pelo backend.
- O cabeçalho de atendimento mostra paciente, profissional, especialidade, clínica/consultório e horário local da clínica em formato brasileiro.
- O menu móvel possui abertura/fechamento acessível; a saída limpa a sessão e o conteúdo clínico em memória.
- A homologação do navegador permite carregar o CSS compartilhado, verifica metadados do atendimento e exercita menu e capturas com dados exclusivamente sintéticos.
- Nenhuma migration, regra de autorização, chave, segredo ou dado foi alterado.

## Permissões que o backend efetivamente aplica

| Perfil/contexto | Resultado observado no backend atual |
|---|---|
| Profissional responsável pelo atendimento e autor do registro | Rotas experimentais permitem consultar e operar o próprio registro, sujeitas a vínculo e sessão ativos, elegibilidade do atendimento e versão concorrente. |
| Outro profissional da mesma clínica | Sem acesso automático ao registro alheio; as consultas do prontuário são escopadas por clínica, profissional e autor. |
| Administrador, secretaria, paciente e operador | Rotas de prontuário interno recusam esses papéis. A autorização está no servidor, não apenas no menu. |
| Outro tenant | Consultas e IDs são limitados ao tenant da sessão; identificadores externos não são aceitos como contexto. |
| Profissional de consultório | O backend revalida titularidade e identidade profissional verificada. |

Esta tabela descreve o backend experimental existente e não declara autorização para uso comercial ou dados reais. A ativação continua restrita ao fixture/schema sintético.

## Bloqueio para M5-02E.3 — cópia solicitada pelo paciente

Não foi implementada uma ação que declare a cópia “disponível”. O estado atual não contém uma verificação de identidade do paciente (a associação de conta é apenas `pacientes.usuario_id`), um responsável de guarda/continuidade assistencial ou um escopo aprovado para cópias que atravessem profissionais. Os anexos clínicos também não participam de uma exportação cifrada ao paciente. Um simples vínculo ou login não comprova representação legal.

Antes de ativar uma solicitação/entrega, a etapa deve definir e testar: prova e revisão de identidade/representação; responsável de guarda e substituição quando o autor estiver indisponível; escopo de exportação que cubra versões, adendos e anexos; formato, expiração, retirada e auditoria da cópia; prazos e procedimento de exceção. O administrador e a secretaria não devem receber conteúdo clínico como consequência desse fluxo. Até então, nenhum endpoint ou rótulo de interface deve afirmar entrega integral.

## Assinatura e validade documental

O registro de autoria do prontuário, a manifestação do paciente e a confirmação de recebimento são eventos distintos. JWT, senha, clique, hash ou confirmação de recebimento não são tratados por este projeto como assinatura eletrônica qualificada ou assinatura digital com validade jurídica. Esta interface experimental não assina documentos e permanece identificada como sintética.

Referências oficiais consultadas em 26/11/2026:

- [LGPD, texto compilado — arts. 18 e 19](https://planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709compilado.htm)
- [Lei nº 13.787/2018 — guarda e manuseio de prontuários](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13787.htm)
- [Código de Ética Médica — Resolução CFM nº 2.217/2018](https://portal.cfm.org.br/images/PDF/cem2019.pdf)

Essas fontes orientam requisitos a validar com responsáveis clínicos e jurídicos; esta entrega não declara conformidade legal, certificação CFM/SBIS, nem adequação a regras de outras profissões.
