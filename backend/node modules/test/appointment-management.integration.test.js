const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { test } = require('node:test');
const mysql = require('mysql2/promise');
const { loadDatabaseConfig } = require('../scripts/db/config');
const { runMigrations } = require('../scripts/db/migrator');
const {
    assertAppointmentDisposableDatabaseName,
    confirmAppointmentTestEnvironment
} = require('../support/mysql-test-safety');

const enabled = process.env.APPOINTMENT_INTEGRATION_TEST === '1';
const migrationsDir = path.join(__dirname, '..', '..', 'database', 'migrations');

function response() {
    return {
        statusCode: null, body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

async function resetSchema(connection, database) {
    await confirmAppointmentTestEnvironment(connection, database);
    const tables = [
        'auditoria_plataforma', 'convites_clinica', 'bloqueios_profissional',
        'disponibilidades_profissional', 'auditoria', 'documentos_clinicos',
        'consultas_historico', 'consultas', 'pacientes', 'profissional_especialidades',
        'profissionais', 'especialidades', 'clinica_usuarios', 'operadores_plataforma',
        'usuarios', 'clinicas', 'schema_migrations'
    ];
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        for (const table of tables) await connection.query(`DROP TABLE IF EXISTS \`${table}\``);
    } finally {
        await connection.query('SET FOREIGN_KEY_CHECKS = 1');
    }
}

test('MySQL 8 valida concorrência, transições, rollback e isolamento da agenda', {
    skip: !enabled
}, async () => {
    const config = loadDatabaseConfig(process.env, 'TEST_DB_');
    assertAppointmentDisposableDatabaseName(config.database);
    Object.assign(process.env, {
        DB_HOST: config.host, DB_PORT: String(config.port), DB_USER: config.user,
        DB_PASSWORD: config.password, DB_DATABASE: config.database,
        JWT_SECRET: randomBytes(32).toString('hex')
    });
    const setup = await mysql.createConnection({ ...config, multipleStatements: true });
    let pool;
    try {
        await resetSchema(setup, config.database);
        await runMigrations({ connection: setup, migrationsDir, logger: { info() {} } });

        const [clinics] = await setup.execute(`INSERT INTO clinicas (nome, slug, timezone, status) VALUES
            ('Aurora Agenda Teste', 'aurora-agenda-test', 'America/Sao_Paulo', 'ativa'),
            ('Horizonte Agenda Teste', 'horizonte-agenda-test', 'America/Sao_Paulo', 'ativa')`);
        const auroraId = Number(clinics.insertId); const horizonteId = auroraId + 1;
        const hash = '$2b$10$fixturefixturefixturefixturefixturefixturefixturefixture';
        const [users] = await setup.execute(`INSERT INTO usuarios
            (nome, email, senha_hash, status, motivo_bloqueio) VALUES
            ('Secretaria Aurora', 'agenda.secretaria.aurora@example.test', ?, 'ativo', 'nenhum'),
            ('Profissional Aurora', 'agenda.profissional.aurora@example.test', ?, 'ativo', 'nenhum'),
            ('Paciente Aurora', 'agenda.paciente.aurora@example.test', ?, 'ativo', 'nenhum'),
            ('Secretaria Horizonte', 'agenda.secretaria.horizonte@example.test', ?, 'ativo', 'nenhum'),
            ('Profissional Horizonte', 'agenda.profissional.horizonte@example.test', ?, 'ativo', 'nenhum'),
            ('Paciente Horizonte', 'agenda.paciente.horizonte@example.test', ?, 'ativo', 'nenhum')`,
        [hash, hash, hash, hash, hash, hash]);
        const secretaryAurora = Number(users.insertId); const professionalAuroraUser = secretaryAurora + 1;
        const patientAuroraUser = secretaryAurora + 2; const secretaryHorizonte = secretaryAurora + 3;
        const professionalHorizonteUser = secretaryAurora + 4; const patientHorizonteUser = secretaryAurora + 5;
        await setup.execute(`INSERT INTO clinica_usuarios (clinica_id, usuario_id, papel, status) VALUES
            (?, ?, 'secretaria', 'ativo'), (?, ?, 'profissional', 'ativo'), (?, ?, 'paciente', 'ativo'),
            (?, ?, 'secretaria', 'ativo'), (?, ?, 'profissional', 'ativo'), (?, ?, 'paciente', 'ativo')`,
        [auroraId, secretaryAurora, auroraId, professionalAuroraUser, auroraId, patientAuroraUser,
            horizonteId, secretaryHorizonte, horizonteId, professionalHorizonteUser,
            horizonteId, patientHorizonteUser]);
        const [specialties] = await setup.execute(`INSERT INTO especialidades (clinica_id, nome, status) VALUES
            (?, 'Clínica Geral', 'ativa'), (?, 'Psicologia', 'ativa')`, [auroraId, horizonteId]);
        const auroraSpecialty = Number(specialties.insertId); const horizonteSpecialty = auroraSpecialty + 1;
        const [auroraProfessional] = await setup.execute(`INSERT INTO profissionais
            (clinica_id, usuario_id, nome_exibicao, tipo_profissional, status)
            VALUES (?, ?, 'Profissional Aurora', 'Médico', 'ativo')`, [auroraId, professionalAuroraUser]);
        const [horizonteProfessional] = await setup.execute(`INSERT INTO profissionais
            (clinica_id, usuario_id, nome_exibicao, tipo_profissional, status)
            VALUES (?, ?, 'Profissional Horizonte', 'Psicólogo', 'ativo')`, [horizonteId, professionalHorizonteUser]);
        const auroraProfessionalId = Number(auroraProfessional.insertId);
        const horizonteProfessionalId = Number(horizonteProfessional.insertId);
        await setup.execute(`INSERT INTO profissional_especialidades
            (clinica_id, profissional_id, especialidade_id) VALUES (?, ?, ?), (?, ?, ?)`,
        [auroraId, auroraProfessionalId, auroraSpecialty,
            horizonteId, horizonteProfessionalId, horizonteSpecialty]);
        const [auroraPatient] = await setup.execute(`INSERT INTO pacientes
            (clinica_id, usuario_id, nome, email, status) VALUES
            (?, ?, 'Paciente Aurora', 'agenda.paciente.aurora@example.test', 'ativo')`,
        [auroraId, patientAuroraUser]);
        const [horizontePatient] = await setup.execute(`INSERT INTO pacientes
            (clinica_id, usuario_id, nome, email, status) VALUES
            (?, ?, 'Paciente Horizonte', 'agenda.paciente.horizonte@example.test', 'ativo')`,
        [horizonteId, patientHorizonteUser]);
        const auroraPatientId = Number(auroraPatient.insertId);
        const horizontePatientId = Number(horizontePatient.insertId);
        await setup.execute(`INSERT INTO disponibilidades_profissional
            (clinica_id, profissional_id, dia_semana, tipo, inicio_local, fim_local, status)
            VALUES (?, ?, 1, 'atendimento', '08:00', '18:00', 'ativo')`,
        [auroraId, auroraProfessionalId]);

        pool = require('../config/database');
        const controller = require('../controllers/consultaController');
        const request = {
            userId: secretaryAurora, tenant: { clinicId: auroraId, role: 'secretaria' },
            body: {
                paciente_id: auroraPatientId, profissional_id: auroraProfessionalId,
                especialidade_id: auroraSpecialty, inicio_local: '2032-05-10T14:00',
                duracao_minutos: 30
            }
        };
        const first = response(); const second = response();
        await Promise.all([
            controller.agendarConsulta(request, first),
            controller.agendarConsulta({ ...request, body: { ...request.body } }, second)
        ]);
        assert.deepEqual([first.statusCode, second.statusCode].sort(), [201, 409]);
        const appointmentId = first.statusCode === 201 ? first.body.id : second.body.id;

        const partialOverlap = response();
        await controller.agendarConsulta({
            ...request, body: { ...request.body, inicio_local: '2032-05-10T13:45' }
        }, partialOverlap);
        assert.equal(partialOverlap.statusCode, 409);

        const crossTenant = response();
        await controller.agendarConsulta({
            ...request,
            body: { ...request.body, paciente_id: horizontePatientId, inicio_local: '2032-05-10T15:00' }
        }, crossTenant);
        assert.equal(crossTenant.statusCode, 404);

        const confirmed = response();
        await controller.updateStatusConsulta({
            userId: secretaryAurora, tenant: request.tenant,
            params: { id: String(appointmentId) }, body: { status: 'confirmada', versao: 1 }
        }, confirmed);
        assert.equal(confirmed.statusCode, 200);
        const stale = response();
        await controller.updateStatusConsulta({
            userId: secretaryAurora, tenant: request.tenant,
            params: { id: String(appointmentId) }, body: { status: 'cancelada', versao: 1 }
        }, stale);
        assert.equal(stale.statusCode, 409);
        const invalidTransition = response();
        await controller.updateStatusConsulta({
            userId: secretaryAurora, tenant: request.tenant,
            params: { id: String(appointmentId) }, body: { status: 'agendada', versao: 2 }
        }, invalidTransition);
        assert.equal(invalidTransition.statusCode, 400);

        await setup.execute('UPDATE pacientes SET status = \'inativo\' WHERE clinica_id = ? AND id = ?',
            [auroraId, auroraPatientId]);
        const inactivePatient = response();
        await controller.agendarConsulta({
            ...request, body: { ...request.body, inicio_local: '2032-05-10T15:00' }
        }, inactivePatient);
        assert.equal(inactivePatient.statusCode, 404);
        await setup.execute('UPDATE pacientes SET status = \'ativo\' WHERE clinica_id = ? AND id = ?',
            [auroraId, auroraPatientId]);

        const availabilityController = require('../controllers/disponibilidadeController');
        const conflictingBlock = response();
        await availabilityController.createBlock({
            userId: secretaryAurora, tenant: request.tenant,
            params: { professionalId: String(auroraProfessionalId) },
            body: {
                tipo: 'indisponibilidade', inicio_local: '2032-05-10T13:30',
                fim_local: '2032-05-10T14:30', motivo: 'Conflito sintético'
            }
        }, conflictingBlock);
        assert.equal(conflictingBlock.statusCode, 409);
        const incompatibleWeekly = response();
        await availabilityController.replaceWeeklyAvailability({
            userId: secretaryAurora, tenant: request.tenant,
            params: { professionalId: String(auroraProfessionalId) },
            body: { intervalos: [
                { dia_semana: 1, tipo: 'atendimento', inicio: '15:00', fim: '18:00' }
            ] }
        }, incompatibleWeekly);
        assert.equal(incompatibleWeekly.statusCode, 409);

        const forcedBySecretary = response();
        await controller.updateStatusConsulta({
            userId: secretaryAurora, tenant: request.tenant,
            params: { id: String(appointmentId) },
            body: { status: 'realizada', versao: 2 }
        }, forcedBySecretary);
        assert.equal(forcedBySecretary.statusCode, 403);

        const crossClinicDoctor = response();
        await controller.concluirAtendimento({
            userId: professionalHorizonteUser,
            tenant: { clinicId: horizonteId, role: 'profissional' },
            params: { id: String(appointmentId) }, body: { versao: 2 }
        }, crossClinicDoctor);
        assert.equal(crossClinicDoctor.statusCode, 404);

        await setup.execute(`UPDATE consultas
            SET inicio_em = '2020-05-10 17:00:00.000000', fim_em = '2020-05-10 17:30:00.000000'
            WHERE clinica_id = ? AND id = ?`, [auroraId, appointmentId]);
        const concludeFirst = response(); const concludeSecond = response();
        await Promise.all([
            controller.concluirAtendimento({
                userId: professionalAuroraUser,
                tenant: { clinicId: auroraId, role: 'profissional' },
                params: { id: String(appointmentId) }, body: { versao: 2 }
            }, concludeFirst),
            controller.concluirAtendimento({
                userId: professionalAuroraUser,
                tenant: { clinicId: auroraId, role: 'profissional' },
                params: { id: String(appointmentId) }, body: { versao: 2 }
            }, concludeSecond)
        ]);
        assert.deepEqual([concludeFirst.statusCode, concludeSecond.statusCode].sort(), [200, 409]);

        const doctorAgenda = response();
        await controller.getMinhaAgenda({
            userId: professionalAuroraUser,
            tenant: { clinicId: auroraId, role: 'profissional' }
        }, doctorAgenda);
        assert.equal(doctorAgenda.statusCode, 200);
        assert.equal(doctorAgenda.body.length, 1);
        assert.equal(doctorAgenda.body[0].status, 'realizada');

        const secretaryAgenda = response();
        await controller.getMinhaAgenda({
            userId: secretaryAurora, tenant: request.tenant
        }, secretaryAgenda);
        assert.equal(secretaryAgenda.statusCode, 200);
        assert.equal(secretaryAgenda.body.some((item) => item.id === appointmentId
            && item.status === 'realizada'), true);

        const secondAppointment = response();
        await controller.agendarConsulta({
            ...request, body: { ...request.body, inicio_local: '2032-05-10T15:00' }
        }, secondAppointment);
        assert.equal(secondAppointment.statusCode, 201);
        const cancelConcurrent = response(); const rescheduleConcurrent = response();
        await Promise.all([
            controller.cancelarConsulta({
                userId: secretaryAurora, tenant: request.tenant,
                params: { id: String(secondAppointment.body.id) }, body: { versao: 1 }
            }, cancelConcurrent),
            controller.reschedule({
                userId: secretaryAurora, tenant: request.tenant,
                params: { id: String(secondAppointment.body.id) },
                body: {
                    paciente_id: auroraPatientId, profissional_id: auroraProfessionalId,
                    especialidade_id: auroraSpecialty, inicio_local: '2032-05-10T16:00',
                    duracao_minutos: 30, versao: 1
                }
            }, rescheduleConcurrent)
        ]);
        assert.deepEqual([cancelConcurrent.statusCode, rescheduleConcurrent.statusCode].sort(), [200, 409]);

        const auroraCalendar = response();
        await controller.listCalendar({
            userId: secretaryAurora, tenant: request.tenant,
            query: { data_inicio: '2032-05-10', data_fim: '2032-05-16', status: 'todos' }
        }, auroraCalendar);
        assert.equal(auroraCalendar.statusCode, 200);
        assert.equal(auroraCalendar.body.consultas.length, 1);
        assert.equal(auroraCalendar.body.consultas[0].paciente_nome, 'Paciente Aurora');

        const horizonteCalendar = response();
        await controller.listCalendar({
            userId: secretaryHorizonte,
            tenant: { clinicId: horizonteId, role: 'secretaria' },
            query: { data_inicio: '2032-05-10', data_fim: '2032-05-16', status: 'todos' }
        }, horizonteCalendar);
        assert.equal(horizonteCalendar.statusCode, 200);
        assert.deepEqual(horizonteCalendar.body.consultas, []);

        const doctorCrossFilter = response();
        await controller.listCalendar({
            userId: professionalAuroraUser,
            tenant: { clinicId: auroraId, role: 'profissional' },
            query: {
                data_inicio: '2032-05-10', data_fim: '2032-05-16', status: 'todos',
                profissional_id: String(horizonteProfessionalId)
            }
        }, doctorCrossFilter);
        assert.equal(doctorCrossFilter.statusCode, 403);

        await setup.query(`ALTER TABLE consultas_historico
            ADD CONSTRAINT chk_consulta_rollback_teste
            CHECK (NOT (acao = 'agendada' AND inicio_novo = '2032-05-10 20:00:00.000000'))`);
        try {
            const failed = response();
            await controller.agendarConsulta({
                ...request, body: { ...request.body, inicio_local: '2032-05-10T17:00' }
            }, failed);
            assert.equal(failed.statusCode, 500);
            const [[partial]] = await setup.execute(`SELECT COUNT(*) AS total FROM consultas
                WHERE clinica_id = ? AND inicio_em = '2032-05-10 20:00:00.000000'`, [auroraId]);
            assert.equal(Number(partial.total), 0);
        } finally {
            await setup.query('ALTER TABLE consultas_historico DROP CHECK chk_consulta_rollback_teste');
        }

        const [[evidence]] = await setup.execute(`SELECT
            (SELECT COUNT(*) FROM consultas WHERE clinica_id = ?) AS consultas,
            (SELECT COUNT(*) FROM consultas_historico WHERE clinica_id = ?) AS historico,
            (SELECT COUNT(*) FROM auditoria WHERE clinica_id = ? AND entidade_tipo = 'consulta') AS auditoria,
            (SELECT COUNT(*) FROM consultas WHERE clinica_id = ?) AS horizonte`,
        [auroraId, auroraId, auroraId, horizonteId]);
        assert.equal(Number(evidence.consultas), 2);
        assert.equal(Number(evidence.historico), 5);
        assert.equal(Number(evidence.auditoria), 5);
        assert.equal(Number(evidence.horizonte), 0);
    } finally {
        await pool?.end();
        await setup.end();
    }
});
