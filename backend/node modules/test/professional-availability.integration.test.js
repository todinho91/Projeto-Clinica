const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { test } = require('node:test');
const mysql = require('mysql2/promise');
const { loadDatabaseConfig } = require('../scripts/db/config');
const { runMigrations } = require('../scripts/db/migrator');
const {
    assertAvailabilityDisposableDatabaseName,
    confirmAvailabilityTestEnvironment
} = require('../support/mysql-test-safety');

const enabled = process.env.AVAILABILITY_INTEGRATION_TEST === '1';
const migrationsDir = path.join(__dirname, '..', '..', 'database', 'migrations');

function response() {
    return { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

async function resetSchema(connection, database) {
    await confirmAvailabilityTestEnvironment(connection, database);
    const tables = [
        'auditoria_plataforma', 'convites_clinica', 'bloqueios_profissional',
        'disponibilidades_profissional', 'auditoria', 'documentos_clinicos', 'consultas_historico', 'consultas',
        'pacientes', 'profissional_especialidades', 'profissionais', 'especialidades',
        'clinica_usuarios', 'operadores_plataforma', 'usuarios', 'clinicas', 'schema_migrations'
    ];
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        for (const table of tables) await connection.query(`DROP TABLE IF EXISTS \`${table}\``);
    } finally {
        await connection.query('SET FOREIGN_KEY_CHECKS = 1');
    }
}

test('MySQL 8 valida disponibilidade, fuso, concorrência, rollback e isolamento', {
    skip: !enabled
}, async () => {
    const config = loadDatabaseConfig(process.env, 'TEST_DB_');
    assertAvailabilityDisposableDatabaseName(config.database);
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
        const [clinics] = await setup.query(`
            INSERT INTO clinicas (nome, slug, timezone, status) VALUES
            ('Clínica Norte Teste', 'norte-disponibilidade-test', 'America/Manaus', 'ativa'),
            ('Clínica Sul Teste', 'sul-disponibilidade-test', 'America/Sao_Paulo', 'ativa')
        `);
        const northId = Number(clinics.insertId);
        const southId = northId + 1;
        const hash = '$2b$10$fixturefixturefixturefixturefixturefixturefixturefixture';
        const [users] = await setup.execute(`
            INSERT INTO usuarios (nome, email, senha_hash, status, motivo_bloqueio) VALUES
            ('Admin Norte', 'admin.norte@example.test', ?, 'ativo', 'nenhum'),
            ('Profissional Norte', 'prof.norte@example.test', ?, 'ativo', 'nenhum'),
            ('Admin Sul', 'admin.sul@example.test', ?, 'ativo', 'nenhum'),
            ('Profissional Sul', 'prof.sul@example.test', ?, 'ativo', 'nenhum')
        `, [hash, hash, hash, hash]);
        const adminNorth = Number(users.insertId);
        const profNorthUser = adminNorth + 1;
        const adminSouth = adminNorth + 2;
        const profSouthUser = adminNorth + 3;
        await setup.execute(`
            INSERT INTO clinica_usuarios (clinica_id, usuario_id, papel, status) VALUES
            (?, ?, 'administrador', 'ativo'), (?, ?, 'profissional', 'ativo'),
            (?, ?, 'administrador', 'ativo'), (?, ?, 'profissional', 'ativo')
        `, [northId, adminNorth, northId, profNorthUser, southId, adminSouth, southId, profSouthUser]);
        const [northProfessional] = await setup.execute(`
            INSERT INTO profissionais (clinica_id, usuario_id, nome_exibicao, tipo_profissional, status)
            VALUES (?, ?, 'Profissional Norte', 'Médico', 'ativo')
        `, [northId, profNorthUser]);
        const [southProfessional] = await setup.execute(`
            INSERT INTO profissionais (clinica_id, usuario_id, nome_exibicao, tipo_profissional, status)
            VALUES (?, ?, 'Profissional Sul', 'Psicólogo', 'ativo')
        `, [southId, profSouthUser]);
        const northProfessionalId = Number(northProfessional.insertId);
        const southProfessionalId = Number(southProfessional.insertId);

        pool = require('../config/database');
        const controller = require('../controllers/disponibilidadeController');
        const weekly = response();
        await controller.replaceWeeklyAvailability({
            params: { professionalId: String(northProfessionalId) }, userId: adminNorth,
            tenant: { clinicId: northId, role: 'administrador' },
            body: { intervalos: [
                { dia_semana: 1, tipo: 'atendimento', inicio: '08:00', fim: '12:00' },
                { dia_semana: 1, tipo: 'descanso', inicio: '12:00', fim: '13:00' },
                { dia_semana: 1, tipo: 'atendimento', inicio: '13:00', fim: '17:00' }
            ] }
        }, weekly);
        assert.equal(weekly.statusCode, 200);

        const crossTenant = response();
        await controller.getProfessionalAvailability({
            params: { professionalId: String(southProfessionalId) }, userId: adminNorth,
            tenant: { clinicId: northId, role: 'administrador' }
        }, crossTenant);
        assert.equal(crossTenant.statusCode, 404);

        const blockRequest = {
            params: { professionalId: String(northProfessionalId) }, userId: adminNorth,
            tenant: { clinicId: northId, role: 'administrador' },
            body: {
                tipo: 'indisponibilidade', inicio_local: '2032-05-10T09:00',
                fim_local: '2032-05-10T11:00', motivo: 'Teste concorrente'
            }
        };
        const first = response();
        const second = response();
        await Promise.all([
            controller.createBlock(blockRequest, first),
            controller.createBlock({ ...blockRequest }, second)
        ]);
        assert.deepEqual([first.statusCode, second.statusCode].sort(), [201, 409]);
        const [[stored]] = await setup.execute(`
            SELECT inicio_em, fim_em FROM bloqueios_profissional
            WHERE clinica_id = ? AND profissional_id = ? AND status = 'ativo'
        `, [northId, northProfessionalId]);
        assert.equal(new Date(stored.inicio_em).toISOString(), '2032-05-10T13:00:00.000Z');
        assert.equal(new Date(stored.fim_em).toISOString(), '2032-05-10T15:00:00.000Z');

        await setup.query(`
            ALTER TABLE disponibilidades_profissional
            ADD CONSTRAINT chk_disponibilidade_rollback_teste
            CHECK (NOT (
                dia_semana = 2
                AND inicio_local = '10:00:00'
                AND fim_local = '16:00:00'
            ))
        `);
        const rollback = response();
        try {
            await controller.replaceWeeklyAvailability({
                params: { professionalId: String(northProfessionalId) }, userId: adminNorth,
                tenant: { clinicId: northId, role: 'administrador' },
                body: { intervalos: [
                    { dia_semana: 2, tipo: 'atendimento', inicio: '10:00', fim: '16:00' }
                ] }
            }, rollback);
            assert.equal(rollback.statusCode, 500);
            const [[preserved]] = await setup.execute(`
                SELECT COUNT(*) AS total FROM disponibilidades_profissional
                WHERE clinica_id = ? AND profissional_id = ? AND status = 'ativo' AND dia_semana = 1
            `, [northId, northProfessionalId]);
            assert.equal(Number(preserved.total), 3);
        } finally {
            await setup.query(`
                ALTER TABLE disponibilidades_profissional
                DROP CHECK chk_disponibilidade_rollback_teste
            `);
        }
    } finally {
        await pool?.end();
        await setup.end();
    }
});
