const assert = require('node:assert/strict');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const core = require('../../../js/vitalis-client');

const root = path.join(__dirname, '..', '..', '..');

test('interface de disponibilidade mantém tenant autenticado e campos acessíveis', async () => {
    const [page, main] = await Promise.all([
        fs.readFile(path.join(root, 'disponibilidade.html'), 'utf8'),
        fs.readFile(path.join(root, 'js', 'main.js'), 'utf8')
    ]);
    assert.equal(core.roleCanAccessPage('administrador', 'disponibilidade.html'), true);
    assert.equal(core.roleCanAccessPage('secretaria', 'disponibilidade.html'), true);
    assert.equal(core.roleCanAccessPage('profissional', 'disponibilidade.html'), true);
    assert.equal(core.roleCanAccessPage('paciente', 'disponibilidade.html'), false);
    assert.match(page, /id="disponibilidade-conteudo" hidden/);
    assert.match(page, /id="disponibilidade-profissional"/);
    assert.match(page, /type="datetime-local"/);
    assert.match(page, /id="disponibilidade-timezone"/);
    assert.match(main, /requireClinicSession\('disponibilidade\.html'\)/);
    assert.match(main, /apiRequest\(`\/disponibilidade\/profissionais\/\$\{professionalId\}/);
    assert.doesNotMatch(main, /disponibilidade[\s\S]{0,500}clinica_id/);
});

test('layout de disponibilidade cobre desktop, 390 e 360 px sem rolagem horizontal', async () => {
    const css = await fs.readFile(path.join(root, 'css', 'dashboard.css'), 'utf8');
    assert.match(css, /\.vitalis-availability-grid/);
    assert.match(css, /\.vitalis-availability-interval/);
    assert.match(css, /@media \(max-width: 767\.98px\)[\s\S]*\.vitalis-availability-interval/);
    assert.match(css, /@media \(max-width: 389\.98px\)[\s\S]*\.vitalis-availability-page/);
    assert.match(css, /grid-template-columns: minmax\(0, 1fr\)/);
});

test('controle de carregamento descarta resposta antiga e bloqueia seleção divergente', () => {
    const gate = core.createLatestRequestGate();
    const first = gate.begin(10);
    const second = gate.begin(20);
    assert.equal(gate.isCurrent(first, 10), false);
    assert.equal(gate.isCurrent(second, 20), true);
    assert.equal(gate.isCurrent(second, 10), false);
    gate.invalidate();
    assert.equal(gate.isCurrent(second, 20), false);
    assert.equal(core.matchingSelectionId(20, '20'), 20);
    assert.equal(core.matchingSelectionId(20, '10'), null);
    assert.equal(core.matchingSelectionId(null, '20'), null);
});

test('formulário de bloqueio é capturado antes dos awaits e reiniciado pela referência estável', async () => {
    const main = await fs.readFile(path.join(root, 'js', 'main.js'), 'utf8');
    const setup = main.slice(
        main.indexOf('async function setupAvailabilityPage()'),
        main.indexOf('async function setupEquipePage()')
    );
    assert.ok(setup.indexOf("const blockForm = document.getElementById('bloqueio-form')")
        < setup.indexOf("apiRequest('/disponibilidade/contexto')"));
    assert.match(setup, /blockForm\.addEventListener\('submit'/);
    assert.match(setup, /blockForm\.reset\(\)/);
    assert.doesNotMatch(setup, /event\.currentTarget\.reset\(\)/);
    assert.match(setup, /loadGate\.isCurrent\(ticket, professionalSelect\.value\)/);
    assert.match(setup, /setProtectedControlsDisabled\(true\)/);
});
