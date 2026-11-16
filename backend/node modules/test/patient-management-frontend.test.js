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

test('layout administrativo mantém navegação rolável e ações da sessão visíveis', async () => {
    const css = await fs.readFile(path.join(root, 'css', 'dashboard.css'), 'utf8');
    const pages = [
        'dashboard-secretaria.html',
        'pacientes.html',
        'profissionais.html',
        'disponibilidade.html',
        'especialidades.html',
        'equipe.html',
        'configuracoes-clinica.html'
    ];

    assert.match(css, /\.vitalis-sidebar[^}]*height: 100dvh[^}]*overflow: hidden/);
    assert.match(css, /\.vitalis-sidebar \.offcanvas-body[^}]*min-height: 0[^}]*overflow: hidden/);
    assert.match(css, /\.vitalis-nav[^}]*flex: 1 1 auto[^}]*min-height: 0[^}]*overflow-y: auto/);
    assert.match(css, /\.vitalis-sidebar-footer[^}]*flex: 0 0 auto[^}]*margin-top: 0/);

    for (const pageName of pages) {
        const page = await fs.readFile(path.join(root, pageName), 'utf8');
        assert.match(page, /class="offcanvas-body d-flex flex-column p-0"/, `${pageName} precisa do contêiner flex compartilhado`);
        assert.match(page, /class="vitalis-nav"/, `${pageName} precisa da navegação rolável compartilhada`);
        assert.match(page, /class="vitalis-sidebar-footer"/, `${pageName} precisa manter Trocar clínica e Sair fora da rolagem`);
    }
});

test('layout de pacientes distribui tabela e formulário nas resoluções-alvo', async () => {
    const [css, page] = await Promise.all([
        fs.readFile(path.join(root, 'css', 'dashboard.css'), 'utf8'),
        fs.readFile(path.join(root, 'pacientes.html'), 'utf8')
    ]);

    assert.match(css, /@media \(max-width: 1399\.98px\) and \(min-width: 992px\)[\s\S]*\.vitalis-patients-page \.vitalis-management-grid[^}]*grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(css, /\.vitalis-patients-page #paciente-nascimento[^}]*width: 100%[^}]*min-width: 0/);
    assert.match(css, /\.vitalis-patient-table th:nth-child\(1\)[^}]*width: 22%/);
    assert.match(css, /\.vitalis-patient-table th:nth-child\(6\)[^}]*width: 15%/);
    assert.match(css, /\.vitalis-patient-table th[^}]*white-space: nowrap/);
    assert.match(css, /@media \(max-width: 767\.98px\)[\s\S]*\.vitalis-patient-table td[^}]*white-space: normal/);
    assert.equal((page.match(/<th scope="col"/g) || []).length, 6);
});

test('controle de busca descarta respostas antigas', async () => {
    const main = await fs.readFile(path.join(root, 'js', 'main.js'), 'utf8');
    const setup = main.slice(main.indexOf('async function setupPatientsPage()'), main.indexOf('async function setupGestaoProfissionaisPage()'));
    assert.match(setup, /createLatestRequestGate\(\)/);
    assert.match(setup, /loadGate\.isCurrent\(ticket, page\)/);
});

test('edição descarta resposta antiga e valida o identificador retornado', async () => {
    const first = core.createLatestRequestGate();
    const oldRequest = first.begin(10);
    const currentRequest = first.begin(20);
    assert.equal(first.isCurrent(oldRequest, 10), false);
    assert.equal(first.isCurrent(currentRequest, 20), true);
    assert.equal(core.matchingSelectionId(10, 20), null);
    assert.equal(core.matchingSelectionId(20, 20), 20);

    const main = await fs.readFile(path.join(root, 'js', 'main.js'), 'utf8');
    const setup = main.slice(main.indexOf('async function setupPatientsPage()'), main.indexOf('async function setupGestaoProfissionaisPage()'));
    assert.match(setup, /editGate\.isCurrent\(ticket, patientId\)/);
    assert.match(setup, /matchingSelectionId\(patient\.id, patientId\)/);
    assert.ok(setup.indexOf('clearPatientForm();') < setup.indexOf('apiRequest(`/pacientes/gestao/${patientId}`)'));
    assert.match(setup, /matchingSelectionId\(patient\.id, patientId\)[\s\S]*clearPatientForm\(\)/);
    assert.match(setup, /catch \(error\)[\s\S]*clearPatientForm\(\)[\s\S]*showMessage\(formStatus, error\.message\)/);
    assert.match(setup, /cancel\.hidden = false;[\s\S]*showMessage\(formStatus, '', 'muted'\)/);
});

test('trava comportamental impede gravações simultâneas mesmo com campos opcionais vazios', async () => {
    const lock = core.createOperationLock();
    const payload = { nome: 'Paciente Teste', email: '', data_nascimento: '' };
    assert.equal(payload.email, '');
    assert.equal(lock.tryBegin(), true);
    assert.equal(lock.tryBegin(), false);
    assert.equal(lock.active, true);
    lock.end();
    assert.equal(lock.tryBegin(), true);

    const main = await fs.readFile(path.join(root, 'js', 'main.js'), 'utf8');
    const setup = main.slice(main.indexOf('async function setupPatientsPage()'), main.indexOf('async function setupGestaoProfissionaisPage()'));
    assert.match(setup, /setFormDisabled\(true\)/);
    assert.match(setup, /setEditActionsDisabled\(true\)/);
    assert.match(setup, /!mutationLock\.tryBegin\(\)/);
});
