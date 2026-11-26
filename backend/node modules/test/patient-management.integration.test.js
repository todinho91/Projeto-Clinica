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

function testCpf(base) {
    let cpf = String(base).replace(/\D/g, '').padStart(9, '0').slice(-9);
    for (let length = 9; length <= 10; length += 1) {
        let sum = 0;
        for (let index = 0; index < length; index += 1) {
            sum += Number(cpf[index]) * (length + 1 - index);
        }
        const remainder = (sum * 10) % 11;
        cpf += String(remainder === 10 ? 0 : remainder);
    }
    return cpf;
}

function patientRequest(clinicId, userId, membershipVersion, overrides = {}) {
    return {
        tenant: { clinicId, role: 'administrador' }, userId,
        auth: { membershipVersion },
        body: {
            nome: 'Paciente Integração', email: 'paciente.integracao@example.test',
            telefone: '41999990000', data_nascimento: '1990-01-15', status: 'ativo',
            cpf: testCpf(123456789), cep: '86300000', logradouro: 'Rua Integração',
            numero: '100', complemento: '', bairro: 'Centro',
            cidade: 'Cornélio Procópio', uf: 'PR', ...overrides
        }
    };
}

async function resetSchema(connection, database) {
    await confirmPatientTestEnvironment(connection, database);
    const tables = [
        'prontuario_versoes', 'prontuario_registros',
        'pacientes_identificacao_administrativa',
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
        JWT_SECRET: randomBytes(32).toString('hex'),
        PATIENT_CPF_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        PATIENT_CPF_INDEX_KEY: randomBytes(32).toString('base64'),
        PATIENT_CPF_KEY_ID: 'integration-key-v1'
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

        const [actors] = await setup.execute(`
            INSERT INTO usuarios (nome, email, senha_hash, status, motivo_bloqueio) VALUES
            ('Profissional A', 'profissional.a.paciente@example.test', ?, 'ativo', 'nenhum'),
            ('Profissional B', 'profissional.b.paciente@example.test', ?, 'ativo', 'nenhum'),
            ('Secretaria Norte', 'secretaria.norte.paciente@example.test', ?, 'ativo', 'nenhum'),
            ('Paciente Titular', 'paciente.integracao@example.test', ?, 'ativo', 'nenhum'),
            ('Profissional Sul', 'profissional.sul.paciente@example.test', ?, 'ativo', 'nenhum')
        `, [hash, hash, hash, hash, hash]);
        const [profA, profB, secretary, patientUser, profSouth] = Array.from(
            { length: 5 }, (_, index) => Number(actors.insertId) + index
        );
        await setup.execute(`
            INSERT INTO clinica_usuarios (clinica_id, usuario_id, papel, status) VALUES
            (?, ?, 'profissional', 'ativo'), (?, ?, 'profissional', 'ativo'),
            (?, ?, 'secretaria', 'ativo'), (?, ?, 'paciente', 'ativo'),
            (?, ?, 'profissional', 'ativo')
        `, [northId, profA, northId, profB, northId, secretary, northId, patientUser, southId, profSouth]);
        const [[linkedPatient]] = await setup.execute(
            'SELECT id FROM pacientes WHERE clinica_id = ? AND email = ?',
            [northId, 'paciente.integracao@example.test']
        );
        await setup.execute('UPDATE pacientes SET usuario_id = ? WHERE clinica_id = ? AND id = ?',
            [patientUser, northId, linkedPatient.id]);
        const [southPatientResult] = await setup.execute(`
            INSERT INTO pacientes (clinica_id, nome, email, telefone, data_nascimento, status)
            VALUES (?, 'Paciente Sul', 'paciente.sul@example.test', '41900000000', '1990-01-01', 'ativo')
        `, [southId]);
        const southPatientId = Number(southPatientResult.insertId);
        const [profiles] = await setup.execute(`
            INSERT INTO profissionais (clinica_id, usuario_id, nome_exibicao, status) VALUES
            (?, ?, 'Profissional A', 'ativo'), (?, ?, 'Profissional B', 'ativo'),
            (?, ?, 'Profissional Sul', 'ativo')
        `, [northId, profA, northId, profB, southId, profSouth]);
        const [profileRows] = await setup.execute(`
            SELECT id, clinica_id, usuario_id FROM profissionais
            WHERE (clinica_id = ? AND usuario_id IN (?, ?)) OR (clinica_id = ? AND usuario_id = ?)
        `, [northId, profA, profB, southId, profSouth]);
        const profileA = Number(profileRows.find((row) => Number(row.usuario_id) === profA).id);
        const profileB = Number(profileRows.find((row) => Number(row.usuario_id) === profB).id);
        const profileSouth = Number(profileRows.find((row) => Number(row.usuario_id) === profSouth).id);
        const [specialty] = await setup.execute(
            "INSERT INTO especialidades (clinica_id, nome, status) VALUES (?, 'Clínica Geral', 'ativa')",
            [northId]
        );
        const [appointments] = await setup.execute(`
            INSERT INTO consultas (clinica_id, paciente_id, profissional_id, especialidade_id,
                inicio_em, fim_em, status, criado_por_usuario_id) VALUES
            (?, ?, ?, ?, '2030-01-01 12:00:00', '2030-01-01 12:30:00', 'realizada', ?),
            (?, ?, ?, ?, '2030-01-02 12:00:00', '2030-01-02 12:30:00', 'confirmada', ?)
        `, [northId, linkedPatient.id, profileA, specialty.insertId, northAdmin,
            northId, linkedPatient.id, profileB, specialty.insertId, northAdmin]);
        const appointmentA = Number(appointments.insertId);
        const appointmentB = appointmentA + 1;
        await setup.execute(`
            INSERT INTO documentos_clinicos (clinica_id, paciente_id, titulo, storage_key,
                mime_type, tamanho_bytes, status, enviado_por_usuario_id) VALUES
            (?, ?, 'Documento A', 'fixture/a.pdf', 'application/pdf', 12, 'ativo', ?),
            (?, ?, 'Documento B', 'fixture/b.pdf', 'application/pdf', 12, 'ativo', ?),
            (?, ?, 'Documento Admin', 'fixture/admin.pdf', 'application/pdf', 12, 'ativo', ?)
        `, [northId, linkedPatient.id, profA, northId, linkedPatient.id, profB,
            northId, linkedPatient.id, northAdmin]);
        await setup.execute(`
            INSERT INTO consultas_historico (clinica_id, consulta_id, versao, acao,
                status_novo, inicio_novo, fim_novo, alterado_por_usuario_id)
            VALUES (?, ?, 1, 'agendada', 'realizada', '2030-01-01 12:00:00', '2030-01-01 12:30:00', ?),
                   (?, ?, 1, 'agendada', 'confirmada', '2030-01-02 12:00:00', '2030-01-02 12:30:00', ?)
        `, [northId, appointmentA, northAdmin, northId, appointmentB, northAdmin]);
        const detailsFor = async (clinicId, role, userId, patientId) => {
            const result = response();
            await controller.getPacienteDetails({
                params: { id: String(patientId) }, userId,
                tenant: { clinicId, role, isPractice: false }
            }, result);
            return result;
        };
        const professionalAView = await detailsFor(northId, 'profissional', profA, linkedPatient.id);
        assert.equal(professionalAView.statusCode, 200);
        assert.deepEqual(professionalAView.body.consultas.map((item) => Number(item.id)), [appointmentA]);
        assert.deepEqual(professionalAView.body.documentos.map((item) => item.titulo), ['Documento A']);
        const professionalBView = await detailsFor(northId, 'profissional', profB, linkedPatient.id);
        assert.equal(professionalBView.statusCode, 200);
        assert.deepEqual(professionalBView.body.consultas.map((item) => Number(item.id)), [appointmentB]);
        assert.deepEqual(professionalBView.body.documentos.map((item) => item.titulo), ['Documento B']);
        await setup.execute("UPDATE profissionais SET status = 'inativo' WHERE clinica_id = ? AND id = ?",
            [northId, profileA]);
        assert.equal((await detailsFor(northId, 'profissional', profA, linkedPatient.id)).statusCode, 404,
            'perfil profissional inativo não autoriza detalhes');
        await setup.execute("UPDATE profissionais SET status = 'ativo' WHERE clinica_id = ? AND id = ?",
            [northId, profileA]);
        await setup.execute("UPDATE clinica_usuarios SET status = 'inativo' WHERE clinica_id = ? AND usuario_id = ?",
            [northId, profA]);
        assert.equal((await detailsFor(northId, 'profissional', profA, linkedPatient.id)).statusCode, 404,
            'vínculo revogado não autoriza detalhes');
        await setup.execute("UPDATE clinica_usuarios SET status = 'ativo' WHERE clinica_id = ? AND usuario_id = ?",
            [northId, profA]);
        await setup.execute("UPDATE consultas SET status = 'cancelada' WHERE clinica_id = ? AND id = ?",
            [northId, appointmentA]);
        assert.equal((await detailsFor(northId, 'profissional', profA, linkedPatient.id)).statusCode, 404,
            'consulta cancelada não autoriza detalhes');
        await setup.execute("UPDATE consultas SET status = 'realizada' WHERE clinica_id = ? AND id = ?",
            [northId, appointmentA]);
        for (const [role, userId] of [['paciente', patientUser], ['secretaria', secretary], ['administrador', northAdmin]]) {
            const authorizedView = await detailsFor(northId, role, userId, linkedPatient.id);
            assert.equal(authorizedView.statusCode, 200);
            assert.equal(authorizedView.body.consultas.length, 2);
            assert.equal(authorizedView.body.documentos.length, 3);
        }
        assert.equal((await detailsFor(southId, 'profissional', profSouth, linkedPatient.id)).statusCode, 404);
        assert.equal((await detailsFor(northId, 'profissional', profA, southPatientId)).statusCode, 404);

        const historyController = require('../controllers/consultaController');
        const historyFor = async (userId, appointmentId) => {
            const result = response();
            await historyController.getHistory({
                params: { id: String(appointmentId) }, userId,
                tenant: { clinicId: northId, role: 'profissional' }
            }, result);
            return result;
        };
        assert.equal((await historyFor(profA, appointmentA)).statusCode, 200);
        assert.equal((await historyFor(profA, appointmentB)).statusCode, 404);


        const duplicateCpf = response();
        await controller.createPatient(patientRequest(northId, northAdmin, northMembershipVersion, {
            nome: 'Outro Nome Mesmo CPF', email: 'outro.cpf@example.test', telefone: '41999990001'
        }), duplicateCpf);
        assert.equal(duplicateCpf.statusCode, 409);
        assert.equal(duplicateCpf.body.code, 'PATIENT_DUPLICATE');

        const incomplete = response();
        await controller.createPatient(patientRequest(northId, northAdmin, northMembershipVersion, {
            nome: 'José Cadastro Incompleto', data_nascimento: '', numero: ''
        }), incomplete);
        assert.equal(incomplete.statusCode, 400);

        const exception = response();
        await controller.createPatient(patientRequest(northId, northAdmin, northMembershipVersion, {
            nome: 'José Cadastro Excepcional', email: '', telefone: '',
            cpf: '', cpf_excecao: 'nao_possui', cep: '', logradouro: '', numero: '',
            bairro: '', cidade: '', uf: '', endereco_excecao: 'sem_endereco_convencional'
        }), exception);
        assert.equal(exception.statusCode, 201);

        const [legacyInsert] = await setup.execute(`
            INSERT INTO pacientes (
                clinica_id, usuario_id, nome, email, telefone, preferencia_contato,
                data_nascimento, status
            ) VALUES (?, NULL, 'Paciente Histórico MySQL', NULL, NULL, 'nenhum', NULL, 'ativo')
        `, [northId]);
        const legacyId = Number(legacyInsert.insertId);
        const legacyEdit = response();
        await controller.updatePatient({
            ...patientRequest(northId, northAdmin, northMembershipVersion, {
                nome: 'Paciente Histórico MySQL', email: 'historico.mysql@example.test',
                telefone: '', data_nascimento: '', cpf: '', cep: '', logradouro: '',
                numero: '', complemento: '', bairro: '', cidade: '', uf: '',
                manter_cadastro_pendente: true
            }),
            params: { id: String(legacyId) }
        }, legacyEdit);
        assert.equal(legacyEdit.statusCode, 200);
        const [[legacyPending]] = await setup.execute(`
            SELECT COUNT(*) AS total FROM pacientes_identificacao_administrativa
            WHERE clinica_id = ? AND paciente_id = ?
        `, [northId, legacyId]);
        assert.equal(Number(legacyPending.total), 0);
        const legacyComplete = response();
        await controller.updatePatient({
            ...patientRequest(northId, northAdmin, northMembershipVersion, {
                nome: 'Paciente Histórico MySQL', email: 'historico.mysql@example.test',
                telefone: '', data_nascimento: '1975-04-12', cpf: testCpf(123456786)
            }),
            params: { id: String(legacyId) }
        }, legacyComplete);
        assert.equal(legacyComplete.statusCode, 200);
        const [[legacyStatus]] = await setup.execute(`
            SELECT cadastro_status FROM pacientes_identificacao_administrativa
            WHERE clinica_id = ? AND paciente_id = ?
        `, [northId, legacyId]);
        assert.equal(legacyStatus.cadastro_status, 'completo');

        const homonymBase = response();
        await controller.createPatient(patientRequest(northId, northAdmin, northMembershipVersion, {
            nome: 'Ana Homônima', email: '', telefone: '', data_nascimento: '1980-02-10',
            cpf: testCpf(123456780)
        }), homonymBase);
        assert.equal(homonymBase.statusCode, 201);
        const homonymNeedsReview = response();
        await controller.createPatient(patientRequest(northId, northAdmin, northMembershipVersion, {
            nome: 'ana homonima', email: '', telefone: '', data_nascimento: '1990-03-20',
            cpf: testCpf(123456781)
        }), homonymNeedsReview);
        assert.equal(homonymNeedsReview.statusCode, 409);
        assert.equal(homonymNeedsReview.body.code, 'PATIENT_REVIEW_REQUIRED');
        const homonymReviewed = response();
        await controller.createPatient(patientRequest(northId, northAdmin, northMembershipVersion, {
            nome: 'ana homonima', email: '', telefone: '', data_nascimento: '1990-03-20',
            cpf: testCpf(123456781), revisao_duplicidade: true,
            motivo_revisao: 'homonimo_confirmado'
        }), homonymReviewed);
        assert.equal(homonymReviewed.statusCode, 201);

        const familyFirst = response();
        await controller.createPatient(patientRequest(northId, northAdmin, northMembershipVersion, {
            nome: 'Contato Familiar Um', email: '', telefone: '41988887777',
            data_nascimento: '1985-01-01', cpf: testCpf(123456782)
        }), familyFirst);
        assert.equal(familyFirst.statusCode, 201);
        const familyReviewed = response();
        await controller.createPatient(patientRequest(northId, northAdmin, northMembershipVersion, {
            nome: 'Contato Familiar Dois', email: '', telefone: '41988887777', data_nascimento: '2010-01-01',
            cpf: testCpf(123456783), revisao_duplicidade: true,
            motivo_revisao: 'contato_compartilhado'
        }), familyReviewed);
        assert.equal(familyReviewed.statusCode, 201);

        const familyEmail = 'familia.compartilhada@example.test';
        const contactA = {
            nome: 'Responsável Contato Email', email: familyEmail, telefone: '',
            data_nascimento: '1978-06-10', cpf: testCpf(223456780)
        };
        const contactB = {
            nome: 'Dependente Contato Email', email: ' FAMILIA.COMPARTILHADA@example.test ',
            telefone: '', data_nascimento: '2012-09-20', cpf: testCpf(223456781)
        };
        const firstContact = response();
        await controller.createPatient(patientRequest(northId, northAdmin, northMembershipVersion, contactA), firstContact);
        assert.equal(firstContact.statusCode, 201);
        const emailReview = response();
        await controller.createPatient(patientRequest(northId, northAdmin, northMembershipVersion, contactB), emailReview);
        assert.equal(emailReview.statusCode, 409);
        assert.equal(emailReview.body.code, 'PATIENT_REVIEW_REQUIRED');
        assert.equal(emailReview.body.revisao_permitida, true);
        const review = { revisao_duplicidade: true, motivo_revisao: 'contato_compartilhado' };
        const sharedEmail = response();
        await controller.createPatient(patientRequest(northId, northAdmin, northMembershipVersion, { ...contactB, ...review }), sharedEmail);
        assert.equal(sharedEmail.statusCode, 201);
        const [familyRows] = await setup.execute(
            'SELECT id, usuario_id FROM pacientes WHERE clinica_id = ? AND email = ? ORDER BY id', [northId, familyEmail]
        );
        assert.equal(familyRows.length, 2);
        assert.ok(familyRows.every(row => row.usuario_id === null));
        assert.notEqual(firstContact.body.id, sharedEmail.body.id);

        const repeatedCpfReviewed = response();
        await controller.createPatient(patientRequest(northId, northAdmin, northMembershipVersion, {
            ...contactB, ...review, nome: 'Outro Nome Mesmo CPF Compartilhado'
        }), repeatedCpfReviewed);
        assert.equal(repeatedCpfReviewed.statusCode, 409);
        assert.equal(repeatedCpfReviewed.body.code, 'PATIENT_DUPLICATE');

        const contactC = {
            nome: 'Terceiro Contato Email', email: 'terceiro.contato@example.test', telefone: '',
            data_nascimento: '2015-02-10', cpf: testCpf(223456782)
        };
        const thirdContact = response();
        await controller.createPatient(patientRequest(northId, northAdmin, northMembershipVersion, contactC), thirdContact);
        assert.equal(thirdContact.statusCode, 201);
        const [[cpfBeforeSharedEdit]] = await setup.execute(
            'SELECT cpf_cifrado, cpf_iv, cpf_auth_tag, cpf_busca_hash, cpf_final, cpf_chave_id FROM pacientes_identificacao_administrativa WHERE clinica_id = ? AND paciente_id = ?',
            [northId, thirdContact.body.id]
        );
        const editShared = response();
        await controller.updatePatient({
            ...patientRequest(northId, northAdmin, northMembershipVersion, {
                ...contactC, email: familyEmail, cpf: '', preservar_cpf: true, ...review
            }),
            params: { id: String(thirdContact.body.id) }
        }, editShared);
        assert.equal(editShared.statusCode, 200);
        const [[editedContact]] = await setup.execute(
            'SELECT email, usuario_id FROM pacientes WHERE clinica_id = ? AND id = ?', [northId, thirdContact.body.id]
        );
        assert.equal(editedContact.email, familyEmail);
        assert.equal(editedContact.usuario_id, null);
        const [[cpfAfterSharedEdit]] = await setup.execute(
            'SELECT cpf_cifrado, cpf_iv, cpf_auth_tag, cpf_busca_hash, cpf_final, cpf_chave_id FROM pacientes_identificacao_administrativa WHERE clinica_id = ? AND paciente_id = ?',
            [northId, thirdContact.body.id]
        );
        assert.ok(cpfBeforeSharedEdit && cpfAfterSharedEdit, 'identificação protegida deve existir');
        assert.deepEqual(cpfAfterSharedEdit, cpfBeforeSharedEdit, 'alteração de contato não deve substituir o CPF protegido');

        const isolatedContact = response();
        await controller.createPatient(patientRequest(southId, southAdmin, southMembershipVersion, contactA), isolatedContact);
        assert.equal(isolatedContact.statusCode, 201);

        const publicSharedContact = response();
        await authController.register({ body: {
            nome: 'Tentativa de Cadastro com Contato Familiar', email: familyEmail,
            senha: 'senha-ficticia-forte', clinica_slug: 'norte-pacientes-test'
        } }, publicSharedContact);
        assert.equal(publicSharedContact.statusCode, 409);
        const [[sharedLoginCount]] = await setup.execute('SELECT COUNT(*) AS total FROM usuarios WHERE email = ?', [familyEmail]);
        assert.equal(Number(sharedLoginCount.total), 0);

        const noCpf = {
            nome: 'Paciente Exceção Concorrente', email: '', telefone: '',
            data_nascimento: '1992-01-15', cpf: '', cpf_excecao: 'nao_possui'
        };
        const noCpfFirst = response();
        const noCpfSecond = response();
        await Promise.all([
            controller.createPatient(patientRequest(northId, northAdmin, northMembershipVersion, noCpf), noCpfFirst),
            controller.createPatient(patientRequest(northId, northAdmin, northMembershipVersion, noCpf), noCpfSecond)
        ]);
        assert.deepEqual([noCpfFirst.statusCode, noCpfSecond.statusCode].sort(), [201, 409]);
        const noCpfReviewed = response();
        await controller.createPatient(patientRequest(northId, northAdmin, northMembershipVersion, { ...noCpf, ...review }), noCpfReviewed);
        assert.equal(noCpfReviewed.statusCode, 409);
        assert.equal(noCpfReviewed.body.code, 'PATIENT_DUPLICATE');

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
            data_nascimento: '2001-02-02', cpf: testCpf(123456784), revisao_duplicidade: true,
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
        const [[northProtected], [southProtected]] = await Promise.all([
            setup.execute(`SELECT cpf_cifrado, cpf_busca_hash FROM pacientes_identificacao_administrativa
                WHERE clinica_id = ? AND cadastro_status = 'completo' ORDER BY paciente_id LIMIT 1`, [northId]),
            setup.execute(`SELECT cpf_cifrado, cpf_busca_hash FROM pacientes_identificacao_administrativa
                WHERE clinica_id = ? AND cadastro_status = 'completo' ORDER BY paciente_id LIMIT 1`, [southId])
        ]);
        assert.equal(northProtected[0].cpf_cifrado.includes(Buffer.from(testCpf(123456789))), false);
        assert.equal(northProtected[0].cpf_busca_hash.equals(southProtected[0].cpf_busca_hash), false);

        const isolatedIncomplete = response();
        await controller.createPatient(patientRequest(southId, southAdmin, southMembershipVersion, {
            nome: 'José Cadastro Excepcional', email: '', telefone: '',
            cpf: '', cpf_excecao: 'nao_possui', cep: '', logradouro: '', numero: '',
            bairro: '', cidade: '', uf: '', endereco_excecao: 'sem_endereco_convencional'
        }), isolatedIncomplete);
        assert.equal(isolatedIncomplete.statusCode, 201, 'exceções iguais são isoladas por clínica');

        const appropriationEmail = 'paciente.administrativo.apropriacao@example.test';
        const [administrativePatient] = await setup.execute(`
            INSERT INTO pacientes (clinica_id, usuario_id, nome, email, telefone, data_nascimento, status)
            VALUES (?, NULL, 'Paciente Administrativo Sintético', ?, NULL, '1988-06-12', 'ativo')
        `, [northId, appropriationEmail]);
        assert.ok(Number(administrativePatient.insertId) > 0);
        const publicRegistration = response();
        await authController.register({ body: {
            nome: 'Tentativa de Apropriação',
            email: appropriationEmail,
            senha: 'senha-ficticia-forte',
            clinica_slug: 'norte-pacientes-test'
        } }, publicRegistration);
        assert.equal(publicRegistration.statusCode, 409);
        const [[partialIdentity]] = await setup.execute(
            'SELECT COUNT(*) AS total FROM usuarios WHERE email = ?',
            [appropriationEmail]
        );
        const [[partialMembership]] = await setup.execute(`
            SELECT COUNT(*) AS total
            FROM clinica_usuarios cu
            JOIN usuarios u ON u.id = cu.usuario_id
            WHERE cu.clinica_id = ? AND u.email = ?
        `, [northId, appropriationEmail]);
        const [[preservedAdministrativePatient]] = await setup.execute(`
            SELECT usuario_id FROM pacientes WHERE clinica_id = ? AND id = ? AND email = ?
        `, [northId, administrativePatient.insertId, appropriationEmail]);
        assert.equal(Number(partialIdentity.total), 0);
        assert.equal(Number(partialMembership.total), 0);
        assert.equal(preservedAdministrativePatient.usuario_id, null);

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
                telefone: '41999991111', data_nascimento: '1984-03-08', status: 'inativo',
                cpf: testCpf(123456785)
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
    assert.equal(assertPatientDisposableDatabaseName('vitalis_pacientes_seguridad_test'), 'vitalis_pacientes_seguridad_test');
    for (const unsafe of ['vitalis_pacientes_visual_m5_test', 'vitalis_m3_validacao', 'vitalis_dev', 'vitalis_backend_test', 'vitalis_pacientes_test_backup']) {
        assert.throws(() => assertPatientDisposableDatabaseName(unsafe), /Operação recusada/);
    }
});

test('integração confirma banco selecionado e MySQL 8 antes da limpeza', async () => {
    const queries = [];
    const connection = { query: async (sql) => {
        queries.push(sql);
        if (/DATABASE/.test(sql)) return [[{ database_name: 'vitalis_pacientes_seguridad_test' }]];
        return [[{ version: '8.0.40' }]];
    } };
    const result = await confirmPatientTestEnvironment(connection, 'vitalis_pacientes_seguridad_test');
    assert.deepEqual(result, { database: 'vitalis_pacientes_seguridad_test', version: '8.0.40' });
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
