const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
    READ_ONLY_QUERIES,
    VALIDATION_DATABASE,
    assertReadOnlyQueries,
    assertValidationDatabase
} = require('../scripts/validation/m3-environment-check');

test('diagnóstico M3 aceita somente o banco de validação autorizado', () => {
    assert.equal(assertValidationDatabase(VALIDATION_DATABASE), 'vitalis_m3_validacao');
    for (const unsafeName of [
        'vitalis_dev',
        'vitalis_backend_test',
        'vitalis_db01_test',
        'vitalis_m3_validacao_test',
        'VITALIS_M3_VALIDACAO'
    ]) {
        assert.throws(() => assertValidationDatabase(unsafeName), /Operação recusada/);
    }
});

test('diagnóstico M3 contém exclusivamente consultas SELECT', () => {
    assert.doesNotThrow(() => assertReadOnlyQueries());
    for (const sql of Object.values(READ_ONLY_QUERIES)) {
        assert.match(sql, /^\s*SELECT\b/i);
        assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|REPLACE)\b/i);
    }
});

test('diagnóstico M3 recusa qualquer consulta de escrita adicionada por regressão', () => {
    assert.throws(
        () => assertReadOnlyQueries({ unsafe: 'DELETE FROM clinicas' }),
        /não é SELECT/
    );
    assert.throws(
        () => assertReadOnlyQueries({ disguised: 'SELECT 1; DROP TABLE clinicas' }),
        /contém escrita/
    );
});
