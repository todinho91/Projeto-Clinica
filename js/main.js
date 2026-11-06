const API_URL = window.VITALIS_API_URL || 'http://localhost:3000/api';
const session = VitalisCore.createSession(window.sessionStorage);

function showMessage(element, message, type = 'danger') {
    if (!element) return;
    element.className = `mt-3 text-${type}`;
    element.textContent = message;
}

async function responseBody(response) {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) return {};
    return response.json();
}

async function apiRequest(path, options = {}, authType = 'clinic') {
    const headers = new Headers(options.headers || {});
    const token = authType === 'identity' ? session.identityToken : session.clinicToken;
    if (authType && token) headers.set('Authorization', `Bearer ${token}`);
    if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
    }

    let response;
    try {
        response = await fetch(`${API_URL}${path}`, { ...options, headers });
    } catch {
        throw new Error('Não foi possível conectar ao servidor Vitalis.');
    }
    const data = await responseBody(response);

    if (response.status === 401 && authType) {
        session.clear();
        window.location.assign('login.html');
        throw new Error('Sua sessão expirou. Entre novamente.');
    }
    if (
        response.status === 403
        && authType === 'clinic'
        && /clínica|vínculo|selecione/i.test(data.error || '')
    ) {
        session.clearClinic();
        window.location.assign('select-clinic.html');
        throw new Error('Selecione novamente uma clínica ativa.');
    }
    if (!response.ok) throw new Error(data.error || 'Não foi possível concluir a operação.');
    return data;
}

function logout() {
    session.clear();
    window.location.assign('login.html');
}

function currentPage() {
    return window.location.pathname.split('/').pop() || 'index.html';
}

function requireClinicSession(page) {
    if (!session.identityToken) {
        window.location.replace('login.html');
        return null;
    }
    if (!session.clinicToken || !session.activeClinic) {
        window.location.replace('select-clinic.html');
        return null;
    }
    if (!VitalisCore.roleCanAccessPage(session.activeClinic.papel, page)) {
        const destination = VitalisCore.dashboardForRole(session.activeClinic.papel);
        window.location.replace(destination || 'select-clinic.html');
        return null;
    }
    return session.activeClinic;
}

function applyClinicIdentity(clinic) {
    document.querySelectorAll('[data-clinic-name]').forEach((element) => {
        element.textContent = clinic.nome;
    });
}

function formatDate(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('pt-BR') : 'Data inválida';
}

function tableCell(text) {
    const cell = document.createElement('td');
    cell.textContent = text ?? '';
    return cell;
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('logout-button')?.addEventListener('click', logout);
    const page = currentPage();
    if (page === 'login.html') setupLoginPage();
    else if (page === 'register.html') setupRegisterPage();
    else if (page === 'select-clinic.html') setupClinicSelectionPage();
    else if (page === 'dashboard-paciente.html') setupPacienteDashboard();
    else if (page === 'dashboard-medico.html') setupProfissionalDashboard();
    else if (page === 'dashboard-secretaria.html') setupAdministracaoDashboard();
    else if (page === 'profissionais.html') setupGestaoProfissionaisPage();
    else if (page === 'especialidades.html') setupGestaoEspecialidadesPage();
});

function setupRegisterPage() {
    const form = document.getElementById('register-form');
    if (!form) return;
    const clinicInput = document.getElementById('clinica-slug');
    const clinicFromUrl = new URLSearchParams(window.location.search).get('clinica');
    if (clinicFromUrl) clinicInput.value = clinicFromUrl;

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const status = document.getElementById('status-message');
        try {
            const data = await apiRequest('/auth/register', {
                method: 'POST',
                body: JSON.stringify({
                    nome: document.getElementById('nome').value,
                    email: document.getElementById('email').value,
                    senha: document.getElementById('senha').value,
                    clinica_slug: clinicInput.value
                })
            }, null);
            showMessage(status, `${data.message} Redirecionando para o login...`, 'success');
            setTimeout(() => window.location.assign('login.html'), 1500);
        } catch (error) {
            showMessage(status, error.message);
        }
    });
}

