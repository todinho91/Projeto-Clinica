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
const tenantContext = require('../middleware/tenant');
const authorize = require('../middleware/authorize');
const { selectClinic } = require('../controllers/authController');
const { getPacienteDetails } = require('../controllers/pacienteController');
const { agendarConsulta, getMinhaAgenda } = require('../controllers/consultaController');
const router = require('../routes');

function response() {
    return {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    };
}

test('contexto de tenant exige token de clínica', async (t) => {
    const execute = t.mock.method(pool, 'execute', async () => {
        throw new Error('não deveria consultar o banco');
    });
    const res = response();

    await tenantContext({ userId: 3, auth: { tokenType: 'identity', clinicId: null } }, res, () => {});

    assert.equal(res.statusCode, 403);
    assert.equal(execute.mock.callCount(), 0);
});

test('contexto usa somente a clínica assinada e revalida o vínculo no banco', async (t) => {
    let parameters;
    t.mock.method(pool, 'execute', async (sql, params) => {
        parameters = params;
        assert.match(sql, /cu\.clinica_id = \?/);
        return [[{ clinica_id: 11, papel: 'secretaria', clinica_nome: 'Demo' }]];
    });
    const req = {
        userId: 3,
        auth: { tokenType: 'clinic', clinicId: 11 },
        body: { clinica_id: 99 }
    };
    const res = response();
    const next = t.mock.fn();

    await tenantContext(req, res, next);

    assert.deepEqual(parameters, [11, 3]);
    assert.deepEqual(req.tenant, { clinicId: 11, clinicName: 'Demo', role: 'secretaria' });
    assert.equal(next.mock.callCount(), 1);
});

test('token forjado para outra clínica é rejeitado sem vínculo ativo', async (t) => {
    t.mock.method(pool, 'execute', async () => [[]]);
    const res = response();
    const next = t.mock.fn();

    await tenantContext({
        userId: 3,
        auth: { tokenType: 'clinic', clinicId: 99 }
    }, res, next);

    assert.equal(res.statusCode, 403);
    assert.equal(next.mock.callCount(), 0);
});

test('seleção de clínica recusa vínculo de outro usuário', async (t) => {
    let params;
    t.mock.method(pool, 'execute', async (sql, values) => {
        params = values;
        return [[]];
    });
    const res = response();

    await selectClinic({ userId: 3, body: { clinica_id: 22 } }, res);

    assert.deepEqual(params, [3, 22]);
    assert.equal(res.statusCode, 403);
});

test('autorização permite somente papéis declarados pela rota', () => {
    const middleware = authorize('administrador', 'secretaria');
    const denied = response();
    middleware({ tenant: { role: 'paciente' } }, denied, () => {});
    assert.equal(denied.statusCode, 403);

    const allowed = response();
    let called = false;
    middleware({ tenant: { role: 'secretaria' } }, allowed, () => { called = true; });
    assert.equal(called, true);
});

test('rota de agenda permite os quatro papéis autenticados da clínica', () => {
    const route = router.stack.find((layer) => layer.route?.path === '/consultas/minha-agenda');
    assert.ok(route);
    assert.equal(route.route.methods.get, true);
    const routeAuthorization = route.route.stack[0].handle;

    for (const role of ['administrador', 'secretaria', 'profissional', 'paciente']) {
        const res = response();
        let called = false;
        routeAuthorization({ tenant: { role } }, res, () => { called = true; });
        assert.equal(called, true, `papel ${role} deveria acessar a agenda`);
    }

    const denied = response();
    routeAuthorization({ tenant: { role: 'superadmin' } }, denied, () => {});
    assert.equal(denied.statusCode, 403);
});

test('rotas de upload recusam paciente antes de processar o arquivo', () => {
    for (const path of ['/documentos/upload', '/exames/upload']) {
        const route = router.stack.find((layer) => layer.route?.path === path);
        assert.ok(route);
        const routeAuthorization = route.route.stack[0].handle;
        const denied = response();
        let called = false;

        routeAuthorization({ tenant: { role: 'paciente' } }, denied, () => { called = true; });

        assert.equal(denied.statusCode, 403);
        assert.equal(called, false);
    }
});

