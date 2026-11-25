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
const { getMinhaAgenda } = require('../controllers/consultaController');
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
        assert.match(sql, /cu\.sessao_versao = \?/);
        return [[{ clinica_id: 11, papel: 'secretaria', clinica_nome: 'Demo' }]];
    });
    const req = {
        userId: 3,
        auth: { tokenType: 'clinic', clinicId: 11, membershipVersion: 4 },
        body: { clinica_id: 99 }
    };
    const res = response();
    const next = t.mock.fn();

    await tenantContext(req, res, next);

    assert.deepEqual(parameters, [11, 3, 4]);
    assert.deepEqual(req.tenant, {
        clinicId: 11,
        clinicName: 'Demo',
        role: 'secretaria',
        permissions: { manageAvailability: false }
    });
    assert.equal(next.mock.callCount(), 1);
});

test('token de clínica sem versão de vínculo é recusado antes do banco', async (t) => {
    const execute=t.mock.method(pool,'execute'); const res=response();
    await tenantContext({userId:3,auth:{tokenType:'clinic',clinicId:11,membershipVersion:null}},res,()=>{});
    assert.equal(res.statusCode,403);
    assert.equal(execute.mock.callCount(),0);
});

test('token forjado para outra clínica é rejeitado sem vínculo ativo', async (t) => {
    t.mock.method(pool, 'execute', async () => [[]]);
    const res = response();
    const next = t.mock.fn();

    await tenantContext({
        userId: 3,
        auth: { tokenType: 'clinic', clinicId: 99, membershipVersion: 1 }
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

test('listagem e seleção de clínicas exigem token de identidade', () => {
    for (const path of ['/auth/clinics', '/auth/select-clinic']) {
        const route = router.stack.find((layer) => layer.route?.path === path);
        assert.ok(route);
        const requireIdentity = route.route.stack[0].handle;

        const denied = response();
        let deniedNext = false;
        requireIdentity({auth:{tokenType:'clinic',clinicId:11,membershipVersion:1}},denied,()=>{deniedNext=true;});
        assert.equal(denied.statusCode,403);
        assert.equal(deniedNext,false);

        const allowed = response();
        let allowedNext = false;
        requireIdentity({auth:{tokenType:'identity'}},allowed,()=>{allowedNext=true;});
        assert.equal(allowedNext,true);
    }
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

test('rotas de equipe recusam profissional e paciente', () => {
    for (const path of ['/equipe', '/equipe/convites']) {
        const route = router.stack.find((layer) => layer.route?.path === path);
        assert.ok(route);
        const authorizeTeam = route.route.stack[0].handle;
        for (const role of ['profissional', 'paciente']) {
            const res = response(); let called = false;
            authorizeTeam({ tenant: { role } }, res, () => { called = true; });
            assert.equal(res.statusCode, 403); assert.equal(called, false);
        }
    }
});

test('agenda administrativa usa exclusivamente a clínica ativa', async (t) => {
    let params;
    t.mock.method(pool, 'execute', async (sql, values) => {
        assert.match(sql, /WHERE c\.clinica_id = \?/);
        params = values;
        return [[{
            id: 1, inicio_em: '2032-01-01 12:00:00.000', fim_em: '2032-01-01 12:30:00.000',
            status: 'agendada', versao: 1, paciente_id: 3, profissional_id: 4,
            timezone: 'America/Sao_Paulo', pode_concluir: 0, futura: 1, em_andamento: 0
        }]];
    });
    const res = response();

    await getMinhaAgenda({
        body: { clinica_id: 99 },
        userId: 7,
        tenant: { clinicId: 11, role: 'administrador' }
    }, res);

    assert.deepEqual(params, [
        7, 'administrador', 11, 'administrador', 'administrador', 7,
        'administrador', 7, 'administrador'
    ]);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].inicio_local, '2032-01-01T09:00');
    assert.equal(res.body[0].fim_local, '2032-01-01T09:30');
    assert.equal(res.body[0].timezone, 'America/Sao_Paulo');
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
test('profissional sem atendimento elegível não consulta detalhes do paciente', async (t) => {
    const execute = t.mock.method(pool, 'execute', async (sql, params) => {
        assert.match(sql, /FROM consultas c/);
        assert.match(sql, /pr\.usuario_id = \?/);
        assert.match(sql, /c\.status IN \('agendada', 'confirmada', 'realizada'\)/);
        assert.match(sql, /pr\.status = 'ativo'/);
        assert.match(sql, /cu\.status = 'ativo'/);
        assert.match(sql, /professional_user\.status = 'ativo'/);
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
    assert.equal(execute.mock.callCount(), 1);
});

test('profissional autorizado recebe somente consultas próprias e documentos enviados por ele', async (t) => {
    const calls = [];
    t.mock.method(pool, 'execute', async (sql, params) => {
        calls.push({ sql, params });
        if (/SELECT p\.id, p\.nome/.test(sql)) return [[{ id: 55, nome: 'Paciente', status: 'ativo' }]];
        if (/FROM consultas c/.test(sql)) return [[{ id: 91, nome_profissional: 'Dra. A' }]];
        if (/FROM documentos_clinicos/.test(sql)) return [[{ id: 112, titulo: 'Documento da Dra. A' }]];
        throw new Error('consulta inesperada');
    });
    const res = response();

    await getPacienteDetails({
        params: { id: '55' }, userId: 7,
        tenant: { clinicId: 11, role: 'profissional', isPractice: false }
    }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.consultas, [{ id: 91, nome_profissional: 'Dra. A' }]);
    assert.deepEqual(res.body.documentos, [{ id: 112, titulo: 'Documento da Dra. A' }]);
    const appointments = calls.find(({ sql }) => /SELECT\s+c\.id, c\.inicio_em/.test(sql));
    assert.match(appointments.sql, /p\.usuario_id = \? AND p\.status = 'ativo'/);
    assert.deepEqual(appointments.params, [11, 55, 'profissional', 7]);
    const documents = calls.find(({ sql }) => /FROM documentos_clinicos/.test(sql));
    assert.match(documents.sql, /enviado_por_usuario_id = \?/);
    assert.deepEqual(documents.params, [11, 55, 'profissional', 7]);
});

test('paciente titular, secretaria e administrador mantêm acesso institucional dentro do tenant', async (t) => {
    const calls = [];
    t.mock.method(pool, 'execute', async (sql, params) => {
        calls.push({ sql, params });
        if (/SELECT p\.id, p\.nome/.test(sql)) return [[{ id: 55, nome: 'Paciente', status: 'ativo' }]];
        if (/FROM consultas c/.test(sql)) return [[{ id: 91 }, { id: 92 }]];
        if (/FROM documentos_clinicos/.test(sql)) return [[{ id: 112 }, { id: 113 }]];
        throw new Error('consulta inesperada');
    });
    for (const [role, userId] of [['paciente', 31], ['secretaria', 32], ['administrador', 33]]) {
        const before = calls.length;
        const res = response();
        await getPacienteDetails({
            params: { id: '55' }, userId,
            tenant: { clinicId: 11, role, isPractice: false }
        }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.consultas.length, 2);
        assert.equal(res.body.documentos.length, 2);
        assert.deepEqual(calls.slice(before).map(({ params }) => params.slice(0, 2)), [[11, 55], [11, 55], [11, 55]]);
    }
    assert.match(calls.find(({ sql }) => /SELECT p\.id, p\.nome/.test(sql)).sql, /\? = 'paciente' AND p\.usuario_id = \?/);
});

test('secretaria de consultório mantém acesso administrativo sem metadados de documentos', async (t) => {
    const calls = [];
    t.mock.method(pool, 'execute', async (sql, params) => {
        calls.push({ sql, params });
        if (/SELECT p\.id, p\.nome/.test(sql)) return [[{ id: 55, nome: 'Paciente' }]];
        if (/FROM consultas c/.test(sql)) return [[{ id: 91 }]];
        throw new Error('secretaria do consultório não deve consultar documentos');
    });
    const res = response();
    await getPacienteDetails({
        params: { id: '55' }, userId: 32,
        tenant: { clinicId: 11, role: 'secretaria', isPractice: true }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.documentos, []);
    assert.equal(calls.some(({ sql }) => /FROM documentos_clinicos/.test(sql)), false);
});
