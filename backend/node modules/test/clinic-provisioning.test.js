const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { test } = require('node:test');

Object.assign(process.env, {
    DB_HOST: '127.0.0.1', DB_USER: 'fixture_user', DB_PASSWORD: 'fixture_password',
    DB_DATABASE: 'fixture_database', JWT_SECRET: randomBytes(32).toString('hex'),
    MAIL_PROVIDER: 'disabled', APP_PUBLIC_ORIGIN: 'http://127.0.0.1:5500'
});

const pool = require('../config/database');
const mailer = require('../services/invitation-mailer');
const controller = require('../controllers/clinicaController');
const { assertProvisioningDisposableDatabaseName } = require('../support/mysql-test-safety');

function response() {
    return {
        statusCode: null, body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

function connection(execute) {
    return {
        execute,
        beginTransaction: async () => {}, commit: async () => {},
        rollback: async () => {}, release() {}
    };
}

function request(overrides = {}) {
    return {
        userId: 7,
        body: {
            nome: 'Clínica Teste', slug: 'clinica-teste', timezone: 'America/Sao_Paulo',
            status: 'ativa', administrador_nome: 'Admin Teste',
            administrador_email: 'ADMIN@example.test'
        },
        ...overrides
    };
}

test('integração destrutiva aceita somente banco exclusivo de provisionamento', () => {
    assert.equal(
        assertProvisioningDisposableDatabaseName('vitalis_provisionamento_local_test'),
        'vitalis_provisionamento_local_test'
    );
    for (const unsafe of ['vitalis_m3_validacao', 'vitalis_dev', 'vitalis_provisionamento']) {
        assert.throws(() => assertProvisioningDisposableDatabaseName(unsafe), /Operação recusada/);
    }
});

test('valida slug estrito, e-mail e fuso IANA sem consultar o banco', async (t) => {
    assert.equal(controller._private.slug('Clinica Teste'), null);
    assert.equal(controller._private.slug('clinica-teste'), 'clinica-teste');
    assert.equal(controller._private.timezone('America/Sao_Paulo'), 'America/Sao_Paulo');
    assert.equal(controller._private.timezone('Fuso Inventado'), null);
    const getConnection = t.mock.method(pool, 'getConnection');
    const res = response();
    await controller.provision(request({ body: { nome: 'X', slug: 'Inválido', status: 'inativa' } }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(getConnection.mock.callCount(), 0);
});

test('usuário comum não provisiona clínica e nenhuma escrita é executada', async (t) => {
    const executions = [];
    const conn = connection(async (sql, params) => {
        executions.push({ sql, params });
        if (/FROM operadores_plataforma/.test(sql)) return [[]];
        throw new Error('escrita inesperada');
    });
    const rollback = t.mock.method(conn, 'rollback');
    t.mock.method(pool, 'getConnection', async () => conn);
    const res = response();
    await controller.provision(request(), res);
    assert.equal(res.statusCode, 403);
    assert.equal(rollback.mock.callCount(), 1);
    assert.equal(executions.some(({ sql }) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
});

test('provisionamento transacional de conta existente preserva senha e vínculos', async (t) => {
    const executions = [];
    const conn = connection(async (sql, params) => {
        executions.push({ sql, params });
        if (/FROM operadores_plataforma/.test(sql)) {
            return [[{ id: 3, operador_status: 'ativo', usuario_status: 'ativo' }]];
        }
        if (/FROM auditoria_plataforma/.test(sql) && /SELECT/.test(sql)) return [[]];
        if (/INSERT INTO clinicas/.test(sql)) return [{ insertId: 20 }];
        if (/FROM usuarios WHERE email/.test(sql)) {
            return [[{ id: 30, status: 'ativo', motivo_bloqueio: 'nenhum' }]];
        }
        if (/INSERT INTO clinica_usuarios/.test(sql)) return [{ insertId: 40 }];
        if (/INSERT INTO convites_clinica/.test(sql)) return [{ insertId: 50 }];
        return [{ affectedRows: 1 }];
    });
    const commit = t.mock.method(conn, 'commit');
    t.mock.method(pool, 'getConnection', async () => conn);
    t.mock.method(pool, 'execute', async (sql, params) => {
        executions.push({ sql, params }); return [{ affectedRows: 1 }];
    });
    t.mock.method(mailer, 'sendInvitation', async () => ({ status: 'not_configured', delivered: false }));
    const res = response();
    await controller.provision(request({ body: { ...request().body, clinica_id: 999 } }), res);
    assert.equal(res.statusCode, 201);
    assert.equal(commit.mock.callCount(), 1);
    assert.equal(executions.some(({ sql }) => /INSERT INTO usuarios/.test(sql)), false);
    assert.equal(executions.some(({ sql }) => /^\s*UPDATE usuarios/.test(sql)), false);
    assert.equal(executions.some(({ params }) => params?.includes(999)), false);
    const invite = executions.find(({ sql }) => /INSERT INTO convites_clinica/.test(sql));
    assert.equal(invite.params[0], 20);
    assert.equal(invite.params[2], 'admin@example.test');
    assert.match(invite.params[3], /^[a-f0-9]{64}$/);
    assert.equal('token' in res.body, false);
});

test('nova identidade começa bloqueada e ativa somente pelo convite', async (t) => {
    const executions = [];
    const conn = connection(async (sql, params) => {
        executions.push({ sql, params });
        if (/FROM operadores_plataforma/.test(sql)) {
            return [[{ id: 3, operador_status: 'ativo', usuario_status: 'ativo' }]];
        }
        if (/FROM auditoria_plataforma/.test(sql) && /SELECT/.test(sql)) return [[]];
        if (/SELECT id FROM clinicas WHERE slug/.test(sql)) return [[]];
        if (/INSERT INTO clinicas/.test(sql)) return [{ insertId: 20 }];
        if (/FROM usuarios WHERE email/.test(sql)) return [[]];
        if (/INSERT INTO usuarios/.test(sql)) return [{ insertId: 30 }];
        if (/INSERT INTO clinica_usuarios/.test(sql)) return [{ insertId: 40 }];
        if (/INSERT INTO convites_clinica/.test(sql)) return [{ insertId: 50 }];
        return [{ affectedRows: 1 }];
    });
    t.mock.method(pool, 'getConnection', async () => conn);
    t.mock.method(pool, 'execute', async () => [{ affectedRows: 1 }]);
    t.mock.method(mailer, 'sendInvitation', async () => ({ status: 'not_configured' }));
    const res = response();
    await controller.provision(request(), res);
    assert.equal(res.statusCode, 201);
    const userInsert = executions.find(({ sql }) => /INSERT INTO usuarios/.test(sql));
    assert.match(userInsert.sql, /'bloqueado', 'ativacao_pendente'/);
    assert.equal(userInsert.params[1], 'admin@example.test');
    const linkInsert = executions.find(({ sql }) => /INSERT INTO clinica_usuarios/.test(sql));
    assert.match(linkInsert.sql, /'administrador', 'convite_pendente'/);
});

test('falha parcial realiza rollback sem confirmar clínica incompleta', async (t) => {
    const conn = connection(async (sql) => {
        if (/FROM operadores_plataforma/.test(sql)) {
            return [[{ id: 3, operador_status: 'ativo', usuario_status: 'ativo' }]];
        }
        if (/FROM auditoria_plataforma/.test(sql) && /SELECT/.test(sql)) return [[]];
        if (/INSERT INTO clinicas/.test(sql)) return [{ insertId: 20 }];
        if (/FROM usuarios WHERE email/.test(sql)) throw Object.assign(new Error('falha'), { code: 'ER_LOCK_DEADLOCK' });
        return [{ affectedRows: 1 }];
    });
    const rollback = t.mock.method(conn, 'rollback');
    const commit = t.mock.method(conn, 'commit');
    t.mock.method(pool, 'getConnection', async () => conn);
    const res = response();
    await controller.provision(request(), res);
    assert.equal(res.statusCode, 500);
    assert.equal(rollback.mock.callCount(), 1);
    assert.equal(commit.mock.callCount(), 0);
});

test('slug duplicado retorna conflito e rollback', async (t) => {
    const conn = connection(async (sql) => {
        if (/FROM operadores_plataforma/.test(sql)) {
            return [[{ id: 3, operador_status: 'ativo', usuario_status: 'ativo' }]];
        }
        if (/FROM auditoria_plataforma/.test(sql) && /SELECT/.test(sql)) return [[]];
        if (/INSERT INTO clinicas/.test(sql)) {
            throw Object.assign(new Error('duplicado'), { code: 'ER_DUP_ENTRY' });
        }
        return [{ affectedRows: 1 }];
    });
    const rollback = t.mock.method(conn, 'rollback');
    t.mock.method(pool, 'getConnection', async () => conn);
    const res = response();
    await controller.provision(request(), res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /slug/);
    assert.equal(rollback.mock.callCount(), 1);
});

test('configuração usa somente clínica autenticada e revalida administrador na transação', async (t) => {
    const executions = [];
    const conn = connection(async (sql, params) => {
        executions.push({ sql, params });
        if (/FROM clinica_usuarios cu/.test(sql)) return [[{ id: 8 }]];
        return [{ affectedRows: 1 }];
    });
    t.mock.method(pool, 'getConnection', async () => conn);
    const res = response();
    await controller.updateSettings({
        userId: 7, tenant: { clinicId: 11, role: 'administrador' },
        auth: { membershipVersion: 4 },
        body: { nome: 'Clínica Atualizada', timezone: 'America/Manaus', clinica_id: 999 }
    }, res);
    assert.equal(res.statusCode, 200);
    const update = executions.find(({ sql }) => /UPDATE clinicas SET/.test(sql));
    assert.deepEqual(update.params, ['Clínica Atualizada', 'America/Manaus', 11]);
    assert.equal(executions.some(({ params }) => params?.includes(999)), false);
});
