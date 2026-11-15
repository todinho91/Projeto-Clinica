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
