const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { scanRepository, scanText } = require('../scripts/security/check-secrets');

test('varredura detecta fixture sintética sem expor o valor', () => {
    const findings = scanText('JWT_SECRET=fixture-secret-value-that-must-be-detected');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].name, 'segredo configurado em arquivo');
    assert.equal(Object.hasOwn(findings[0], 'value'), false);
});

test('varredura aceita exemplos vazios e a árvore rastreada atual', () => {
    assert.deepEqual(scanText('DB_PASSWORD=\nJWT_SECRET=\nSEED_PASSWORD='), []);
    const repositoryRoot = path.resolve(__dirname, '..', '..', '..');
    assert.deepEqual(scanRepository(repositoryRoot), []);
});
