const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

Object.assign(process.env, {
    DB_HOST: '127.0.0.1', DB_USER: 'fixture_user', DB_PASSWORD: 'fixture_password',
    DB_DATABASE: 'fixture_database', PORT: '3000', JWT_SECRET: randomBytes(32).toString('hex')
});

const pool = require('../config/database');
const controller = require('../controllers/consultaController');
const router = require('../routes');
const {
    assertAppointmentDisposableDatabaseName,
    confirmAppointmentTestEnvironment
} = require('../support/mysql-test-safety');

function response() {
    return {
        statusCode: null, body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

function transaction(t, handler) {
    return {
        beginTransaction: t.mock.fn(async () => {}),
        commit: t.mock.fn(async () => {}),
        rollback: t.mock.fn(async () => {}),
        release: t.mock.fn(),
        execute: t.mock.fn(handler)
    };
}

test('proteção destrutiva aceita somente banco descartável exclusivo de agendamento', () => {
    assert.equal(
        assertAppointmentDisposableDatabaseName('vitalis_agendamento_m4_test'),
        'vitalis_agendamento_m4_test'
    );
    for (const name of ['vitalis_m3_validacao', 'vitalis_dev', 'vitalis_agendamento', 'vitalis_agendamento_test_backup']) {
        assert.throws(() => assertAppointmentDisposableDatabaseName(name));
    }
});

test('integração confirma banco selecionado e MySQL 8 antes de qualquer limpeza', async () => {
    const calls = [];
    const environment = await confirmAppointmentTestEnvironment({
        query: async (sql) => {
            calls.push(sql);
            if (/DATABASE/.test(sql)) return [[{ database_name: 'vitalis_agendamento_m4_test' }]];
            return [[{ version: '8.0.46' }]];
        }
    }, 'vitalis_agendamento_m4_test');
    assert.equal(environment.database, 'vitalis_agendamento_m4_test');
    assert.deepEqual(calls, ['SELECT DATABASE() AS database_name', 'SELECT VERSION() AS version']);
});

test('fixture MySQL usa somente colunas existentes na disponibilidade da migration 007', async () => {
    const integration = await fs.readFile(
        path.join(__dirname, 'appointment-management.integration.test.js'), 'utf8'
    );
    const insert = integration.match(/INSERT INTO disponibilidades_profissional[\s\S]*?\)`,/)[0];
    assert.doesNotMatch(insert, /criado_por_usuario_id/);
    assert.match(insert, /clinica_id, profissional_id, dia_semana, tipo, inicio_local, fim_local, status/);
});

test('período usa fuso da clínica e limita duração', () => {
    const period = controller.appointmentPeriod({
        inicio_local: '2032-01-05T09:00', duracao_minutos: 45
    }, 'America/Sao_Paulo', new Date('2031-01-01T00:00:00Z'));
    assert.equal(period.start.toISOString(), '2032-01-05T12:00:00.000Z');
    assert.equal(period.end.toISOString(), '2032-01-05T12:45:00.000Z');
    assert.equal(controller.appointmentPeriod({
        inicio_local: '2032-01-05T09:00', duracao_minutos: 10
    }, 'America/Sao_Paulo', new Date('2031-01-01T00:00:00Z')), null);
});

test('grade aceita atendimento, recusa descanso e sobreposição parcial', () => {
    const intervals = [
        { tipo: 'atendimento', inicio: '08:00', fim: '12:00' },
        { tipo: 'descanso', inicio: '10:00', fim: '10:30' }
    ];
    assert.equal(controller.periodFitsWeekly(intervals, { startMinute: 540, endMinute: 570 }), true);
    assert.equal(controller.periodFitsWeekly(intervals, { startMinute: 585, endMinute: 615 }), false);
    assert.equal(controller.periodFitsWeekly(intervals, { startMinute: 705, endMinute: 735 }), false);
});

test('matriz de estados é explícita e terminal', () => {
    assert.equal(controller.canTransition('agendada', 'confirmada'), true);
    assert.equal(controller.canTransition('confirmada', 'realizada'), true);
    assert.equal(controller.canTransition('cancelada', 'agendada'), false);
    assert.equal(controller.canTransition('realizada', 'cancelada'), false);
    assert.equal(controller.canTransition('agendada', 'invalida'), false);
});

test('limites temporais impedem realização e falta antes do atendimento', () => {
    const appointment = {
        inicio_em: '2032-01-05T12:00:00.000Z', fim_em: '2032-01-05T12:30:00.000Z'
    };
    assert.equal(controller.transitionAllowedAt(appointment, 'realizada', new Date('2032-01-05T11:59:59Z')), false);
    assert.equal(controller.transitionAllowedAt(appointment, 'realizada', new Date('2032-01-05T12:00:00Z')), true);
    assert.equal(controller.transitionAllowedAt(appointment, 'nao_compareceu', new Date('2032-01-05T12:29:59Z')), false);
    assert.equal(controller.transitionAllowedAt(appointment, 'nao_compareceu', new Date('2032-01-05T12:30:00Z')), true);
    assert.equal(controller.transitionAllowedAt(appointment, 'confirmada', new Date('2032-01-05T12:29:59Z')), true);
    assert.equal(controller.transitionAllowedAt(appointment, 'cancelada', new Date('2032-01-05T12:30:00Z')), false);
});

test('secretaria agenda no tenant autenticado com transação, histórico e auditoria', async (t) => {
    let insertParams;
    const connection = transaction(t, async (sql, params) => {
        if (/SELECT cu\.papel/.test(sql)) return [[{ papel: 'secretaria' }]];
        if (/SELECT id, timezone FROM clinicas/.test(sql)) return [[{ id: 11, timezone: 'America/Sao_Paulo' }]];
        if (/SELECT p\.id, p\.nome_exibicao/.test(sql)) return [[{ id: 8, especialidade_id: 5 }]];
        if (/SELECT id, nome FROM pacientes/.test(sql)) return [[{ id: 44, nome: 'Paciente Sintético' }]];
        if (/FROM disponibilidades_profissional/.test(sql)) {
            return [[{ tipo: 'atendimento', inicio: '08:00', fim: '12:00' }]];
        }
        if (/FROM bloqueios_profissional/.test(sql) || /SELECT id FROM consultas/.test(sql)) return [[]];
        if (/INSERT INTO consultas \(/.test(sql)) { insertParams = params; return [{ insertId: 123 }]; }
        if (/INSERT INTO consultas_historico/.test(sql) || /INSERT INTO auditoria/.test(sql)) return [{ insertId: 1 }];
        throw new Error(`SQL inesperado: ${sql}`);
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await controller.agendarConsulta({
        userId: 7, tenant: { clinicId: 11, role: 'secretaria' },
        body: {
            clinica_id: 99, paciente_id: 44, profissional_id: 8, especialidade_id: 5,
            inicio_local: '2032-01-05T09:00', duracao_minutos: 30
        }
    }, res);
    assert.equal(res.statusCode, 201);
    assert.deepEqual(insertParams.slice(0, 4), [11, 44, 8, 5]);
    assert.deepEqual(insertParams.slice(4, 6), [
        '2032-01-05 12:00:00.000', '2032-01-05 12:30:00.000'
    ]);
    assert.equal(connection.commit.mock.callCount(), 1);
    assert.equal(connection.rollback.mock.callCount(), 0);
    assert.equal(connection.execute.mock.calls.some((call) => /consultas_historico/.test(call.arguments[0])), true);
    assert.equal(connection.execute.mock.calls.some((call) => /INSERT INTO auditoria/.test(call.arguments[0])), true);
});

test('paciente ou profissional inativo encerra a transação sem inserir', async (t) => {
    const connection = transaction(t, async (sql) => {
        if (/SELECT cu\.papel/.test(sql)) return [[{ papel: 'secretaria' }]];
        if (/SELECT id, timezone FROM clinicas/.test(sql)) return [[{ id: 11, timezone: 'America/Sao_Paulo' }]];
        if (/SELECT p\.id, p\.nome_exibicao/.test(sql)) return [[]];
        if (/SELECT id, nome FROM pacientes/.test(sql)) return [[{ id: 44 }]];
        throw new Error('nenhuma escrita deveria ocorrer');
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await controller.agendarConsulta({
        userId: 7, tenant: { clinicId: 11, role: 'secretaria' },
        body: { paciente_id: 44, profissional_id: 8, especialidade_id: 5, inicio_local: '2032-01-05T09:00', duracao_minutos: 30 }
    }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(connection.rollback.mock.callCount(), 1);
    assert.equal(connection.execute.mock.calls.some((call) => /INSERT INTO consultas \(/.test(call.arguments[0])), false);
});

test('falha na auditoria desfaz consulta e histórico parciais', async (t) => {
    const connection = transaction(t, async (sql) => {
        if (/SELECT cu\.papel/.test(sql)) return [[{ papel: 'administrador' }]];
        if (/SELECT id, timezone FROM clinicas/.test(sql)) return [[{ id: 11, timezone: 'America/Sao_Paulo' }]];
        if (/SELECT p\.id, p\.nome_exibicao/.test(sql)) return [[{ id: 8, especialidade_id: 5 }]];
        if (/SELECT id, nome FROM pacientes/.test(sql)) return [[{ id: 44 }]];
        if (/FROM disponibilidades_profissional/.test(sql)) return [[{ tipo: 'atendimento', inicio: '08:00', fim: '12:00' }]];
        if (/FROM bloqueios_profissional/.test(sql) || /SELECT id FROM consultas/.test(sql)) return [[]];
        if (/INSERT INTO consultas \(/.test(sql)) return [{ insertId: 123 }];
        if (/INSERT INTO consultas_historico/.test(sql)) return [{ insertId: 1 }];
        if (/INSERT INTO auditoria/.test(sql)) throw Object.assign(new Error('falha sintética'), { code: 'ER_TEST' });
        throw new Error('SQL inesperado');
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await controller.agendarConsulta({
        userId: 7, tenant: { clinicId: 11, role: 'administrador' },
        body: { paciente_id: 44, profissional_id: 8, especialidade_id: 5, inicio_local: '2032-01-05T09:00', duracao_minutos: 30 }
    }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(connection.rollback.mock.callCount(), 1);
    assert.equal(connection.commit.mock.callCount(), 0);
});

test('cancelamento autorizado é transacional, versionado e preserva histórico', async (t) => {
    const connection = transaction(t, async (sql) => {
        if (/SELECT cu\.papel/.test(sql)) return [[{ papel: 'secretaria' }]];
        if (/FROM consultas c/.test(sql)) return [[{
            id: 123, paciente_id: 44, profissional_id: 8, especialidade_id: 5,
            inicio_em: '2032-01-05 12:00:00.000', fim_em: '2032-01-05 12:30:00.000',
            status: 'agendada', versao: 1, profissional_usuario_id: 90, paciente_usuario_id: 91
        }]];
        if (/UPDATE consultas SET status/.test(sql)) return [{ affectedRows: 1 }];
        if (/confirmacoes_consulta/.test(sql)) return [{ affectedRows: 0 }];
        if (/INSERT INTO consultas_historico/.test(sql) || /INSERT INTO auditoria/.test(sql)) return [{ insertId: 1 }];
        throw new Error(`SQL inesperado: ${sql}`);
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await controller.cancelarConsulta({
        userId: 7, tenant: { clinicId: 11, role: 'secretaria' }, params: { id: '123' },
        body: { versao: 1 }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(connection.commit.mock.callCount(), 1);
    assert.equal(connection.execute.mock.calls.some((call) => /consultas_historico/.test(call.arguments[0])), true);
    assert.equal(connection.execute.mock.calls.some((call) => /UPDATE confirmacoes_consulta/.test(call.arguments[0])), true);
    const update = connection.execute.mock.calls.find((call) => /UPDATE consultas SET status/.test(call.arguments[0]));
    assert.deepEqual(update.arguments[1], ['cancelada', 2, 11, 123, 1]);
});

test('reagendamento revalida profissional e disponibilidade antes de atualizar', async (t) => {
    const connection = transaction(t, async (sql) => {
        if (/SELECT cu\.papel/.test(sql)) return [[{ papel: 'administrador' }]];
        if (/SELECT id, timezone FROM clinicas/.test(sql)) return [[{ id: 11, timezone: 'America/Sao_Paulo' }]];
        if (/SELECT p\.id, p\.nome_exibicao/.test(sql)) return [[{ id: 8, especialidade_id: 5 }]];
        if (/FROM consultas c/.test(sql)) return [[{
            id: 123, paciente_id: 44, profissional_id: 8, especialidade_id: 5,
            inicio_em: '2032-01-05 12:00:00.000', fim_em: '2032-01-05 12:30:00.000',
            status: 'confirmada', versao: 2, profissional_usuario_id: 90, paciente_usuario_id: 91
        }]];
        if (/SELECT id, nome FROM pacientes/.test(sql)) return [[{ id: 44, nome: 'Paciente' }]];
        if (/FROM disponibilidades_profissional/.test(sql)) return [[{ tipo: 'atendimento', inicio: '08:00', fim: '12:00' }]];
        if (/FROM bloqueios_profissional/.test(sql) || /SELECT id FROM consultas/.test(sql)) return [[]];
        if (/UPDATE consultas SET profissional_id/.test(sql)) return [{ affectedRows: 1 }];
        if (/confirmacoes_consulta/.test(sql)) return [{ affectedRows: 0 }];
        if (/INSERT INTO consultas_historico/.test(sql) || /INSERT INTO auditoria/.test(sql)) return [{ insertId: 1 }];
        throw new Error(`SQL inesperado: ${sql}`);
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await controller.reschedule({
        userId: 7, tenant: { clinicId: 11, role: 'administrador' }, params: { id: '123' },
        body: {
            paciente_id: 44, profissional_id: 8, especialidade_id: 5,
            inicio_local: '2032-01-05T10:00', duracao_minutos: 45, versao: 2
        }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(connection.commit.mock.callCount(), 1);
    const calls = connection.execute.mock.calls.map((call) => call.arguments[0]);
    assert.ok(calls.findIndex((sql) => /SELECT p\.id, p\.nome_exibicao/.test(sql))
        < calls.findIndex((sql) => /FROM consultas c/.test(sql)));
    assert.equal(calls.some((sql) => /consultas_historico/.test(sql)), true);
    assert.equal(calls.some((sql) => /UPDATE confirmacoes_consulta/.test(sql)), true);
});

test('ID de paciente de outra clínica é recusado antes de inserir consulta', async (t) => {
    const connection = transaction(t, async (sql, params) => {
        if (/SELECT cu\.papel/.test(sql)) return [[{ papel: 'secretaria' }]];
        if (/SELECT id, timezone FROM clinicas/.test(sql)) return [[{ id: 11, timezone: 'America/Sao_Paulo' }]];
        if (/SELECT p\.id, p\.nome_exibicao/.test(sql)) return [[{ id: 8, especialidade_id: 5 }]];
        if (/SELECT id, nome FROM pacientes/.test(sql)) {
            assert.equal(params[0], 11);
            assert.equal(params.at(-1), 99);
            return [[]];
        }
        throw new Error('nenhuma escrita deveria ocorrer');
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await controller.agendarConsulta({
        userId: 7, tenant: { clinicId: 11, role: 'secretaria' },
        body: {
            paciente_id: 99, profissional_id: 8, especialidade_id: 5,
            inicio_local: '2032-01-05T09:00', duracao_minutos: 30
        }
    }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(connection.execute.mock.calls.some((call) => /INSERT INTO consultas \(/.test(call.arguments[0])), false);
});

test('alteração de status não alcança consulta de outra clínica', async (t) => {
    const connection = transaction(t, async (sql) => {
        if (/SELECT cu\.papel/.test(sql)) return [[{ papel: 'administrador' }]];
        if (/FROM consultas c/.test(sql)) return [[]];
        throw new Error('nenhuma atualização deveria ocorrer');
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await controller.updateStatusConsulta({
        userId: 7, tenant: { clinicId: 11, role: 'administrador' },
        params: { id: '99' }, body: { status: 'realizada', versao: 1 }
    }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(connection.execute.mock.calls.some((call) => /UPDATE consultas SET status/.test(call.arguments[0])), false);
});

test('paciente não cancela consulta de terceiro', async (t) => {
    const connection = transaction(t, async (sql) => {
        if (/SELECT cu\.papel/.test(sql)) return [[{ papel: 'paciente' }]];
        if (/FROM consultas c/.test(sql)) return [[{
            id: 123, paciente_id: 44, profissional_id: 8, especialidade_id: 5,
            inicio_em: '2032-01-05 12:00:00.000', fim_em: '2032-01-05 12:30:00.000',
            status: 'agendada', versao: 1, profissional_usuario_id: 90, paciente_usuario_id: 999
        }]];
        throw new Error('nenhuma atualização deveria ocorrer');
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await controller.cancelarConsulta({
        userId: 7, tenant: { clinicId: 11, role: 'paciente' },
        params: { id: '123' }, body: { versao: 1 }
    }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(connection.execute.mock.calls.some((call) => /UPDATE consultas SET status/.test(call.arguments[0])), false);
});

test('retorno antecipado aguarda rollback antes de liberar conexão', async (t) => {
    const order = [];
    const connection = transaction(t, async (sql) => {
        if (/SELECT cu\.papel/.test(sql)) return [[]];
        throw new Error('SQL inesperado');
    });
    connection.rollback = t.mock.fn(async () => {
        await new Promise((resolve) => setImmediate(resolve));
        order.push('rollback');
    });
    connection.release = t.mock.fn(() => order.push('release'));
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await controller.agendarConsulta({
        userId: 7, tenant: { clinicId: 11, role: 'secretaria' },
        body: {
            paciente_id: 44, profissional_id: 8, especialidade_id: 5,
            inicio_local: '2032-01-05T09:00', duracao_minutos: 30
        }
    }, res);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(order, ['rollback', 'release']);
});

test('versão desatualizada não sobrescreve alteração concorrente', async (t) => {
    const connection = transaction(t, async (sql) => {
        if (/SELECT cu\.papel/.test(sql)) return [[{ papel: 'secretaria' }]];
        if (/FROM consultas c/.test(sql)) return [[{
            id: 123, paciente_id: 44, profissional_id: 8, especialidade_id: 5,
            inicio_em: '2032-01-05 12:00:00.000', fim_em: '2032-01-05 12:30:00.000',
            status: 'agendada', versao: 2, profissional_usuario_id: 90, paciente_usuario_id: 91
        }]];
        throw new Error('nenhuma atualização deveria ocorrer');
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await controller.updateStatusConsulta({
        userId: 7, tenant: { clinicId: 11, role: 'secretaria' },
        params: { id: '123' }, body: { status: 'confirmada', versao: 1 }
    }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(connection.execute.mock.calls.some((call) => /UPDATE consultas SET status/.test(call.arguments[0])), false);
});

test('consulta futura não pode ser marcada como realizada pelo backend', async (t) => {
    const connection = transaction(t, async (sql) => {
        if (/SELECT cu\.papel/.test(sql)) return [[{ papel: 'profissional' }]];
        if (/FROM consultas c/.test(sql)) return [[{
            id: 123, paciente_id: 44, profissional_id: 8, especialidade_id: 5,
            inicio_em: '2999-01-05 12:00:00.000', fim_em: '2999-01-05 12:30:00.000',
            status: 'confirmada', versao: 1, profissional_usuario_id: 7,
            profissional_status: 'ativo', paciente_usuario_id: 91
        }]];
        if (/SELECT id, timezone FROM clinicas/.test(sql)) {
            return [[{ id: 11, timezone: 'America/Sao_Paulo' }]];
        }
        throw new Error('nenhuma atualização deveria ocorrer');
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await controller.concluirAtendimento({
        userId: 7, tenant: { clinicId: 11, role: 'profissional' },
        params: { id: '123' }, body: { versao: 1 }
    }, res);
    assert.equal(res.statusCode, 409);
});

test('médico ativo conclui a própria consulta com versão, histórico e auditoria', async (t) => {
    const connection = transaction(t, async (sql) => {
        if (/SELECT cu\.papel/.test(sql)) return [[{ papel: 'profissional' }]];
        if (/FROM consultas c/.test(sql)) return [[{
            id: 123, paciente_id: 44, profissional_id: 8, especialidade_id: 5,
            inicio_em: '2020-01-05 12:00:00.000', fim_em: '2020-01-05 12:30:00.000',
            status: 'confirmada', versao: 3, profissional_usuario_id: 7,
            profissional_status: 'ativo', paciente_usuario_id: 91
        }]];
        if (/SELECT id, timezone FROM clinicas/.test(sql)) {
            return [[{ id: 11, timezone: 'America/Sao_Paulo' }]];
        }
        if (/UPDATE consultas SET status/.test(sql)) return [{ affectedRows: 1 }];
        if (/confirmacoes_consulta/.test(sql)) return [{ affectedRows: 0 }];
        if (/INSERT INTO consultas_historico/.test(sql) || /INSERT INTO auditoria/.test(sql)) {
            return [{ insertId: 1 }];
        }
        throw new Error(`SQL inesperado: ${sql}`);
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await controller.concluirAtendimento({
        userId: 7, tenant: { clinicId: 11, role: 'profissional' },
        params: { id: '123' }, body: { versao: 3 }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(connection.commit.mock.callCount(), 1);
    const update = connection.execute.mock.calls.find((call) => /UPDATE consultas SET status/.test(call.arguments[0]));
    assert.deepEqual(update.arguments[1], ['realizada', 4, 11, 123, 3]);
    assert.equal(connection.execute.mock.calls.some((call) => /consultas_historico/.test(call.arguments[0])), true);
    assert.equal(connection.execute.mock.calls.some((call) => /INSERT INTO auditoria/.test(call.arguments[0])), true);
});

test('conclusão médica recusa clínica inativa dentro da transação', async (t) => {
    const connection = transaction(t, async (sql) => {
        if (/SELECT cu\.papel/.test(sql)) return [[{ papel: 'profissional' }]];
        if (/FROM consultas c/.test(sql)) return [[{
            id: 123, paciente_id: 44, profissional_id: 8, especialidade_id: 5,
            inicio_em: '2020-01-05 12:00:00.000', fim_em: '2020-01-05 12:30:00.000',
            status: 'confirmada', versao: 1, profissional_usuario_id: 7,
            profissional_status: 'ativo', paciente_usuario_id: 91
        }]];
        if (/SELECT id, timezone FROM clinicas/.test(sql)) return [[]];
        throw new Error('nenhuma atualização deveria ocorrer');
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await controller.concluirAtendimento({
        userId: 7, tenant: { clinicId: 11, role: 'profissional' },
        params: { id: '123' }, body: { versao: 1 }
    }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(connection.rollback.mock.callCount(), 1);
    assert.equal(connection.execute.mock.calls.some((call) => /UPDATE consultas SET status/.test(call.arguments[0])), false);
});

test('sessões independentes de médico e secretaria observam a conclusão atualizada', async (t) => {
    const state = {
        id: 123, paciente_id: 44, profissional_id: 8, especialidade_id: 5,
        inicio_em: '2020-01-05 12:00:00.000', fim_em: '2020-01-05 12:30:00.000',
        status: 'confirmada', versao: 1, profissional_usuario_id: 7,
        profissional_status: 'ativo', paciente_usuario_id: 91
    };
    const connection = transaction(t, async (sql, params) => {
        if (/SELECT cu\.papel/.test(sql)) return [[{ papel: 'profissional' }]];
        if (/FROM consultas c/.test(sql)) return [[{ ...state }]];
        if (/SELECT id, timezone FROM clinicas/.test(sql)) {
            return [[{ id: 11, timezone: 'America/Sao_Paulo' }]];
        }
        if (/UPDATE consultas SET status/.test(sql)) {
            state.status = params[0]; state.versao = params[1]; return [{ affectedRows: 1 }];
        }
        if (/confirmacoes_consulta/.test(sql)) return [{ affectedRows: 0 }];
        if (/INSERT INTO consultas_historico/.test(sql) || /INSERT INTO auditoria/.test(sql)) return [{ insertId: 1 }];
        throw new Error(`SQL inesperado: ${sql}`);
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    t.mock.method(pool, 'execute', async (sql) => {
        assert.match(sql, /JOIN clinica_usuarios actor/);
        return [[{
            ...state, nome_paciente: 'Paciente', nome_profissional: 'Profissional',
            nome_especialidade: 'Clínica Geral', pode_concluir: 1
        }]];
    });
    const doctor = response();
    await controller.concluirAtendimento({
        userId: 7, tenant: { clinicId: 11, role: 'profissional' },
        params: { id: '123' }, body: { versao: 1 }
    }, doctor);
    assert.equal(doctor.statusCode, 200);
    const secretary = response();
    await controller.getMinhaAgenda({
        userId: 8, tenant: { clinicId: 11, role: 'secretaria' }
    }, secretary);
    assert.equal(secretary.statusCode, 200);
    assert.equal(secretary.body[0].status, 'realizada');
    assert.equal(secretary.body[0].versao, 2);
});

test('secretaria não consegue forçar realização pela API', async (t) => {
    const connection = transaction(t, async (sql) => {
        if (/SELECT cu\.papel/.test(sql)) return [[{ papel: 'secretaria' }]];
        if (/FROM consultas c/.test(sql)) return [[{
            id: 123, paciente_id: 44, profissional_id: 8, especialidade_id: 5,
            inicio_em: '2020-01-05 12:00:00.000', fim_em: '2020-01-05 12:30:00.000',
            status: 'confirmada', versao: 1, profissional_usuario_id: 90,
            profissional_status: 'ativo', paciente_usuario_id: 91
        }]];
        throw new Error('nenhuma atualização deveria ocorrer');
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await controller.updateStatusConsulta({
        userId: 7, tenant: { clinicId: 11, role: 'secretaria' },
        params: { id: '123' }, body: { status: 'realizada', versao: 1 }
    }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(connection.execute.mock.calls.some((call) => /UPDATE consultas SET status/.test(call.arguments[0])), false);
});

test('médico não conclui consulta de outro profissional e versão antiga é recusada', async (t) => {
    for (const scenario of [
        { professionalUser: 99, version: 1, expected: 404 },
        { professionalUser: 7, version: 2, expected: 409 }
    ]) {
        const connection = transaction(t, async (sql) => {
            if (/SELECT cu\.papel/.test(sql)) return [[{ papel: 'profissional' }]];
            if (/FROM consultas c/.test(sql)) return [[{
                id: 123, paciente_id: 44, profissional_id: 8, especialidade_id: 5,
                inicio_em: '2020-01-05 12:00:00.000', fim_em: '2020-01-05 12:30:00.000',
                status: 'confirmada', versao: 1, profissional_usuario_id: scenario.professionalUser,
                profissional_status: 'ativo', paciente_usuario_id: 91
            }]];
            throw new Error('nenhuma atualização deveria ocorrer');
        });
        t.mock.method(pool, 'getConnection', async () => connection);
        const res = response();
        await controller.concluirAtendimento({
            userId: 7, tenant: { clinicId: 11, role: 'profissional' },
            params: { id: '123' }, body: { versao: scenario.version }
        }, res);
        assert.equal(res.statusCode, scenario.expected);
        assert.equal(connection.execute.mock.calls.some((call) => /UPDATE consultas SET status/.test(call.arguments[0])), false);
        t.mock.restoreAll();
    }
});

test('rota de conclusão aceita somente profissional e status genérico exclui profissional', () => {
    const conclude = router.stack.find((layer) => layer.route?.path === '/consultas/:id/concluir');
    const status = router.stack.find((layer) => layer.route?.path === '/consultas/:id/status');
    assert.ok(conclude); assert.ok(status);
    for (const role of ['administrador', 'secretaria', 'paciente']) {
        const res = response(); let next = false;
        conclude.route.stack[0].handle({ tenant: { role } }, res, () => { next = true; });
        assert.equal(res.statusCode, 403); assert.equal(next, false);
    }
    const res = response(); let next = false;
    status.route.stack[0].handle({ tenant: { role: 'profissional' } }, res, () => { next = true; });
    assert.equal(res.statusCode, 403); assert.equal(next, false);
});

test('reagendamento rejeita troca de paciente e paciente original inativo', async (t) => {
    const baseAppointment = {
        id: 123, paciente_id: 44, profissional_id: 8, especialidade_id: 5,
        inicio_em: '2032-01-05 12:00:00.000', fim_em: '2032-01-05 12:30:00.000',
        status: 'agendada', versao: 1, profissional_usuario_id: 90, paciente_usuario_id: 91
    };
    for (const requestedPatient of [99, 44]) {
        const connection = transaction(t, async (sql) => {
            if (/SELECT cu\.papel/.test(sql)) return [[{ papel: 'administrador' }]];
            if (/SELECT id, timezone FROM clinicas/.test(sql)) return [[{ id: 11, timezone: 'America/Sao_Paulo' }]];
            if (/SELECT p\.id, p\.nome_exibicao/.test(sql)) return [[{ id: 8, especialidade_id: 5 }]];
            if (/FROM consultas c/.test(sql)) return [[baseAppointment]];
            if (/SELECT id, nome FROM pacientes/.test(sql)) return [[]];
            throw new Error('nenhuma atualização deveria ocorrer');
        });
        t.mock.method(pool, 'getConnection', async () => connection);
        const res = response();
        await controller.reschedule({
            userId: 7, tenant: { clinicId: 11, role: 'administrador' }, params: { id: '123' },
            body: {
                paciente_id: requestedPatient, profissional_id: 8, especialidade_id: 5,
                inicio_local: '2032-01-05T10:00', duracao_minutos: 30, versao: 1
            }
        }, res);
        assert.equal(res.statusCode, 409);
        assert.equal(connection.execute.mock.calls.some((call) => /UPDATE consultas SET profissional_id/.test(call.arguments[0])), false);
        t.mock.restoreAll();
    }
});

test('rotas de gestão não permitem paciente nem profissional', () => {
    for (const routePath of ['/consultas/gestao', '/consultas/:id/reagendar']) {
        const route = router.stack.find((layer) => layer.route?.path === routePath);
        assert.ok(route);
        for (const role of ['paciente', 'profissional']) {
            const res = response(); let next = false;
            route.route.stack[0].handle({ tenant: { role } }, res, () => { next = true; });
            assert.equal(res.statusCode, 403); assert.equal(next, false);
        }
    }
});

test('controller serializa pelo profissional antes de verificar sobreposição', async () => {
    const source = await fs.readFile(path.join(__dirname, '..', 'controllers', 'consultaController.js'), 'utf8');
    const create = source.slice(source.indexOf('exports.agendarConsulta'), source.indexOf('exports.listForManagement'));
    assert.ok(create.indexOf('activeProfessional(') < create.indexOf('validateReservation('));
    assert.match(source, /LIMIT 1 \$\{lock \? 'FOR UPDATE' : ''\}/);
    assert.match(source, /inicio_em < \? AND fim_em > \?/);
    assert.doesNotMatch(source, /console\.error\([^\n]*error\)/);
});
