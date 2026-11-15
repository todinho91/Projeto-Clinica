const assert = require('node:assert/strict');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..', '..', '..');

test('provisionamento usa token de identidade e não recebe senha ou clínica do navegador', async () => {
    const [page, main, routes] = await Promise.all([
        fs.readFile(path.join(root, 'provisionamento-clinicas.html'), 'utf8'),
        fs.readFile(path.join(root, 'js', 'main.js'), 'utf8'),
        fs.readFile(path.join(root, 'backend', 'node modules', 'routes', 'index.js'), 'utf8')
    ]);
    assert.match(page, /id="provisionamento-form"/);
    assert.match(page, /id="provisionamento-status"/);
    assert.doesNotMatch(page, /type="password"|id=".*senha/i);
    assert.match(main, /\/plataforma\/clinicas[\s\S]{0,500}'identity'/);
    assert.doesNotMatch(main, /provisionamento[\s\S]{0,500}clinica_id/);
    assert.match(routes, /router\.post\('\/plataforma\/clinicas', identityOnly, clinicaController\.provision\)/);
});

test('configurações são exclusivas de administrador e interface cobre 360 e 390 px', async () => {
    const [page, core, css, main] = await Promise.all([
        fs.readFile(path.join(root, 'configuracoes-clinica.html'), 'utf8'),
        fs.readFile(path.join(root, 'js', 'vitalis-client.js'), 'utf8'),
        fs.readFile(path.join(root, 'css', 'dashboard.css'), 'utf8'),
        fs.readFile(path.join(root, 'js', 'main.js'), 'utf8')
    ]);
    assert.match(page, /id="configuracoes-clinica-form"/);
    assert.match(page, /id="config-clinica-slug" readonly/);
    assert.match(core, /'configuracoes-clinica\.html': \['administrador'\]/);
    assert.match(main, /clinic\.papel !== 'administrador'/);
    assert.match(css, /@media \(max-width: 389\.98px\)/);
    assert.match(css, /\.vitalis-provisioning-grid/);
    assert.match(css, /overflow-wrap: anywhere/);
});
