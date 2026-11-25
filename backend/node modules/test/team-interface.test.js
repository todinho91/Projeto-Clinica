const assert = require('node:assert/strict');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..', '..', '..');

test('layout da equipe reserva espaço para o papel e preserva o rótulo completo', async () => {
    const [css, main] = await Promise.all([
        fs.readFile(path.join(root, 'css', 'dashboard.css'), 'utf8'),
        fs.readFile(path.join(root, 'js', 'main.js'), 'utf8')
    ]);
    const setup = main.slice(main.indexOf('async function setupEquipePage()'), main.indexOf('async function setupConvitePage()'));

    assert.match(css, /\.vitalis-team-table th:nth-child\(2\) \{ width: 20%; \}/);
    assert.match(css, /\.vitalis-team-role-select \{ width: 100%; min-width: 0; \}/);
    assert.match(css, /@media \(max-width: 389\.98px\)[\s\S]*\.vitalis-team-role-select \{ min-height: 42px; font-size: \.82rem; \}/);
    assert.match(setup, /administrador: 'Administrador'/);
    assert.match(setup, /option\.textContent = roleLabels\[role\]/);
});

test('equipe oculta a desativação do único administrador ativo', async () => {
    const main = await fs.readFile(path.join(root, 'js', 'main.js'), 'utf8');
    const setup = main.slice(main.indexOf('async function setupEquipePage()'), main.indexOf('async function setupConvitePage()'));

    assert.match(setup, /activeAdministratorCount = members\.filter\([\s\S]*member\.papel === 'administrador' && member\.status === 'ativo'/);
    assert.match(setup, /isLastAdministrator = member\.papel === 'administrador'[\s\S]*activeAdministratorCount <= 1/);
    assert.match(setup, /if \(!isLastAdministrator\) \{[\s\S]*addButton\(actionLabel/);
    assert.match(setup, /Somente visualização|Nenhuma ação disponível/);
});
