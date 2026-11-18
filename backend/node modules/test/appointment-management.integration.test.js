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
            (clinica_id, profissional_id, dia_semana, tipo, inicio_local, fim_local, status, criado_por_usuario_id)
            VALUES (?, ?, 1, 'atendimento', '08:00', '18:00', 'ativo', ?)`,
        [auroraId, auroraProfessionalId, secretaryAurora]);

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

        const crossTenant = response();
        await controller.agendarConsulta({
            ...request,
            body: { ...request.body, paciente_id: horizontePatientId, inicio_local: '2032-05-10T15:00' }
        }, crossTenant);
        assert.equal(crossTenant.statusCode, 404);

        const confirmed = response();
        await controller.updateStatusConsulta({
            userId: secretaryAurora, tenant: request.tenant,
            params: { id: String(appointmentId) }, body: { status: 'confirmada' }
        }, confirmed);
        assert.equal(confirmed.statusCode, 200);
        const invalidTransition = response();
        await controller.updateStatusConsulta({
            userId: secretaryAurora, tenant: request.tenant,
            params: { id: String(appointmentId) }, body: { status: 'agendada' }
        }, invalidTransition);
        assert.equal(invalidTransition.statusCode, 400);

        await setup.query(`ALTER TABLE consultas ADD CONSTRAINT chk_consulta_rollback_teste
            CHECK (inicio_em <> '2032-05-10 19:00:00.000000')`);
        try {
            const failed = response();
            await controller.agendarConsulta({
                ...request, body: { ...request.body, inicio_local: '2032-05-10T16:00' }
            }, failed);
            assert.equal(failed.statusCode, 500);
            const [[partial]] = await setup.execute(`SELECT COUNT(*) AS total FROM consultas
                WHERE clinica_id = ? AND inicio_em = '2032-05-10 19:00:00.000000'`, [auroraId]);
            assert.equal(Number(partial.total), 0);
        } finally {
            await setup.query('ALTER TABLE consultas DROP CHECK chk_consulta_rollback_teste');
        }

        const [[evidence]] = await setup.execute(`SELECT
            (SELECT COUNT(*) FROM consultas WHERE clinica_id = ?) AS consultas,
            (SELECT COUNT(*) FROM consultas_historico WHERE clinica_id = ?) AS historico,
            (SELECT COUNT(*) FROM auditoria WHERE clinica_id = ? AND entidade_tipo = 'consulta') AS auditoria,
            (SELECT COUNT(*) FROM consultas WHERE clinica_id = ?) AS horizonte`,
        [auroraId, auroraId, auroraId, horizonteId]);
        assert.equal(Number(evidence.consultas), 1);
        assert.equal(Number(evidence.historico), 2);
        assert.equal(Number(evidence.auditoria), 2);
        assert.equal(Number(evidence.horizonte), 0);
    } finally {
        await pool?.end();
        await setup.end();
    }
});
