const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { test } = require('node:test');
const mysql = require('mysql2/promise');
const { loadDatabaseConfig } = require('../scripts/db/config');
const { runMigrations } = require('../scripts/db/migrator');
const { readBcryptRounds, readSeedPassword, seedDatabase } = require('../scripts/db/seeder');

const enabled = process.env.BACKEND_INTEGRATION_TEST === '1';
const migrationsDir = path.join(__dirname, '..', '..', 'database', 'migrations');

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

async function resetTestSchema(connection) {
    const tables = [
        'auditoria', 'documentos_clinicos', 'consultas', 'pacientes',
        'profissional_especialidades', 'profissionais', 'especialidades',
        'clinica_usuarios', 'usuarios', 'clinicas', 'schema_migrations'
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

test('backend seleciona tenant e bloqueia paciente de outra clínica no MySQL 8', {
    skip: !enabled
}, async () => {
    const config = loadDatabaseConfig(process.env, 'TEST_DB_');
    if (!/^vitalis_[a-z0-9_]*_test$/.test(config.database)) {
        throw new Error('TEST_DB_DATABASE deve começar com vitalis_ e terminar com _test.');
    }

    Object.assign(process.env, {
        DB_HOST: config.host,
        DB_PORT: String(config.port),
        DB_USER: config.user,
        DB_PASSWORD: config.password,
        DB_DATABASE: config.database,
        PORT: '3000',
        JWT_SECRET: randomBytes(32).toString('hex')
    });

    const connection = await mysql.createConnection({ ...config, multipleStatements: true });
    const pool = require('../config/database');
    const authenticate = require('../middleware/auth');
    const tenantContext = require('../middleware/tenant');
    const authController = require('../controllers/authController');
    const pacienteController = require('../controllers/pacienteController');

    try {
        await resetTestSchema(connection);
        await runMigrations({ connection, migrationsDir, logger: { info() {} } });
        await seedDatabase({
            connection,
            password: readSeedPassword(),
            rounds: readBcryptRounds()
        });

        const loginResponse = response();
        await authController.login({
            body: {
                email: 'paciente.aurora@example.test',
                senha: process.env.SEED_PASSWORD
            }
        }, loginResponse);
        assert.equal(loginResponse.statusCode, 200);

        const identityRequest = {
            headers: { authorization: `Bearer ${loginResponse.body.token}` },
            body: {}
        };
        authenticate(identityRequest, response(), () => {});
        const aurora = loginResponse.body.clinicas.find((item) => item.slug === 'aurora-demo');
        const selectionResponse = response();
        await authController.selectClinic({
            userId: identityRequest.userId,
            body: { clinica_id: aurora.id }
        }, selectionResponse);
        assert.equal(selectionResponse.statusCode, 200);

        const clinicRequest = {
            headers: { authorization: `Bearer ${selectionResponse.body.token}` }
        };
        authenticate(clinicRequest, response(), () => {});
        const contextResponse = response();
        let contextResolved = false;
        await tenantContext(clinicRequest, contextResponse, () => { contextResolved = true; });
        assert.equal(contextResolved, true);
        assert.equal(clinicRequest.tenant.role, 'paciente');

        const [[otherPatient]] = await connection.query(`
            SELECT p.id
            FROM pacientes p
            JOIN clinicas c ON c.id = p.clinica_id
            WHERE c.slug = 'horizonte-demo'
            LIMIT 1
        `);
        const patientResponse = response();
        await pacienteController.getPacienteDetails({
            ...clinicRequest,
            params: { id: String(otherPatient.id) }
        }, patientResponse);
        assert.equal(patientResponse.statusCode, 404);

        const [[horizonte]] = await connection.query(
            "SELECT id FROM clinicas WHERE slug = 'horizonte-demo'"
        );
        const forged = authController.clinicToken(identityRequest.userId, horizonte.id);
        const forgedRequest = { headers: { authorization: `Bearer ${forged}` } };
        authenticate(forgedRequest, response(), () => {});
        const forgedResponse = response();
        await tenantContext(forgedRequest, forgedResponse, () => {});
        assert.equal(forgedResponse.statusCode, 403);
    } finally {
        await pool.end();
        await connection.end();
    }
});
