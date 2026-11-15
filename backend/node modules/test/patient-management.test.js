const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { test } = require('node:test');

Object.assign(process.env, {
    DB_HOST: '127.0.0.1', DB_USER: 'fixture_user', DB_PASSWORD: 'fixture_password',
    DB_DATABASE: 'fixture_database', PORT: '3000', JWT_SECRET: randomBytes(32).toString('hex')
});

const pool = require('../config/database');
const controller = require('../controllers/pacienteController');
const router = require('../routes');

function response() {
    return { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function connection(execute) {
    return { execute, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} };
}

function request(overrides = {}) {
    return {
        body: { clinica_id: 999, nome: '  Maria   Silva  ', email: 'MARIA@example.test', telefone: '(41) 99999-1234', data_nascimento: '1990-05-20', status: 'ativo' },
        userId: 7, tenant: { clinicId: 11, role: 'secretaria' }, ...overrides
    };
}

test('validação normaliza dados e recusa datas inválidas ou futuras', () => {
    assert.deepEqual(controller.patientPayload(request().body), {
        name: 'Maria Silva', email: 'maria@example.test', phone: '41999991234', birthDate: '1990-05-20', status: 'ativo'
    });
    assert.equal(controller.patientPayload({ nome: 'Maria', data_nascimento: '2999-01-01' }), null);
    assert.equal(controller.patientPayload({ nome: 'Maria', email: 'invalido' }), null);
});

test('listagem é isolada e mascara dados pessoais', async (t) => {
    const calls = [];
    t.mock.method(pool, 'execute', async (sql, params) => {
        calls.push({ sql, params });
        if (/COUNT/.test(sql)) return [[{ total: 1 }]];
        return [[{ id: 3, nome: 'Maria', email: 'maria@example.test', telefone: '41999991234', ano_nascimento: 1990, status: 'ativo' }]];
    });
    const res = response();
    await controller.listForManagement({ tenant: { clinicId: 11 }, query: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.pacientes[0].email_mascarado, 'm***@example.test');
    assert.equal(res.body.pacientes[0].telefone_mascarado, '***1234');
    assert.equal('email' in res.body.pacientes[0], false);
    assert.ok(calls.every((call) => call.params[0] === 11 && /clinica_id = \?/.test(call.sql)));
});

test('paginação recusa valores fora dos limites antes de consultar o banco', async (t) => {
    const execute = t.mock.method(pool, 'execute', async () => {
        throw new Error('não deveria consultar o banco');
    });
    for (const query of [
        { pagina: '0' }, { pagina: '-1' }, { pagina: '1.5' },
        { pagina: '100001' }, { limite: '0' }, { limite: '51' }, { limite: 'abc' }
    ]) {
        const res = response();
        await controller.listForManagement({ tenant: { clinicId: 11 }, query }, res);
        assert.equal(res.statusCode, 400);
    }
    assert.equal(execute.mock.callCount(), 0);
});

test('paginação aceita os limites máximos sem interpolar entrada livre', async (t) => {
    const sqlSeen = [];
    t.mock.method(pool, 'execute', async (sql) => {
        sqlSeen.push(sql);
        return /COUNT/.test(sql) ? [[{ total: 0 }]] : [[]];
    });
    const res = response();
    await controller.listForManagement({
        tenant: { clinicId: 11 }, query: { pagina: '100000', limite: '50' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.match(sqlSeen[0], /LIMIT 50 OFFSET 4999950/);
});

test('busca para M4-02 expõe somente id, nome e ano na clínica ativa', async (t) => {
    t.mock.method(pool, 'execute', async (sql, params) => {
        assert.match(sql, /clinica_id = \? AND status = 'ativo'/);
        assert.equal(params[0], 11);
        return [[{ id: 3, nome: 'Maria', ano_nascimento: 1990 }]];
    });
    const res = response();
    await controller.searchForScheduling({ tenant: { clinicId: 11 }, query: { q: 'Mar' } }, res);
    assert.deepEqual(res.body, [{ id: 3, nome: 'Maria', ano_nascimento: 1990 }]);
});

test('secretaria cadastra no tenant autenticado sem criar identidade global', async (t) => {
    const executions = [];
    const db = connection(async (sql, params) => {
        executions.push({ sql, params });
        if (/SELECT id FROM clinicas/.test(sql)) return [[{ id: 11 }]];
        if (/SELECT cu\.id/.test(sql)) return [[{ id: 2 }]];
        if (/SELECT id FROM pacientes/.test(sql)) return [[]];
        if (/INSERT INTO pacientes/.test(sql)) return [{ insertId: 44 }];
        return [{ affectedRows: 1 }];
    });
    const commit = t.mock.method(db, 'commit');
    t.mock.method(pool, 'getConnection', async () => db);
    const res = response();
    await controller.createPatient(request(), res);
    assert.equal(res.statusCode, 201);
    assert.equal(commit.mock.callCount(), 1);
    const insert = executions.find((entry) => /INSERT INTO pacientes/.test(entry.sql));
    assert.match(insert.sql, /VALUES \(\?, NULL/);
    assert.equal(insert.params[0], 11);
    assert.equal(executions.some((entry) => entry.params?.includes(999)), false);
    const audit = executions.find((entry) => /INSERT INTO auditoria/.test(entry.sql));
    assert.equal(audit.params.join(' ').includes('maria@example.test'), false);
});

test('duplicidade na clínica aborta sem inserir', async (t) => {
    const executions = [];
    const db = connection(async (sql) => {
        executions.push(sql);
        if (/SELECT id FROM clinicas/.test(sql)) return [[{ id: 11 }]];
        if (/SELECT cu\.id/.test(sql)) return [[{ id: 2 }]];
        if (/SELECT id FROM pacientes/.test(sql)) return [[{ id: 5 }]];
        return [{ affectedRows: 1 }];
    });
    const rollback = t.mock.method(db, 'rollback');
    t.mock.method(pool, 'getConnection', async () => db);
    const res = response();
    await controller.createPatient(request(), res);
    assert.equal(res.statusCode, 409);
    assert.equal(rollback.mock.callCount(), 1);
    assert.equal(executions.some((sql) => /INSERT INTO pacientes/.test(sql)), false);
});

test('permissão do operador é revalidada dentro da transação', async (t) => {
    const executions = [];
    const db = connection(async (sql) => {
        executions.push(sql);
        if (/SELECT id FROM clinicas/.test(sql)) return [[{ id: 11 }]];
        if (/SELECT cu\.id/.test(sql)) return [[]];
        return [{ affectedRows: 1 }];
    });
    t.mock.method(pool, 'getConnection', async () => db);
    const res = response();
    await controller.createPatient(request(), res);
    assert.equal(res.statusCode, 403);
    assert.equal(executions.some((sql) => /INSERT INTO pacientes/.test(sql)), false);
});

test('edição por identificador de outra clínica retorna 404', async (t) => {
    const db = connection(async (sql) => {
        if (/SELECT id FROM clinicas/.test(sql)) return [[{ id: 11 }]];
        if (/SELECT cu\.id/.test(sql)) return [[{ id: 2 }]];
        if (/FROM pacientes WHERE/.test(sql)) return [[]];
        return [{ affectedRows: 1 }];
    });
    t.mock.method(pool, 'getConnection', async () => db);
    const res = response();
    await controller.updatePatient(request({ params: { id: '77' } }), res);
    assert.equal(res.statusCode, 404);
});

test('falha parcial provoca rollback e não confirma a transação', async (t) => {
    const db = connection(async (sql) => {
        if (/SELECT id FROM clinicas/.test(sql)) return [[{ id: 11 }]];
        if (/SELECT cu\.id/.test(sql)) return [[{ id: 2 }]];
        if (/SELECT id FROM pacientes/.test(sql)) return [[]];
        if (/INSERT INTO pacientes/.test(sql)) return [{ insertId: 44 }];
        throw new Error('falha de auditoria');
    });
    const rollback = t.mock.method(db, 'rollback');
    const commit = t.mock.method(db, 'commit');
    t.mock.method(pool, 'getConnection', async () => db);
    t.mock.method(console, 'error', () => {});
    const res = response();
    await controller.createPatient(request(), res);
    assert.equal(res.statusCode, 500);
    assert.equal(rollback.mock.callCount(), 1);
    assert.equal(commit.mock.callCount(), 0);
});

test('logs de falha não expõem mensagem, SQL, parâmetros ou dados pessoais', async (t) => {
    const sensitive = new Error('maria@example.test telefone 41999991234');
    sensitive.code = 'ER_PARSE_ERROR';
    sensitive.sql = 'SELECT * FROM pacientes WHERE email = maria@example.test';
    sensitive.sqlMessage = 'parâmetros privados';
    t.mock.method(pool, 'execute', async () => { throw sensitive; });
    const logged = [];
    t.mock.method(console, 'error', (...args) => logged.push(args));
    const res = response();
    await controller.listForManagement({ tenant: { clinicId: 11 }, query: {} }, res);
    assert.equal(res.statusCode, 500);
    const serialized = JSON.stringify(logged);
    assert.match(serialized, /ER_PARSE_ERROR/);
    assert.doesNotMatch(serialized, /maria@example|41999991234|SELECT \*|parâmetros privados/);
});

test('rotas de gestão aceitam apenas administrador e secretaria', () => {
    const routes = router.stack.filter((layer) => layer.route).map((layer) => ({
        path: layer.route.path, methods: layer.route.methods, handlers: layer.route.stack.map((item) => item.handle)
    }));
    for (const path of ['/pacientes/gestao', '/pacientes/busca', '/pacientes/gestao/:id', '/pacientes', '/pacientes/:id']) {
        assert.ok(routes.some((route) => route.path === path), `rota ausente: ${path}`);
    }
    const create = routes.find((route) => route.path === '/pacientes' && route.methods.post);
    const authorized = create.handlers[0];
    for (const role of ['administrador', 'secretaria']) {
        let called = false;
        authorized({ tenant: { role } }, response(), () => { called = true; });
        assert.equal(called, true);
    }
    for (const role of ['profissional', 'paciente']) {
        const res = response();
        authorized({ tenant: { role } }, res, () => {});
        assert.equal(res.statusCode, 403);
    }
});
