const assert = require('node:assert/strict');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const core = require('../../../js/vitalis-client');

const root = path.join(__dirname, '..', '..', '..');

test('login entra direto com vínculo único e mantém seleção para múltiplos vínculos', async () => {
    assert.deepEqual(core.clinicEntryDecision([{ id: 17, papel: 'secretaria' }]), {
        mode: 'direct', clinicId: 17
    });
    assert.deepEqual(core.clinicEntryDecision([
        { id: 17, papel: 'secretaria' }, { id: 22, papel: 'administrador' }
    ]), { mode: 'select' });
    assert.deepEqual(core.clinicEntryDecision([]), { mode: 'select' });

    const main = await fs.readFile(path.join(root, 'js', 'main.js'), 'utf8');
    const login = main.slice(main.indexOf('function setupLoginPage()'), main.indexOf('async function setupClinicSelectionPage()'));
    assert.match(login, /clinicEntryDecision\(data\.clinicas\)/);
    assert.match(login, /entry\.mode === 'direct'[\s\S]*\/auth\/select-clinic/);
    assert.match(login, /session\.saveClinic\(selected\)/);
    assert.match(login, /window\.location\.assign\('select-clinic\.html'\)/);
});

test('troca de contexto depende da quantidade de vínculos, não do nome do papel', () => {
    assert.deepEqual(core.workspaceSwitchState(
        [{ id: 17, papel: 'secretaria' }],
        { id: 17, papel: 'secretaria', tipo_contexto: 'clinica' }
    ), { visible: false, label: 'Trocar clínica' });
    assert.deepEqual(core.workspaceSwitchState(
        [{ id: 17, papel: 'secretaria' }, { id: 22, papel: 'secretaria' }],
        { id: 17, papel: 'secretaria', tipo_contexto: 'clinica' }
    ), { visible: true, label: 'Trocar clínica' });
    assert.deepEqual(core.workspaceSwitchState(
        [{ id: 17 }, { id: 22 }],
        { id: 22, papel: 'profissional', tipo_contexto: 'consultorio', titular: true }
    ), { visible: true, label: 'Alternar espaço' });
});

test('páginas da secretaria mantêm troca oculta até a autorização do perfil', async () => {
    const pages = [
        'dashboard-secretaria.html', 'agenda.html', 'calendario.html', 'disponibilidade.html',
        'equipe.html', 'especialidades.html', 'pacientes.html', 'profissionais.html'
    ];
    for (const pageName of pages) {
        const page = await fs.readFile(path.join(root, pageName), 'utf8');
        const links = page.match(/<a data-clinic-switch[^>]*href="select-clinic\.html"/g) || [];
        assert.ok(links.length > 0, `${pageName} deve identificar a ação compartilhada`);
        links.forEach((link) => assert.match(link, /\shidden(?:\s|$)/));
    }
});

test('painel do paciente usa dados reais, destaca pendências e não expõe conteúdo de desenvolvimento', async () => {
    const [page, main] = await Promise.all([
        fs.readFile(path.join(root, 'dashboard-paciente.html'), 'utf8'),
        fs.readFile(path.join(root, 'js', 'main.js'), 'utf8')
    ]);
    assert.match(page, /class="vitalis-dashboard-body vitalis-patient-portal"/);
    assert.match(page, /id="patient-total-upcoming"/);
    assert.match(page, /id="patient-pending-confirmations"/);
    assert.match(page, /id="patient-next-appointment"/);
    assert.match(page, /id="preferencias"/);
    assert.doesNotMatch(page, /Descobrir cuidados|Próxima evolução|issue #67|catálogo fictício/i);
    assert.doesNotMatch(page, /href="select-clinic\.html"/);
    assert.match(page, /Você pode ativar ou desativar esta opção quando quiser/);
    assert.match(page, /bi-calendar-check-fill/);
    assert.match(page, /bi-chat-dots-fill/);
    assert.match(page, /bi-check-circle-fill/);
    assert.match(main, /appointment\.confirmacao_estado === 'preparada'/);
    assert.match(main, /patient-total-upcoming/);
    assert.match(main, /patient-pending-confirmations/);
    assert.match(main, /session\.user\?\.nome \|\| 'paciente'/);
});

test('layout cobre desktop, 390 e 360 px e menu da agenda não é recortado', async () => {
    const css = await fs.readFile(path.join(root, 'css', 'dashboard.css'), 'utf8');
    assert.match(css, /\.vitalis-patient-dashboard-grid[^}]*grid-template-columns: minmax\(0, 1\.65fr\) minmax\(280px, \.75fr\)/);
    assert.match(css, /@media \(max-width: 991\.98px\)[\s\S]*\.vitalis-patient-dashboard-grid[^}]*grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(css, /@media \(max-width: 767\.98px\)[\s\S]*\.vitalis-patient-booking-grid[^}]*grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(css, /@media \(max-width: 389\.98px\)[\s\S]*\.vitalis-patient-portal \.vitalis-main/);
    assert.match(css, /\.vitalis-patient-welcome h1 span[^}]*color: #fff !important/);
    assert.match(css, /\.vitalis-appointment-table-wrap[^}]*overflow: visible/);
    assert.match(css, /\.vitalis-appointment-table-wrap \.vitalis-overflow-menu-list[^}]*z-index: 80/);
});
