const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { test } = require('node:test');
const mysql = require('mysql2/promise');
const { loadDatabaseConfig } = require('../scripts/db/config');
const { runMigrations } = require('../scripts/db/migrator');
const { assertSpecialtyDisposableDatabaseName } = require('../support/mysql-test-safety');

const enabled = process.env.SPECIALTY_INTEGRATION_TEST === '1';
const migrationsDir = path.join(__dirname, '..', '..', 'database', 'migrations');

function response() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

async function resetTestSchema(connection, expectedDatabase) {
    assertSpecialtyDisposableDatabaseName(expectedDatabase);
    const [[selected]] = await connection.query('SELECT DATABASE() AS database_name');
    if (selected.database_name !== expectedDatabase) {
        throw new Error(
            `Operação recusada: conexão aponta para ${selected.database_name || 'nenhum banco'}, não para ${expectedDatabase}.`
        );
    }
    const tables = [
        'auditoria', 'documentos_clinicos', 'consultas', 'pacientes',
        'profissional_especialidades', 'profissionais', 'especialidades',
        'clinica_usuarios', 'usuarios', 'clinicas', 'schema_migrations'
    ];
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        for (const table of tables) await connection.query(`DROP TABLE IF EXISTS \`${table}\``);
    } finally {
        await connection.query('SET FOREIGN_KEY_CHECKS = 1');
    }
}

async function insertUser(connection, name, email) {
    const [result] = await connection.execute(`
        INSERT INTO usuarios (nome, email, senha_hash, status)
        VALUES (?, ?, ?, 'ativo')
    `, [name, email, randomBytes(32).toString('hex')]);
    return Number(result.insertId);
}

async function fixtures(connection) {
    const [clinicAResult] = await connection.execute(`
        INSERT INTO clinicas (nome, slug, status)
        VALUES ('Clínica Sintética A', 'especialidades-a', 'ativa')
    `);
    const [clinicBResult] = await connection.execute(`
        INSERT INTO clinicas (nome, slug, status)
        VALUES ('Clínica Sintética B', 'especialidades-b', 'ativa')
    `);
    const clinicA = Number(clinicAResult.insertId);
    const clinicB = Number(clinicBResult.insertId);
    const adminA = await insertUser(connection, 'Administrador Sintético A', 'admin.especialidades.a@example.test');
    const professionalAUser = await insertUser(connection, 'Profissional Sintético A', 'profissional.especialidades.a@example.test');
    const professionalBUser = await insertUser(connection, 'Profissional Sintético B', 'profissional.especialidades.b@example.test');
    for (const [clinicId, userId, role] of [
        [clinicA, adminA, 'administrador'],
        [clinicA, professionalAUser, 'profissional'],
        [clinicB, professionalBUser, 'profissional']
    ]) {
        await connection.execute(`
            INSERT INTO clinica_usuarios (clinica_id, usuario_id, papel, status)
            VALUES (?, ?, ?, 'ativo')
        `, [clinicId, userId, role]);
    }
    const [professionalAResult] = await connection.execute(`
        INSERT INTO profissionais (
            clinica_id, usuario_id, nome_exibicao, conselho_tipo, conselho_numero, status
        ) VALUES (?, ?, 'Profissional Sintético A', 'CRM', 'A-001', 'ativo')
    `, [clinicA, professionalAUser]);
    const [professionalBResult] = await connection.execute(`
        INSERT INTO profissionais (
            clinica_id, usuario_id, nome_exibicao, conselho_tipo, conselho_numero, status
        ) VALUES (?, ?, 'Profissional Sintético B', 'CRM', 'B-001', 'ativo')
    `, [clinicB, professionalBUser]);
    const [specialtyBResult] = await connection.execute(`
        INSERT INTO especialidades (clinica_id, nome, status)
        VALUES (?, 'Especialidade Externa Sintética', 'ativa')
    `, [clinicB]);
    return {
        clinicA, clinicB, adminA,
        professionalA: Number(professionalAResult.insertId),
        professionalB: Number(professionalBResult.insertId),
        specialtyB: Number(specialtyBResult.insertId)
    };
}

