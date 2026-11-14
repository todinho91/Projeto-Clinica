const assert = require('node:assert/strict');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..', '..', '..');

test('gestão de equipe apresenta convite, estados e ações sem expor token', async () => {
    const [html, main] = await Promise.all([
        fs.readFile(path.join(root, 'equipe.html'), 'utf8'),
        fs.readFile(path.join(root, 'js', 'main.js'), 'utf8')
    ]);
    assert.match(html, /id="convite-form"/);
    assert.match(html, /id="equipe-lista"/);
    assert.match(main, /\/equipe\/convites/);
    assert.match(main, /Reenviar/);
    assert.match(main, /Revogar/);
    assert.match(main, /window\.confirm\('Revogar este convite pendente\?'\)/);
    assert.doesNotMatch(html, /token[_ -]?hash/i);
});

test('aceite público lê token da URL e nunca solicita senha para conta existente', async () => {
    const [html, main] = await Promise.all([
        fs.readFile(path.join(root, 'aceitar-convite.html'), 'utf8'),
        fs.readFile(path.join(root, 'js', 'main.js'), 'utf8')
    ]);
    assert.match(html, /autocomplete="new-password"/);
    assert.match(main, /aceite-senha-campo.*hidden = !invitation\.requer_senha/);
    assert.match(main, /invitation\.requer_senha \? null : 'identity'/);
});
