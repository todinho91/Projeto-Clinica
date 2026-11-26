const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { positiveId, onlyKeys, recordContent, addendumContent, eligible, canRead, nextState,
    completeForFinalization } = require('../support/clinical-record');

test('prontuário valida IDs, campos permitidos, limites e texto sem controles', () => {
    for (const x of [null, false, true, [], {}, '1e2', ' 1', '01', -1, 0, '9007199254740992']) assert.equal(positiveId(x), null);
    assert.equal(positiveId('123'), 123);
    assert.equal(onlyKeys({ clinica_id: 4 }, ['conteudo']), false);
    assert.equal(recordContent({ autor_usuario_id: 2 }), null);
    assert.equal(recordContent({ queixa: 'a'.repeat(8001) }), null);
    assert.equal(recordContent({ queixa: '\u0000' }), null);
    assert.equal(recordContent({ queixa: 1 }), null);
    assert.equal(recordContent({ queixa: '  texto  ' }).queixa, 'texto');
    assert.equal(recordContent({}).alergias, null);
    assert.equal(recordContent({ queixa: 'é'.repeat(5000) }), null);
    assert.equal(addendumContent({ texto: 'Adendo', motivo: '' }), null);
    assert.deepEqual(addendumContent({ texto: 'Adendo', motivo: 'Correção' }), { texto: 'Adendo', motivo: 'Correção' });
});
test('transições não sobrescrevem finalizados e respeitam elegibilidade', () => {
    assert.equal(eligible('agendada', 0), false);
    assert.equal(eligible('confirmada', 1), true);
    assert.equal(eligible('realizada', 1), true);
    for (const status of ['cancelada', 'nao_compareceu']) assert.equal(eligible(status, 1), false);
    assert.equal(canRead('finalizado', 'cancelada', 1), true);
    assert.equal(canRead('rascunho', 'cancelada', 1), false);
    assert.equal(nextState('rascunho', 'finalizacao'), 'finalizado');
    assert.equal(nextState('finalizado', 'adendo'), 'finalizado');
    assert.equal(nextState('finalizado', 'rascunho'), null);
    assert.equal(nextState('finalizado', 'descarte'), null);
    assert.equal(nextState('descartado', 'finalizacao'), null);
    assert.equal(completeForFinalization({ evolucao: 'E', conduta: 'C' }, {}), false);
    assert.equal(completeForFinalization({ evolucao: 'E', conduta: 'C' }, { conselho_tipo: 'CRM', conselho_numero: 'FICTICIO' }), true);
});
test('rotas clínicas têm autorização específica e cache desabilitado', () => {
    const routes = readFileSync(path.join(__dirname, '..', 'routes', 'index.js'), 'utf8');
    assert.ok(routes.indexOf("router.use(tenantContext)") < routes.indexOf("router.get('/prontuarios/pacientes/"));
    const endpoints = routes.split('\n').filter(line => /router\.(get|post|patch)\('\/prontuarios\//.test(line));
    assert.equal(endpoints.length, 8);
    assert.ok(endpoints.every(line => line.includes("authorize('profissional')")));
    assert.match(routes, /router\.use\('\/prontuarios',[\s\S]*?'Cache-Control': 'no-store/);
    const controller = readFileSync(path.join(__dirname, '..', 'controllers', 'prontuarioController.js'), 'utf8');
    assert.doesNotMatch(controller, /UPDATE prontuario_versoes|DELETE FROM prontuario_/i);
    assert.match(controller, /if \(!syntheticEnabled\(\)\)/);
});
test('migration 016 preserva histórico e amarra consulta, paciente e profissional ao tenant', () => {
    const sql = readFileSync(path.join(__dirname, '..', '..', 'database', 'migrations', '016_versioned_clinical_records.sql'), 'utf8');
    assert.match(sql, /FOREIGN KEY \(clinica_id, consulta_id, paciente_id, profissional_id\)/);
    assert.match(sql, /REFERENCES consultas \(clinica_id, id, paciente_id, profissional_id\)/);
    assert.match(sql, /UNIQUE KEY uk_prontuario_consulta \(clinica_id, consulta_id\)/);
    assert.match(sql, /PRIMARY KEY \(clinica_id, registro_id, versao\)/);
    assert.match(sql, /FOREIGN KEY \(clinica_id, registro_id, autor_usuario_id\)/);
    assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM|TRUNCATE|ON DELETE CASCADE/i);
});