test('MySQL 8 valida ciclo completo, histórico e isolamento de especialidades', {
    skip: !enabled
}, async () => {
    const config = loadDatabaseConfig(process.env, 'TEST_DB_');
    const databaseName = assertSpecialtyDisposableDatabaseName(config.database);
    Object.assign(process.env, {
        DB_HOST: config.host,
        DB_PORT: String(config.port),
        DB_USER: config.user,
        DB_PASSWORD: config.password,
        DB_DATABASE: databaseName,
        PORT: '3000',
        JWT_SECRET: randomBytes(32).toString('hex')
    });

    const connection = await mysql.createConnection({ ...config, multipleStatements: true });
    let pool;
    try {
        const [[server]] = await connection.query('SELECT VERSION() AS version, DATABASE() AS database_name');
        assert.match(server.version, /^8\./, `MySQL 8 obrigatório; servidor informou ${server.version}`);
        assert.equal(server.database_name, databaseName);
        console.info(`Banco descartável validado antes da limpeza: ${databaseName}`);

        await resetTestSchema(connection, databaseName);
        await runMigrations({ connection, migrationsDir, logger: { info() {} } });
        const data = await fixtures(connection);
        pool = require('../config/database');
        const specialtyController = require('../controllers/especialidadeController');
        const professionalController = require('../controllers/medicoController');
        const tenantA = { clinicId: data.clinicA, role: 'administrador' };

        const createdResponse = response();
        await specialtyController.createSpecialty({
            body: { nome: '  Especialidade   Criada A ', clinica_id: data.clinicB },
            userId: data.adminA, tenant: tenantA
        }, createdResponse);
        assert.equal(createdResponse.statusCode, 201);
        const specialtyA = createdResponse.body.id;
        const [[created]] = await connection.execute(
            'SELECT clinica_id, nome, status FROM especialidades WHERE id = ?', [specialtyA]
        );
        assert.equal(Number(created.clinica_id), data.clinicA);
        assert.equal(created.nome, 'Especialidade Criada A');
        assert.equal(created.status, 'ativa');

        const duplicateResponse = response();
        await specialtyController.createSpecialty({
            body: { nome: 'especialidade criada a' }, userId: data.adminA, tenant: tenantA
        }, duplicateResponse);
        assert.equal(duplicateResponse.statusCode, 409);

        const updateResponse = response();
        await specialtyController.updateSpecialty({
            params: { id: String(specialtyA) },
            body: { nome: 'Especialidade Editada A', clinica_id: data.clinicB },
            userId: data.adminA, tenant: tenantA
        }, updateResponse);
        assert.equal(updateResponse.statusCode, 200);

        await connection.execute(`
            INSERT INTO profissional_especialidades (clinica_id, profissional_id, especialidade_id)
            VALUES (?, ?, ?)
        `, [data.clinicA, data.professionalA, specialtyA]);

        const deactivateResponse = response();
        await specialtyController.updateSpecialtyStatus({
            params: { id: String(specialtyA) }, body: { status: 'inativa' },
            userId: data.adminA, tenant: tenantA
        }, deactivateResponse);
        assert.equal(deactivateResponse.statusCode, 200);
        const [[preservedAfterDeactivation]] = await connection.execute(`
            SELECT COUNT(*) AS total
            FROM profissional_especialidades
            WHERE clinica_id = ? AND profissional_id = ? AND especialidade_id = ?
        `, [data.clinicA, data.professionalA, specialtyA]);
        assert.equal(Number(preservedAfterDeactivation.total), 1);

        const [activeSpecialtyResult] = await connection.execute(`
            INSERT INTO especialidades (clinica_id, nome, status)
            VALUES (?, 'Especialidade Ativa Auxiliar', 'ativa')
        `, [data.clinicA]);
        const activeSpecialty = Number(activeSpecialtyResult.insertId);
        const professionalUpdate = response();
        await professionalController.updateProfessional({
            params: { id: String(data.professionalA) },
            body: {
                nome_exibicao: 'Profissional Sintético A', conselho_tipo: 'CRM',
                conselho_numero: 'A-001', especialidade_ids: [activeSpecialty]
            },
            userId: data.adminA, tenant: tenantA
        }, professionalUpdate);
        assert.equal(professionalUpdate.statusCode, 200);
        const [[preservedAfterProfessionalEdit]] = await connection.execute(`
            SELECT COUNT(*) AS total
            FROM profissional_especialidades
            WHERE clinica_id = ? AND profissional_id = ? AND especialidade_id = ?
        `, [data.clinicA, data.professionalA, specialtyA]);
        assert.equal(Number(preservedAfterProfessionalEdit.total), 1);

        const crossTenantUpdate = response();
        await specialtyController.updateSpecialty({
            params: { id: String(data.specialtyB) }, body: { nome: 'Tentativa Cruzada' },
            userId: data.adminA, tenant: tenantA
        }, crossTenantUpdate);
        assert.equal(crossTenantUpdate.statusCode, 404);

        const crossTenantAssociation = response();
        await professionalController.updateProfessional({
            params: { id: String(data.professionalA) },
            body: {
                nome_exibicao: 'Profissional Sintético A', conselho_tipo: 'CRM',
                conselho_numero: 'A-001', especialidade_ids: [data.specialtyB]
            },
            userId: data.adminA, tenant: tenantA
        }, crossTenantAssociation);
        assert.equal(crossTenantAssociation.statusCode, 400);

        const listResponse = response();
        await specialtyController.listForManagement({ tenant: tenantA }, listResponse);
        assert.equal(listResponse.statusCode, 200);
        assert.equal(listResponse.body.some((item) => item.id === specialtyA), true);
        assert.equal(listResponse.body.some((item) => item.id === data.specialtyB), false);

        const reactivateResponse = response();
        await specialtyController.updateSpecialtyStatus({
            params: { id: String(specialtyA) }, body: { status: 'ativa' },
            userId: data.adminA, tenant: tenantA
        }, reactivateResponse);
        assert.equal(reactivateResponse.statusCode, 200);

        const [auditRows] = await connection.execute(`
            SELECT acao FROM auditoria
            WHERE clinica_id = ? AND entidade_tipo = 'especialidade' AND entidade_id = ?
            ORDER BY id
        `, [data.clinicA, specialtyA]);
        assert.deepEqual(auditRows.map((row) => row.acao), [
            'especialidade_criada', 'especialidade_atualizada',
            'especialidade_status_alterado', 'especialidade_status_alterado'
        ]);
    } finally {
        if (pool) await pool.end();
        await connection.end();
    }
});
