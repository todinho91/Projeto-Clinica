const assert = require('node:assert/strict');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const core = require('../../../js/vitalis-client');

const root = path.join(__dirname, '..', '..', '..');

test('layout da equipe reserva largura para o seletor em desktop e usa cartões em 390 e 360 px', async () => {
    const [css, main, page, controller] = await Promise.all([
        fs.readFile(path.join(root, 'css', 'dashboard.css'), 'utf8'),
        fs.readFile(path.join(root, 'js', 'main.js'), 'utf8'),
        fs.readFile(path.join(root, 'equipe.html'), 'utf8'),
        fs.readFile(path.join(__dirname, '..', 'controllers', 'equipeController.js'), 'utf8')
    ]);
    const setup = main.slice(main.indexOf('async function setupEquipePage()'), main.indexOf('async function setupConvitePage()'));

    assert.match(css, /\.vitalis-team-page \.vitalis-management-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    assert.match(css, /\.vitalis-team-page \.vitalis-management-form \{ position: static; \}/);
    assert.match(page, /class="vitalis-management-grid vitalis-team-management-grid"/);
    assert.match(controller, /u\.status AS usuario_status/);
    assert.match(css, /\.vitalis-team-table \{ width: 100%; min-width: 0; table-layout: fixed; \}/);
    assert.match(css, /\.vitalis-team-table th:nth-child\(2\) \{ width: 27%; \}/);
    assert.match(css, /\.vitalis-team-role-select \{ box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%; \}/);
    assert.match(css, /@media \(max-width: 767\.98px\)[\s\S]*\.vitalis-team-table \{ min-width: 0; table-layout: auto; margin: 0; \}/);
    assert.match(css, /@media \(max-width: 389\.98px\)[\s\S]*\.vitalis-team-table td \{ grid-template-columns: minmax\(78px, \.38fr\) minmax\(0, 1fr\)/);
    assert.match(css, /@media \(max-width: 767\.98px\)[\s\S]*\.vitalis-team-role-select \{ min-width: 0; min-height: 42px; font-size: \.82rem; \}/);
    assert.match(setup, /administrador: 'Administrador'/);
    assert.match(setup, /option\.textContent = roleLabels\[role\]/);
    assert.match(setup, /select\.title = roleLabels\[member\.papel\] \|\| member\.papel/);
    assert.match(setup, /select\.setAttribute\('aria-label', `Papel de \$\{member\.nome\}`\)/);
    assert.match(setup, /&& !isLastActiveAdministrator/);
    assert.match(setup, /Mantenha outro administrador ativo antes de transferir este papel/);
    assert.match(setup, /error\.message[\s\S]*A clínica deve manter ao menos um administrador ativo[\s\S]*load\(\)/);
});

test('regra comportamental bloqueia o último admin ativo e libera quando há outro', () => {
    const soleAdmin = { id: 1, papel: 'administrador', status: 'ativo', usuario_status: 'ativo' };
    assert.equal(core.isLastActiveAdministrator(soleAdmin, [soleAdmin]), true);

    const secondAdmin = { id: 2, papel: 'administrador', status: 'ativo', usuario_status: 'ativo' };
    assert.equal(core.isLastActiveAdministrator(soleAdmin, [soleAdmin, secondAdmin]), false);
    assert.equal(core.isLastActiveAdministrator(secondAdmin, [soleAdmin, secondAdmin]), false);

    const inactiveIdentity = { ...secondAdmin, usuario_status: 'inativo' };
    assert.equal(core.isLastActiveAdministrator(soleAdmin, [soleAdmin, inactiveIdentity]), true);
    assert.equal(core.isLastActiveAdministrator({ ...soleAdmin, status: 'inativo' }, [soleAdmin]), false);
    assert.equal(core.isLastActiveAdministrator({ ...soleAdmin, usuario_status: 'inativo' }, [soleAdmin]), false);
    assert.equal(core.isLastActiveAdministrator({ ...soleAdmin, papel: 'secretaria' }, [soleAdmin]), false);
});

test('equipe oculta a desativação do único administrador ativo', async () => {
    const main = await fs.readFile(path.join(root, 'js', 'main.js'), 'utf8');
    const setup = main.slice(main.indexOf('async function setupEquipePage()'), main.indexOf('async function setupConvitePage()'));

    assert.match(setup, /isLastActiveAdministrator = VitalisCore\.isLastActiveAdministrator\(member, members\)/);
    assert.match(setup, /const isLastAdministrator = VitalisCore\.isLastActiveAdministrator\(member, members\)/);
    assert.match(setup, /if \(!isLastAdministrator\) \{[\s\S]*addButton\(actionLabel/);
    assert.match(setup, /Somente visualização|Nenhuma ação disponível/);
});
