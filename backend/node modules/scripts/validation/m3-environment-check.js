const mysql = require('mysql2/promise');
const { loadDatabaseConfig } = require('../db/config');

const VALIDATION_DATABASE = 'vitalis_m3_validacao';
const REQUIRED_TABLES = Object.freeze([
    'auditoria',
    'clinica_usuarios',
    'clinicas',
    'consultas',
    'documentos_clinicos',
    'especialidades',
    'pacientes',
    'profissional_especialidades',
    'profissionais',
    'schema_migrations',
    'usuarios'
]);

const READ_ONLY_QUERIES = Object.freeze({
    server: 'SELECT VERSION() AS version',
    schema: `
        SELECT SCHEMA_NAME AS schema_name
        FROM information_schema.SCHEMATA
        WHERE SCHEMA_NAME = ?
    `,
    tables: `
        SELECT TABLE_NAME AS table_name
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME
    `,
    migrations: `
        SELECT version, checksum
        FROM vitalis_m3_validacao.schema_migrations
        ORDER BY version
    `,
    clinics: `
        SELECT id, nome, slug, status
        FROM vitalis_m3_validacao.clinicas
        ORDER BY id
    `,
    roleCounts: `
        SELECT c.slug, cu.papel, cu.status, COUNT(*) AS total
        FROM vitalis_m3_validacao.clinica_usuarios cu
        JOIN vitalis_m3_validacao.clinicas c ON c.id = cu.clinica_id
        GROUP BY c.slug, cu.papel, cu.status
        ORDER BY c.slug, cu.papel, cu.status
    `,
    entityCounts: `
        SELECT c.slug,
               (SELECT COUNT(*) FROM vitalis_m3_validacao.profissionais p
                WHERE p.clinica_id = c.id) AS profissionais,
               (SELECT COUNT(*) FROM vitalis_m3_validacao.especialidades e
                WHERE e.clinica_id = c.id) AS especialidades,
               (SELECT COUNT(*) FROM vitalis_m3_validacao.documentos_clinicos d
                WHERE d.clinica_id = c.id) AS documentos
        FROM vitalis_m3_validacao.clinicas c
        ORDER BY c.id
    `
});

function assertValidationDatabase(databaseName) {
    if (databaseName !== VALIDATION_DATABASE) {
        throw new Error(
            `Operação recusada: M3_VALIDATION_DB_DATABASE deve ser exatamente ${VALIDATION_DATABASE}.`
        );
    }
    return databaseName;
}

function assertReadOnlyQueries(queries = READ_ONLY_QUERIES) {
    for (const [name, sql] of Object.entries(queries)) {
        if (!/^\s*SELECT\b/i.test(sql)) {
            throw new Error(`Diagnóstico recusado: consulta ${name} não é SELECT.`);
        }
        if (/\b(?:INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|REPLACE)\b/i.test(sql)) {
            throw new Error(`Diagnóstico recusado: consulta ${name} contém escrita.`);
        }
    }
}

async function diagnose(env = process.env) {
    const config = loadDatabaseConfig(env, 'M3_VALIDATION_DB_');
    const databaseName = assertValidationDatabase(config.database);
    assertReadOnlyQueries();

    // A conexão deliberadamente não seleciona banco. A existência é consultada
    // pelo information_schema antes de qualquer leitura do schema de validação.
    const { database: _ignored, ...serverConfig } = config;
    const connection = await mysql.createConnection(serverConfig);
    try {
        const [[server]] = await connection.query(READ_ONLY_QUERIES.server);
        const [schemas] = await connection.execute(READ_ONLY_QUERIES.schema, [databaseName]);
        if (schemas.length === 0) {
            return { database: databaseName, exists: false, mysqlVersion: server.version };
        }

        const [tableRows] = await connection.execute(READ_ONLY_QUERIES.tables, [databaseName]);
        const tables = tableRows.map((row) => row.table_name);
        const missingTables = REQUIRED_TABLES.filter((table) => !tables.includes(table));
        const result = {
            database: databaseName,
            exists: true,
            mysqlVersion: server.version,
            tables,
            missingTables
        };

        if (missingTables.length === 0) {
            const [migrations] = await connection.query(READ_ONLY_QUERIES.migrations);
            const [clinics] = await connection.query(READ_ONLY_QUERIES.clinics);
            const [roleCounts] = await connection.query(READ_ONLY_QUERIES.roleCounts);
            const [entityCounts] = await connection.query(READ_ONLY_QUERIES.entityCounts);
            Object.assign(result, { migrations, clinics, roleCounts, entityCounts });
        }
        return result;
    } finally {
        await connection.end();
    }
}

if (require.main === module) {
    diagnose()
        .then((result) => console.info(JSON.stringify(result, null, 2)))
        .catch((error) => {
            console.error(error.message);
            process.exitCode = 1;
        });
}

module.exports = {
    READ_ONLY_QUERIES,
    REQUIRED_TABLES,
    VALIDATION_DATABASE,
    assertReadOnlyQueries,
    assertValidationDatabase,
    diagnose
};
