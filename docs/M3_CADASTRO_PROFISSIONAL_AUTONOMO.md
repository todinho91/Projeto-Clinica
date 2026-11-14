# M3 — Cadastro autônomo de profissionais

## Fluxo anterior

O cadastro em `profissionais.html` exigia um usuário previamente criado e um
vínculo ativo com papel `profissional`. A tela apenas selecionava esse vínculo e
criava o perfil em `profissionais`, o que obrigava uma preparação manual no
MySQL.

O endpoint legado `POST /api/profissionais` foi preservado para compatibilidade.

## Novo fluxo

O formulário coleta nome completo, nome de exibição, e-mail, tipo de
profissional, conselho opcional, especialidades e situação do perfil. A criação
usa `POST /api/profissionais/cadastro-completo`.

Dentro de uma única transação, o backend:

1. usa exclusivamente a clínica presente em `req.tenant`;
2. recusa dados inválidos e e-mail já existente;
3. bloqueia especialidades inativas ou de outro tenant;
4. cria a identidade global com estado `bloqueado`;
5. cria o vínculo da clínica como `profissional` e `convite_pendente`;
6. cria o perfil profissional e suas especialidades;
7. registra `profissional_pre_cadastrado` em `auditoria`;
8. confirma a transação somente ao final.

O `clinica_id` eventualmente enviado pelo navegador é ignorado. Administrador e
secretaria podem usar a rota; paciente e profissional recebem `403`.

## Credencial e dependência da issue #13

Não existe ainda fluxo de convite completo no Vitalis. Para não criar ou enviar
senha temporária, o backend gera uma credencial aleatória de alta entropia,
armazena somente o hash bcrypt e descarta o valor. A identidade permanece
bloqueada e o vínculo fica como `convite_pendente`.

Nenhum token de convite é criado, devolvido ao navegador ou enviado por e-mail.
O profissional somente poderá configurar senha e entrar quando a issue #13
implementar convite de uso único, expiração, revogação e ativação atômica da
identidade e do vínculo.

Contas com e-mail já existente são recusadas. Vincular uma identidade existente
exigirá confirmação pelo titular no futuro fluxo de convite; administradores e
secretarias não podem se apropriar dessa conta pelo cadastro atual.

## Migration preparada

`004_professional_onboarding.sql` adiciona `tipo_profissional` ao perfil. A
migration não foi executada por esta entrega. Antes de testar em MySQL:

1. confirmar o banco selecionado;
2. gerar e ensaiar backup/restauração;
3. revisar o impacto do `ALTER TABLE`;
4. obter autorização específica;
5. executar a migration com o executor oficial.

Registros anteriores recebem o valor padrão `Profissional de saúde` e podem ser
refinados depois pela edição normal.

## Testes seguros executados

Os testes unitários cobrem administrador, secretaria, autorização da rota,
tenant do servidor, especialidade cruzada, e-mail existente, campos inválidos,
rollback e regressões da gestão anterior. As quatro integrações MySQL antigas
continuam opt-in e não devem ser usadas em `vitalis_m3_validacao`, pois removem
tabelas de bancos descartáveis específicos.

## Validação manual futura

Após migration autorizada em banco de validação:

1. entrar como administrador e depois como secretaria;
2. cadastrar profissionais fictícios distintos em Aurora e Horizonte;
3. confirmar o perfil somente na clínica ativa;
4. confirmar identidade `bloqueado` e vínculo `convite_pendente` no banco;
5. confirmar que o profissional não consegue autenticar;
6. tentar e-mail já existente e ID de especialidade de outra clínica;
7. confirmar ausência de registros parciais após cada falha;
8. editar, ativar/desativar e verificar a preservação do histórico.