function setupLoginPage() {
    const form = document.getElementById('login-form');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const errorElement = document.getElementById('error-message');
        errorElement.textContent = '';
        try {
            const data = await apiRequest('/auth/login', {
                method: 'POST',
                body: JSON.stringify({
                    email: document.getElementById('email').value,
                    senha: document.getElementById('senha').value
                })
            }, null);
            session.clear();
            session.saveIdentity(data);
            if (data.clinicas.length === 0) throw new Error('Nenhuma clínica ativa vinculada ao usuário.');
            window.location.assign('select-clinic.html');
        } catch (error) {
            errorElement.textContent = error.message;
        }
    });
}

async function setupClinicSelectionPage() {
    if (!session.identityToken) {
        window.location.replace('login.html');
        return;
    }
    const select = document.getElementById('clinica-select');
    const status = document.getElementById('clinic-status');
    try {
        const clinics = await apiRequest('/auth/clinics', {}, 'identity');
        select.replaceChildren();
        clinics.forEach((clinic) => {
            const option = document.createElement('option');
            option.value = clinic.id;
            option.textContent = `${clinic.nome} — ${clinic.papel}`;
            select.append(option);
        });
        if (clinics.length === 0) {
            select.disabled = true;
            showMessage(status, 'Nenhuma clínica ativa vinculada ao usuário.');
        }
    } catch (error) {
        showMessage(status, error.message);
    }

    document.getElementById('clinic-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
            const data = await apiRequest('/auth/select-clinic', {
                method: 'POST',
                body: JSON.stringify({ clinica_id: Number(select.value) })
            }, 'identity');
            session.saveClinic(data);
            const destination = VitalisCore.dashboardForRole(data.clinica.papel);
            if (!destination) throw new Error('Papel sem painel disponível.');
            window.location.assign(destination);
        } catch (error) {
            showMessage(status, error.message);
        }
    });
}

async function setupPacienteDashboard() {
    const clinic = requireClinicSession('dashboard-paciente.html');
    if (!clinic) return;
    applyClinicIdentity(clinic);
    const table = document.getElementById('tabela-consultas-paciente');
    const professionalSelect = document.getElementById('profissional-select');
    const status = document.getElementById('agendamento-status');

    async function loadAgenda() {
        try {
            const appointments = await apiRequest('/consultas/minha-agenda');
            table.replaceChildren();
            if (appointments.length === 0) {
                const row = document.createElement('tr');
                const cell = tableCell('Nenhuma consulta agendada.');
                cell.colSpan = 4;
                cell.className = 'text-center';
                row.append(cell);
                table.append(row);
                return;
            }
            appointments.forEach((appointment) => {
                const row = document.createElement('tr');
                row.append(
                    tableCell(appointment.nome_profissional),
                    tableCell(`${formatDate(appointment.inicio_em)} — ${formatDate(appointment.fim_em)}`),
                    tableCell(appointment.status)
                );
                const actions = document.createElement('td');
                if (!['cancelada', 'realizada'].includes(appointment.status)) {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'btn btn-sm btn-outline-danger';
                    button.textContent = 'Cancelar';
                    button.addEventListener('click', async () => {
                        try {
                            await apiRequest(`/consultas/${appointment.id}`, { method: 'DELETE' });
                            await loadAgenda();
                        } catch (error) {
                            showMessage(status, error.message);
                        }
                    });
                    actions.append(button);
                }
                row.append(actions);
                table.append(row);
            });
        } catch (error) {
            showMessage(status, error.message);
        }
    }

    try {
        const professionals = await apiRequest('/profissionais');
        professionalSelect.replaceChildren();
        professionals.forEach((professional) => {
            const option = document.createElement('option');
            option.value = professional.id;
            option.textContent = professional.especialidades
                ? `${professional.nome} — ${professional.especialidades}`
                : professional.nome;
            professionalSelect.append(option);
        });
    } catch (error) {
        showMessage(status, error.message);
    }

    document.getElementById('agendamento-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
            const payload = VitalisCore.appointmentPayload(
                document.getElementById('inicio-consulta').value,
                document.getElementById('duracao-consulta').value,
                professionalSelect.value
            );
            const data = await apiRequest('/consultas', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            showMessage(status, data.message, 'success');
            event.currentTarget.reset();
            await loadAgenda();
        } catch (error) {
            showMessage(status, error.message);
        }
    });

    await loadAgenda();
}

