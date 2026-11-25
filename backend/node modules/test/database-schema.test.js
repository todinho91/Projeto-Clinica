const assert = require('node:assert/strict');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const migrationsDir = path.join(__dirname, '..', '..', 'database', 'migrations');

async function schemaSql() {
    const files = (await fs.readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
    return (await Promise.all(files.map((name) => fs.readFile(path.join(migrationsDir, name), 'utf8')))).join('\n');
}

test('migrations criam todas as tabelas previstas para DB-01', async () => {
    const sql = await schemaSql();
    for (const table of [
        'clinicas',
        'usuarios',
        'clinica_usuarios',
        'pacientes',
        'profissionais',
        'especialidades',
        'profissional_especialidades',
        'consultas',
        'documentos_clinicos',
        'auditoria',
        'convites_clinica',
        'operadores_plataforma',
        'auditoria_plataforma',
        'disponibilidades_profissional',
        'bloqueios_profissional',
        'consultas_historico',
        'confirmacoes_consulta',
        'confirmacoes_consulta_eventos',
        'identidades_profissionais',
        'consultorios_profissionais',
        'consultorio_locais',
        'consultorio_delegacoes'
    ]) {
        assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
    }
});

test('migrations não escolhem nem criam banco implicitamente', async () => {
    const sql = await schemaSql();
    assert.doesNotMatch(sql, /\bCREATE\s+DATABASE\b/i);
    assert.doesNotMatch(sql, /\bUSE\s+[a-z0-9_]+/i);
});

test('entidades clínicas possuem chave de tenant e referências compostas', async () => {
    const sql = await schemaSql();
    for (const table of [
        'clinica_usuarios',
        'pacientes',
        'profissionais',
        'especialidades',
        'consultas',
        'documentos_clinicos',
        'auditoria',
        'convites_clinica',
        'disponibilidades_profissional',
        'bloqueios_profissional'
    ]) {
        const block = sql.match(new RegExp(
            `CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\) ENGINE=InnoDB`
        ));
        assert.ok(block, `bloco SQL ausente para ${table}`);
        assert.match(block[1], /clinica_id BIGINT UNSIGNED NOT NULL/);
    }

    assert.match(sql, /FOREIGN KEY \(clinica_id, paciente_id\)[\s\S]*REFERENCES pacientes \(clinica_id, id\)/);
    assert.match(sql, /FOREIGN KEY \(clinica_id, profissional_id\)[\s\S]*REFERENCES profissionais \(clinica_id, id\)/);
    assert.match(sql, /FOREIGN KEY \(clinica_id, especialidade_id\)[\s\S]*REFERENCES especialidades \(clinica_id, id\)/);
});

test('convites persistem somente hash, expiram e referenciam vínculo da mesma clínica', async () => {
    const sql = await fs.readFile(path.join(migrationsDir, '005_team_invitations.sql'), 'utf8');
    assert.match(sql, /token_hash CHAR\(64\)/);
    assert.doesNotMatch(sql, /token_plain|token_texto|senha/);
    assert.match(sql, /expira_em DATETIME\(6\) NOT NULL/);
    assert.match(sql, /FOREIGN KEY \(clinica_id, clinica_usuario_id\)[\s\S]*REFERENCES clinica_usuarios \(clinica_id, id\)/);
    assert.match(sql, /envio_status ENUM\([\s\S]*'accepted_by_provider'[\s\S]*'delivered'[\s\S]*'failed'/);
    assert.match(sql, /provedor_mensagem_id VARCHAR\(200\) NULL/);
    assert.match(sql, /motivo_bloqueio ENUM\('nenhum', 'ativacao_pendente', 'seguranca'\)/);
    assert.match(sql, /sessao_versao INT UNSIGNED NOT NULL DEFAULT 1/);
});

test('consultas exigem período válido, reserva ativa única e histórico tenant-aware', async () => {
    const sql = await fs.readFile(
        path.join(migrationsDir, '009_appointment_management.sql'), 'utf8'
    );
    assert.match(sql, /DROP INDEX uk_consultas_inicio_profissional/);
    assert.match(sql, /GENERATED ALWAYS AS \(CASE WHEN status IN \('agendada', 'confirmada'\)/);
    assert.match(sql, /UNIQUE KEY uk_consultas_reserva_inicio[\s\S]*clinica_id, profissional_id, inicio_em, reserva_ativa/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS consultas_historico/);
    assert.match(sql, /UNIQUE KEY uk_consultas_historico_versao \(clinica_id, consulta_id, versao\)/);
    assert.match(sql, /FOREIGN KEY \(clinica_id, consulta_id\)[\s\S]*REFERENCES consultas \(clinica_id, id\)/);
    assert.doesNotMatch(sql, /TRUNCATE|DELETE FROM/i);
});

test('onboarding profissional adiciona tipo sem criar senha ou convite inseguro no SQL', async () => {
    const sql = await fs.readFile(
        path.join(migrationsDir, '004_professional_onboarding.sql'),
        'utf8'
    );
    assert.match(sql, /ALTER TABLE profissionais[\s\S]*ADD COLUMN tipo_profissional VARCHAR\(80\)/);
    assert.doesNotMatch(sql, /senha|token|convite/i);
});

test('provisionamento usa operador explícito, auditoria e convite sem token puro', async () => {
    const sql = await fs.readFile(
        path.join(migrationsDir, '006_clinic_provisioning.sql'),
        'utf8'
    );
    assert.match(sql, /CREATE TABLE IF NOT EXISTS operadores_plataforma/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS auditoria_plataforma/);
    assert.match(sql, /criado_por_operador_id BIGINT UNSIGNED NULL/);
    assert.match(sql, /CHECK \(\(criado_por_usuario_id IS NOT NULL\) <> \(criado_por_operador_id IS NOT NULL\)\)/);
    assert.doesNotMatch(sql, /INSERT INTO operadores_plataforma|senha|token_hash\s*=\s*['"]/i);
});

test('disponibilidade e bloqueios são aditivos, isolados por tenant e preparados para M4-02', async () => {
    const sql = await fs.readFile(
        path.join(migrationsDir, '007_professional_availability.sql'), 'utf8'
    );
    assert.match(sql, /CREATE TABLE IF NOT EXISTS disponibilidades_profissional/);
    assert.match(sql, /tipo ENUM\('atendimento', 'descanso'\)/);
    assert.match(sql, /CHECK \(fim_local > inicio_local\)/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS bloqueios_profissional/);
    assert.match(sql, /tipo ENUM\('ferias', 'feriado', 'indisponibilidade'\)/);
    assert.match(sql, /CHECK \(fim_em > inicio_em\)/);
    assert.match(sql, /FOREIGN KEY \(clinica_id, profissional_id\)[\s\S]*REFERENCES profissionais \(clinica_id, id\)/);
    assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE|DELETE FROM/i);
});

test('gestão de pacientes adiciona índices tenant-aware sem destruir dados', async () => {
    const sql = await fs.readFile(
        path.join(migrationsDir, '008_patient_management.sql'), 'utf8'
    );
    assert.match(sql, /UNIQUE KEY uk_pacientes_email \(clinica_id, email\)/);
    assert.match(sql, /KEY idx_pacientes_status_nome \(clinica_id, status, nome\)/);
    assert.match(sql, /KEY idx_pacientes_nascimento_nome \(clinica_id, data_nascimento, nome\)/);
    assert.doesNotMatch(sql, /DROP|TRUNCATE|DELETE|UPDATE|INSERT/i);
});

test('confirmações usam hash, expiração, trilha e referências multi-tenant', async () => {
    const sql = await fs.readFile(
        path.join(migrationsDir, '010_appointment_confirmations.sql'), 'utf8'
    );
    assert.match(sql, /token_hash CHAR\(64\) NULL/);
    assert.match(sql, /expira_em DATETIME\(6\) NULL/);
    assert.match(sql, /UNIQUE KEY uk_confirmacoes_token_hash/);
    assert.match(sql, /FOREIGN KEY \(clinica_id, consulta_id\)[\s\S]*REFERENCES consultas \(clinica_id, id\)/);
    assert.match(sql, /FOREIGN KEY \(clinica_id, confirmacao_id\)[\s\S]*REFERENCES confirmacoes_consulta \(clinica_id, id\)/);
    assert.match(sql, /preferencia_contato ENUM\('nenhum', 'whatsapp', 'telefone', 'email'\)/);
    assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE|DELETE FROM|UPDATE pacientes|INSERT INTO pacientes/i);
});

test('delegações do consultório são aditivas, tenant-aware e não apagam vínculos', async () => {
    const sql = await fs.readFile(
        path.join(migrationsDir, '013_practice_delegations.sql'), 'utf8'
    );
    assert.match(sql, /CREATE TABLE IF NOT EXISTS consultorio_delegacoes/);
    assert.match(sql, /PRIMARY KEY \(clinica_id, clinica_usuario_id\)/);
    assert.match(sql, /FOREIGN KEY \(clinica_id, clinica_usuario_id\)[\s\S]*REFERENCES clinica_usuarios \(clinica_id, id\)/);
    assert.match(sql, /FOREIGN KEY \(clinica_id\)[\s\S]*REFERENCES consultorios_profissionais \(clinica_id\)/);
    assert.match(sql, /CHECK \(gerenciar_disponibilidade IN \(0, 1\)\)/);
    assert.doesNotMatch(
        sql,
        /\b(?:DROP|TRUNCATE)\s+TABLE|\bDELETE\s+FROM|\bUPDATE\s+(?:clinica_usuarios|usuarios)\b/i
    );
});

test('pré-voo da migration 008 inclui e-mails vazios e usa a collation real', async () => {
    const documentation = await fs.readFile(
        path.join(__dirname, '..', '..', '..', 'docs', 'M5_1_PACIENTES.md'), 'utf8'
    );
    assert.match(documentation, /WHERE email IS NOT NULL/);
    assert.match(documentation, /GROUP BY clinica_id, email/);
    assert.doesNotMatch(documentation, /TRIM\(email\) <> ''/);
    assert.match(documentation, /inclui e-mails vazios/);
});

test('documentação bloqueia vinculação automática até verificação de titularidade da issue 33', async () => {
    const documentation = await fs.readFile(
        path.join(__dirname, '..', '..', '..', 'docs', 'M5_1_PACIENTES.md'), 'utf8'
    );
    assert.match(documentation, /verificação de titularidade/);
    assert.match(documentation, /issues\/33/);
    assert.match(documentation, /não informam se os dados correspondem a uma identidade global ou a um perfil clínico/);
});
