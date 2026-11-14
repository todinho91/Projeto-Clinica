# M3 — Convites, ativação e controle de acesso

## Fluxo

1. Administrador ou secretaria abre `equipe.html` na clínica ativa.
2. O backend ignora qualquer `clinica_id` do navegador e usa o tenant revalidado pelo token.
3. A secretaria pode convidar somente profissionais; o administrador pode definir os papéis autorizados.
4. O convite armazena somente SHA-256 do token, expira em 48 horas e é de uso único.
5. Uma conta nova define a própria senha (mínimo de 12 caracteres). Uma conta existente deve autenticar-se; sua senha e seus demais vínculos não são alterados.
6. Reenvio invalida convites pendentes anteriores. Revogação e desativação são auditadas.

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

O padrão seguro é `MAIL_PROVIDER=disabled`. Nesse modo o convite é criado, mas a API informa que a entrega não foi confirmada. O token nunca é retornado pela API administrativa nem registrado em log.

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

## Migration e validação local

A migration aditiva é `backend/database/migrations/005_team_invitations.sql`. Ela não altera as migrations 001–004. Antes de aplicá-la, faça backup e confirme explicitamente o banco conectado. Não execute o migrador no banco de validação sem autorização.

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