async function setupProfissionalDashboard() {
    const clinic = requireClinicSession('dashboard-medico.html');
    if (!clinic) return;
    applyClinicIdentity(clinic);
    const table = document.getElementById('tabela-agenda');
    const status = document.getElementById('agenda-status');

    async function loadAgenda() {
        try {
            const appointments = await apiRequest('/consultas/minha-agenda');
            table.replaceChildren();
            appointments.forEach((appointment) => {
                const row = document.createElement('tr');
                row.append(
                    tableCell(`${formatDate(appointment.inicio_em)} — ${formatDate(appointment.fim_em)}`),
                    tableCell(appointment.nome_paciente),
                    tableCell(appointment.status)
                );
                const actions = document.createElement('td');
                if (!['realizada', 'cancelada'].includes(appointment.status)) {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'btn btn-sm btn-success';
                    button.textContent = 'Marcar realizada';
                    button.addEventListener('click', async () => {
                        try {
                            await apiRequest(`/consultas/${appointment.id}/status`, {
                                method: 'PUT',
                                body: JSON.stringify({ status: 'realizada' })
                            });
                            await loadAgenda();
                        } catch (error) {
                            showMessage(status, error.message);
                        }
                    });
                    actions.append(button);
                }
                row.append(actions);
                table.append(row);
            });
            if (appointments.length === 0) {
                const row = document.createElement('tr');
                const cell = tableCell('Nenhuma consulta na agenda.');
                cell.colSpan = 4;
                cell.className = 'text-center';
                row.append(cell);
                table.append(row);
            }
        } catch (error) {
            showMessage(status, error.message);
        }
    }
    await loadAgenda();
}

async function setupAdministracaoDashboard() {
    const clinic = requireClinicSession('dashboard-secretaria.html');
    if (!clinic) return;
    applyClinicIdentity(clinic);
    document.getElementById('clinic-role').textContent = clinic.papel === 'administrador'
        ? 'Administrador da clínica'
        : 'Secretaria da clínica';
    document.getElementById('dashboard-title').textContent = clinic.papel === 'administrador'
        ? 'Administração da clínica'
        : 'Painel da secretaria';
    const summaryStatus = document.getElementById('resumo-status');
    try {
        const [professionals, appointments] = await Promise.all([
            apiRequest('/profissionais'),
            apiRequest('/consultas/minha-agenda')
        ]);
        const summary = VitalisCore.dashboardSummary(professionals, appointments);
        document.getElementById('total-profissionais').textContent = String(summary.professionals);
        document.getElementById('consultas-hoje').textContent = String(summary.today);
        document.getElementById('proximas-consultas').textContent = String(summary.upcoming);
        const agenda = VitalisCore.dashboardAgenda(appointments);
        const agendaBody = document.getElementById('agenda-resumida');
        agendaBody.replaceChildren();
        if (agenda.length === 0) {
            const row = document.createElement('tr');
            const cell = tableCell('Nenhuma consulta futura agendada ou confirmada.');
            cell.colSpan = 3;
            cell.className = 'text-center py-4 text-muted';
            row.append(cell);
            agendaBody.append(row);
        } else {
            const statusLabels = { agendada: 'Agendada', confirmada: 'Confirmada' };
            agenda.forEach((appointment) => {
                const row = document.createElement('tr');
                row.append(tableCell(formatDate(appointment.inicio_em)), tableCell(appointment.nome_profissional));
                const statusCell = document.createElement('td');
                const badge = document.createElement('span');
                badge.className = `vitalis-status vitalis-status-${appointment.status}`;
                badge.textContent = statusLabels[appointment.status];
                statusCell.append(badge);
                row.append(statusCell);
                agendaBody.append(row);
            });
        }
    } catch (error) {
        showMessage(summaryStatus, `Não foi possível carregar o resumo: ${error.message}`);
    }

    document.getElementById('refresh-dashboard')?.addEventListener('click', () => window.location.reload());

    const form = document.getElementById('upload-documento-form');
    const status = document.getElementById('upload-status');
    form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
            const data = await apiRequest('/documentos/upload', {
                method: 'POST',
                body: new FormData(form)
            });
            showMessage(status, data.message, 'success');
            form.reset();
        } catch (error) {
            showMessage(status, error.message);
        }
    });
}