test('agenda administrativa usa exclusivamente a clínica ativa', async (t) => {
    let params;
    t.mock.method(pool, 'execute', async (sql, values) => {
        assert.match(sql, /WHERE c\.clinica_id = \?/);
        params = values;
        return [[{ id: 1, inicio_em: '2032-01-01T12:00:00.000Z', status: 'agendada' }]];
    });
    const res = response();

    await getMinhaAgenda({
        body: { clinica_id: 99 },
        userId: 7,
        tenant: { clinicId: 11, role: 'administrador' }
    }, res);

    assert.deepEqual(params, [11, 'administrador', 'administrador', 7, 'administrador', 7]);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.length, 1);
});

test('pool interpreta DATETIME clínico como UTC', () => {
    assert.equal(pool.pool.config.connectionConfig.timezone, 'Z');
});

test('paciente de outra clínica não pode ser consultado', async (t) => {
    let params;
    t.mock.method(pool, 'execute', async (sql, values) => {
        params = values;
        return [[]];
    });
    const res = response();

    await getPacienteDetails({
        params: { id: '55' },
        userId: 7,
        tenant: { clinicId: 11, role: 'administrador' }
    }, res);

    assert.deepEqual(params, [
        11, 55, 'administrador', 'administrador', 7, 'administrador', 7
    ]);
    assert.equal(res.statusCode, 404);
});

test('profissional só consulta paciente vinculado à própria agenda', async (t) => {
    t.mock.method(pool, 'execute', async (sql, params) => {
        assert.match(sql, /FROM consultas c/);
        assert.match(sql, /pr\.usuario_id = \?/);
        assert.deepEqual(params, [
            11, 55, 'profissional', 'profissional', 7, 'profissional', 7
        ]);
        return [[]];
    });
    const res = response();

    await getPacienteDetails({
        params: { id: '55' },
        userId: 7,
        tenant: { clinicId: 11, role: 'profissional' }
    }, res);

    assert.equal(res.statusCode, 404);
});

test('agendamento rejeita paciente fora da clínica ativa antes do insert', async (t) => {
    let executions = 0;
    t.mock.method(pool, 'execute', async (sql, params) => {
        executions += 1;
        assert.equal(params[0], 11);
        assert.equal(params[5], 11);
        return [[{ paciente_id: null, profissional_id: 8 }]];
    });
    const res = response();

    await agendarConsulta({
        body: {
            clinica_id: 99,
            paciente_id: 55,
            profissional_id: 8,
            inicio_em: '2032-01-01T10:00:00Z',
            fim_em: '2032-01-01T11:00:00Z'
        },
        userId: 7,
        tenant: { clinicId: 11, role: 'secretaria' }
    }, res);

    assert.equal(executions, 1);
    assert.equal(res.statusCode, 404);
});

test('agendamento usa tenant do servidor e normaliza horário para UTC', async (t) => {
    let executions = 0;
    t.mock.method(pool, 'execute', async (sql, params) => {
        executions += 1;
        if (executions === 1) {
            assert.equal(params[0], 11);
            assert.equal(params[5], 11);
            return [[{ paciente_id: 44, profissional_id: 8 }]];
        }
        assert.match(sql, /INSERT INTO consultas/);
        assert.deepEqual(params, [
            11, 44, 8,
            '2032-01-01 13:00:00.000',
            '2032-01-01 14:00:00.000',
            7
        ]);
        return [{ insertId: 123 }];
    });
    const res = response();

    await agendarConsulta({
        body: {
            clinica_id: 99,
            paciente_id: 999,
            profissional_id: 8,
            inicio_em: '2032-01-01T10:00:00-03:00',
            fim_em: '2032-01-01T11:00:00-03:00'
        },
        userId: 7,
        tenant: { clinicId: 11, role: 'paciente' }
    }, res);

    assert.equal(executions, 2);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.id, 123);
});
