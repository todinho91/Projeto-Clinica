const assert = require('node:assert/strict');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const core = require('../../../js/vitalis-client');

const root = path.join(__dirname, '..', '..', '..');

test('página de pacientes exige papel de gestão e não envia clinica_id', async () => {
    const [page, main] = await Promise.all([
        fs.readFile(path.join(root, 'pacientes.html'), 'utf8'),
        fs.readFile(path.join(root, 'js', 'main.js'), 'utf8')
    ]);
    assert.equal(core.roleCanAccessPage('administrador', 'pacientes.html'), true);
    assert.equal(core.roleCanAccessPage('secretaria', 'pacientes.html'), true);
    assert.equal(core.roleCanAccessPage('profissional', 'pacientes.html'), false);
    assert.equal(core.roleCanAccessPage('paciente', 'pacientes.html'), false);
    assert.match(page, /id="paciente-form"/);
    assert.match(page, /id="pacientes-filtros"/);
    const setup = main.slice(main.indexOf('async function setupPatientsPage()'), main.indexOf('async function setupGestaoProfissionaisPage()'));
    assert.match(setup, /requireClinicSession\('pacientes\.html'\)/);
    assert.match(setup, /email_mascarado/);
    assert.doesNotMatch(setup, /clinica_id/);
});

test('layout de pacientes cobre 390 e 360 px sem tabela horizontal', async () => {
    const css = await fs.readFile(path.join(root, 'css', 'dashboard.css'), 'utf8');
    assert.match(css, /\.vitalis-patient-filters/);
    assert.match(css, /@media \(max-width: 767\.98px\)[\s\S]*\.vitalis-patient-table/);
    assert.match(css, /@media \(max-width: 389\.98px\)[\s\S]*\.vitalis-patients-page/);
    assert.match(css, /grid-template-columns: minmax\(76px, \.35fr\) minmax\(0, 1fr\)/);
});

test('controle de busca descarta respostas antigas', async () => {
    const main = await fs.readFile(path.join(root, 'js', 'main.js'), 'utf8');
    const setup = main.slice(main.indexOf('async function setupPatientsPage()'), main.indexOf('async function setupGestaoProfissionaisPage()'));
    assert.match(setup, /createLatestRequestGate\(\)/);
    assert.match(setup, /loadGate\.isCurrent\(ticket, page\)/);
});
