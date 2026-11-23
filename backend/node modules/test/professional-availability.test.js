const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

Object.assign(process.env, {
    DB_HOST: '127.0.0.1', DB_USER: 'fixture_user', DB_PASSWORD: 'fixture_password',
    DB_DATABASE: 'fixture_database', PORT: '3000', JWT_SECRET: randomBytes(32).toString('hex')
});

const pool = require('../config/database');
const controller = require('../controllers/disponibilidadeController');
const router = require('../routes');
const { utcToLocal, zonedLocalToUtc } = require('../support/clinic-time');
const {
    assertAvailabilityDisposableDatabaseName,
    confirmAvailabilityTestEnvironment
} = require('../support/mysql-test-safety');

function response() {
    return {
        statusCode: null, body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

function connection(execute) {
    return {
        execute, beginTransaction: async () => {}, commit: async () => {},
        rollback: async () => {}, release() {}
    };
}

test('integração destrutiva aceita somente banco exclusivo de disponibilidade', () => {
    assert.equal(
        assertAvailabilityDisposableDatabaseName('vitalis_disponibilidade_m4_test'),
        'vitalis_disponibilidade_m4_test'
    );
    for (const unsafe of [
        'vitalis_m3_validacao', 'vitalis_dev', 'vitalis_backend_test',
        'vitalis_disponibilidade', 'vitalis_disponibilidade_test_backup'
    ]) {
        assert.throws(() => assertAvailabilityDisposableDatabaseName(unsafe), /Operação recusada/);
    }
});

test('integração confirma banco selecionado e MySQL 8 antes da limpeza', async () => {
    const queries = [];
    const environment = await confirmAvailabilityTestEnvironment({
        async query(sql) {
            queries.push(sql);
            if (/DATABASE/.test(sql)) return [[{ database_name: 'vitalis_disponibilidade_m4_test' }]];
            return [[{ version: '8.0.46-0ubuntu0.24.04.2' }]];
        }
    }, 'vitalis_disponibilidade_m4_test');
    assert.deepEqual(queries, [
        'SELECT DATABASE() AS database_name',
        'SELECT VERSION() AS version'
    ]);
    assert.equal(environment.database, 'vitalis_disponibilidade_m4_test');
    assert.match(environment.version, /^8\./);
    await assert.rejects(
        confirmAvailabilityTestEnvironment({
            async query(sql) {
                if (/DATABASE/.test(sql)) return [[{ database_name: 'vitalis_disponibilidade_m4_test' }]];
                return [[{ version: '5.7.44' }]];
            }
        }, 'vitalis_disponibilidade_m4_test'),
        /exige MySQL 8/
    );
});

test('rollback MySQL usa restrição nova sem invalidar auditoria ou intervalos existentes', () => {
    const integration = readFileSync(
        path.join(__dirname, 'professional-availability.integration.test.js'), 'utf8'
    );
    assert.match(integration, /ALTER TABLE disponibilidades_profissional[\s\S]*ADD CONSTRAINT chk_disponibilidade_rollback_teste/);
    assert.match(integration, /dia_semana = 2[\s\S]*inicio_local = '10:00:00'[\s\S]*fim_local = '16:00:00'/);
    assert.doesNotMatch(integration, /ALTER TABLE auditoria ADD CONSTRAINT chk_disponibilidade_rollback_teste/);
});

test('grade semanal aceita períodos adjacentes e rejeita qualquer sobreposição', () => {
    const valid = controller.weeklyPayload({ intervalos: [
        { dia_semana: 1, tipo: 'atendimento', inicio: '08:00', fim: '12:00' },
        { dia_semana: 1, tipo: 'descanso', inicio: '12:00', fim: '13:00' },
        { dia_semana: 1, tipo: 'atendimento', inicio: '13:00', fim: '17:00' }
    ] });
    assert.equal(valid.length, 3);
    assert.equal(controller.weeklyPayload({ intervalos: [
        { dia_semana: 2, tipo: 'atendimento', inicio: '08:00', fim: '12:00' },
        { dia_semana: 2, tipo: 'descanso', inicio: '11:30', fim: '13:00' }
    ] }), null);
    assert.equal(controller.weeklyPayload({ intervalos: [
        { dia_semana: 7, tipo: 'atendimento', inicio: '08:00', fim: '12:00' }
    ] }), null);
    assert.equal(controller.weeklyPayload({ intervalos: [
        { dia_semana: 0, tipo: 'atendimento', inicio: '00:00', fim: '23:59' }
    ] }).length, 1);
    assert.equal(controller.weeklyPayload({ intervalos: [
        { dia_semana: 0, tipo: 'atendimento', inicio: '23:59', fim: '00:00' }
    ] }), null);
});

test('conversão respeita fuso da clínica e recusa horário DST inexistente ou ambíguo', () => {
    const saoPaulo = zonedLocalToUtc('2032-01-15T09:30', 'America/Sao_Paulo');
    assert.equal(saoPaulo.toISOString(), '2032-01-15T12:30:00.000Z');
    assert.equal(utcToLocal(saoPaulo, 'America/Sao_Paulo'), '2032-01-15T09:30');
    assert.equal(zonedLocalToUtc('2032-03-14T02:30', 'America/New_York'), null);
    assert.equal(zonedLocalToUtc('2032-11-07T01:30', 'America/New_York'), null);
    assert.equal(zonedLocalToUtc('2032-02-31T10:00', 'America/Sao_Paulo'), null);
});

test('atualização semanal usa tenant autenticado, preserva histórico e audita', async (t) => {
    const executions = [];
    const db = connection(async (sql, params) => {
        executions.push({ sql, params });
        if (/SELECT p\.id/.test(sql)) return [[{ id: 8, nome_exibicao: 'Profissional' }]];
        if (/SELECT timezone FROM clinicas/.test(sql)) return [[{ timezone: 'America/Sao_Paulo' }]];
        if (/FROM consultas/.test(sql)) return [[]];
        return [{ affectedRows: 1 }];
    });
    const commit = t.mock.method(db, 'commit');
    t.mock.method(pool, 'getConnection', async () => db);
    const res = response();
    await controller.replaceWeeklyAvailability({
        params: { professionalId: '8' }, userId: 4,
        tenant: { clinicId: 11, role: 'secretaria' },
        body: { clinica_id: 999, intervalos: [
            { dia_semana: 1, tipo: 'atendimento', inicio: '08:00', fim: '12:00' }
        ] }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(commit.mock.callCount(), 1);
    assert.ok(executions.some((item) => /SET status = 'inativo'/.test(item.sql)));
    assert.ok(executions.some((item) => /ON DUPLICATE KEY UPDATE status = 'ativo'/.test(item.sql)));
    assert.ok(executions.some((item) => /INSERT INTO auditoria/.test(item.sql)));
    assert.equal(executions.some((item) => item.params?.includes(999)), false);
});

test('falha parcial da grade semanal realiza rollback', async (t) => {
    t.mock.method(console, 'error', () => {});
    const db = connection(async (sql) => {
        if (/SELECT p\.id/.test(sql)) return [[{ id: 8 }]];
        if (/SELECT timezone FROM clinicas/.test(sql)) return [[{ timezone: 'America/Sao_Paulo' }]];
        if (/FROM consultas/.test(sql)) return [[]];
        if (/INSERT INTO disponibilidades_profissional/.test(sql)) throw Object.assign(new Error('falha'), { code: 'ER_TEST' });
        return [{ affectedRows: 1 }];
    });
    const rollback = t.mock.method(db, 'rollback');
    const commit = t.mock.method(db, 'commit');
    t.mock.method(pool, 'getConnection', async () => db);
    const res = response();
    await controller.replaceWeeklyAvailability({
        params: { professionalId: '8' }, userId: 4,
        tenant: { clinicId: 11, role: 'administrador' },
        body: { intervalos: [{ dia_semana: 1, tipo: 'atendimento', inicio: '08:00', fim: '12:00' }] }
    }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(rollback.mock.callCount(), 1);
    assert.equal(commit.mock.callCount(), 0);
});

test('bloqueio sobreposto é recusado dentro da transação e do tenant', async (t) => {
    const executions = [];
    const db = connection(async (sql, params) => {
        executions.push({ sql, params });
        if (/SELECT p\.id/.test(sql)) return [[{ id: 8 }]];
        if (/SELECT timezone FROM clinicas/.test(sql)) return [[{ timezone: 'America/Sao_Paulo' }]];
        if (/FROM bloqueios_profissional/.test(sql)) return [[{ id: 50 }]];
        return [{ affectedRows: 1 }];
    });
    const rollback = t.mock.method(db, 'rollback');
    t.mock.method(pool, 'getConnection', async () => db);
    const res = response();
    await controller.createBlock({
        params: { professionalId: '8' }, userId: 4,
        tenant: { clinicId: 11, role: 'secretaria' },
        body: { tipo: 'ferias', inicio_local: '2032-01-10T08:00', fim_local: '2032-01-20T18:00' }
    }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(rollback.mock.callCount(), 1);
    const overlap = executions.find((item) => /FROM bloqueios_profissional/.test(item.sql));
    assert.match(overlap.sql, /clinica_id = \?/);
    assert.deepEqual(overlap.params.slice(0, 2), [11, 8]);
    assert.equal(executions.some((item) => /INSERT INTO bloqueios_profissional/.test(item.sql)), false);
});

test('bloqueio válido converte o fuso, usa tenant do token e registra auditoria', async (t) => {
    const executions = [];
    const db = connection(async (sql, params) => {
        executions.push({ sql, params });
        if (/SELECT p\.id/.test(sql)) return [[{ id: 8 }]];
        if (/SELECT timezone FROM clinicas/.test(sql)) return [[{ timezone: 'America/Manaus' }]];
        if (/SELECT id FROM bloqueios_profissional/.test(sql)) return [[]];
        if (/SELECT id FROM consultas/.test(sql)) return [[]];
        if (/INSERT INTO bloqueios_profissional/.test(sql)) return [{ insertId: 52 }];
        return [{ affectedRows: 1 }];
    });
    const commit = t.mock.method(db, 'commit');
    t.mock.method(pool, 'getConnection', async () => db);
    const res = response();
    await controller.createBlock({
        params: { professionalId: '8' }, userId: 4,
        tenant: { clinicId: 11, role: 'administrador' },
        body: {
            clinica_id: 999, tipo: 'feriado',
            inicio_local: '2032-06-15T08:00', fim_local: '2032-06-15T18:00',
            motivo: 'Feriado local'
        }
    }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.id, 52);
    assert.equal(commit.mock.callCount(), 1);
    const insert = executions.find((item) => /INSERT INTO bloqueios_profissional/.test(item.sql));
    assert.deepEqual(insert.params, [
        11, 8, 'feriado', '2032-06-15 12:00:00.000', '2032-06-15 22:00:00.000',
        'Feriado local', 4
    ]);
    assert.equal(executions.some((item) => item.params?.includes(999)), false);
    assert.ok(executions.some((item) => /INSERT INTO auditoria/.test(item.sql)));
});

test('bloqueio que cruza consulta ativa é recusado sem cancelar a reserva', async (t) => {
    const db = connection(async (sql) => {
        if (/SELECT p\.id/.test(sql)) return [[{ id: 8 }]];
        if (/SELECT timezone FROM clinicas/.test(sql)) return [[{ timezone: 'America/Sao_Paulo' }]];
        if (/FROM bloqueios_profissional/.test(sql)) return [[]];
        if (/FROM consultas/.test(sql)) return [[{ id: 77 }]];
        throw new Error('nenhuma escrita deveria ocorrer');
    });
    const rollback = t.mock.method(db, 'rollback');
    t.mock.method(pool, 'getConnection', async () => db);
    const res = response();
    await controller.createBlock({
        params: { professionalId: '8' }, userId: 4,
        tenant: { clinicId: 11, role: 'secretaria' },
        body: {
            tipo: 'indisponibilidade', inicio_local: '2032-06-15T08:00',
            fim_local: '2032-06-15T18:00'
        }
    }, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /consulta ativa/);
    assert.equal(rollback.mock.callCount(), 1);
});

test('grade incompatível com consulta futura é recusada antes de desativar intervalos', async (t) => {
    const executions = [];
    const db = connection(async (sql) => {
        executions.push(sql);
        if (/SELECT p\.id/.test(sql)) return [[{ id: 8 }]];
        if (/SELECT timezone FROM clinicas/.test(sql)) return [[{ timezone: 'America/Sao_Paulo' }]];
        if (/FROM consultas/.test(sql)) return [[{
            id: 77, inicio_em: '2032-01-05 12:00:00.000', fim_em: '2032-01-05 12:30:00.000'
        }]];
        throw new Error('nenhuma escrita deveria ocorrer');
    });
    t.mock.method(pool, 'getConnection', async () => db);
    const res = response();
    await controller.replaceWeeklyAvailability({
        params: { professionalId: '8' }, userId: 4,
        tenant: { clinicId: 11, role: 'administrador' },
        body: { intervalos: [
            { dia_semana: 1, tipo: 'atendimento', inicio: '13:00', fim: '17:00' }
        ] }
    }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(executions.some((sql) => /UPDATE disponibilidades_profissional/.test(sql)), false);
});

test('consulta exige identidade, vínculo e perfil ativos da mesma clínica', async (t) => {
    const executions = [];
    t.mock.method(pool, 'execute', async (sql, params) => {
        executions.push({ sql, params });
        if (/SELECT p\.id, p\.nome_exibicao/.test(sql)) {
            assert.match(sql, /JOIN clinica_usuarios cu/);
            assert.match(sql, /cu\.papel = 'profissional'/);
            assert.match(sql, /cu\.status = 'ativo'/);
            assert.match(sql, /JOIN usuarios u ON u\.id = p\.usuario_id AND u\.status = 'ativo'/);
            assert.match(sql, /p\.clinica_id = \?/);
            assert.match(sql, /p\.status = 'ativo'/);
            assert.deepEqual(params, [11, 8, 'profissional', 70, 0]);
            return [[{ id: 8, nome_exibicao: 'Profissional' }]];
        }
        if (/FROM disponibilidades_profissional/.test(sql)) return [[]];
        if (/FROM bloqueios_profissional/.test(sql)) return [[]];
        if (/SELECT timezone FROM clinicas/.test(sql)) return [[{ timezone: 'America/Sao_Paulo' }]];
        throw new Error('SQL inesperado');
    });
    const res = response();
    await controller.getProfessionalAvailability({
        params: { professionalId: '8' }, userId: 70,
        tenant: { clinicId: 11, role: 'profissional' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(executions.length, 4);
});

test('consulta inativa encerra antes de ler horários ou bloqueios', async (t) => {
    const execute = t.mock.method(pool, 'execute', async (sql) => {
        assert.match(sql, /JOIN clinica_usuarios cu/);
        return [[]];
    });
    const res = response();
    await controller.getProfessionalAvailability({
        params: { professionalId: '8' }, userId: 4,
        tenant: { clinicId: 11, role: 'administrador' }
    }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(execute.mock.callCount(), 1);
});

test('profissional só alcança o próprio perfil e paciente não acessa as rotas', () => {
    for (const path of [
        '/disponibilidade/contexto',
        '/disponibilidade/profissionais/:professionalId',
        '/disponibilidade/profissionais/:professionalId/semana',
        '/disponibilidade/profissionais/:professionalId/bloqueios',
        '/disponibilidade/profissionais/:professionalId/bloqueios/:blockId/cancelar'
    ]) {
        const route = router.stack.find((layer) => layer.route?.path === path);
        assert.ok(route, `rota ausente: ${path}`);
        const authorization = route.route.stack[0].handle;
        for (const role of ['administrador', 'secretaria', 'profissional']) {
            let called = false;
            authorization({ tenant: { role } }, response(), () => { called = true; });
            assert.equal(called, true);
        }
        const denied = response();
        authorization({ tenant: { role: 'paciente' } }, denied, () => {});
        assert.equal(denied.statusCode, 403);
    }
});
