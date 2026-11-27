# Vitalis — Direção de produto: profissional autônomo primeiro
Decisão do responsável em 27/11/2026. Esta revisão de prioridade não encerra issues, não remove funcionalidades institucionais já entregues e não autoriza dados reais. A matriz abaixo cobre as 38 issues abertas observadas no inventário; os nove itens fechados permanecem históricos. A numeração M0–M11 é preservada para rastreabilidade; prioridade transversal prevalece sobre ordem numérica.

## Produto
Vitalis Profissional é o primeiro plano a desenvolver, homologar e comercializar. O plano Vitalis Clínica permanece como expansão futura; não apagar arquitetura multi-tenant, vínculos, dados, gestão ou acessos já autorizados. Não presumir exclusividade de guarda pelo médico em instituições, postos ou unidades de saúde. Um profissional verificado possui login único, espaço próprio, locais de atendimento, agenda consolidada e prontuários no contexto assistencial autorizado. Locais de um mesmo espaço sob mesma guarda não são necessariamente tenants distintos; vínculos institucionais continuam segregados. Integração com sistemas de terceiros/SUS não está implícita.

Secretária delegada por espaço: cadastro administrativo, agenda, reagendamento, confirmação; sem conteúdo clínico. Titular pode operar sem secretária e gerir sua equipe, sem exigir terceiro administrador, dentro dos limites autorizados. Administrativo não recebe acesso clínico por papel. Paciente: portal/app futuro, busca por médico/especialidade/local publicado, consulta aos horários já marcados, confirmação de presença/ausência, evolução finalizada disponibilizada de modo autorizado e cópia completa por fluxo próprio (#58). Sem acesso à edição interna, rascunhos ou versionamento interno indiscriminado; sem autoagendamento neste primeiro escopo. A confirmação de recebimento não é barreira ao direito de acesso. Assinatura do profissional, identificação e entrega segura são requisitos distintos. 

## Backlog por prioridade
| Prioridade | Issues | Direção |
|---|---|---|
| Núcleo imediato | #59, #60, #19, #13, #17, #62, #55 | Consultório próprio, prontuário, agenda multilocal, delegação, confirmação, cadastro sem duplicidade |
| Fundação e UX (paralelo, conforme dependência) | #1, #6, #7, #8, #9, #10, #11 | Preservar e validar identidade, autorização, migração, marca, contexto e painéis |
| Segurança e lançamento (gates obrigatórios; iniciar em paralelo) | #20, #58, #27, #28, #29, #30, #31, #32, #33, #34, #35, #36, #24, #25, #26 | Arquivos e cópia segura, infraestrutura, segurança, operação e assinatura individual; cobrança sandbox e gestão comercial mínima, sem antecipar plano institucional |
| Evolução clínica após núcleo | #21, #56, #57 | Modelos por especialidade, receitas e documentos, com requisitos profissionais e assinatura validados; avaliar escopo indispensável para piloto |
| Portal/app do paciente (fase seguinte, planejar contratos agora) | #67, #37, #38 | Busca, locais, horários marcados, confirmações e evolução disponibilizada; sem reserva autônoma inicial; acesso a cópias #58 não depende de app |
| Adiar, sem encerrar | #22, #23, #66 | Financeiro institucional e assistente clínico IA; reavaliar demanda do autônomo após núcleo. Separar faturamento SaaS (#24–26) do financeiro do consultório. |
 
Nenhum item é declarado concluído por CI verde. PRs #72–75 permanecem sujeitas a integração ordenada e revisão; o modo experimental não é produto comercial. Mudança de prioridade não é autorização de merge/deploy, execução de migration em bancos existentes, exclusão de issues ou acesso real.
