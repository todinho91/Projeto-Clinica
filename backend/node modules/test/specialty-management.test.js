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
const controller = require('../controllers/especialidadeController');
const router = require('../routes');
const { assertSpecialtyDisposableDatabaseName } = require('../support/mysql-test-safety');

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

test('proteção destrutiva aceita somente banco descartável exclusivo de especialidades', () => {
    assert.equal(
        assertSpecialtyDisposableDatabaseName('vitalis_especialidades_test'),
        'vitalis_especialidades_test'
    );
    for (const unsafeName of [
        'vitalis_dev', 'vitalis_producao', 'especialidades_test', 'vitalis_profissionais_test',
        'vitalis_especialidades_test_backup', 'VITALIS_ESPECIALIDADES_TEST'
    ]) {
        assert.throws(() => assertSpecialtyDisposableDatabaseName(unsafeName), /Operação recusada/);
    }
});

test('listagem usa somente a clínica ativa e converte contagens', async (t) => {
    t.mock.method(pool, 'execute', async (sql, params) => {
        assert.match(sql, /WHERE e\.clinica_id = \?/);
        assert.match(sql, /pe\.clinica_id = e\.clinica_id/);
        assert.deepEqual(params, [11]);
        return [[{
            id: 3, nome: 'Cardiologia', status: 'ativa',
            total_profissionais: '2', profissionais_ativos: '1'
        }]];
    });
    const res = response();

    await controller.listForManagement({ tenant: { clinicId: 11 } }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body[0], {
        id: 3, nome: 'Cardiologia', status: 'ativa',
        total_profissionais: 2, profissionais_ativos: 1
    });
});

test('cadastro normaliza nome, ignora clinica_id do navegador e registra auditoria', async (t) => {
    const executions = [];
    const connection = transactionConnection(async (sql, params) => {
        executions.push({ sql, params });
        if (/INSERT INTO especialidades/.test(sql)) return [{ insertId: 30 }];
        return [{ affectedRows: 1 }];
    });
    const commit = t.mock.method(connection, 'commit');
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();

    await controller.createSpecialty({
        body: { nome: '  Medicina   da Família ', clinica_id: 999 },
        userId: 7,
        tenant: { clinicId: 11 }
    }, res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.id, 30);
    assert.equal(commit.mock.callCount(), 1);
    assert.ok(executions.some((item) => /INSERT INTO especialidades/.test(item.sql)
        && item.params[0] === 11 && item.params[1] === 'Medicina da Família'));
    assert.ok(executions.some((item) => /INSERT INTO auditoria/.test(item.sql)
        && item.params[0] === 11 && item.params[1] === 7));
    assert.equal(executions.some((item) => item.params?.includes(999)), false);
});

test('cadastro rejeita nome vazio ou inválido antes de acessar o banco', async (t) => {
    const getConnection = t.mock.method(pool, 'getConnection', async () => {
        throw new Error('não deveria acessar o banco');
    });

    for (const nome of ['', ' ', 'A', 'x'.repeat(121), 42]) {
        const res = response();
        await controller.createSpecialty({ body: { nome }, tenant: { clinicId: 11 } }, res);
        assert.equal(res.statusCode, 400);
    }
    assert.equal(getConnection.mock.callCount(), 0);
});

test('duplicidade na mesma clínica retorna conflito sem publicar detalhe do banco', async (t) => {
    const error = Object.assign(new Error('duplicate fixture'), { code: 'ER_DUP_ENTRY' });
    const connection = transactionConnection(async () => { throw error; });
    const rollback = t.mock.method(connection, 'rollback');
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();

    await controller.createSpecialty({
        body: { nome: 'Cardiologia' }, userId: 7, tenant: { clinicId: 11 }
    }, res);

    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /Já existe/);
    assert.doesNotMatch(res.body.error, /duplicate fixture/);
    assert.equal(rollback.mock.callCount(), 1);
});

test('edição altera apenas registro da clínica ativa e registra nome anterior', async (t) => {
    const executions = [];
    const connection = transactionConnection(async (sql, params) => {
        executions.push({ sql, params });
        if (/SELECT id, nome/.test(sql)) return [[{ id: 3, nome: 'Clínica geral' }]];
        return [{ affectedRows: 1 }];
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();

    await controller.updateSpecialty({
        params: { id: '3' }, body: { nome: 'Medicina Geral', clinica_id: 999 },
        userId: 7, tenant: { clinicId: 11 }
    }, res);

    assert.equal(res.statusCode, 200);
    assert.ok(executions.some((item) => /UPDATE especialidades/.test(item.sql)
        && item.params[0] === 'Medicina Geral' && item.params[1] === 11 && item.params[2] === 3));
    assert.equal(executions.some((item) => item.params?.includes(999)), false);
    const audit = executions.find((item) => /INSERT INTO auditoria/.test(item.sql));
    assert.deepEqual(JSON.parse(audit.params[4]), {
        nome_anterior: 'Clínica geral', nome_atual: 'Medicina Geral'
    });
});

test('edição de especialidade de outra clínica retorna 404', async (t) => {
    const connection = transactionConnection(async (sql, params) => {
        assert.match(sql, /WHERE clinica_id = \? AND id = \?/);
        assert.deepEqual(params, [11, 99]);
        return [[]];
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();

    await controller.updateSpecialty({
        params: { id: '99' }, body: { nome: 'Externa' },
        userId: 7, tenant: { clinicId: 11 }
    }, res);

    assert.equal(res.statusCode, 404);
});

test('ativação e desativação são lógicas, preservam vínculos e auditam', async (t) => {
    for (const status of ['inativa', 'ativa']) {
        const executions = [];
        const connection = transactionConnection(async (sql, params) => {
            executions.push({ sql, params });
            if (/SELECT id, status/.test(sql)) return [[{ id: 3, status: status === 'ativa' ? 'inativa' : 'ativa' }]];
            return [{ affectedRows: 1 }];
        });
        const getConnection = t.mock.method(pool, 'getConnection', async () => connection);
        const res = response();

        await controller.updateSpecialtyStatus({
            params: { id: '3' }, body: { status }, userId: 7,
            tenant: { clinicId: 11 }
        }, res);

        assert.equal(res.statusCode, 200);
        assert.ok(executions.some((item) => /UPDATE especialidades SET status/.test(item.sql)
            && item.params[0] === status && item.params[1] === 11));
        assert.ok(executions.some((item) => /INSERT INTO auditoria/.test(item.sql)));
        assert.equal(executions.some((item) => /DELETE/i.test(item.sql)), false);
        getConnection.mock.restore();
    }
});

test('rotas de especialidades permitem somente administrador e secretaria', () => {
    for (const [path, method] of [
        ['/especialidades/gestao', 'get'],
        ['/especialidades', 'post'],
        ['/especialidades/:id', 'put'],
        ['/especialidades/:id/status', 'patch']
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