async function setupGestaoProfissionaisPage() {
    const clinic = requireClinicSession('profissionais.html');
    if (!clinic) return;
    applyClinicIdentity(clinic);
    document.getElementById('clinic-role').textContent = clinic.papel === 'administrador'
        ? 'Administrador da clínica'
        : 'Secretaria da clínica';

    const form = document.getElementById('profissional-form');
    const formStatus = document.getElementById('profissional-form-status');
    const listStatus = document.getElementById('profissionais-status');
    const table = document.getElementById('profissionais-lista');
    const userField = document.getElementById('profissional-usuario-field');
    const userSelect = document.getElementById('profissional-usuario');
    const specialtyContainer = document.getElementById('profissional-especialidades');
    const formTitle = document.getElementById('profissional-form-title');
    const cancelButton = document.getElementById('cancelar-edicao');
    let professionals = [];
    let options = { usuarios: [], especialidades: [] };
    let editingId = null;

    function selectedSpecialties() {
        return [...specialtyContainer.querySelectorAll('input:checked')]
            .map((input) => Number(input.value));
    }

    function renderOptions() {
        userSelect.replaceChildren();
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = options.usuarios.length
            ? 'Selecione um usuário com vínculo profissional'
            : 'Nenhum vínculo profissional disponível';
        placeholder.disabled = true;
        placeholder.selected = true;
        userSelect.append(placeholder);
        options.usuarios.forEach((user) => {
            const option = document.createElement('option');
            option.value = user.id;
            option.textContent = `${user.nome} — ${user.email}`;
            userSelect.append(option);
        });

        specialtyContainer.replaceChildren();
        if (options.especialidades.length === 0) {
            const message = document.createElement('p');
            message.className = 'text-muted small mb-0';
            message.textContent = 'Nenhuma especialidade ativa cadastrada.';
            specialtyContainer.append(message);
            return;
        }
        options.especialidades.forEach((specialty) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'form-check';
            const input = document.createElement('input');
            input.className = 'form-check-input';
            input.type = 'checkbox';
            input.value = specialty.id;
            input.id = `especialidade-${specialty.id}`;
            const label = document.createElement('label');
            label.className = 'form-check-label';
            label.htmlFor = input.id;
            label.textContent = specialty.nome;
            wrapper.append(input, label);
            specialtyContainer.append(wrapper);
        });
    }

    function resetForm() {
        editingId = null;
        form.reset();
        formTitle.textContent = 'Cadastrar profissional';
        userField.hidden = false;
        userSelect.required = true;
        cancelButton.hidden = true;
        specialtyContainer.querySelectorAll('input').forEach((input) => { input.checked = false; });
        showMessage(formStatus, '', 'muted');
    }

    function startEdit(professional) {
        editingId = professional.id;
        formTitle.textContent = 'Editar profissional';
        userField.hidden = true;
        userSelect.required = false;
        cancelButton.hidden = false;
        document.getElementById('profissional-nome').value = professional.nome;
        document.getElementById('profissional-conselho-tipo').value = professional.conselho_tipo ?? '';
        document.getElementById('profissional-conselho-numero').value = professional.conselho_numero ?? '';
        const specialtyIds = new Set(professional.especialidades.map((item) => item.id));
        specialtyContainer.querySelectorAll('input').forEach((input) => {
            input.checked = specialtyIds.has(Number(input.value));
        });
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function statusBadge(status) {
        const badge = document.createElement('span');
        badge.className = `vitalis-status ${status === 'ativo' ? 'vitalis-status-confirmada' : 'vitalis-status-inativo'}`;
        badge.textContent = status === 'ativo' ? 'Ativo' : 'Inativo';
        return badge;
    }

    function renderProfessionals() {
        table.replaceChildren();
        if (professionals.length === 0) {
            const row = document.createElement('tr');
            const cell = tableCell('Nenhum profissional cadastrado nesta clínica.');
            cell.colSpan = 5;
            cell.className = 'text-center py-4 text-muted';
            row.append(cell);
            table.append(row);
            return;
        }
        professionals.forEach((professional) => {
            const row = document.createElement('tr');
            const identity = document.createElement('td');
            const name = document.createElement('strong');
            name.textContent = professional.nome;
            const email = document.createElement('small');
            email.className = 'd-block text-muted';
            email.textContent = professional.email;
            identity.append(name, email);
            row.append(identity);
            row.append(tableCell(
                professional.conselho_tipo && professional.conselho_numero
                    ? `${professional.conselho_tipo} ${professional.conselho_numero}`
                    : 'Não informado'
            ));
            row.append(tableCell(
                professional.especialidades
                    .map((item) => item.status === 'inativa' ? `${item.nome} (inativa)` : item.nome)
                    .join(', ') || 'Sem especialidade'
            ));
            const statusCell = document.createElement('td');
            statusCell.append(statusBadge(professional.status));
            row.append(statusCell);

            const actions = document.createElement('td');
            actions.className = 'vitalis-table-actions';
            const editButton = document.createElement('button');
            editButton.type = 'button';
            editButton.className = 'btn btn-sm btn-outline-primary';
            editButton.innerHTML = '<i class="bi bi-pencil"></i><span class="visually-hidden">Editar</span>';
            editButton.setAttribute('aria-label', `Editar ${professional.nome}`);
            editButton.addEventListener('click', () => startEdit(professional));
            const statusButton = document.createElement('button');
            statusButton.type = 'button';
            statusButton.className = `btn btn-sm ${professional.status === 'ativo' ? 'btn-outline-danger' : 'btn-outline-success'}`;
            statusButton.textContent = professional.status === 'ativo' ? 'Desativar' : 'Ativar';
            statusButton.setAttribute('aria-label', `${statusButton.textContent} ${professional.nome}`);
            statusButton.addEventListener('click', async () => {
                const nextStatus = professional.status === 'ativo' ? 'inativo' : 'ativo';
                if (!window.confirm(`${statusButton.textContent} o profissional ${professional.nome}?`)) return;
                try {
                    const result = await apiRequest(`/profissionais/${professional.id}/status`, {
                        method: 'PATCH',
                        body: JSON.stringify({ status: nextStatus })
                    });
                    showMessage(listStatus, result.message, 'success');
                    await loadData();
                } catch (error) {
                    showMessage(listStatus, error.message);
                }
            });
            actions.append(editButton, statusButton);
            row.append(actions);
            table.append(row);
        });
    }

    async function loadData() {
        const [professionalData, optionData] = await Promise.all([
            apiRequest('/profissionais/gestao'),
            apiRequest('/profissionais/opcoes')
        ]);
        professionals = professionalData;
        options = optionData;
        renderOptions();
        renderProfessionals();
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const payload = {
            nome_exibicao: document.getElementById('profissional-nome').value,
            conselho_tipo: document.getElementById('profissional-conselho-tipo').value,
            conselho_numero: document.getElementById('profissional-conselho-numero').value,
            especialidade_ids: selectedSpecialties()
        };
        if (!editingId) payload.usuario_id = Number(userSelect.value);
        try {
            const result = await apiRequest(editingId ? `/profissionais/${editingId}` : '/profissionais', {
                method: editingId ? 'PUT' : 'POST',
                body: JSON.stringify(payload)
            });
            await loadData();
            resetForm();
            showMessage(formStatus, result.message, 'success');
        } catch (error) {
            showMessage(formStatus, error.message);
        }
    });
    cancelButton.addEventListener('click', resetForm);

    try {
        await loadData();
    } catch (error) {
        showMessage(listStatus, error.message);
    }
}

