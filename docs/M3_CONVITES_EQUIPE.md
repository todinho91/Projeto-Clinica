# M3 — Convites, ativação e controle de acesso

## Fluxo

1. Administrador ou secretaria abre `equipe.html` na clínica ativa.
2. O backend ignora qualquer `clinica_id` do navegador e usa o tenant revalidado pelo token.
3. A secretaria pode convidar somente profissionais; o administrador pode definir os papéis autorizados.
4. O convite armazena somente SHA-256 do token, expira em 48 horas e é de uso único.
5. Uma conta nova define a própria senha (mínimo de 12 caracteres). Uma conta existente deve autenticar-se; sua senha e seus demais vínculos não são alterados.
6. Reenvio invalida convites pendentes anteriores. Revogação e desativação são auditadas.

Profissionais e pacientes somente recebem convite quando o perfil clínico correspondente já existe na mesma clínica. Para profissionais novos, o cadastro completo deve ser concluído primeiro em `profissionais.html`, pelo fluxo transacional da PR #50. O sistema não cria perfis clínicos incompletos na tela de equipe.

Essa restrição é necessária porque listagem de profissionais, agendamento, agenda do médico, acesso a pacientes e dashboard profissional consultam ou associam dados pela tabela `profissionais`. Um vínculo com papel `profissional` sem esse perfil ficaria autenticado, mas não apareceria corretamente nas operações clínicas e não teria identidade clínica para filtrar agenda e pacientes.

Um vínculo `inativo` só volta ao fluxo de convite com o mesmo papel previamente autorizado. Dentro da mesma transação, ele muda para `convite_pendente`, registra `vinculo_reativacao_iniciada` na auditoria e somente então recebe um novo convite. Trocar o papel por meio do convite é recusado.

O middleware de tenant consulta o vínculo a cada requisição. Assim, desativar o vínculo bloqueia imediatamente um JWT emitido anteriormente.

## Matriz de autorização

| Operação | Administrador | Secretaria | Profissional/Paciente |
|---|---:|---:|---:|
| Listar equipe da clínica ativa | Sim | Sim | Não |
| Convidar profissional | Sim | Sim | Não |
| Convidar administrador/secretaria | Sim | Não | Não |
| Reenviar/revogar convite profissional | Sim | Sim | Não |
| Alterar papel | Sim | Não | Não |
| Desativar profissional | Sim | Sim | Não |
| Desativar administrador/secretaria | Sim | Não | Não |

Uma promoção para `profissional` ou `paciente` exige que o perfil correspondente já exista na mesma clínica. Nenhuma operação pode remover, desativar ou rebaixar o último administrador ativo.

## E-mail

O padrão seguro é `MAIL_PROVIDER=disabled`. Nesse modo o convite é criado, mas a API informa que o envio não está configurado. O token nunca é retornado pela API administrativa nem registrado em log.

O adaptador `webhook` exige:

```dotenv
APP_PUBLIC_ORIGIN=http://127.0.0.1:5500
MAIL_PROVIDER=webhook
INVITATION_TTL_HOURS=48
MAIL_API_URL=https://provedor.example/v1/send
MAIL_API_TOKEN=<segredo-no-ambiente>
MAIL_FROM=<remetente-verificado>
```

O webhook recebe `from`, `to`, `template` e `variables`. A variável `activationUrl` contém o token e deve ser tratada pelo provedor como segredo. A URL pública é construída exclusivamente com `APP_PUBLIC_ORIGIN`, nunca com o cabeçalho `Host` da requisição.

Os estados persistidos em `convites_clinica.envio_status` são:

- `not_requested`: convite criado, tentativa ainda não realizada;
- `not_configured`: provedor não configurado;
- `accepted_by_provider`: HTTP 2xx; o provedor aceitou a solicitação, mas a entrega não está confirmada;
- `delivered`: reservado para confirmação real de entrega por integração autenticada;
- `failed`: rejeição HTTP ou indisponibilidade do provedor.

O adaptador webhook atual nunca transforma apenas HTTP 200/202 em `delivered`. A confirmação definitiva dependerá de callback autenticado do provedor de e-mail.

### Caixa de convite exclusivamente local

Para validar o fluxo no Ubuntu sem contratar provedor, use o coletor que escuta apenas em `127.0.0.1`, mantém o último convite somente em memória e não imprime o link/token no terminal:

```bash
cd "/home/joao/Projeto-Clinica-m3-validacao/backend/node modules"
export VITALIS_LOCAL_MAIL_TOKEN="$(openssl rand -hex 32)"
LOCAL_MAIL_WEBHOOK_TOKEN="$VITALIS_LOCAL_MAIL_TOKEN" npm run dev:mailbox
```

Em outro terminal, configure o backend local (sem gravar o segredo no repositório):

```bash
export MAIL_PROVIDER=webhook
export MAIL_API_URL=http://127.0.0.1:3100/send
export MAIL_API_TOKEN="$VITALIS_LOCAL_MAIL_TOKEN"
export MAIL_FROM=local-vitalis@example.test
export APP_PUBLIC_ORIGIN=http://127.0.0.1:5500
npm start
```

Depois de criar ou reenviar o convite pela interface, abra `http://127.0.0.1:3100` no mesmo Ubuntu e use o link exibido. A API administrativa continua sem retornar o token. Reiniciar o coletor apaga a mensagem em memória. Use este procedimento somente após a migration 005 ser autorizada e aplicada ao banco isolado aprovado.

## Migration e validação local

A migration aditiva é `backend/database/migrations/005_team_invitations.sql`. Como ainda não foi aplicada no ambiente de validação, ela foi ajustada na própria PR #51 para registrar o estado de envio, distinguir ativação pendente de bloqueio administrativo e versionar as sessões de cada vínculo. Ela não altera as migrations 001–004. Antes de aplicá-la, faça backup e confirme explicitamente o banco conectado. Não execute o migrador no banco de validação sem autorização.

Após a implantação da migration 005, tokens de clínica emitidos pela versão anterior não possuem `membership_version` e serão recusados. O usuário deve entrar novamente ou selecionar a clínica outra vez. Desativação, reativação, mudança de papel e aceite de convite incrementam a versão do vínculo; por isso, uma sessão revogada não volta a funcionar quando o vínculo é reativado.

Testes sem MySQL:

```bash
cd "backend/node modules"
npm ci
npm test
npm run check:secrets
```

Após autorização para o banco isolado, aplique a migration com as variáveis apontando exclusivamente para o banco descartável aprovado, inicie `npm start` na porta 3000 e sirva a raiz do frontend pelo Go Live na porta 5500.

## Limites operacionais

- 30 tentativas públicas por IP a cada 15 minutos no processo Node.
- Um convite por vínculo por minuto, no máximo cinco por hora.
- No máximo 50 convites por hora por operador e clínica.

O limitador público em memória é adequado ao ambiente local. Antes de escalar para múltiplas instâncias, substitua-o por armazenamento compartilhado (por exemplo, Redis) e adicione telemetria de abuso.
