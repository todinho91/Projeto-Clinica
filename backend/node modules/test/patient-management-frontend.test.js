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

test('cadastro rotineiro exige identificação e mantém contato como preferência separada', async () => {
    const [page, main] = await Promise.all([
        fs.readFile(path.join(root, 'pacientes.html'), 'utf8'),
        fs.readFile(path.join(root, 'js', 'main.js'), 'utf8')
    ]);
    for (const id of [
        'paciente-nome', 'paciente-cpf', 'paciente-nascimento', 'paciente-cep',
        'paciente-logradouro', 'paciente-numero', 'paciente-bairro',
        'paciente-cidade', 'paciente-uf'
    ]) {
        assert.match(page, new RegExp(`id="${id}"[^>]*required`), `${id} deve ser obrigatório`);
    }
    assert.match(page, /id="paciente-email"[^>]*\(opcional\)|E-mail de contato <span[^>]*>\(opcional\)/);
    assert.match(page, /id="paciente-telefone"[^>]*type="tel"/);
    assert.match(page, /id="paciente-preferencia-contato"/);
    assert.match(page, /id="paciente-sem-cpf"/);
    assert.match(page, /id="paciente-sem-endereco"/);
    assert.match(page, /não consulta a situação na Receita Federal/);
    assert.match(main, /VitalisCore\.isValidCpf/);
    assert.match(main, /\/pacientes\/cep\/\$\{cep\}/);
    assert.doesNotMatch(main, /viacep\.com\.br/);
    assert.match(main, /'paciente-numero'/);
    assert.match(main, /VitalisCore\.createPatientCepLookup\(/);
    assert.match(main, /lookup: \(cep\) => apiRequest\(`\/pacientes\/cep\/\$\{cep\}`\)/);
    assert.match(main, /writeFields: \(values\)/);
    assert.match(main, /Endereço diferente localizado\. O número anterior foi removido/);
    assert.match(main, /result\.type === 'unavailable'/);
    assert.match(main, /result\.error\.message.*Você pode continuar com o preenchimento manual/);
    assert.match(main, /birthInput\.min = earliestBirth\.toISOString/);
    assert.match(main, /birthInput\.max = today\.toISOString/);
    assert.match(main, /manter_cadastro_pendente/);
    assert.match(main, /cpf_mascarado/);
});

test('máscaras de CPF e CEP são determinísticas no frontend', () => {
    assert.equal(core.formatCpf('52998224725'), '529.982.247-25');
    assert.equal(core.isValidCpf('529.982.247-25'), true);
    assert.equal(core.isValidCpf('111.111.111-11'), false);
    assert.equal(core.formatCep('86300000'), '86300-000');
});

test('troca para endereço diferente remove o número anterior antes de permitir reutilizá-lo', async () => {
    const fields = { logradouro: 'Rua das Flores', bairro: 'Centro', cidade: 'Londrina', uf: 'PR', numero: '123' };
    const harness = createCepHarness(fields, async () => ({
        logradouro: 'Avenida Brasil', bairro: 'Jardim América', cidade: 'Maringá', uf: 'PR'
    }));

    await harness.run();

    assert.equal(fields.logradouro, 'Avenida Brasil');
    assert.equal(fields.cidade, 'Maringá');
    assert.equal(fields.numero, '');
    assert.equal(harness.status.at(-1).numberCleared, true);
});

function createCepHarness(fields, lookup) {
    let cep = '86000000';
    const status = [];
    const run = core.createPatientCepLookup({
        gate: core.createLatestRequestGate(),
        readCep: () => cep,
        readFields: () => ({ ...fields }),
        lookup,
        writeFields: (next) => Object.assign(fields, next),
        onStatus: (next) => status.push(next)
    });
    return { run, status, setCep: (value) => { cep = value; } };
}

test('consulta do mesmo endereço mantém o número já informado', async () => {
    const fields = { logradouro: 'Rua das Flores', bairro: 'Centro', cidade: 'Londrina', uf: 'PR', numero: '123' };
    const harness = createCepHarness(fields, async () => ({
        logradouro: 'Rua das Flores', bairro: 'Centro', cidade: 'Londrina', uf: 'PR'
    }));

    await harness.run();

    assert.equal(fields.numero, '123');
    assert.equal(harness.status.at(-1).numberCleared, false);
});

test('retorno atrasado de CEP antigo não sobrescreve o endereço do CEP mais recente', async () => {
    const fields = { logradouro: 'Rua antiga', bairro: 'Centro', cidade: 'Londrina', uf: 'PR', numero: '123' };
    const pending = new Map();
    const harness = createCepHarness(fields, (cep) => new Promise((resolve) => pending.set(cep, resolve)));
    const oldRequest = harness.run();
    harness.setCep('87000000');
    const latestRequest = harness.run();

    pending.get('86000000')({ logradouro: 'Rua velha', bairro: 'Centro', cidade: 'Londrina', uf: 'PR' });
    await oldRequest;
    assert.equal(fields.logradouro, 'Rua antiga');
    pending.get('87000000')({ logradouro: 'Rua nova', bairro: 'Zona 1', cidade: 'Maringá', uf: 'PR' });
    await latestRequest;
    assert.equal(fields.logradouro, 'Rua nova');
    assert.equal(fields.numero, '');
});

test('edições manuais feitas durante a consulta de CEP são preservadas', async () => {
    const fields = { logradouro: 'Rua antiga', bairro: 'Centro', cidade: 'Londrina', uf: 'PR', numero: '123' };
    let resolveLookup;
    const harness = createCepHarness(fields, () => new Promise((resolve) => { resolveLookup = resolve; }));
    const request = harness.run();

    fields.logradouro = 'Estrada informada manualmente';
    fields.numero = '45 fundos';
    resolveLookup({ logradouro: 'Avenida nova', bairro: 'Zona 1', cidade: 'Maringá', uf: 'PR' });
    await request;

    assert.equal(fields.logradouro, 'Estrada informada manualmente');
    assert.equal(fields.numero, '45 fundos');
    assert.equal(fields.cidade, 'Maringá');
});

test('falha ou indisponibilidade do CEP não altera campos preenchidos', async () => {
    const fields = { logradouro: 'Rua informada', bairro: 'Vila Nova', cidade: 'Londrina', uf: 'PR', numero: '18' };
    const harness = createCepHarness(fields, async () => { throw new Error('ViaCEP indisponível.'); });
    const before = { ...fields };

    await harness.run();

    assert.deepEqual(fields, before);
    assert.equal(harness.status.at(-1).type, 'unavailable');
    assert.match(harness.status.at(-1).error.message, /ViaCEP indisponível/);
});

test('layout de pacientes cobre 390 e 360 px sem tabela horizontal', async () => {
    const css = await fs.readFile(path.join(root, 'css', 'dashboard.css'), 'utf8');
    assert.match(css, /\.vitalis-patient-filters/);
    assert.match(css, /@media \(max-width: 767\.98px\)[\s\S]*\.vitalis-patient-table/);
    assert.match(css, /@media \(max-width: 389\.98px\)[\s\S]*\.vitalis-patients-page/);
    assert.match(css, /grid-template-columns: minmax\(76px, \.35fr\) minmax\(0, 1fr\)/);
    assert.match(css, /\.vitalis-address-fields[^}]*min-width: 0/);
    assert.match(css, /\.vitalis-field-error[^}]*color: #b42318/);
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
    assert.match(css, /\.vitalis-patient-table th:nth-child\(1\)[^}]*width: 19%/);
    assert.match(css, /\.vitalis-patient-table th:nth-child\(5\)[^}]*width: 14%/);
    assert.match(css, /\.vitalis-patient-table th:nth-child\(6\)[^}]*width: 24%/);
    assert.match(css, /\.vitalis-patient-table th[^}]*white-space: nowrap/);
    assert.match(css, /\.vitalis-patient-table \.vitalis-table-actions[^}]*display: grid[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)[^}]*white-space: normal/);
    assert.match(css, /@media \(max-width: 1199\.98px\) and \(min-width: 768px\)[\s\S]*\.vitalis-patient-table \.vitalis-table-actions[^}]*grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(css, /@media \(max-width: 767\.98px\)[\s\S]*\.vitalis-patient-table td[^}]*white-space: normal/);
    assert.match(css, /@media \(max-width: 767\.98px\)[\s\S]*\.vitalis-patient-table \.vitalis-table-actions[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
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

test('cadastro faz pré-verificação, oferece paciente existente e revisão de homônimo', async () => {
    const [page, main, css] = await Promise.all([
        fs.readFile(path.join(root, 'pacientes.html'), 'utf8'),
        fs.readFile(path.join(root, 'js', 'main.js'), 'utf8'),
        fs.readFile(path.join(root, 'css', 'dashboard.css'), 'utf8')
    ]);
    const setup = main.slice(main.indexOf('async function setupPatientsPage()'), main.indexOf('async function setupGestaoProfissionaisPage()'));
    assert.match(page, /id="paciente-duplicidades"/);
    assert.match(setup, /apiRequest\('\/pacientes\/duplicidades'/);
    assert.match(setup, /Usar paciente existente/);
    assert.match(setup, /startEdit\(candidate\.id\)/);
    assert.match(setup, /revisao_duplicidade: true/);
    assert.match(setup, /homonimo_confirmado/);
    assert.match(setup, /duplicatePanel\.hidden = true/);
    assert.match(css, /\.vitalis-duplicate-candidate/);
    assert.match(css, /@media \(max-width: 767\.98px\)[\s\S]*\.vitalis-duplicate-confirm/);
});