async function setupGestaoEspecialidadesPage() {
    const clinic = requireClinicSession('especialidades.html');
    if (!clinic) return;
    applyClinicIdentity(clinic);
    document.getElementById('clinic-role').textContent = clinic.papel === 'administrador'
        ? 'Administrador da clínica'
        : 'Secretaria da clínica';

    const form = document.getElementById('especialidade-form');
    const nameInput = document.getElementById('especialidade-nome');
    const formTitle = document.getElementById('especialidade-form-title');
    const cancelButton = document.getElementById('cancelar-edicao-especialidade');
    const formStatus = document.getElementById('especialidade-form-status');
    const listStatus = document.getElementById('especialidades-status');
    const table = document.getElementById('especialidades-lista');
    let specialties = [];
    let editingId = null;

    function statusBadge(status) {
        const badge = document.createElement('span');
        badge.className = `vitalis-status ${status === 'ativa' ? 'vitalis-status-confirmada' : 'vitalis-status-inativo'}`;
        badge.textContent = status === 'ativa' ? 'Ativa' : 'Inativa';
        return badge;
    }

    function resetForm() {
        editingId = null;
        form.reset();
        formTitle.textContent = 'Cadastrar especialidade';
        cancelButton.hidden = true;
        showMessage(formStatus, '', 'muted');
    }

    function startEdit(specialty) {
        editingId = specialty.id;
        formTitle.textContent = 'Editar especialidade';
        nameInput.value = specialty.nome;
        cancelButton.hidden = false;
        nameInput.focus();
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function renderSpecialties() {
        table.replaceChildren();
        if (specialties.length === 0) {
            const row = document.createElement('tr');
            const cell = tableCell('Nenhuma especialidade cadastrada nesta clínica.');
            cell.colSpan = 4;
            cell.className = 'text-center py-4 text-muted';
            row.append(cell);
            table.append(row);
            return;
        }
        specialties.forEach((specialty) => {
            const row = document.createElement('tr');
            const name = document.createElement('td');
            const strong = document.createElement('strong');
            strong.textContent = specialty.nome;
            name.append(strong);
            row.append(name);
            row.append(tableCell(String(specialty.total_profissionais)));
            const statusCell = document.createElement('td');
            statusCell.append(statusBadge(specialty.status));
            row.append(statusCell);

            const actions = document.createElement('td');
            actions.className = 'vitalis-table-actions';
            const editButton = document.createElement('button');
            editButton.type = 'button';
            editButton.className = 'btn btn-sm btn-outline-primary';
            editButton.innerHTML = '<i class="bi bi-pencil"></i><span class="visually-hidden">Editar</span>';
            editButton.setAttribute('aria-label', `Editar ${specialty.nome}`);
            editButton.addEventListener('click', () => startEdit(specialty));
            const statusButton = document.createElement('button');
            statusButton.type = 'button';
            statusButton.className = `btn btn-sm ${specialty.status === 'ativa' ? 'btn-outline-danger' : 'btn-outline-success'}`;
            statusButton.textContent = specialty.status === 'ativa' ? 'Desativar' : 'Ativar';
            statusButton.setAttribute('aria-label', `${statusButton.textContent} ${specialty.nome}`);
            statusButton.addEventListener('click', async () => {
                const nextStatus = specialty.status === 'ativa' ? 'inativa' : 'ativa';
                if (!window.confirm(`${statusButton.textContent} a especialidade ${specialty.nome}? Os vínculos existentes serão preservados.`)) return;
                try {
                    const result = await apiRequest(`/especialidades/${specialty.id}/status`, {
                        method: 'PATCH',
                        body: JSON.stringify({ status: nextStatus })
                    });
                    showMessage(listStatus, result.message, 'success');
                    await loadData();
                } catch (error) {
                    showMessage(listStatus, error.message);
                }
            });
            actions.append(editButton, statusButton);
            row.append(actions);
            table.append(row);
        });
    }

    async function loadData() {
        specialties = await apiRequest('/especialidades/gestao');
        renderSpecialties();
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
            const result = await apiRequest(editingId ? `/especialidades/${editingId}` : '/especialidades', {
                method: editingId ? 'PUT' : 'POST',
                body: JSON.stringify({ nome: nameInput.value })
            });
            await loadData();
            resetForm();
            showMessage(formStatus, result.message, 'success');
        } catch (error) {
            showMessage(formStatus, error.message);
        }
    });
    cancelButton.addEventListener('click', resetForm);

    try {
        await loadData();
    } catch (error) {
        showMessage(listStatus, error.message);
    }
}
