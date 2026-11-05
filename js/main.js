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
    document.getElementById('dashboard-title').textContent = clinic.papel === 'administrador'
        ? 'Administração da clínica'
        : 'Painel da secretaria';
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
