const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { test } = require('node:test');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const { loadDatabaseConfig } = require('../scripts/db/config');
const { runMigrations } = require('../scripts/db/migrator');
const { assertDisposableDatabaseName } = require('../support/mysql-test-safety');

const enabled = process.env.PROFESSIONAL_INTEGRATION_TEST === '1';
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
    assertDisposableDatabaseName(expectedDatabase);
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
        for (const table of tables) {
            await connection.query(`DROP TABLE IF EXISTS \`${table}\``);
        }
    } finally {
        await connection.query('SET FOREIGN_KEY_CHECKS = 1');
    }
}

async function insertUser(connection, name, email, passwordHash) {
    const [result] = await connection.execute(`
        INSERT INTO usuarios (nome, email, senha_hash, status)
        VALUES (?, ?, ?, 'ativo')
    `, [name, email, passwordHash]);
    return Number(result.insertId);
}

async function createSyntheticFixtures(connection) {
    const [clinicAResult] = await connection.execute(`
        INSERT INTO clinicas (nome, slug, status)
        VALUES ('Clínica Integração A', 'integracao-a', 'ativa')
    `);
    const [clinicBResult] = await connection.execute(`
        INSERT INTO clinicas (nome, slug, status)
        VALUES ('Clínica Integração B', 'integracao-b', 'ativa')
    `);
    const clinicA = Number(clinicAResult.insertId);
    const clinicB = Number(clinicBResult.insertId);
    const passwordHash = await bcrypt.hash(randomBytes(24).toString('hex'), 4);

    const adminA = await insertUser(connection, 'Administrador Integração A', 'admin.a@example.test', passwordHash);
    const candidateA = await insertUser(connection, 'Profissional Candidato A', 'candidato.a@example.test', passwordHash);
    const professionalBUser = await insertUser(connection, 'Profissional Existente B', 'profissional.b@example.test', passwordHash);
    const patientAUser = await insertUser(connection, 'Paciente Sintético A', 'paciente.a@example.test', passwordHash);

    for (const [clinicId, userId, role] of [
        [clinicA, adminA, 'administrador'],
        [clinicA, candidateA, 'profissional'],
        [clinicA, patientAUser, 'paciente'],
        [clinicB, professionalBUser, 'profissional']
    ]) {
        await connection.execute(`
            INSERT INTO clinica_usuarios (clinica_id, usuario_id, papel, status)
            VALUES (?, ?, ?, 'ativo')
        `, [clinicId, userId, role]);
    }

    const [specialtyAResult] = await connection.execute(`
        INSERT INTO especialidades (clinica_id, nome, status)
        VALUES (?, 'Especialidade Sintética A', 'ativa')
    `, [clinicA]);
    const [specialtyBResult] = await connection.execute(`
        INSERT INTO especialidades (clinica_id, nome, status)
        VALUES (?, 'Especialidade Sintética B', 'ativa')
    `, [clinicB]);
    const [professionalBResult] = await connection.execute(`
        INSERT INTO profissionais (
            clinica_id, usuario_id, nome_exibicao, conselho_tipo, conselho_numero, status
        ) VALUES (?, ?, 'Profissional Existente B', 'CRM', 'B-001', 'ativo')
    `, [clinicB, professionalBUser]);
    const [patientAResult] = await connection.execute(`
        INSERT INTO pacientes (clinica_id, usuario_id, nome, email, status)
        VALUES (?, ?, 'Paciente Sintético A', 'paciente.a@example.test', 'ativo')
    `, [clinicA, patientAUser]);

    return {
        clinicA,
        clinicB,
        adminA,
        candidateA,
        professionalBUser,
        professionalB: Number(professionalBResult.insertId),
        patientA: Number(patientAResult.insertId),
        specialtyA: Number(specialtyAResult.insertId),
        specialtyB: Number(specialtyBResult.insertId)
    };
}

