const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { test } = require('node:test');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const { loadDatabaseConfig } = require('../scripts/db/config');
const { runMigrations } = require('../scripts/db/migrator');
const {
    assertPracticeDisposableDatabaseName,
    confirmPracticeTestEnvironment
} = require('../support/mysql-test-safety');

const enabled = process.env.PRACTICE_INTEGRATION_TEST === '1';
const migrationsDir = path.join(__dirname, '..', '..', 'database', 'migrations');

function response() {
    return {
        statusCode: null, body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
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

function patientIdentification(base) {
    return {
        cpf: testCpf(base), cep: '01001000', logradouro: 'Praça da Sé',
        numero: String(base), complemento: '', bairro: 'Sé', cidade: 'São Paulo', uf: 'SP'
    };
}

async function resetSchema(connection, database) {
    await confirmPracticeTestEnvironment(connection, database);
    const [rows] = await connection.query(`
        SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?
    `, [database]);
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        for (const row of rows) {
            const table = String(row.TABLE_NAME).replace(/`/g, '');
            await connection.query(`DROP TABLE IF EXISTS \`${table}\``);
        }
    } finally { await connection.query('SET FOREIGN_KEY_CHECKS = 1'); }
}

async function createOperator(connection, suffix) {
    const hash = await bcrypt.hash(randomBytes(24).toString('hex'), 4);
    const [operatorUser] = await connection.execute(`
        INSERT INTO usuarios (nome, email, senha_hash, status, motivo_bloqueio)
        VALUES (?, ?, ?, 'ativo', 'nenhum')
    `, [`Operador ${suffix}`, `operador.${suffix}@example.test`, hash]);
    const [operator] = await connection.execute(`
        INSERT INTO operadores_plataforma (usuario_id, status) VALUES (?, 'ativo')
    `, [operatorUser.insertId]);
    return { userId: Number(operatorUser.insertId), operatorId: Number(operator.insertId) };
}

async function registerAndVerifyProfessional(connection, controllers, operatorUserId, suffix) {
    const registration = response();
    await controllers.auth.registerProfessional({ body: {
        nome: `Profissional ${suffix}`,
        email: `profissional.${suffix}@example.test`,
        senha: `senha-profissional-${suffix}-segura`,
        tipo_profissional: 'Médico', conselho_tipo: 'CRM',
        conselho_numero: `M3${suffix}`, conselho_uf: 'SP'
    } }, registration);
    assert.equal(registration.statusCode, 201);
    const [[user]] = await connection.execute(
        'SELECT id FROM usuarios WHERE email = ?', [`profissional.${suffix}@example.test`]
    );
    const [[before]] = await connection.execute(`
        SELECT COUNT(*) AS total FROM clinica_usuarios WHERE usuario_id = ?
    `, [user.id]);
    assert.equal(Number(before.total), 0);
    const verification = response();
    await controllers.practice.verifyIdentity({
        userId: operatorUserId,
        params: { userId: String(user.id) },
        body: { status_verificacao: 'verificada' }
    }, verification);
    assert.equal(verification.statusCode, 200);
    return Number(user.id);
}

test('MySQL 8 valida fluxo completo, concorrência, rollback e isolamento de consultórios', {
    skip: !enabled
}, async () => {
    const config = loadDatabaseConfig(process.env, 'TEST_DB_');
    assertPracticeDisposableDatabaseName(config.database);
    Object.assign(process.env, {
        DB_HOST: config.host, DB_PORT: String(config.port), DB_USER: config.user,
        DB_PASSWORD: config.password, DB_DATABASE: config.database,
        JWT_SECRET: randomBytes(32).toString('hex'), MAIL_PROVIDER: 'disabled',
        APP_PUBLIC_ORIGIN: 'http://127.0.0.1:5500',
        PATIENT_CPF_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        PATIENT_CPF_INDEX_KEY: randomBytes(32).toString('base64'),
        PATIENT_CPF_KEY_ID: 'practice-integration-v1'
    });
    const setup = await mysql.createConnection({ ...config, multipleStatements: true });
    let pool;
    let originalSendInvitation;
    try {
        await resetSchema(setup, config.database);
        await runMigrations({ connection: setup, migrationsDir, logger: { info() {} } });
        pool = require('../config/database');
        const invitationMailer = require('../services/invitation-mailer');
        let capturedInvitationToken = null;
        originalSendInvitation = invitationMailer.sendInvitation;
        invitationMailer.sendInvitation = async (payload) => {
            capturedInvitationToken = payload.token;
            return {
                status: 'accepted_by_provider',
                delivered: false,
                providerMessageId: 'local-integration-test'
            };
        };
        const controllers = {
            auth: require('../controllers/authController'),
            practice: require('../controllers/consultorioController'),
            specialty: require('../controllers/especialidadeController'),
            availability: require('../controllers/disponibilidadeController'),
            patient: require('../controllers/pacienteController'),
            appointment: require('../controllers/consultaController'),
            confirmation: require('../controllers/confirmacaoConsultaController'),
            team: require('../controllers/equipeController')
        };
        const operator = await createOperator(setup, 'm3');
        const ownerA = await registerAndVerifyProfessional(
            setup, controllers, operator.userId, 'a'
        );
        const ownerB = await registerAndVerifyProfessional(
            setup, controllers, operator.userId, 'b'
        );
        const payloadA = {
            nome: 'Consultório A', slug: 'consultorio-a', timezone: 'America/Sao_Paulo',
            nome_exibicao: 'Profissional A'
        };
        const first = response(); const concurrent = response();
        await Promise.all([
            controllers.practice.provision({ userId: ownerA, body: payloadA }, first),
            controllers.practice.provision({ userId: ownerA, body: payloadA }, concurrent)
        ]);
        assert.deepEqual([first.statusCode, concurrent.statusCode].sort(), [201, 409]);
        const clinicA = Number((first.statusCode === 201 ? first : concurrent).body.id);
        const [[complete]] = await setup.execute(`
            SELECT cp.titular_usuario_id, cu.papel, cu.status AS vinculo_status,
                   p.status AS profissional_status
            FROM consultorios_profissionais cp
            JOIN clinica_usuarios cu ON cu.clinica_id = cp.clinica_id
              AND cu.usuario_id = cp.titular_usuario_id
            JOIN profissionais p ON p.clinica_id = cp.clinica_id
              AND p.usuario_id = cp.titular_usuario_id
            WHERE cp.clinica_id = ?
        `, [clinicA]);
        assert.deepEqual({
            titular_usuario_id: Number(complete.titular_usuario_id), papel: complete.papel,
            vinculo_status: complete.vinculo_status, profissional_status: complete.profissional_status
        }, {
            titular_usuario_id: ownerA, papel: 'profissional',
            vinculo_status: 'ativo', profissional_status: 'ativo'
        });

        await setup.query(`ALTER TABLE consultorios_profissionais
            ADD CONSTRAINT chk_consultorio_rollback_teste CHECK (titular_usuario_id <> ${ownerB})`);
        const failed = response();
        await controllers.practice.provision({ userId: ownerB, body: {
            nome: 'Consultório Rollback', slug: 'consultorio-rollback',
            timezone: 'America/Sao_Paulo', nome_exibicao: 'Profissional B'
        } }, failed);
        assert.equal(failed.statusCode, 500);
        const [[rolledBack]] = await setup.execute(`
            SELECT COUNT(*) AS total FROM clinicas WHERE slug = 'consultorio-rollback'
        `);
        assert.equal(Number(rolledBack.total), 0);
        await setup.query(`ALTER TABLE consultorios_profissionais
            DROP CHECK chk_consultorio_rollback_teste`);

        const second = response();
        await controllers.practice.provision({ userId: ownerB, body: {
            nome: 'Consultório B', slug: 'consultorio-b', timezone: 'America/Manaus',
            nome_exibicao: 'Profissional B'
        } }, second);
        assert.equal(second.statusCode, 201);
        const clinicB = Number(second.body.id);

        const [[ownerProfile]] = await setup.execute(`
            SELECT p.id AS profissional_id, cu.sessao_versao
            FROM profissionais p
            JOIN clinica_usuarios cu ON cu.clinica_id = p.clinica_id
              AND cu.usuario_id = p.usuario_id
            WHERE p.clinica_id = ? AND p.usuario_id = ?
        `, [clinicA, ownerA]);
        const ownerRequest = {
            userId: ownerA,
            auth: { membershipVersion: Number(ownerProfile.sessao_versao) },
            tenant: { clinicId: clinicA, role: 'profissional', isPractice: true },
            workspaceOwner: true
        };

        const specialty = response();
        await controllers.specialty.createSpecialty({
            ...ownerRequest, body: { nome: 'Clínica médica' }
        }, specialty);
        assert.equal(specialty.statusCode, 201);
        const [[specialtyLink]] = await setup.execute(`
            SELECT COUNT(*) AS total FROM profissional_especialidades
            WHERE clinica_id = ? AND profissional_id = ? AND especialidade_id = ?
        `, [clinicA, ownerProfile.profissional_id, specialty.body.id]);
        assert.equal(Number(specialtyLink.total), 1);

        const availability = response();
        await controllers.availability.replaceWeeklyAvailability({
            ...ownerRequest,
            params: { professionalId: String(ownerProfile.profissional_id) },
            body: { intervalos: Array.from({ length: 7 }, (_, day) => ({
                dia_semana: day, tipo: 'atendimento', inicio: '08:00', fim: '18:00'
            })) }
        }, availability);
        assert.equal(availability.statusCode, 200);

        const patient = response();
        await controllers.patient.createPatient({
            ...ownerRequest,
            body: {
                nome: 'Paciente Sintético M3', email: 'paciente.m3@example.test',
                telefone: '11987654321', preferencia_contato: 'whatsapp',
                data_nascimento: '1990-01-15', status: 'ativo',
                ...patientIdentification(101)
            }
        }, patient);
        assert.equal(patient.statusCode, 201);

        const future = new Date(Date.now() + 7 * 86400000);
        const localDate = `${future.getUTCFullYear()}-${String(future.getUTCMonth() + 1).padStart(2, '0')}-${String(future.getUTCDate()).padStart(2, '0')}`;
        const appointment = response();
        await controllers.appointment.agendarConsulta({
            ...ownerRequest,
            body: {
                paciente_id: patient.body.id,
                profissional_id: Number(ownerProfile.profissional_id),
                especialidade_id: specialty.body.id,
                inicio_local: `${localDate}T10:00`, duracao_minutos: 30
            }
        }, appointment);
        assert.equal(appointment.statusCode, 201);

        const confirmation = response();
        await controllers.confirmation.requestConfirmation({
            ...ownerRequest,
            params: { id: String(appointment.body.id) },
            body: { versao: 1, canal_esperado: 'whatsapp' }
        }, confirmation);
        assert.equal(confirmation.statusCode, 201);
        assert.equal(confirmation.body.canal_selecionado, 'whatsapp');
        const whatsappText = new URL(confirmation.body.whatsapp_url).searchParams.get('text');
        const token = whatsappText.match(/#token=([A-Za-z0-9_-]+)/)?.[1];
        assert.ok(token);
        const patientAnswer = response();
        await controllers.confirmation.respondPublic({
            body: { token, resposta: 'confirmada' }
        }, patientAnswer);
        assert.equal(patientAnswer.statusCode, 200);
        const [[confirmed]] = await setup.execute(`
            SELECT estado FROM confirmacoes_consulta
            WHERE clinica_id = ? AND consulta_id = ? ORDER BY id DESC LIMIT 1
        `, [clinicA, appointment.body.id]);
        assert.equal(confirmed.estado, 'confirmada');

        const secretary = response();
        await controllers.team.createInvitation({
            ...ownerRequest,
            body: {
                nome: 'Secretária Sintética M3',
                email: 'secretaria.m3@example.test', papel: 'secretaria'
            }
        }, secretary);
        assert.equal(secretary.statusCode, 201);
        assert.ok(capturedInvitationToken);

        const [[pendingSecretary]] = await setup.execute(`
            SELECT cu.id AS vinculo_id, cu.usuario_id, cu.status, cu.sessao_versao,
                   u.status AS usuario_status
            FROM clinica_usuarios cu
            JOIN usuarios u ON u.id = cu.usuario_id
            WHERE cu.clinica_id = ? AND u.email = ?
        `, [clinicA, 'secretaria.m3@example.test']);
        assert.equal(pendingSecretary.status, 'convite_pendente');
        assert.equal(pendingSecretary.usuario_status, 'bloqueado');

        const acceptedInvitation = response();
        await controllers.team.acceptInvitation({
            params: { token: capturedInvitationToken },
            body: { senha: 'senha-secretaria-m3-segura' }
        }, acceptedInvitation);
        assert.equal(acceptedInvitation.statusCode, 200);

        const [[activeSecretary]] = await setup.execute(`
            SELECT cu.id AS vinculo_id, cu.usuario_id, cu.status, cu.sessao_versao,
                   u.status AS usuario_status
            FROM clinica_usuarios cu
            JOIN usuarios u ON u.id = cu.usuario_id
            WHERE cu.id = ? AND cu.clinica_id = ?
        `, [pendingSecretary.vinculo_id, clinicA]);
        assert.equal(activeSecretary.status, 'ativo');
        assert.equal(activeSecretary.usuario_status, 'ativo');
        assert.ok(Number(activeSecretary.sessao_versao) > Number(pendingSecretary.sessao_versao));

        const secretaryRequest = {
            userId: Number(activeSecretary.usuario_id),
            auth: { membershipVersion: Number(activeSecretary.sessao_versao) },
            tenant: { clinicId: clinicA, role: 'secretaria', isPractice: true }
        };
        const secretaryPatient = response();
        await controllers.patient.createPatient({
            ...secretaryRequest,
            body: {
                nome: 'Paciente da Secretária M3',
                email: 'paciente.secretaria.m3@example.test',
                telefone: '11976543210', data_nascimento: '1988-03-20', status: 'ativo',
                ...patientIdentification(102)
            }
        }, secretaryPatient);
        assert.equal(secretaryPatient.statusCode, 201);

        const delegation = response();
        await controllers.team.updatePermissions({
            ...ownerRequest,
            params: { id: String(activeSecretary.vinculo_id) },
            body: { gerenciar_disponibilidade: true }
        }, delegation);
        assert.equal(delegation.statusCode, 200);
        const [[delegatedSecretary]] = await setup.execute(`
            SELECT cu.sessao_versao, cd.gerenciar_disponibilidade
            FROM clinica_usuarios cu
            JOIN consultorio_delegacoes cd
              ON cd.clinica_id = cu.clinica_id AND cd.clinica_usuario_id = cu.id
            WHERE cu.id = ? AND cu.clinica_id = ?
        `, [activeSecretary.vinculo_id, clinicA]);
        assert.equal(Number(delegatedSecretary.gerenciar_disponibilidade), 1);
        assert.ok(Number(delegatedSecretary.sessao_versao) > Number(activeSecretary.sessao_versao));
        const delegatedSecretaryRequest = {
            ...secretaryRequest,
            auth: { membershipVersion: Number(delegatedSecretary.sessao_versao) },
            tenant: {
                ...secretaryRequest.tenant,
                permissions: { manageAvailability: true }
            }
        };

        const delegatedAvailability = response();
        await controllers.availability.replaceWeeklyAvailability({
            ...delegatedSecretaryRequest,
            params: { professionalId: String(ownerProfile.profissional_id) },
            body: { intervalos: Array.from({ length: 7 }, (_, day) => ({
                dia_semana: day, tipo: 'atendimento', inicio: '08:00', fim: '18:00'
            })) }
        }, delegatedAvailability);
        assert.equal(delegatedAvailability.statusCode, 200);

        const archivedPatient = response();
        await controllers.patient.updatePatientStatus({
            ...delegatedSecretaryRequest,
            params: { id: String(secretaryPatient.body.id) },
            body: { status: 'inativo' }
        }, archivedPatient);
        assert.equal(archivedPatient.statusCode, 200);
        const [[archivedState]] = await setup.execute(`
            SELECT status FROM pacientes WHERE clinica_id = ? AND id = ?
        `, [clinicA, secretaryPatient.body.id]);
        assert.equal(archivedState.status, 'inativo');

        const reactivatedPatient = response();
        await controllers.patient.updatePatientStatus({
            ...delegatedSecretaryRequest,
            params: { id: String(secretaryPatient.body.id) },
            body: { status: 'ativo' }
        }, reactivatedPatient);
        assert.equal(reactivatedPatient.statusCode, 200);
        const [[reactivatedState]] = await setup.execute(`
            SELECT status FROM pacientes WHERE clinica_id = ? AND id = ?
        `, [clinicA, secretaryPatient.body.id]);
        assert.equal(reactivatedState.status, 'ativo');

        const revokedSecretary = response();
        await controllers.team.updateStatus({
            ...ownerRequest,
            params: { id: String(activeSecretary.vinculo_id) },
            body: { status: 'inativo' }
        }, revokedSecretary);
        assert.equal(revokedSecretary.statusCode, 200);
        const [[inactiveSecretary]] = await setup.execute(`
            SELECT status, sessao_versao
            FROM clinica_usuarios
            WHERE id = ? AND clinica_id = ?
        `, [activeSecretary.vinculo_id, clinicA]);
        assert.equal(inactiveSecretary.status, 'inativo');
        assert.ok(Number(inactiveSecretary.sessao_versao) > Number(activeSecretary.sessao_versao));
        const [[revokedDelegation]] = await setup.execute(`
            SELECT gerenciar_disponibilidade
            FROM consultorio_delegacoes
            WHERE clinica_id = ? AND clinica_usuario_id = ?
        `, [clinicA, activeSecretary.vinculo_id]);
        assert.equal(Number(revokedDelegation.gerenciar_disponibilidade), 0);

        const accessAfterRevocation = response();
        await controllers.patient.createPatient({
            ...delegatedSecretaryRequest,
            body: {
                nome: 'Acesso Revogado M3', email: 'revogado.m3@example.test',
                telefone: '11970000000', data_nascimento: '1992-06-10', status: 'ativo',
                ...patientIdentification(103)
            }
        }, accessAfterRevocation);
        assert.equal(accessAfterRevocation.statusCode, 403);
        const [[revokedWrite]] = await setup.execute(`
            SELECT COUNT(*) AS total
            FROM pacientes
            WHERE clinica_id = ? AND email = 'revogado.m3@example.test'
        `, [clinicA]);
        assert.equal(Number(revokedWrite.total), 0);

        const [secretaryAudit] = await setup.execute(`
            SELECT acao
            FROM auditoria
            WHERE clinica_id = ?
              AND acao IN ('convite_aceito', 'vinculo_status_alterado')
            ORDER BY id
        `, [clinicA]);
        assert.deepEqual(secretaryAudit.map((row) => row.acao), [
            'convite_aceito', 'vinculo_status_alterado'
        ]);
        const [[delegationAudit]] = await setup.execute(`
            SELECT COUNT(*) AS total
            FROM auditoria
            WHERE clinica_id = ? AND acao = 'delegacao_consultorio_alterada'
              AND entidade_id = ?
        `, [clinicA, activeSecretary.vinculo_id]);
        assert.equal(Number(delegationAudit.total), 1);

        const locationA = response();
        await controllers.practice.createLocation({
            userId: ownerA, tenant: { clinicId: clinicA, role: 'profissional' },
            body: { nome: 'Unidade A', endereco_linha: 'Rua A, 1', cidade: 'São Paulo', uf: 'SP' }
        }, locationA);
        assert.equal(locationA.statusCode, 201);
        const crossTenant = response();
        await controllers.practice.updateLocationStatus({
            userId: ownerB, tenant: { clinicId: clinicB, role: 'profissional' },
            params: { id: locationA.body.id }, body: { status: 'inativo' }
        }, crossTenant);
        assert.equal(crossTenant.statusCode, 404);
        const [[preserved]] = await setup.execute(`
            SELECT status FROM consultorio_locais WHERE clinica_id = ? AND id = ?
        `, [clinicA, locationA.body.id]);
        assert.equal(preserved.status, 'ativo');
        const [[isolatedPatients]] = await setup.execute(`
            SELECT COUNT(*) AS total FROM pacientes WHERE clinica_id = ?
        `, [clinicB]);
        assert.equal(Number(isolatedPatients.total), 0);
    } finally {
        if (originalSendInvitation) {
            require('../services/invitation-mailer').sendInvitation = originalSendInvitation;
        }
        await pool?.end();
        await setup.end();
    }
});

test('proteção destrutiva recusa bancos de demonstração e valida SELECTs antes da limpeza', () => {
    assert.equal(
        assertPracticeDisposableDatabaseName('vitalis_consultorios_local_test'),
        'vitalis_consultorios_local_test'
    );
    for (const unsafe of ['vitalis_m3_validacao', 'vitalis_dev', 'vitalis_consultorios']) {
        assert.throws(() => assertPracticeDisposableDatabaseName(unsafe), /Operação recusada/);
    }
    const source = require('node:fs').readFileSync(__filename, 'utf8');
    assert.ok(source.indexOf('confirmPracticeTestEnvironment') < source.indexOf('DROP TABLE'));
    const safety = require('node:fs').readFileSync(
        path.join(__dirname, '..', 'support', 'mysql-test-safety.js'), 'utf8'
    );
    assert.match(safety, /SELECT DATABASE\(\)/);
    assert.match(safety, /SELECT VERSION\(\)/);
});
