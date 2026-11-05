const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const mysql = require('mysql2/promise');
const { loadDatabaseConfig } = require('../scripts/db/config');
const { runMigrations } = require('../scripts/db/migrator');
const { readBcryptRounds, readSeedPassword, seedDatabase } = require('../scripts/db/seeder');

const enabled = process.env.DB_INTEGRATION_TEST === '1';
const migrationsDir = path.join(__dirname, '..', '..', 'database', 'migrations');

async function resetTestSchema(connection) {
    const tables = [
        'auditoria',
        'documentos_clinicos',
        'consultas',
        'pacientes',
        'profissional_especialidades',
        'profissionais',
        'especialidades',
        'clinica_usuarios',
        'usuarios',
        'clinicas',
        'schema_migrations'
    ];
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        for (const table of tables) {
            await connection.query(`DROP TABLE IF EXISTS \`${table}\``);
        }
    } finally {
        await connection.query('SET FOREIGN_KEY_CHECKS = 1');
    }
}

test('MySQL 8 aplica migrations, repete seed e bloqueia referência entre clínicas', {
    skip: !enabled
}, async () => {
    const config = loadDatabaseConfig(process.env, 'TEST_DB_');
    if (!/^vitalis_[a-z0-9_]*_test$/.test(config.database)) {
        throw new Error('TEST_DB_DATABASE deve começar com vitalis_ e terminar com _test.');
    }

    const connection = await mysql.createConnection({ ...config, multipleStatements: true });
    try {
        await resetTestSchema(connection);
        const firstMigration = await runMigrations({ connection, migrationsDir, logger: { info() {} } });
        const secondMigration = await runMigrations({ connection, migrationsDir, logger: { info() {} } });
        assert.equal(firstMigration.applied.length, 3);
        assert.equal(secondMigration.skipped.length, 3);

        const password = readSeedPassword();
        const rounds = readBcryptRounds();
        await seedDatabase({ connection, password, rounds });
        await seedDatabase({ connection, password, rounds });

        const [[clinicCount]] = await connection.query('SELECT COUNT(*) AS total FROM clinicas');
        const [[userCount]] = await connection.query('SELECT COUNT(*) AS total FROM usuarios');
        assert.equal(Number(clinicCount.total), 2);
        assert.equal(Number(userCount.total), 8);

        const [clinics] = await connection.query('SELECT id, slug FROM clinicas ORDER BY slug');
        const aurora = clinics.find((row) => row.slug === 'aurora-demo');
        const horizonte = clinics.find((row) => row.slug === 'horizonte-demo');
        const [[patient]] = await connection.execute(
            'SELECT id FROM pacientes WHERE clinica_id = ?',
            [horizonte.id]
        );
        const [[professional]] = await connection.execute(
            'SELECT id FROM profissionais WHERE clinica_id = ?',
            [aurora.id]
        );
        const [[creator]] = await connection.execute(
            'SELECT usuario_id FROM clinica_usuarios WHERE clinica_id = ? AND papel = ?',
            [aurora.id, 'secretaria']
        );

        await assert.rejects(
            connection.execute(`
                INSERT INTO consultas (
                    clinica_id, paciente_id, profissional_id, inicio_em, fim_em,
                    status, criado_por_usuario_id
                ) VALUES (?, ?, ?, '2031-01-01 10:00:00', '2031-01-01 11:00:00', 'agendada', ?)
            `, [aurora.id, patient.id, professional.id, creator.usuario_id]),
            /foreign key constraint fails/i
        );
    } finally {
        await connection.end();
    }
});