test('MySQL 8 valida ciclo completo e isolamento da gestão de profissionais', {
    skip: !enabled
}, async () => {
    const config = loadDatabaseConfig(process.env, 'TEST_DB_');
    const databaseName = assertDisposableDatabaseName(config.database);

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
        const fixtures = await createSyntheticFixtures(connection);

        pool = require('../config/database');
        const controller = require('../controllers/medicoController');
        const tenantA = { clinicId: fixtures.clinicA, role: 'administrador' };

        const autonomousResponse = response();
        await controller.createProfessionalAccount({
            body: {
                clinica_id: fixtures.clinicB,
                nome_completo: 'Profissional Autônomo A',
                nome_exibicao: 'Profissional Autônomo A',
                email: 'autonomo.a@example.test',
                tipo_profissional: 'Fisioterapeuta',
                conselho_tipo: 'CREFITO',
                conselho_numero: 'AUTO-A',
                especialidade_ids: [fixtures.specialtyA],
                status: 'ativo'
            },
            userId: fixtures.adminA,
            tenant: tenantA
        }, autonomousResponse);
        assert.equal(autonomousResponse.statusCode, 201);
        const [[autonomous]] = await connection.execute(`
            SELECT p.clinica_id, p.tipo_profissional, p.status,
                   u.status AS usuario_status, cu.papel, cu.status AS vinculo_status
            FROM profissionais p
            JOIN usuarios u ON u.id = p.usuario_id
            JOIN clinica_usuarios cu
              ON cu.clinica_id = p.clinica_id
             AND cu.usuario_id = p.usuario_id
            WHERE p.id = ?
        `, [autonomousResponse.body.id]);
        assert.equal(Number(autonomous.clinica_id), fixtures.clinicA);
        assert.equal(autonomous.tipo_profissional, 'Fisioterapeuta');
        assert.equal(autonomous.status, 'ativo');
        assert.equal(autonomous.usuario_status, 'bloqueado');
        assert.equal(autonomous.papel, 'profissional');
        assert.equal(autonomous.vinculo_status, 'convite_pendente');

        const createResponse = response();
        await controller.createProfessional({
            body: {
                clinica_id: fixtures.clinicB,
                usuario_id: fixtures.candidateA,
                nome_exibicao: 'Profissional Criado A',
                conselho_tipo: 'crm',
                conselho_numero: 'A-001',
                especialidade_ids: [fixtures.specialtyA]
            },
            userId: fixtures.adminA,
            tenant: tenantA
        }, createResponse);
        assert.equal(createResponse.statusCode, 201);
        const professionalA = createResponse.body.id;

        const [[created]] = await connection.execute(`
            SELECT clinica_id, usuario_id, nome_exibicao, status
            FROM profissionais WHERE id = ?
        `, [professionalA]);
        assert.equal(Number(created.clinica_id), fixtures.clinicA);
        assert.equal(Number(created.usuario_id), fixtures.candidateA);
        assert.equal(created.status, 'ativo');

        const updateResponse = response();
        await controller.updateProfessional({
            params: { id: String(professionalA) },
            body: {
                clinica_id: fixtures.clinicB,
                usuario_id: fixtures.professionalBUser,
                nome_exibicao: 'Profissional Editado A',
                conselho_tipo: 'crm',
                conselho_numero: 'A-002',
                especialidade_ids: [fixtures.specialtyA]
            },
            userId: fixtures.adminA,
            tenant: tenantA
        }, updateResponse);
        assert.equal(updateResponse.statusCode, 200);

        const [[edited]] = await connection.execute(`
            SELECT clinica_id, usuario_id, nome_exibicao, conselho_tipo, conselho_numero
            FROM profissionais WHERE id = ?
        `, [professionalA]);
        assert.equal(Number(edited.clinica_id), fixtures.clinicA);
        assert.equal(Number(edited.usuario_id), fixtures.candidateA);
        assert.equal(edited.nome_exibicao, 'Profissional Editado A');
        assert.equal(edited.conselho_tipo, 'CRM');
        assert.equal(edited.conselho_numero, 'A-002');

        const [appointmentResult] = await connection.execute(`
            INSERT INTO consultas (
                clinica_id, paciente_id, profissional_id, inicio_em, fim_em,
                status, criado_por_usuario_id
            ) VALUES (?, ?, ?, '2035-01-10 12:00:00', '2035-01-10 13:00:00', 'confirmada', ?)
        `, [fixtures.clinicA, fixtures.patientA, professionalA, fixtures.adminA]);
        const appointmentId = Number(appointmentResult.insertId);

        const deactivateResponse = response();
        await controller.updateProfessionalStatus({
            params: { id: String(professionalA) }, body: { status: 'inativo' },
            userId: fixtures.adminA, tenant: tenantA
        }, deactivateResponse);
        assert.equal(deactivateResponse.statusCode, 200);

        const [[inactive]] = await connection.execute(
            'SELECT status FROM profissionais WHERE clinica_id = ? AND id = ?',
            [fixtures.clinicA, professionalA]
        );
        assert.equal(inactive.status, 'inativo');
        const [[historyAfterDeactivation]] = await connection.execute(
            'SELECT COUNT(*) AS total FROM consultas WHERE clinica_id = ? AND id = ? AND profissional_id = ?',
            [fixtures.clinicA, appointmentId, professionalA]
        );
        assert.equal(Number(historyAfterDeactivation.total), 1);

        const schedulingResponse = response();
        await controller.getAllMedicos({ tenant: tenantA }, schedulingResponse);
        assert.equal(schedulingResponse.body.some((item) => Number(item.id) === professionalA), false);

        const activateResponse = response();
        await controller.updateProfessionalStatus({
            params: { id: String(professionalA) }, body: { status: 'ativo' },
            userId: fixtures.adminA, tenant: tenantA
        }, activateResponse);
        assert.equal(activateResponse.statusCode, 200);

        const [[active]] = await connection.execute(
            'SELECT status FROM profissionais WHERE clinica_id = ? AND id = ?',
            [fixtures.clinicA, professionalA]
        );
        assert.equal(active.status, 'ativo');

        const managementResponse = response();
        await controller.listForManagement({ tenant: tenantA }, managementResponse);
        assert.equal(managementResponse.statusCode, 200);
        assert.equal(managementResponse.body.some((item) => item.id === professionalA), true);
        assert.equal(managementResponse.body.some((item) => item.id === fixtures.professionalB), false);

        const crossTenantUpdate = response();
        await controller.updateProfessional({
            params: { id: String(fixtures.professionalB) },
            body: { nome_exibicao: 'Tentativa Cruzada', especialidade_ids: [] },
            userId: fixtures.adminA,
            tenant: tenantA
        }, crossTenantUpdate);
        assert.equal(crossTenantUpdate.statusCode, 404);

        const crossTenantCreate = response();
        await controller.createProfessional({
            body: {
                usuario_id: fixtures.professionalBUser,
                nome_exibicao: 'Tentativa Cruzada',
                especialidade_ids: [fixtures.specialtyB]
            },
            userId: fixtures.adminA,
            tenant: tenantA
        }, crossTenantCreate);
        assert.equal(crossTenantCreate.statusCode, 409);

        const [auditRows] = await connection.execute(`
            SELECT acao, metadados
            FROM auditoria
            WHERE clinica_id = ? AND entidade_tipo = 'profissional' AND entidade_id = ?
            ORDER BY id
        `, [fixtures.clinicA, professionalA]);
        assert.deepEqual(auditRows.map((row) => row.acao), [
            'profissional_criado',
            'profissional_atualizado',
            'profissional_status_alterado',
            'profissional_status_alterado'
        ]);
        const metadata = auditRows.map((row) => (
            typeof row.metadados === 'string' ? JSON.parse(row.metadados) : row.metadados
        ));
        assert.equal(metadata[2].status, 'inativo');
        assert.equal(metadata[3].status, 'ativo');
    } finally {
        if (pool) await pool.end();
        await connection.end();
    }
});

