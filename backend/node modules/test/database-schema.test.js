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
        'auditoria'
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
        'auditoria'
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

test('consultas exigem período válido e evitam mesmo início para o profissional', async () => {
    const sql = await schemaSql();
    assert.match(sql, /CHECK \(fim_em > inicio_em\)/);
    assert.match(sql, /UNIQUE KEY uk_consultas_inicio_profissional \(clinica_id, profissional_id, inicio_em\)/);
});
