const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { test } = require('node:test');
const mysql = require('mysql2/promise');
const { loadDatabaseConfig } = require('../scripts/db/config');
const { runMigrations } = require('../scripts/db/migrator');
const {
    assertPatientDisposableDatabaseName,
    confirmPatientTestEnvironment
} = require('../support/mysql-test-safety');

const enabled = process.env.PATIENT_INTEGRATION_TEST === '1';
const migrationsDir = path.join(__dirname, '..', '..', 'database', 'migrations');

function response() {
    return { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function patientRequest(clinicId, userId, membershipVersion, overrides = {}) {
    return {
        tenant: { clinicId, role: 'administrador' }, userId,
        auth: { membershipVersion },
        body: { nome: 'Paciente Integração', email: 'paciente.integracao@example.test', telefone: '41999990000', data_nascimento: '1990-01-15', status: 'ativo', ...overrides }
    };
}

async function resetSchema(connection, database) {
    await confirmPatientTestEnvironment(connection, database);
    const tables = [
        'consultorio_delegacoes', 'consultorio_locais', 'consultorios_profissionais', 'identidades_profissionais',
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

test('MySQL 8 valida cadastro, concorrência, duplicidade, rollback e isolamento de pacientes', {
    skip: !enabled
}, async () => {
    const config = loadDatabaseConfig(process.env, 'TEST_DB_');
    assertPatientDisposableDatabaseName(config.database);
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
            ('Clínica Norte Pacientes', 'norte-pacientes-test', 'America/Sao_Paulo', 'ativa'),
            ('Clínica Sul Pacientes', 'sul-pacientes-test', 'America/Manaus', 'ativa')
        `);
        const northId = Number(clinics.insertId);
        const southId = northId + 1;
        const hash = '$2b$10$fixturefixturefixturefixturefixturefixturefixturefixture';
        const [users] = await setup.execute(`
            INSERT INTO usuarios (nome, email, senha_hash, status, motivo_bloqueio) VALUES
            ('Admin Norte', 'admin.norte.paciente@example.test', ?, 'ativo', 'nenhum'),
            ('Admin Sul', 'admin.sul.paciente@example.test', ?, 'ativo', 'nenhum')
        `, [hash, hash]);
        const northAdmin = Number(users.insertId);
        const southAdmin = northAdmin + 1;
        await setup.execute(`
            INSERT INTO clinica_usuarios (clinica_id, usuario_id, papel, status) VALUES
            (?, ?, 'administrador', 'ativo'), (?, ?, 'administrador', 'ativo')
        `, [northId, northAdmin, southId, southAdmin]);
        const [membershipRows] = await setup.execute(`
            SELECT usuario_id, sessao_versao
            FROM clinica_usuarios
            WHERE (clinica_id = ? AND usuario_id = ?)
               OR (clinica_id = ? AND usuario_id = ?)
        `, [northId, northAdmin, southId, southAdmin]);
        const membershipVersionByUser = new Map(membershipRows.map((row) => [
            Number(row.usuario_id), Number(row.sessao_versao)
        ]));
        const northMembershipVersion = membershipVersionByUser.get(northAdmin);
        const southMembershipVersion = membershipVersionByUser.get(southAdmin);
        assert.ok(Number.isInteger(northMembershipVersion));
        assert.ok(Number.isInteger(southMembershipVersion));

        pool = require('../config/database');
        const controller = require('../controllers/pacienteController');
        const authController = require('../controllers/authController');

        const first = response();
        const concurrent = response();
        await Promise.all([
            controller.createPatient(patientRequest(
                northId, northAdmin, northMembershipVersion
            ), first),
            controller.createPatient(patientRequest(
                northId, northAdmin, northMembershipVersion
            ), concurrent)
        ]);
        assert.deepEqual([first.statusCode, concurrent.statusCode].sort(), [201, 409]);

        const incompleteFirst = response(); const incompleteConcurrent = response();
        const incomplete = patientRequest(northId, northAdmin, northMembershipVersion, {
            nome: 'José   Cadastro Incompleto', email: '', telefone: '', data_nascimento: ''
        });
        await Promise.all([
            controller.createPatient(incomplete, incompleteFirst),
            controller.createPatient({ ...incomplete, body: { ...incomplete.body } }, incompleteConcurrent)
        ]);
        assert.deepEqual([incompleteFirst.statusCode, incompleteConcurrent.statusCode].sort(), [201, 409]);
        const incompleteDuplicate = incompleteFirst.statusCode === 409 ? incompleteFirst : incompleteConcurrent;
        assert.equal(incompleteDuplicate.body.code, 'PATIENT_DUPLICATE');
        const accentAndSpacing = response();
        await controller.createPatient(patientRequest(northId, northAdmin, northMembershipVersion, {
            nome: '  jose   cadastro incompleto ', email: '', telefone: '', data_nascimento: ''
        }), accentAndSpacing);
        assert.equal(accentAndSpacing.statusCode, 409);

        const homonymBase = response();
        await controller.createPatient(patientRequest(northId, northAdmin, northMembershipVersion, {
            nome: 'Ana Homônima', email: '', telefone: '', data_nascimento: '1980-02-10'
        }), homonymBase);
        assert.equal(homonymBase.statusCode, 201);
        const homonymNeedsReview = response();
        await controller.createPatient(patientRequest(northId, northAdmin, northMembershipVersion, {
            nome: 'ana homonima', email: '', telefone: '', data_nascimento: '1990-03-20'
        }), homonymNeedsReview);
        assert.equal(homonymNeedsReview.statusCode, 409);
        assert.equal(homonymNeedsReview.body.code, 'PATIENT_REVIEW_REQUIRED');
        const homonymReviewed = response();
        await controller.createPatient(patientRequest(northId, northAdmin, northMembershipVersion, {
            nome: 'ana homonima', email: '', telefone: '', data_nascimento: '1990-03-20',
            revisao_duplicidade: true, motivo_revisao: 'homonimo_confirmado'
        }), homonymReviewed);
        assert.equal(homonymReviewed.statusCode, 201);

        const familyFirst = response();
        await controller.createPatient(patientRequest(northId, northAdmin, northMembershipVersion, {
            nome: 'Contato Familiar Um', email: '', telefone: '41988887777', data_nascimento: '1985-01-01'
        }), familyFirst);
        assert.equal(familyFirst.statusCode, 201);
        const familyReviewed = response();
        await controller.createPatient(patientRequest(northId, northAdmin, northMembershipVersion, {
            nome: 'Contato Familiar Dois', email: '', telefone: '41988887777', data_nascimento: '2010-01-01',
            revisao_duplicidade: true, motivo_revisao: 'contato_compartilhado'
        }), familyReviewed);
        assert.equal(familyReviewed.statusCode, 201);

        const candidateValues = []; const candidateParams = [];
        for (let index = 0; index < 11; index += 1) {
            candidateValues.push("(?, NULL, 'Candidato Limite', NULL, ?, ?, 'ativo')");
            candidateParams.push(
                northId,
                index === 10 ? '41977776666' : `4197000${String(index).padStart(4, '0')}`,
                `19${String(70 + index).padStart(2, '0')}-01-01`
            );
        }
        await setup.execute(`INSERT INTO pacientes
            (clinica_id, usuario_id, nome, email, telefone, data_nascimento, status)
            VALUES ${candidateValues.join(', ')}`, candidateParams);
        const afterTenthBlocking = response();
        await controller.createPatient(patientRequest(northId, northAdmin, northMembershipVersion, {
            nome: 'Candidato Limite', email: '', telefone: '(41) 97777-6666',
            data_nascimento: '2001-02-02', revisao_duplicidade: true,
            motivo_revisao: 'dados_conferidos'
        }), afterTenthBlocking);
        assert.equal(afterTenthBlocking.statusCode, 409);
        assert.equal(afterTenthBlocking.body.code, 'PATIENT_DUPLICATE');
        assert.equal(afterTenthBlocking.body.total_candidatos, 11);
        assert.equal(afterTenthBlocking.body.candidatos.length, 10);

        const south = response();
        await controller.createPatient(patientRequest(
            southId, southAdmin, southMembershipVersion
        ), south);
        assert.equal(south.statusCode, 201, 'o mesmo e-mail é permitido em clínicas independentes');
        const isolatedIncomplete = response();
        await controller.createPatient(patientRequest(southId, southAdmin, southMembershipVersion, {
            nome: 'José Cadastro Incompleto', email: '', telefone: '', data_nascimento: ''
        }), isolatedIncomplete);
        assert.equal(isolatedIncomplete.statusCode, 201, 'nome incompleto igual é isolado por clínica');

        const publicRegistration = response();
        await authController.register({ body: {
            nome: 'Tentativa de Apropriação',
            email: 'paciente.integracao@example.test',
            senha: 'senha-ficticia-forte',
            clinica_slug: 'norte-pacientes-test'
        } }, publicRegistration);
        assert.equal(publicRegistration.statusCode, 409);
        const [[partialIdentity]] = await setup.execute(
            'SELECT COUNT(*) AS total FROM usuarios WHERE email = ?',
            ['paciente.integracao@example.test']
        );
        const [[partialMembership]] = await setup.execute(`
            SELECT COUNT(*) AS total
            FROM clinica_usuarios cu
            JOIN usuarios u ON u.id = cu.usuario_id
            WHERE cu.clinica_id = ? AND u.email = ?
        `, [northId, 'paciente.integracao@example.test']);
        assert.equal(Number(partialIdentity.total), 0);
        assert.equal(Number(partialMembership.total), 0);

        const search = response();
        await controller.searchForScheduling({ tenant: { clinicId: northId }, query: { q: 'Integração' } }, search);
        assert.equal(search.statusCode, 200);
        assert.equal(search.body.length, 1);
        assert.deepEqual(Object.keys(search.body[0]).sort(), ['ano_nascimento', 'id', 'nome']);

        const [[southPatient]] = await setup.execute(
            'SELECT id FROM pacientes WHERE clinica_id = ? LIMIT 1', [southId]
        );
        const crossTenant = response();
        await controller.updatePatient({
            ...patientRequest(northId, northAdmin, northMembershipVersion),
            params: { id: String(southPatient.id) }
        }, crossTenant);
        assert.equal(crossTenant.statusCode, 404);

        await setup.query(`
            ALTER TABLE auditoria
            ADD CONSTRAINT chk_paciente_rollback_teste
            CHECK (NOT (
                acao = 'paciente_criado'
                AND JSON_UNQUOTE(JSON_EXTRACT(metadados, '$.status')) = 'inativo'
            ))
        `);
        try {
            const rollback = response();
            await controller.createPatient(patientRequest(
                northId, northAdmin, northMembershipVersion, {
                nome: 'Paciente Rollback', email: 'rollback.paciente@example.test',
                telefone: '41999991111', data_nascimento: '1984-03-08', status: 'inativo'
            }), rollback);
            assert.equal(rollback.statusCode, 500);
            const [[preserved]] = await setup.execute(
                'SELECT COUNT(*) AS total FROM pacientes WHERE clinica_id = ? AND email = ?',
                [northId, 'rollback.paciente@example.test']
            );
            assert.equal(Number(preserved.total), 0);
        } finally {
            await setup.query('ALTER TABLE auditoria DROP CHECK chk_paciente_rollback_teste');
        }
    } finally {
        await pool?.end();
        await setup.end();
    }
});

test('integração destrutiva aceita somente banco descartável exclusivo de pacientes', () => {
    assert.equal(assertPatientDisposableDatabaseName('vitalis_pacientes_m5_test'), 'vitalis_pacientes_m5_test');
    for (const unsafe of ['vitalis_m3_validacao', 'vitalis_dev', 'vitalis_backend_test', 'vitalis_pacientes_test_backup']) {
        assert.throws(() => assertPatientDisposableDatabaseName(unsafe), /Operação recusada/);
    }
});

test('integração confirma banco selecionado e MySQL 8 antes da limpeza', async () => {
    const queries = [];
    const connection = { query: async (sql) => {
        queries.push(sql);
        if (/DATABASE/.test(sql)) return [[{ database_name: 'vitalis_pacientes_m5_test' }]];
        return [[{ version: '8.0.40' }]];
    } };
    const result = await confirmPatientTestEnvironment(connection, 'vitalis_pacientes_m5_test');
    assert.deepEqual(result, { database: 'vitalis_pacientes_m5_test', version: '8.0.40' });
    assert.deepEqual(queries, ['SELECT DATABASE() AS database_name', 'SELECT VERSION() AS version']);
});

test('rollback MySQL usa CHECK real e exclusivo do cenário sintético', async () => {
    const source = await require('node:fs').promises.readFile(__filename, 'utf8');
    const integration = source.slice(
        source.indexOf("test('MySQL 8 valida cadastro"),
        source.indexOf("test('integração destrutiva")
    );
    assert.match(integration, /ALTER TABLE auditoria[\s\S]*ADD CONSTRAINT chk_paciente_rollback_teste[\s\S]*JSON_EXTRACT/);
    assert.doesNotMatch(integration, /CREATE\s+TRIGGER|SUPER|log_bin_trust_function_creators/i);
});
