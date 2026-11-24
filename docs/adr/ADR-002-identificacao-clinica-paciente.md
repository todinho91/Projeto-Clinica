# ADR-002 — Identificação administrativa do paciente

- Status: aceita para implementação na PR #69; migration ainda não aplicada
- Dependência: PR #68
- Relacionamento: issues #18 e #33
- Escopo: identificação administrativa para cadastro e agendamento, sem prontuário

## Contexto e finalidade

O cadastro rápido anterior permitia nome e contatos opcionais. Ele continua válido para
leitura e histórico, mas novos cadastros rotineiros precisam identificar corretamente a
pessoa e seu endereço para a operação do atendimento. Isso não autoriza coletar conteúdo
assistencial, consultar CPF externamente nem reunir registros de clínicas diferentes.

A finalidade desta etapa é identificar administrativamente o paciente no tenant ativo,
permitir contato quando houver preferência explícita e sustentar agendamento, faturamento
administrativo futuro e correção cadastral. Diagnósticos, anamnese, prescrições, exames,
alergias e evolução permanecem fora desta estrutura.

## Decisão funcional

### Cadastro rotineiro novo

Exige, na mesma transação:

- nome completo;
- CPF matematicamente válido;
- data de nascimento válida;
- CEP, logradouro, número, bairro, cidade e UF;
- telefone e e-mail opcionais;
- complemento opcional;
- preferência de contato independente dos dados de identificação.

A validação de dígitos do CPF não comprova situação regular na Receita Federal e nenhum
serviço de consulta de CPF integra esta etapa.

### Exceções assistenciais

Ausência de CPF, endereço não convencional e urgência usam códigos fechados e auditáveis.
Não são aceitos documentos fictícios nem justificativas livres copiadas para a auditoria.
O atendimento não é bloqueado quando uma exceção autorizada for aplicável.

### Pacientes históricos

Pacientes anteriores permanecem na tabela `pacientes`, visíveis e vinculados às consultas.
Na ausência da nova linha, a API retorna `cadastro_status = pendente`. O operador pode
completar o cadastro em edição posterior. Uma edição administrativa estritamente necessária
pode manter o estado pendente por opção explícita; um cadastro novo nunca pode usar essa
compatibilidade.

Nenhuma coluna histórica recebe `NOT NULL`, nenhum paciente é atualizado em massa e a
visualização do histórico clínico não depende da complementação administrativa.

## Modelo aditivo

A migration `014_patient_administrative_identity.sql` cria
`pacientes_identificacao_administrativa`, vinculada por `(clinica_id, paciente_id)`.

Ela armazena:

- estado `pendente`, `completo` ou `excecao`;
- CPF cifrado, IV, tag de autenticação, identificador da chave e últimos quatro dígitos;
- índice de busca HMAC exclusivo por tenant;
- endereço e códigos controlados de exceção;
- usuário responsável e timestamps.

A migration não contém seed, `UPDATE`, `DELETE`, `DROP`, alteração destrutiva ou migração
automática dos registros existentes.

## Proteção do CPF e gestão de chaves

O CPF nunca é persistido em texto puro.

- Cifra: AES-256-GCM com IV aleatório de 96 bits e tag de autenticação.
- Contexto autenticado adicional: versão do formato e `clinica_id`.
- Busca: HMAC-SHA-256 com chave separada, calculado sobre versão, tenant e CPF normalizado.
- Unicidade: `(clinica_id, cpf_busca_hash)`; não existe comparação global entre clínicas.
- Exposição: somente máscara `***.***.***-0000` para operadores autorizados.
- Logs e auditoria: registram somente estado, operação e códigos de exceção.

Segredos obrigatórios, mantidos fora do Git:

- `PATIENT_CPF_ENCRYPTION_KEY`: 32 bytes em Base64;
- `PATIENT_CPF_INDEX_KEY`: 32 bytes em Base64 e separada da chave de cifra;
- `PATIENT_CPF_KEY_ID`: identificador não secreto da chave ativa.

