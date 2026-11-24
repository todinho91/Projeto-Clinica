const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { scanRepository, scanText } = require('../scripts/security/check-secrets');

test('varredura detecta fixture sintética sem expor o valor', () => {
    const findings = scanText([
        'JWT_SECRET=fixture-secret-value-that-must-be-detected',
        'PATIENT_CPF_ENCRYPTION_KEY=fixture-base64-key',
        'PATIENT_CPF_INDEX_KEY=fixture-index-key'
    ].join('\n'));
    assert.equal(findings.length, 3);
    assert.equal(findings[0].name, 'segredo configurado em arquivo');
    assert.equal(Object.hasOwn(findings[0], 'value'), false);
});

test('varredura aceita exemplos vazios e a árvore rastreada atual', () => {
    assert.deepEqual(scanText([
        'DB_PASSWORD=', 'JWT_SECRET=', 'SEED_PASSWORD=',
        'PATIENT_CPF_ENCRYPTION_KEY=', 'PATIENT_CPF_INDEX_KEY='
    ].join('\n')), []);
    const repositoryRoot = path.resolve(__dirname, '..', '..', '..');
    assert.deepEqual(scanRepository(repositoryRoot), []);
});
