# ADR-002 — Identificação clínica completa do paciente

- Status: proposta; implementação bloqueada por decisões de privacidade e segurança
- Dependência: PR #68
- Relacionamento: issues #18 e #33
- Escopo: evolução do cadastro administrativo para identificação clínica, sem prontuário

## Contexto

A PR #68 mantém o cadastro rápido necessário para agendamento: nome completo,
nascimento e contatos opcionais, preferência explícita de contato e situação
ativa/arquivada. Esse cadastro é isolado por `clinica_id`, não cria identidade global
automaticamente e não reúne prontuários de tenants diferentes.

A identificação usada em contexto assistencial pode exigir mais elementos. Entretanto,
incluir todos eles no formulário administrativo, antes de existir finalidade e controle de
acesso definidos, ampliaria a coleta e a exposição de dados pessoais. O modelo do e-SUS APS
é uma referência contextual do SUS; seus campos não devem se tornar requisitos universais
para consultórios privados.

## Decisão proposta

Separar o modelo em dois níveis.

### Nível A — cadastro rápido administrativo

Permanece na tabela `pacientes` e nos fluxos atuais:

- nome completo;
- data de nascimento opcional, inclusive quando desconhecida;
- telefone e e-mail opcionais;
- preferência de contato;
- situação ativa ou arquivada;
- prevenção de duplicidade dentro do tenant;
- arquivamento lógico e auditável, sem exclusão do histórico.

CPF não será acrescentado ao Nível A até que finalidade, chave de busca e proteção em
repouso sejam aprovadas.

### Nível B — identificação clínica

Deve ser implementado em migration aditiva posterior, sem alterar migrations publicadas.
A proposta é uma tabela tenant-aware, vinculada por `(clinica_id, paciente_id)`, para:

- nome social;
- sexo cadastral quando aplicável ao atendimento;
- nome da mãe;
- naturalidade;
- CPF e CNS quando aplicáveis;
- estado de completude e motivo de informação desconhecida.

Endereços, responsáveis legais, contatos de emergência e convênios devem usar estruturas
filhas próprias, também tenant-aware, porque podem ter múltiplas versões e períodos de
validade. Nenhuma dessas tabelas deve conter anamnese, alergias, medicamentos, antecedentes,
diagnósticos ou evolução clínica.

## Decisões obrigatórias antes da migration

1. Definir finalidade e base legal para cada campo, inclusive CPF e CNS.
2. Definir a matriz de acesso. A secretária pode administrar identificação necessária à
   operação, mas não recebe conteúdo assistencial restrito.
3. Definir como CPF será protegido e pesquisado. Não persistir CPF em texto puro nem criar
   índice global entre tenants. A estratégia de cifra, chave e hash de busca precisa de
   revisão de segurança e rotação de chaves.
4. Representar informação desconhecida por estado explícito; não gravar valores fictícios
   como “não possui” em campos documentais.
5. Definir responsáveis legais, menores, incapazes e atendimentos urgentes sem bloquear o
   cuidado por ausência de dado não essencial.
6. Definir retenção, correção, exportação e exclusão conforme dependências clínicas e
   obrigações legais.
7. Concluir a verificação de titularidade da issue #33 antes de qualquer vínculo entre perfil
   clínico e identidade global.

## Regras de autorização e isolamento

- `clinica_id` deriva apenas do contexto autenticado.
- Toda chave estrangeira clínica deve ser composta pelo tenant.
- Nenhum CPF, CNS ou paciente é compartilhado automaticamente entre clínicas ou
  consultórios.
- Homônimos permanecem registros distintos até revisão humana autorizada.
- Nunca unir prontuários automaticamente por nome, telefone, e-mail, CPF ou CNS.
- Toda leitura e escrita sensível é auditada sem copiar o valor sensível para logs ou
  metadados de auditoria.
- O arquivamento preserva consultas, confirmações, documentos e trilhas já existentes.
- Exclusão física não integra este fluxo.

## Sequência de implementação dependente

1. Aprovar esta ADR e a matriz de acesso.
2. Definir proteção criptográfica e gestão de chaves para documentos.
3. Criar migration aditiva `014_*` com pré-voo somente leitura.
4. Implementar validação de CPF quando informado e normalização de CNS, sem unicidade
   global.
5. Criar endpoints transacionais separados do cadastro rápido.
6. Criar interface progressiva, marcando campos opcionais e estados desconhecidos.
7. Cobrir isolamento, concorrência, rollback, mascaramento, auditoria e regressões.
8. Executar integração apenas em MySQL 8 descartável `*_test`, após autorização específica.

Até essas decisões, não há migration 014 e nenhum banco deve ser alterado.

## Critérios de aceite da implementação futura

- migration exclusivamente aditiva, sem seed ou atualização global;
- compatibilidade integral com pacientes e consultas existentes;
- CPF válido quando informado, protegido em repouso e não revelado em listagens;
- ausência de falsa unicidade entre tenants;
- estados desconhecidos não bloqueiam atendimento;
- secretária não acessa dados assistenciais;
- profissional acessa somente pacientes autorizados no tenant ativo;
- rollback completo em falha;
- auditoria sem dados sensíveis;
- nenhuma fusão automática de prontuários.

## Referências oficiais

- Resolução CFM nº 1.638/2002:
  https://sistemas.cfm.org.br/normas/visualizar/resolucoes/BR/2002/1638
- Lei nº 13.787/2018:
  https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13787.htm
- LGPD — Lei nº 13.709/2018:
  https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709compilado.htm
- Guia de segurança da ANPD:
  https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia-orientativo-sobre-seguranca-da-informacao-para-agentes-de-tratamento-de-pequeno-porte
- Cadastro Individual do e-SUS APS, apenas como referência contextual:
  https://sisaps.saude.gov.br/sistemas/esusaps/docs/manual/PEC/PEC_04_cidadao/
