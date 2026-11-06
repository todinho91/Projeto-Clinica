const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { test } = require('node:test');

Object.assign(process.env, {
    DB_HOST: '127.0.0.1',
    DB_USER: 'fixture_user',
    DB_PASSWORD: 'fixture_password',
    DB_DATABASE: 'fixture_database',
    PORT: '3000',
    JWT_SECRET: randomBytes(32).toString('hex')
});

const pool = require('../config/database');
const controller = require('../controllers/medicoController');
const router = require('../routes');
const { assertDisposableDatabaseName } = require('../support/mysql-test-safety');

function response() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

function transactionConnection(execute) {
    return {
        execute,
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release() {}
    };
}

test('proteção destrutiva aceita somente nome explícito de banco descartável Vitalis', () => {
    assert.equal(
        assertDisposableDatabaseName('vitalis_profissionais_test'),
        'vitalis_profissionais_test'
    );
    for (const unsafeName of [
        'vitalis_dev', 'vitalis_producao', 'profissionais_test', 'vitalis_backend_test',
        'vitalis_profissionais_test_backup', 'VITALIS_PROFISSIONAIS_TEST'
    ]) {
        assert.throws(() => assertDisposableDatabaseName(unsafeName), /Operação recusada/);
    }
});

test('listagem administrativa agrega especialidades somente da clínica ativa', async (t) => {
    const seen = [];
    t.mock.method(pool, 'execute', async (sql, params) => {
        seen.push({ sql, params });
        if (/FROM profissionais p/.test(sql)) {
            return [[{
                id: 8, usuario_id: 18, nome: 'Profissional Demo',
                conselho_tipo: 'CRM', conselho_numero: '123/PR',
                status: 'ativo', email: 'profissional@example.test'
            }]];
        }
        return [[{ profissional_id: 8, id: 3, nome: 'Clínica geral' }]];
    });
    const res = response();

    await controller.listForManagement({ tenant: { clinicId: 11 } }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(seen.map((item) => item.params), [[11], [11]]);
    assert.ok(seen.every((item) => /clinica_id = \?/.test(item.sql)));
    assert.deepEqual(res.body[0].especialidades, [{ id: 3, nome: 'Clínica geral' }]);
});

test('listagem usada em agendamentos exige profissional, vínculo e usuário ativos', async (t) => {
    t.mock.method(pool, 'execute', async (sql, params) => {
        assert.match(sql, /cu\.papel = 'profissional'/);
        assert.match(sql, /cu\.status = 'ativo'/);
        assert.match(sql, /u\.status = 'ativo'/);
        assert.match(sql, /p\.clinica_id = \?/);
        assert.deepEqual(params, [11]);
        return [[]];
    });
    const res = response();

    await controller.getAllMedicos({ tenant: { clinicId: 11 } }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, []);
});

test('opções de cadastro limitam usuários e especialidades à clínica ativa', async (t) => {
    const seen = [];
    t.mock.method(pool, 'execute', async (sql, params) => {
        seen.push({ sql, params });
        if (/FROM clinica_usuarios/.test(sql)) {
            assert.match(sql, /cu\.papel = 'profissional'/);
            assert.match(sql, /p\.id IS NULL/);
            return [[{ id: 18, nome: 'Pessoa Demo', email: 'pessoa@example.test' }]];
        }
        return [[{ id: 3, nome: 'Clínica geral' }]];
    });
    const res = response();

    await controller.getManagementOptions({ tenant: { clinicId: 11 } }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(seen.map((item) => item.params), [[11], [11]]);
    assert.equal(res.body.usuarios[0].id, 18);
});

test('cadastro usa o tenant do servidor e registra auditoria', async (t) => {
    const executions = [];
    const connection = transactionConnection(async (sql, params) => {
        executions.push({ sql, params });
        if (/SELECT cu\.usuario_id/.test(sql)) return [[{ usuario_id: 18 }]];
        if (/FROM especialidades/.test(sql)) return [[{ id: 3 }]];
        if (/INSERT INTO profissionais/.test(sql)) return [{ insertId: 44 }];
        return [{ affectedRows: 1 }];
    });
    const commit = t.mock.method(connection, 'commit');
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();

    await controller.createProfessional({
        body: {
            clinica_id: 999,
            usuario_id: 18,
            nome_exibicao: 'Profissional Demo',
            conselho_tipo: 'crm',
            conselho_numero: '123/PR',
            especialidade_ids: [3]
        },
        userId: 7,
        tenant: { clinicId: 11, role: 'administrador' }
    }, res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.id, 44);
    assert.equal(commit.mock.callCount(), 1);
    assert.ok(executions.some((item) => /INSERT INTO profissionais/.test(item.sql)
        && item.params[0] === 11 && item.params[1] === 18));
    assert.ok(executions.some((item) => /INSERT INTO auditoria/.test(item.sql)
        && item.params[0] === 11 && item.params[1] === 7));
    assert.equal(executions.some((item) => item.params?.includes(999)), false);
});

test('cadastro recusa usuário sem vínculo profissional na clínica ativa', async (t) => {
    const connection = transactionConnection(async (sql, params) => {
        assert.match(sql, /cu\.clinica_id = \?/);
        assert.deepEqual(params, [11, 18]);
        return [[]];
    });
    const rollback = t.mock.method(connection, 'rollback');
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();

    await controller.createProfessional({
        body: { usuario_id: 18, nome_exibicao: 'Profissional Demo', especialidade_ids: [] },
        userId: 7,
        tenant: { clinicId: 11, role: 'secretaria' }
    }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(rollback.mock.callCount(), 1);
});

test('edição não encontra profissional pertencente a outra clínica', async (t) => {
    const connection = transactionConnection(async (sql, params) => {
        assert.match(sql, /WHERE clinica_id = \? AND id = \?/);
        assert.deepEqual(params, [11, 99]);
        return [[]];
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();

    await controller.updateProfessional({
        params: { id: '99' },
        body: { nome_exibicao: 'Profissional Externo', especialidade_ids: [] },
        userId: 7,
        tenant: { clinicId: 11, role: 'administrador' }
    }, res);

    assert.equal(res.statusCode, 404);
});

test('edição atualiza dados e especialidades sem trocar usuário ou clínica', async (t) => {
    const executions = [];
    const connection = transactionConnection(async (sql, params) => {
        executions.push({ sql, params });
        if (/SELECT id FROM profissionais/.test(sql)) return [[{ id: 8 }]];
        if (/FROM especialidades/.test(sql)) return [[{ id: 3 }, { id: 4 }]];
        return [{ affectedRows: 1 }];
    });
    const commit = t.mock.method(connection, 'commit');
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();

    await controller.updateProfessional({
        params: { id: '8' },
        body: {
            clinica_id: 999,
            usuario_id: 888,
            nome_exibicao: 'Nome Atualizado',
            conselho_tipo: 'crm',
            conselho_numero: '456/PR',
            especialidade_ids: [3, 4]
        },
        userId: 7,
        tenant: { clinicId: 11, role: 'secretaria' }
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(commit.mock.callCount(), 1);
    const update = executions.find((item) => /UPDATE profissionais/.test(item.sql));
    assert.deepEqual(update.params, ['Nome Atualizado', 'CRM', '456/PR', 11, 8]);
    assert.equal(executions.some((item) => item.params?.includes(999) || item.params?.includes(888)), false);
});

test('reativação exige vínculo profissional ativo', async (t) => {
    const connection = transactionConnection(async (sql, params) => {
        assert.deepEqual(params, [11, 8]);
        return [[{ id: 8, papel: 'profissional', vinculo_status: 'inativo', usuario_status: 'ativo' }]];
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();

    await controller.updateProfessionalStatus({
        params: { id: '8' }, body: { status: 'ativo' }, userId: 7,
        tenant: { clinicId: 11, role: 'administrador' }
    }, res);

    assert.equal(res.statusCode, 409);
});

test('desativação é lógica, preserva histórico e registra auditoria', async (t) => {
    const executions = [];
    const connection = transactionConnection(async (sql, params) => {
        executions.push({ sql, params });
        if (/SELECT p\.id/.test(sql)) {
            return [[{ id: 8, papel: 'profissional', vinculo_status: 'ativo', usuario_status: 'ativo' }]];
        }
        return [{ affectedRows: 1 }];
    });
    const commit = t.mock.method(connection, 'commit');
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();

    await controller.updateProfessionalStatus({
        params: { id: '8' }, body: { status: 'inativo' }, userId: 7,
        tenant: { clinicId: 11, role: 'administrador' }
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(commit.mock.callCount(), 1);
    assert.ok(executions.some((item) => /UPDATE profissionais SET status/.test(item.sql)
        && item.params[0] === 'inativo' && item.params[1] === 11));
    assert.ok(executions.some((item) => /INSERT INTO auditoria/.test(item.sql)));
    assert.equal(executions.some((item) => /DELETE FROM profissionais/.test(item.sql)), false);
});

test('rotas de gestão permitem somente administrador e secretaria', () => {
    for (const [path, method] of [
        ['/profissionais/gestao', 'get'],
        ['/profissionais/opcoes', 'get'],
        ['/profissionais', 'post'],
        ['/profissionais/:id', 'put'],
        ['/profissionais/:id/status', 'patch']
    ]) {
        const layer = router.stack.find((item) => item.route?.path === path && item.route.methods[method]);
        assert.ok(layer, `${method.toUpperCase()} ${path} deveria existir`);
        const authorize = layer.route.stack[0].handle;
        for (const role of ['administrador', 'secretaria']) {
            let called = false;
            authorize({ tenant: { role } }, response(), () => { called = true; });
            assert.equal(called, true);
        }
        for (const role of ['profissional', 'paciente']) {
            const denied = response();
            authorize({ tenant: { role } }, denied, () => {});
            assert.equal(denied.statusCode, 403);
        }
    }
});

test('campos obrigatórios inválidos são rejeitados antes do banco', async (t) => {
    const getConnection = t.mock.method(pool, 'getConnection', async () => {
        throw new Error('não deveria acessar o banco');
    });
    const res = response();

    await controller.createProfessional({
        body: { usuario_id: 18, nome_exibicao: 'A', conselho_tipo: 'CRM', conselho_numero: '' },
        tenant: { clinicId: 11 }, userId: 7
    }, res);

    assert.equal(res.statusCode, 400);
    assert.equal(getConnection.mock.callCount(), 0);
});
