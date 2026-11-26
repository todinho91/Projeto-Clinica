# M5 — Prevenção reforçada de pacientes duplicados

Esta entrega trata a issue #62, complementada pela migration 015 de contato compartilhado, sem alterar registros, prontuários ou consultas existentes.
O sistema nunca funde pacientes automaticamente e nunca pesquisa registros fora da clínica
ativa.

## Regras aplicadas

- nome é normalizado por espaços, caixa e acentuação para localizar candidatos;
- e-mail, telefone e nome com nascimento ajudam a classificar possíveis duplicidades;
- nome igual sem e-mail, telefone ou nascimento é bloqueado até que existam dados adicionais;
- CPF igual no tenant, nome com nascimento igual ou nome e telefone iguais são bloqueios fortes;
- e-mail de contato igual isoladamente exige revisão, mas não impede pessoas distintas;
- homônimos com dados distintos e contatos compartilhados exigem revisão explícita por um
  administrador ou pela secretaria;
- a revisão registra somente um motivo controlado na auditoria, sem copiar dados pessoais;
- candidatos exibem apenas nome, ano de nascimento, situação e contatos mascarados;
- a decisão considera todos os candidatos encontrados; somente a interface limita a exibição
  aos dez primeiros, informando a quantidade total;
- a ação **Usar paciente existente** abre o cadastro já existente para edição;
- a linha da clínica é bloqueada antes da busca e da inserção, serializando cadastros
  concorrentes na mesma clínica.

O cadastro público em `/auth/register` aplica a mesma normalização de nome dentro da clínica.
Nome equivalente ou e-mail já usado produz a mesma resposta neutra, sem dizer se o conflito
está na identidade global ou no perfil clínico. Nenhum vínculo ou usuário parcial é mantido,
e o cadastro público nunca apropria automaticamente um paciente administrativo existente.
Homônimos bloqueados nesse fluxo devem ser revisados pela equipe autorizada da clínica.

## Compatibilidade com a migration 008

A migration 008 permanece intacta, inclusive seu checksum. A migration 015 substitui
somente `uk_pacientes_email` por `idx_pacientes_email (clinica_id, email)`, não único.
Não modifica dados nem referências. A unicidade de `usuarios.email`, de `pacientes (clinica_id,
usuario_id)` e do índice protegido de CPF por clínica permanece inalterada.
O cadastro administrativo exige revisão auditada para contatos coincidentes e não cria nem
vincula contas. O cadastro público continua bloqueando conflitos de nome/e-mail com resposta
neutra até existir verificação de titularidade (#33). Compartilhar contato não concede acesso
ao portal de outro paciente; representação legal é fluxo futuro separado.

Aplicação: somente após backup/restauração verificados, teste MySQL descartável e autorização
específica. Executar em janela de manutenção, sem escritores concorrentes nem versões antigas
do backend. A reversão para índice único pode falhar se já existirem contatos compartilhados;
não apagar nem mesclar pacientes para reverter. Avaliar contagens sem expor endereços de e-mail,
preservar IDs e vínculos e restaurar backup validado em schema separado se necessário.

Nenhuma chave única por nome foi criada, porque pessoas homônimas são válidas. Também não há
mesclagem automática: uma futura função de fusão deve ser separada, autorizada, transacional,
auditada e preservar consultas, documentos e prontuários.

## Integração MySQL 8 preparada

Use somente banco descartável autorizado cujo nome comece com `vitalis_pacientes` e termine
com `_test`. O teste confirma `SELECT DATABASE()` e `SELECT VERSION()` antes de limpar o
schema.

```bash
cd "backend/node modules"
export TEST_DB_HOST=127.0.0.1
export TEST_DB_PORT=3306
export TEST_DB_USER="usuario_de_teste"
export TEST_DB_PASSWORD="<defina somente no terminal>"
export TEST_DB_DATABASE=vitalis_pacientes_m5_test
npm run test:patients:integration
```

Os cenários incluem dados incompletos concorrentes, homônimos, contato familiar compartilhado,
isolamento entre clínicas, rollback e preservação do cadastro público. O teste não deve ser
executado em `vitalis_m3_validacao`, `vitalis_dev` ou bancos de demonstração.