Em ambiente comercial, as chaves devem ficar em gerenciador de segredos, com acesso mínimo,
backup seguro e rotação registrada. A chave de cifra pode ser rotacionada recriptografando
linhas em lote controlado e mantendo o identificador anterior durante a transição. A rotação
da chave de índice exige migration própria com período de dupla indexação; não deve ser feita
por substituição direta, pois impediria localizar duplicidades antigas.

Se as chaves não estiverem configuradas, operações que precisem persistir ou pesquisar CPF
falham antes de qualquer escrita. Não há fallback para texto puro.

## Consulta de CEP

O navegador consulta somente o backend autenticado. O backend envia ao ViaCEP apenas os oito
dígitos do CEP, por HTTPS, com timeout, limite por operador e cache curto em memória.
Nome, CPF, telefone, tenant e informações clínicas não são enviados ao provedor.

CEP inexistente, timeout ou indisponibilidade não apagam campos já preenchidos. O formulário
permite correção e preenchimento manual, mas não salva endereço rotineiro parcial.

## Matriz de acesso

| Papel no tenant ativo | Listagem mascarada | Identificação administrativa completa | Criar/editar | Conteúdo assistencial |
| --- | --- | --- | --- | --- |
| Administrador institucional | Sim | Sim | Sim | Conforme permissões clínicas existentes |
| Secretária institucional | Sim | Sim | Sim | Não ampliado por esta PR |
| Médico titular do consultório | Sim | Sim | Sim | Conforme vínculo profissional existente |
| Secretária do consultório | Sim | Sim | Sim | Documentos clínicos continuam bloqueados |
| Profissional não titular | Somente fluxos clínicos já autorizados | Não pela gestão administrativa | Não | Somente pacientes vinculados ao atendimento |
| Paciente | Próprios dados em fluxos específicos futuros | Não nesta PR | Não nesta PR | Próprio histórico autorizado |

Toda operação deriva `clinica_id` do token, revalida usuário, clínica, vínculo, versão de
sessão e papel. Nenhum identificador do navegador escolhe o tenant.

## Retenção e correção

O arquivamento do paciente é lógico e preserva consultas, documentos e auditoria. CPF e
endereço são mantidos enquanto forem necessários para identificar o registro e cumprir as
obrigações aplicáveis ao histórico. Eliminação física ou anonimização exige política formal,
verificação de dependências clínicas e jurídicas e trilha de decisão; não integra esta PR.

Correções substituem a cifra usando a chave ativa. O sistema não une pacientes ou prontuários
automaticamente por CPF, nome, telefone, e-mail ou endereço. A vinculação a uma identidade
global continua dependente da verificação de titularidade da issue #33.

## Riscos residuais e operação

- A validação matemática do CPF não consulta nem comprova situação cadastral oficial.
- ViaCEP é dependência externa auxiliar; o preenchimento manual permanece disponível.
- Segredos devem ser provisionados antes de aplicar a migration em qualquer ambiente.
- Backup e restauração precisam incluir as chaves; perder a chave de cifra torna o CPF
  irrecuperável.
- Exportação de CPF completo, atendimento de direitos do titular e rotação em massa precisam
  de procedimentos operacionais aprovados antes do lançamento comercial.

## Validação

- CPF válido, inválido, sequencial, duplicado e concorrente;
- hash distinto para o mesmo CPF em tenants diferentes;
- ausência de CPF puro em banco, API, logs e auditoria;
- CEP válido, inexistente, timeout, limite e preenchimento manual;
- cadastro incompleto recusado antes de qualquer escrita;
- exceções controladas e auditadas;
- leitura e edição gradual de pacientes antigos;
- isolamento e permissões de administrador, secretária e titular;
- regressão de consultas, confirmações e arquivamento.

Integrações MySQL permanecem opt-in e somente podem rodar em banco novo `vitalis_pacientes*_test`
após autorização específica.

## Referências

- LGPD — Lei nº 13.709/2018:
  https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709compilado.htm
- Guia de Segurança da Informação da ANPD:
  https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia-orientativo-sobre-seguranca-da-informacao-para-agentes-de-tratamento-de-pequeno-porte
- Lei nº 13.787/2018:
  https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13787.htm
- ViaCEP — documentação do webservice:
  https://viacep.com.br/
