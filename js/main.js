const API_URL = window.VITALIS_API_URL || 'http://localhost:3000/api';
const session = VitalisCore.createSession(window.sessionStorage);

function showMessage(element, message, type = 'danger') {
    if (!element) return;
    element.className = `mt-3 text-${type}`;
    element.textContent = message;
}

function confirmationStateBadge(state, channel) {
    if (!state) return null;
    const labels = {
        preparada: 'Confirmação pendente', confirmada: 'Presença confirmada',
        recusada: 'Não poderá comparecer', expirada: 'Confirmação expirada',
        revogada: 'Confirmação revogada'
    };
    const badge = document.createElement('span');
    badge.className = `vitalis-confirmation-state vitalis-confirmation-state-${state}`;
    const channelLabels = {
        manual: 'registro manual', portal_vitalis: 'Painel Vitalis',
        whatsapp: 'WhatsApp', aplicativo: 'Aplicativo Vitalis', push: 'push'
    };
    badge.textContent = `${labels[state] || state}${channelLabels[channel] ? ` · ${channelLabels[channel]}` : ''}`;
    return badge;
}

function overflowActionMenu(label, items) {
    const details = document.createElement('details');
    details.className = 'vitalis-overflow-menu';
    const summary = document.createElement('summary');
    summary.className = 'btn btn-sm btn-outline-secondary';
    summary.setAttribute('aria-label', label);
    summary.title = label;
    summary.innerHTML = '<i class="bi bi-three-dots-vertical" aria-hidden="true"></i>';
    const menu = document.createElement('div'); menu.className = 'vitalis-overflow-menu-list';
    items.filter(Boolean).forEach(({ text, icon, action, disabled = false, title = '' }) => {
        const button = document.createElement('button'); button.type = 'button';
        button.className = 'vitalis-overflow-menu-item'; button.disabled = disabled; button.title = title;
        button.innerHTML = `<i class="bi ${icon}" aria-hidden="true"></i><span>${text}</span>`;
        button.addEventListener('click', async () => {
            details.open = false;
            await action();
        });
        menu.append(button);
    });
    details.append(summary, menu);
    return details;
}

const pendingConfirmationRequests = new Set();

async function requestAppointmentConfirmation(appointment, statusElement, afterSuccess = async () => {}) {
    const replacing = Boolean(appointment.confirmacao_estado);
    const expectedChannel = appointment.confirmacao_canal_recomendado;
    if (!['portal_vitalis', 'whatsapp'].includes(expectedChannel)) {
        showMessage(
            statusElement,
            'O paciente não possui um canal de confirmação autorizado. Revise as preferências de contato.',
            'info'
        );
        return;
    }
    const usesWhatsApp = expectedChannel === 'whatsapp';
    const prompt = replacing
        ? `Substituir a solicitação pelo ${usesWhatsApp ? 'WhatsApp' : 'painel Vitalis'}? O histórico será preservado.`
        : usesWhatsApp
        ? 'Preparar uma solicitação de confirmação pelo WhatsApp?'
        : 'Disponibilizar a solicitação no painel Vitalis do paciente?';
    if (!window.confirm(prompt) || pendingConfirmationRequests.has(appointment.id)) return;
    pendingConfirmationRequests.add(appointment.id);
    const popup = usesWhatsApp
        ? window.open('about:blank', 'vitalis_whatsapp_confirmation') : null;
    if (usesWhatsApp && !popup) {
        showMessage(statusElement, 'Permita pop-ups para abrir o WhatsApp com a mensagem preparada.');
        pendingConfirmationRequests.delete(appointment.id);
        return;
    }
    if (popup) popup.opener = null;
    try {
        const result = await apiRequest(`/consultas/${appointment.id}/confirmacoes`, {
            method: 'POST', body: JSON.stringify({
                versao: Number(appointment.versao), substituir: replacing,
                confirmacao_id_esperada: replacing ? Number(appointment.confirmacao_id) : null,
                canal_esperado: expectedChannel
            })
        });
        if (result.whatsapp_url && popup) popup.location.replace(result.whatsapp_url);
        else popup?.close();
        showMessage(statusElement, result.message, 'success');
        await afterSuccess();
    } catch (error) {
        popup?.close(); showMessage(statusElement, error.message);
    } finally { pendingConfirmationRequests.delete(appointment.id); }
}

async function registerManualConfirmation(appointment, answer, statusElement, afterSuccess = async () => {}) {
    const correction = ['confirmada', 'recusada'].includes(appointment.confirmacao_estado)
        && appointment.confirmacao_estado !== answer;
    const message = correction
        ? 'Corrigir explicitamente a resposta registrada? A alteração ficará identificada no histórico e na auditoria.'
        : answer === 'confirmada'
        ? 'Registrar que o paciente confirmou presença diretamente com a clínica?'
        : 'Registrar que o paciente informou que não poderá comparecer?';
    if (!window.confirm(message)) return;
    try {
        const result = await apiRequest(`/consultas/${appointment.id}/confirmacoes/manual`, {
            method: 'POST', body: JSON.stringify({
                resposta: answer, versao: Number(appointment.versao), corrigir: correction
            })
        });
        showMessage(statusElement, result.message, 'success');
        await afterSuccess();
    } catch (error) { showMessage(statusElement, error.message); }
}

async function showConfirmationHistory(appointment, statusElement) {
    try {
        const data = await apiRequest(`/consultas/${appointment.id}/confirmacoes`);
        const dialog = document.createElement('dialog'); dialog.className = 'vitalis-confirmation-history';
        const title = document.createElement('h2'); title.textContent = 'Histórico de confirmações';
        const list = document.createElement('div'); list.className = 'vitalis-confirmation-history-list';
        if (!data.confirmacoes.length) {
            const empty = document.createElement('p'); empty.textContent = 'Nenhuma solicitação registrada.'; list.append(empty);
        } else data.confirmacoes.forEach((item) => {
            const row = document.createElement('article');
            const state = confirmationStateBadge(item.estado, item.canal);
            const date = document.createElement('small');
            const channel = {
                manual: 'Registro manual', portal_vitalis: 'Painel Vitalis',
                aplicativo: 'Aplicativo Vitalis', push: 'Notificação push', whatsapp: 'WhatsApp'
            }[item.canal] || item.canal;
            date.textContent = `${formatDate(item.criado_em)} · ${channel}`;
            const delivery = document.createElement('span');
            delivery.textContent = item.estado_entrega === 'nao_enviado'
                ? 'Envio/entrega não comprovados' : `Entrega: ${item.estado_entrega}`;
            row.append(state, date, delivery); list.append(row);
        });
        const close = document.createElement('button'); close.type = 'button';
        close.className = 'btn btn-outline-secondary'; close.textContent = 'Fechar';
        close.addEventListener('click', () => dialog.close());
        dialog.addEventListener('close', () => dialog.remove());
        dialog.append(title, list, close); document.body.append(dialog); dialog.showModal();
    } catch (error) { showMessage(statusElement, error.message); }
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
    if (!response.ok) {
        const error = new Error(data.error || 'Não foi possível concluir a operação.');
        error.code = data.code;
        error.details = data;
        throw error;
    }
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
    if (clinic.papel !== 'administrador') {
        document.querySelectorAll('[data-admin-only]').forEach((element) => element.remove());
    }
    document.querySelectorAll('[data-clinic-switch]').forEach((element) => {
        element.hidden = clinic.papel === 'secretaria';
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
    else if (page === 'pacientes.html') setupPatientsPage();
    else if (page === 'agenda.html') setupAppointmentsPage();
    else if (page === 'calendario.html') setupCalendarPage();
    else if (page === 'especialidades.html') setupGestaoEspecialidadesPage();
    else if (page === 'equipe.html') setupEquipePage();
    else if (page === 'aceitar-convite.html') setupAceiteConvitePage();
    else if (page === 'configuracoes-clinica.html') setupClinicSettingsPage();
    else if (page === 'provisionamento-clinicas.html') setupClinicProvisioningPage();
    else if (page === 'disponibilidade.html') setupAvailabilityPage();
    else if (page === 'confirmacao-consulta.html') setupAppointmentConfirmationPage();
});

async function setupAppointmentConfirmationPage() {
    const loading = document.getElementById('confirmation-loading');
    const details = document.getElementById('confirmation-details');
    const status = document.getElementById('confirmation-status');
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
    const controls = [
        document.getElementById('confirmation-accept'),
        document.getElementById('confirmation-decline')
    ];
    const setBusy = (busy) => controls.forEach((button) => { button.disabled = busy; });
    const renderUnavailable = (message) => {
        loading.hidden = true; details.hidden = true;
        showMessage(status, message || 'Este link não está mais disponível.', 'secondary');
    };
    if (token.length < 32) { renderUnavailable('Link de confirmação inválido.'); return; }
    try {
        const data = await apiRequest('/confirmacoes-consulta/consultar', {
            method: 'POST', cache: 'no-store', referrerPolicy: 'no-referrer',
            body: JSON.stringify({ token })
        }, null);
        document.getElementById('confirmation-clinic').textContent = data.clinica_nome;
        const local = data.inicio_local;
        document.getElementById('confirmation-date').textContent = `${local.slice(8, 10)}/${local.slice(5, 7)}/${local.slice(0, 4)} às ${local.slice(11, 16)}`;
        loading.hidden = true; details.hidden = false;
    } catch (error) {
        renderUnavailable('Este link não está disponível. Entre em contato com a clínica.');
        return;
    }
    async function respond(answer) {
        if (!window.confirm(answer === 'confirmada'
            ? 'Confirmar que pretende comparecer?' : 'Informar que não poderá comparecer?')) return;
        setBusy(true);
        try {
            const data = await apiRequest('/confirmacoes-consulta/responder', {
                method: 'POST', cache: 'no-store', referrerPolicy: 'no-referrer',
                body: JSON.stringify({ token, resposta: answer })
            }, null);
            details.hidden = true;
            showMessage(status, data.message, answer === 'confirmada' ? 'success' : 'secondary');
        } catch (error) { showMessage(status, error.message); setBusy(false); }
    }
    controls[0].addEventListener('click', () => respond('confirmada'));
    controls[1].addEventListener('click', () => respond('recusada'));
}

async function setupClinicSettingsPage() {
    const clinic = requireClinicSession('configuracoes-clinica.html');
    if (!clinic) return;
    applyClinicIdentity(clinic);
    const form = document.getElementById('configuracoes-clinica-form');
    const status = document.getElementById('configuracoes-clinica-status');
    try {
        const settings = await apiRequest('/clinica/configuracoes');
        document.getElementById('config-clinica-nome').value = settings.nome;
        document.getElementById('config-clinica-slug').value = settings.slug;
        document.getElementById('config-clinica-timezone').value = settings.timezone;
        document.getElementById('config-clinica-status').textContent = settings.status === 'ativa' ? 'Ativa' : 'Inativa';
    } catch (error) {
        showMessage(status, error.message);
        form.hidden = true;
        return;
    }
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!window.confirm('Salvar nome e fuso horário da clínica ativa?')) return;
        try {
            const data = await apiRequest('/clinica/configuracoes', {
                method: 'PATCH',
                body: JSON.stringify({
                    nome: document.getElementById('config-clinica-nome').value,
                    timezone: document.getElementById('config-clinica-timezone').value
                })
            });
            session.saveClinic({
                token: session.clinicToken,
                clinica: { ...clinic, nome: data.clinica.nome }
            });
            showMessage(status, data.message, 'success');
            document.querySelectorAll('[data-clinic-name]').forEach((element) => {
                element.textContent = data.clinica.nome;
            });
        } catch (error) {
            showMessage(status, error.message);
        }
    });
}

async function setupClinicProvisioningPage() {
    if (!session.identityToken) {
        window.location.replace('login.html');
        return;
    }
    const form = document.getElementById('provisionamento-form');
    const status = document.getElementById('provisionamento-status-mensagem');
    const listStatus = document.getElementById('provisionamento-lista-status');
    const list = document.getElementById('provisionamento-lista');
    const accessState = document.getElementById('provisionamento-acesso');
    const accessAlert = document.getElementById('provisionamento-acesso-alerta');
    const accessIcon = document.getElementById('provisionamento-acesso-icone');
    const accessTitle = document.getElementById('provisionamento-acesso-titulo');
    const accessMessage = document.getElementById('provisionamento-acesso-mensagem');
    const protectedContent = document.getElementById('provisionamento-conteudo');

    function renderAccessState(state) {
        const states = {
            restricted: {
                alert: 'alert-warning',
                icon: 'bi-shield-lock',
                title: 'Acesso restrito',
                message: 'Sua conta não possui permissão para provisionar clínicas. Volte à seleção de clínicas para continuar.'
            },
            unavailable: {
                alert: 'alert-danger',
                icon: 'bi-cloud-slash',
                title: 'Não foi possível verificar o acesso',
                message: 'Houve uma falha de comunicação com o Vitalis. Verifique a conexão e tente novamente.'
            }
        };
        const view = states[state];
        protectedContent.hidden = true;
        accessState.hidden = false;
        accessAlert.className = `alert ${view.alert} mb-0`;
        accessIcon.className = `bi ${view.icon}`;
        accessTitle.textContent = view.title;
        accessMessage.textContent = view.message;
    }

    async function loadClinics() {
        const clinics = await apiRequest('/plataforma/clinicas', {}, 'identity');
        list.replaceChildren();
        clinics.forEach((clinic) => {
            const card = document.createElement('article');
            card.className = 'vitalis-provisioning-card';
            const title = document.createElement('strong');
            title.textContent = clinic.nome;
            const detail = document.createElement('span');
            detail.textContent = `${clinic.slug} · ${clinic.timezone}`;
            const admin = document.createElement('small');
            const adminStatusLabel = {
                ativo: 'acesso ativo',
                convite_pendente: 'ativação pendente',
                inativo: 'acesso inativo'
            }[clinic.administrador_status] || clinic.administrador_status;
            admin.textContent = clinic.administrador_email
                ? `Administrador: ${clinic.administrador_email} · ${adminStatusLabel}`
                : 'Administrador ainda não definido';
            const invitationState = document.createElement('small');
            invitationState.className = 'vitalis-provisioning-invitation';
            if (clinic.administrador_status === 'ativo') {
                invitationState.textContent = 'Acesso do administrador ativo';
            } else if (clinic.convite_expirado) {
                invitationState.textContent = 'Convite expirado';
            } else if (clinic.convite_envio_status === 'failed') {
                invitationState.textContent = 'Falha ao solicitar o envio';
            } else if (clinic.convite_envio_status === 'not_configured') {
                invitationState.textContent = 'E-mail não configurado';
            } else if (clinic.convite_envio_status === 'accepted_by_provider') {
                invitationState.textContent = 'Envio aceito pelo provedor; entrega não confirmada';
            } else if (clinic.convite_envio_status === 'delivered') {
                invitationState.textContent = 'Entrega confirmada; aceite pendente';
            } else {
                invitationState.textContent = clinic.convite_status
                    ? `Convite ${clinic.convite_status}`
                    : 'Convite ainda não disponível';
            }
            card.append(title, detail, admin, invitationState);
            if (clinic.pode_reenviar_convite && clinic.convite_id) {
                const resend = document.createElement('button');
                resend.type = 'button';
                resend.className = 'btn btn-sm btn-outline-primary mt-2';
                resend.textContent = 'Gerar novo convite';
                resend.addEventListener('click', async () => {
                    if (!window.confirm(`Invalidar o convite anterior e gerar outro para ${clinic.administrador_email}?`)) return;
                    try {
                        const data = await apiRequest(
                            `/plataforma/clinicas/${clinic.id}/convites/${clinic.convite_id}/reenviar`,
                            { method: 'POST' },
                            'identity'
                        );
                        showMessage(status, data.message, 'success');
                        await loadClinics();
                    } catch (error) {
                        showMessage(status, error.message);
                    }
                });
                card.append(resend);
            }
            list.append(card);
        });
        if (!clinics.length) showMessage(listStatus, 'Nenhuma clínica provisionada.', 'secondary');
        else listStatus.replaceChildren();
    }

    let capabilities;
    try {
        capabilities = await apiRequest('/plataforma/capacidades', {}, 'identity');
    } catch {
        renderAccessState(VitalisCore.platformAccessState(null, true));
        return;
    }
    const permissionState = VitalisCore.platformAccessState(capabilities);
    if (permissionState !== 'authorized') {
        renderAccessState(permissionState);
        return;
    }

    accessState.hidden = true;
    protectedContent.hidden = false;
    try {
        await loadClinics();
    } catch (error) {
        showMessage(listStatus, `Acesso confirmado, mas não foi possível carregar as clínicas: ${error.message}`);
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const clinicName = document.getElementById('provisionamento-nome').value.trim();
        const adminEmail = document.getElementById('provisionamento-admin-email').value.trim();
        if (!window.confirm(`Criar ${clinicName} e convidar ${adminEmail} como primeiro administrador?`)) return;
        try {
            const data = await apiRequest('/plataforma/clinicas', {
                method: 'POST',
                body: JSON.stringify({
                    nome: clinicName,
                    slug: document.getElementById('provisionamento-slug').value,
                    timezone: document.getElementById('provisionamento-timezone').value,
                    status: document.getElementById('provisionamento-status').value,
                    administrador_nome: document.getElementById('provisionamento-admin-nome').value,
                    administrador_email: adminEmail
                })
            }, 'identity');
            showMessage(status, data.message, 'success');
            form.reset();
            await loadClinics();
        } catch (error) {
            showMessage(status, error.message);
        }
    });
}

async function setupAvailabilityPage() {
    const clinic = requireClinicSession('disponibilidade.html');
    if (!clinic) return;
    applyClinicIdentity(clinic);
    document.querySelectorAll('[data-availability-home]').forEach((link) => {
        link.href = VitalisCore.dashboardForRole(clinic.papel) || 'select-clinic.html';
    });
    if (!['administrador', 'secretaria'].includes(clinic.papel)) {
        document.querySelectorAll('[data-management-only]').forEach((element) => element.remove());
    }
    const professionalSelect = document.getElementById('disponibilidade-profissional');
    const timezone = document.getElementById('disponibilidade-timezone');
    const pageStatus = document.getElementById('disponibilidade-status');
    const content = document.getElementById('disponibilidade-conteudo');
    const intervalList = document.getElementById('disponibilidade-intervalos');
    const weeklyForm = document.getElementById('disponibilidade-semanal-form');
    const blockForm = document.getElementById('bloqueio-form');
    const addIntervalButton = document.getElementById('adicionar-intervalo');
    const weeklyStatus = document.getElementById('disponibilidade-semanal-status');
    const blockStatus = document.getElementById('bloqueio-form-status');
    const blockList = document.getElementById('bloqueios-lista');
    const dayNames = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
    const typeLabels = { atendimento: 'Atendimento', descanso: 'Descanso' };
    const blockLabels = { ferias: 'Férias', feriado: 'Feriado', indisponibilidade: 'Indisponibilidade' };
    const loadGate = VitalisCore.createLatestRequestGate();
    let loadedProfessionalId = null;
    let mutationInProgress = false;

    function setProtectedControlsDisabled(disabled) {
        content.setAttribute('aria-busy', String(disabled));
        content.querySelectorAll('button, input, select').forEach((control) => {
            control.disabled = disabled;
        });
    }

    function mutationTarget(expectedId = null) {
        const professionalId = VitalisCore.matchingSelectionId(
            loadedProfessionalId, professionalSelect.value
        );
        if (!professionalId || (expectedId && professionalId !== expectedId) || mutationInProgress) {
            showMessage(pageStatus, 'Aguarde o carregamento do profissional selecionado antes de alterar horários.');
            return null;
        }
        return professionalId;
    }

    async function runMutation(expectedId, operation) {
        const professionalId = mutationTarget(expectedId);
        if (!professionalId) return false;
        mutationInProgress = true;
        professionalSelect.disabled = true;
        setProtectedControlsDisabled(true);
        try {
            await operation(professionalId);
            return true;
        } finally {
            mutationInProgress = false;
            professionalSelect.disabled = clinic.papel === 'profissional';
            if (loadedProfessionalId) setProtectedControlsDisabled(false);
        }
    }

    function option(value, label, selected = false) {
        const element = document.createElement('option');
        element.value = value;
        element.textContent = label;
        element.selected = selected;
        return element;
    }

    function addInterval(data = {}) {
        const row = document.createElement('div');
        row.className = 'vitalis-availability-interval';
        const day = document.createElement('select');
        day.className = 'form-select';
        day.setAttribute('aria-label', 'Dia da semana');
        dayNames.forEach((name, index) => day.append(option(index, name, Number(data.dia_semana) === index)));
        const type = document.createElement('select');
        type.className = 'form-select';
        type.setAttribute('aria-label', 'Tipo de intervalo');
        Object.entries(typeLabels).forEach(([value, label]) => type.append(option(value, label, data.tipo === value)));
        const start = document.createElement('input');
        start.className = 'form-control';
        start.type = 'time';
        start.value = data.inicio || '08:00';
        start.required = true;
        start.setAttribute('aria-label', 'Início do intervalo');
        const end = document.createElement('input');
        end.className = 'form-control';
        end.type = 'time';
        end.value = data.fim || '12:00';
        end.required = true;
        end.setAttribute('aria-label', 'Fim do intervalo');
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-outline-danger';
        remove.setAttribute('aria-label', 'Remover intervalo');
        remove.innerHTML = '<i class="bi bi-trash"></i><span class="d-sm-none"> Remover</span>';
        remove.addEventListener('click', () => row.remove());
        row.append(day, type, start, end, remove);
        intervalList.append(row);
    }

    function intervalPayload() {
        return [...intervalList.querySelectorAll('.vitalis-availability-interval')].map((row) => {
            const [day, type, start, end] = row.querySelectorAll('select, input');
            return {
                dia_semana: Number(day.value), tipo: type.value,
                inicio: start.value, fim: end.value
            };
        });
    }

    function localLabel(value) {
        if (typeof value !== 'string' || !value.includes('T')) return 'Horário indisponível';
        const [date, time] = value.split('T');
        const [year, month, day] = date.split('-');
        return `${day}/${month}/${year} ${time}`;
    }

    function renderBlocks(blocks, renderedProfessionalId) {
        blockList.replaceChildren();
        if (!blocks.length) {
            const empty = document.createElement('p');
            empty.className = 'text-muted mb-0';
            empty.textContent = 'Nenhum bloqueio cadastrado para este profissional.';
            blockList.append(empty);
            return;
        }
        blocks.forEach((block) => {
            const card = document.createElement('article');
            card.className = 'vitalis-block-card';
            const header = document.createElement('div');
            const title = document.createElement('strong');
            title.textContent = blockLabels[block.tipo] || block.tipo;
            const badge = document.createElement('span');
            badge.className = `vitalis-team-badge ${block.status === 'ativo' ? 'vitalis-team-badge-active' : 'vitalis-team-badge-neutral'}`;
            badge.textContent = block.status === 'ativo' ? 'Ativo' : 'Cancelado';
            header.append(title, badge);
            const period = document.createElement('p');
            period.textContent = `${localLabel(block.inicio_local)} até ${localLabel(block.fim_local)}`;
            card.append(header, period);
            if (block.motivo) {
                const reason = document.createElement('small');
                reason.textContent = block.motivo;
                card.append(reason);
            }
            if (block.status === 'ativo') {
                const cancel = document.createElement('button');
                cancel.type = 'button';
                cancel.className = 'btn btn-sm btn-outline-danger mt-2';
                cancel.textContent = 'Cancelar bloqueio';
                cancel.addEventListener('click', async () => {
                    if (!window.confirm('Cancelar este bloqueio e preservar seu histórico?')) return;
                    try {
                        await runMutation(renderedProfessionalId, async (professionalId) => {
                            const data = await apiRequest(`/disponibilidade/profissionais/${professionalId}/bloqueios/${block.id}/cancelar`, { method: 'PATCH' });
                            showMessage(blockStatus, data.message, 'success');
                            await loadAvailability();
                        });
                    } catch (error) {
                        showMessage(blockStatus, error.message);
                    }
                });
                card.append(cancel);
            }
            blockList.append(card);
        });
    }

    async function loadAvailability() {
        const professionalId = Number(professionalSelect.value);
        if (!professionalId) {
            loadGate.invalidate();
            loadedProfessionalId = null;
            content.hidden = true;
            return;
        }
        const ticket = loadGate.begin(professionalId);
        loadedProfessionalId = null;
        content.hidden = true;
        setProtectedControlsDisabled(true);
        showMessage(pageStatus, 'Carregando disponibilidade...', 'secondary');
        try {
            const data = await apiRequest(`/disponibilidade/profissionais/${professionalId}`);
            if (!loadGate.isCurrent(ticket, professionalSelect.value)) return;
            intervalList.replaceChildren();
            data.intervalos.forEach(addInterval);
            renderBlocks(data.bloqueios, professionalId);
            timezone.textContent = data.timezone;
            loadedProfessionalId = professionalId;
            setProtectedControlsDisabled(mutationInProgress);
            content.hidden = false;
            pageStatus.replaceChildren();
        } catch (error) {
            if (!loadGate.isCurrent(ticket, professionalSelect.value)) return;
            loadedProfessionalId = null;
            content.hidden = true;
            showMessage(pageStatus, error.message);
        }
    }

    addIntervalButton.addEventListener('click', () => addInterval());
    professionalSelect.addEventListener('change', loadAvailability);
    weeklyForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
            const payload = intervalPayload();
            await runMutation(null, async (professionalId) => {
                const data = await apiRequest(`/disponibilidade/profissionais/${professionalId}/semana`, {
                    method: 'PUT', body: JSON.stringify({ intervalos: payload })
                });
                showMessage(weeklyStatus, data.message, 'success');
                await loadAvailability();
            });
        } catch (error) {
            showMessage(weeklyStatus, error.message);
        }
    });
    blockForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
            const payload = {
                tipo: document.getElementById('bloqueio-tipo').value,
                inicio_local: document.getElementById('bloqueio-inicio').value,
                fim_local: document.getElementById('bloqueio-fim').value,
                motivo: document.getElementById('bloqueio-motivo').value
            };
            await runMutation(null, async (professionalId) => {
                const data = await apiRequest(`/disponibilidade/profissionais/${professionalId}/bloqueios`, {
                    method: 'POST', body: JSON.stringify(payload)
                });
                showMessage(blockStatus, data.message, 'success');
                blockForm.reset();
                await loadAvailability();
            });
        } catch (error) {
            showMessage(blockStatus, error.message);
        }
    });

    try {
        const data = await apiRequest('/disponibilidade/contexto');
        timezone.textContent = data.timezone;
        professionalSelect.replaceChildren();
        data.profissionais.forEach((professional) => {
            professionalSelect.append(option(professional.id, professional.nome_exibicao));
        });
        if (!data.profissionais.length) {
            professionalSelect.append(option('', 'Nenhum profissional ativo disponível', true));
            professionalSelect.disabled = true;
            showMessage(pageStatus, 'Nenhum profissional ativo está disponível nesta clínica.', 'secondary');
            return;
        }
        professionalSelect.disabled = clinic.papel === 'profissional';
        await loadAvailability();
    } catch (error) {
        content.hidden = true;
        showMessage(pageStatus, error.message);
    }
}

async function setupEquipePage() {
    const clinic = requireClinicSession('equipe.html');
    if (!clinic) return;
    applyClinicIdentity(clinic);
    const list = document.getElementById('equipe-lista');
    const status = document.getElementById('equipe-status');
    const roleSelect = document.getElementById('convite-papel');
    const roleLabels = {
        administrador: 'Administrador', secretaria: 'Secretaria',
        profissional: 'Profissional', paciente: 'Paciente'
    };
    const linkLabels = {
        convite_pendente: ['Convite pendente', 'vitalis-team-badge-pending'],
        ativo: ['Acesso ativo', 'vitalis-team-badge-active'],
        inativo: ['Acesso inativo', 'vitalis-team-badge-inactive']
    };
    const invitationLabels = {
        pendente: ['Pendente', 'vitalis-team-badge-pending'],
        aceito: ['Aceito', 'vitalis-team-badge-active'],
        revogado: ['Revogado', 'vitalis-team-badge-inactive']
    };
    if (clinic.papel === 'secretaria') {
        [...roleSelect.options].forEach((option) => {
            if (option.value !== 'profissional') option.remove();
        });
    }

    function badge([label, css]) {
        const element = document.createElement('span');
        element.className = `vitalis-team-badge ${css}`;
        element.textContent = label;
        return element;
    }

    function setCellLabel(cell, label) {
        cell.dataset.label = label;
        return cell;
    }

    async function action(path, method = 'POST', body, successMessage) {
        const data = await apiRequest(path, {
            method,
            body: body ? JSON.stringify(body) : undefined
        });
        await load();
        showMessage(status, successMessage || data.message || 'Alteração realizada com sucesso.', 'success');
    }

    async function load() {
        try {
            const members = await apiRequest('/equipe');
            list.replaceChildren();
            if (!members.length) {
                const row = document.createElement('tr'); const cell = tableCell('Nenhum membro.'); cell.colSpan = 5; row.append(cell); list.append(row); return;
            }
            members.forEach((member) => {
                const row = document.createElement('tr');
                const person = setCellLabel(document.createElement('td'), 'Pessoa');
                person.className = 'vitalis-team-person';
                const personName = document.createElement('strong');
                personName.className = 'vitalis-team-person-name';
                personName.textContent = member.nome;
                const email = document.createElement('small');
                email.className = 'vitalis-team-email';
                email.textContent = member.email;
                person.append(personName, email);

                const roleCell = setCellLabel(tableCell(roleLabels[member.papel] || member.papel), 'Papel');
                if (clinic.papel === 'administrador' && member.status !== 'convite_pendente') {
                    const select = document.createElement('select');
                    select.className = 'form-select form-select-sm vitalis-team-role-select';
                    select.setAttribute('aria-label', `Papel de ${member.nome}`);
                    ['administrador', 'secretaria', 'profissional', 'paciente'].forEach((role) => {
                        const option = document.createElement('option');
                        option.value = role; option.textContent = roleLabels[role]; option.selected = role === member.papel;
                        select.append(option);
                    });
                    select.addEventListener('change', () => {
                        const nextRole = select.value;
                        if (!window.confirm(`Alterar o papel de ${member.nome} para ${roleLabels[nextRole]}?`)) {
                            select.value = member.papel;
                            return;
                        }
                        action(
                            `/equipe/vinculos/${member.id}/papel`, 'PATCH', { papel: nextRole },
                            `Papel de ${member.nome} atualizado.`
                        ).catch((error) => { showMessage(status, error.message); load(); });
                    });
                    roleCell.replaceChildren(select);
                }
                const deliveryLabel = {
                    not_requested: 'Envio pendente',
                    not_configured: 'E-mail não configurado',
                    accepted_by_provider: 'Aceito pelo provedor; entrega não confirmada',
                    delivered: 'Entrega confirmada',
                    failed: 'Falha no envio'
                }[member.envio_status];
                const linkCell = setCellLabel(document.createElement('td'), 'Vínculo');
                linkCell.append(badge(linkLabels[member.status] || [member.status, 'vitalis-team-badge-neutral']));
                const invitationCell = setCellLabel(document.createElement('td'), 'Convite');
                invitationCell.className = 'vitalis-team-invitation';
                if (member.convite_status) {
                    invitationCell.append(badge(
                        invitationLabels[member.convite_status]
                            || [member.convite_status, 'vitalis-team-badge-neutral']
                    ));
                    if (deliveryLabel) {
                        const delivery = document.createElement('small');
                        delivery.textContent = deliveryLabel;
                        invitationCell.append(delivery);
                    }
                } else {
                    invitationCell.textContent = 'Ainda não gerado';
                }
                row.append(person, roleCell, linkCell, invitationCell);

                const actions = setCellLabel(document.createElement('td'), 'Ações');
                actions.className = 'vitalis-team-actions';
                const addButton = (label, css, handler) => {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = `btn btn-sm ${css}`;
                    button.textContent = label;
                    button.addEventListener('click', handler);
                    actions.append(button);
                };
                const canManageMember = clinic.papel === 'administrador'
                    || (clinic.papel === 'secretaria' && member.papel === 'profissional');
                if (canManageMember && member.status === 'convite_pendente') {
                    if (member.convite_id && member.convite_status === 'pendente') {
                        addButton('Reenviar', 'btn-outline-primary', () => {
                            if (window.confirm(`Reenviar o convite para ${member.email}? O link anterior será invalidado.`)) {
                                action(
                                    `/equipe/convites/${member.convite_id}/reenviar`, 'POST', undefined,
                                    `Novo convite criado para ${member.nome}.`
                                ).catch((error) => showMessage(status, error.message));
                            }
                        });
                        addButton('Revogar', 'btn-outline-danger', () => {
                            if (window.confirm(`Revogar o convite de ${member.nome}? O link deixará de funcionar imediatamente.`)) {
                                action(
                                    `/equipe/convites/${member.convite_id}/revogar`, 'POST', undefined,
                                    `Convite de ${member.nome} revogado.`
                                ).catch((error) => showMessage(status, error.message));
                            }
                        });
                    } else {
                        addButton(member.convite_id ? 'Gerar novo convite' : 'Gerar convite', 'btn-outline-primary', () => action(
                            '/equipe/convites', 'POST',
                            { email: member.email, papel: member.papel, nome: member.nome },
                            `Convite criado para ${member.nome}.`
                        ).catch((error) => showMessage(status, error.message)));
                    }
                }
                if (canManageMember && member.status === 'ativo') addButton('Desativar', 'btn-outline-danger', () => {
                    if (window.confirm(`Desativar o acesso de ${member.nome}? As sessões desse vínculo serão encerradas.`)) {
                        action(
                            `/equipe/vinculos/${member.id}/status`, 'PATCH', {status:'inativo'},
                            `Acesso de ${member.nome} desativado.`
                        ).catch((error) => showMessage(status, error.message));
                    }
                });
                if (canManageMember && member.status === 'inativo') addButton('Reativar', 'btn-outline-success', () => {
                    if (window.confirm(`Reativar o acesso de ${member.nome} como ${roleLabels[member.papel]}?`)) {
                        action(
                            `/equipe/vinculos/${member.id}/status`, 'PATCH', {status:'ativo'},
                            `Acesso de ${member.nome} reativado.`
                        ).catch((error) => showMessage(status, error.message));
                    }
                });
                if (!actions.childElementCount) {
                    const noActions = document.createElement('span');
                    noActions.className = 'vitalis-team-no-actions';
                    noActions.textContent = canManageMember ? 'Nenhuma ação disponível' : 'Somente visualização';
                    actions.append(noActions);
                }
                row.append(actions); list.append(row);
            });
        } catch (error) { showMessage(status, error.message); }
    }
    document.getElementById('convite-form').addEventListener('submit', async (event) => {
        event.preventDefault(); const message = document.getElementById('convite-status');
        try { const data = await apiRequest('/equipe/convites',{method:'POST',body:JSON.stringify({nome:document.getElementById('convite-nome').value,email:document.getElementById('convite-email').value,papel:roleSelect.value})}); showMessage(message,data.message,'success'); event.target.reset(); await load(); } catch(error) { showMessage(message,error.message); }
    });
    await load();
}

async function setupAceiteConvitePage() {
    const token = new URLSearchParams(window.location.search).get('token');
    const details = document.getElementById('aceite-detalhes'); const form = document.getElementById('aceite-form'); const status = document.getElementById('aceite-status');
    if (!token) { showMessage(status, 'Link de convite inválido.'); return; }
    let invitation;
    try { invitation = await apiRequest(`/convites/${encodeURIComponent(token)}`, {}, null); details.textContent = `Convite para ${invitation.clinica}, papel ${invitation.papel}. Válido até ${formatDate(invitation.expira_em)}.`; document.getElementById('aceite-senha-campo').hidden = !invitation.requer_senha; form.hidden = false; } catch(error) { details.textContent = error.message; return; }
    if (!invitation.requer_senha && !session.identityToken) {
        form.hidden = true;
        const link = document.createElement('a');
        link.className = 'btn btn-primary w-100 mt-3';
        link.textContent = 'Entrar para aceitar';
        const returnTo = `aceitar-convite.html?token=${token}`;
        link.href = `login.html?return=${encodeURIComponent(returnTo)}`;
        status.replaceChildren(link);
        return;
    }
    form.addEventListener('submit', async (event) => { event.preventDefault(); try { const authType = invitation.requer_senha ? null : 'identity'; const data = await apiRequest(`/convites/${encodeURIComponent(token)}/aceitar`,{method:'POST',body:JSON.stringify({senha:document.getElementById('aceite-senha').value})},authType); showMessage(status,data.message,'success'); form.hidden=true; } catch(error) { showMessage(status,error.message); } });
}

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
            const returnTo = new URLSearchParams(window.location.search).get('return');
            if (returnTo && /^aceitar-convite\.html\?token=[A-Za-z0-9_-]+$/.test(returnTo)) {
                window.location.assign(returnTo);
                return;
            }
            const entry = VitalisCore.clinicEntryDecision(data.clinicas);
            if (entry.mode === 'direct') {
                const selected = await apiRequest('/auth/select-clinic', {
                    method: 'POST', body: JSON.stringify({ clinica_id: entry.clinicId })
                }, 'identity');
                session.saveClinic(selected);
                const destination = VitalisCore.dashboardForRole(selected.clinica.papel);
                if (!destination) throw new Error('Papel sem painel disponível.');
                window.location.assign(destination);
                return;
            }
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
    const platformLink = document.getElementById('platform-provisioning-link');
    let mayProvision = false;
    try {
        const capabilities = await apiRequest('/plataforma/capacidades', {}, 'identity');
        mayProvision = Boolean(capabilities.provisionar_clinicas);
        platformLink.hidden = !mayProvision;
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
            document.querySelector('#clinic-form button[type="submit"]').disabled = true;
            showMessage(
                status,
                mayProvision
                    ? 'Nenhuma clínica ativa vinculada. Você pode provisionar uma nova clínica.'
                    : 'Nenhuma clínica ativa vinculada ao usuário.',
                mayProvision ? 'primary' : 'danger'
            );
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
    document.querySelectorAll('[data-user-name]').forEach((element) => {
        element.textContent = session.user?.nome || 'paciente';
    });
    const table = document.getElementById('tabela-consultas-paciente');
    const specialtySelect = document.getElementById('especialidade-select');
    const professionalSelect = document.getElementById('profissional-select');
    const dateInput = document.getElementById('data-consulta');
    const durationSelect = document.getElementById('duracao-consulta');
    const slotSelect = document.getElementById('horario-consulta');
    const status = document.getElementById('agendamento-status');
    const form = document.getElementById('agendamento-form');
    const vitalisChannelToggle = document.getElementById('confirmacao-vitalis-ativa');
    const vitalisChannelStatus = document.getElementById('confirmacao-vitalis-status');
    const slotsGate = VitalisCore.createLatestRequestGate();
    const mutationLock = VitalisCore.createOperationLock();
    let specialties = [];

    async function loadChannelPreference() {
        vitalisChannelToggle.disabled = true;
        try {
            const preference = await apiRequest('/confirmacoes/minhas-preferencias');
            vitalisChannelToggle.checked = Boolean(preference.confirmacao_vitalis_ativa);
            document.getElementById('patient-channel-state').textContent = vitalisChannelToggle.checked
                ? 'Ativo' : 'Inativo';
            vitalisChannelToggle.disabled = false;
        } catch (error) {
            document.getElementById('patient-channel-state').textContent = 'Indisponível';
            showMessage(vitalisChannelStatus, error.message);
        }
    }

    function selectedSpecialty() {
        return specialties.find((item) => item.id === Number(specialtySelect.value));
    }

    function fillProfessionals() {
        slotsGate.invalidate();
        professionalSelect.replaceChildren(new Option('Selecione', ''));
        (selectedSpecialty()?.profissionais || []).forEach((professional) => {
            professionalSelect.append(new Option(professional.nome_exibicao, String(professional.id)));
        });
        professionalSelect.disabled = !selectedSpecialty();
        slotSelect.replaceChildren(new Option('Informe data e profissional', ''));
        slotSelect.disabled = true;
    }

    async function loadSlots() {
        slotsGate.invalidate();
        const key = `${specialtySelect.value}:${professionalSelect.value}:${dateInput.value}:${durationSelect.value}`;
        if (!specialtySelect.value || !professionalSelect.value || !dateInput.value) {
            slotSelect.replaceChildren(new Option('Informe data e profissional', ''));
            slotSelect.disabled = true;
            return;
        }
        const ticket = slotsGate.begin(key);
        slotSelect.replaceChildren(new Option('Consultando horários...', ''));
        slotSelect.disabled = true;
        try {
            const params = new URLSearchParams({
                especialidade_id: specialtySelect.value,
                profissional_id: professionalSelect.value,
                data: dateInput.value,
                duracao_minutos: durationSelect.value
            });
            const data = await apiRequest(`/consultas/horarios?${params}`);
            if (!slotsGate.isCurrent(ticket, key)) return;
            slotSelect.replaceChildren(new Option(
                data.horarios.length ? 'Selecione um horário' : 'Nenhum horário disponível', ''
            ));
            data.horarios.forEach((slot) => {
                slotSelect.append(new Option(slot.inicio_local.slice(11, 16), slot.inicio_local));
            });
            slotSelect.disabled = data.horarios.length === 0;
        } catch (error) {
            if (slotsGate.isCurrent(ticket, key)) showMessage(status, error.message);
        }
    }

    async function loadAgenda() {
        try {
            const appointments = await apiRequest('/consultas/minha-agenda');
            const upcoming = appointments.filter((appointment) => (
                ['agendada', 'confirmada'].includes(appointment.status) && appointment.futura !== false
            ));
            const pending = upcoming.filter((appointment) => appointment.confirmacao_estado === 'preparada');
            const next = [...upcoming].sort((first, second) => (
                String(first.inicio_local || first.inicio_em).localeCompare(String(second.inicio_local || second.inicio_em))
            ))[0];
            document.getElementById('patient-total-upcoming').textContent = String(upcoming.length);
            document.getElementById('patient-pending-confirmations').textContent = String(pending.length);
            const nextContainer = document.getElementById('patient-next-appointment');
            const nextDetails = document.getElementById('patient-next-details');
            if (next) {
                const nextPeriod = next.inicio_local
                    ? `${next.inicio_local.slice(8, 10)}/${next.inicio_local.slice(5, 7)}/${next.inicio_local.slice(0, 4)} às ${next.inicio_local.slice(11, 16)}`
                    : formatDate(next.inicio_em);
                nextContainer.querySelector('strong').textContent = next.nome_profissional;
                nextDetails.textContent = `${nextPeriod}${next.especialidade_nome ? ` · ${next.especialidade_nome}` : ''}`;
            } else {
                nextContainer.querySelector('strong').textContent = 'Nenhuma consulta futura';
                nextDetails.textContent = 'Quando houver um novo agendamento, ele aparecerá em destaque aqui.';
            }
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
                if (appointment.confirmacao_estado === 'preparada') row.classList.add('vitalis-patient-row-pending');
                const period = appointment.inicio_local && appointment.fim_local
                    ? `${appointment.inicio_local.slice(8, 10)}/${appointment.inicio_local.slice(5, 7)}/${appointment.inicio_local.slice(0, 4)} · ${appointment.inicio_local.slice(11, 16)}–${appointment.fim_local.slice(11, 16)}`
                    : `${formatDate(appointment.inicio_em)} — ${formatDate(appointment.fim_em)}`;
                const patientStatusLabels = {
                    agendada: 'Agendada', confirmada: 'Confirmada', realizada: 'Realizada',
                    cancelada: 'Cancelada', nao_compareceu: 'Não compareceu'
                };
                const situation = document.createElement('td'); situation.dataset.label = 'Situação';
                const clinicalState = document.createElement('span');
                clinicalState.className = `vitalis-status vitalis-status-${appointment.status.replaceAll('_', '-')}`;
                clinicalState.textContent = patientStatusLabels[appointment.status] || appointment.status;
                situation.append(clinicalState);
                const confirmationBadge = confirmationStateBadge(
                    appointment.confirmacao_estado, appointment.confirmacao_canal
                );
                if (confirmationBadge) situation.append(confirmationBadge);
                const professionalCell = tableCell(appointment.nome_profissional);
                professionalCell.dataset.label = 'Profissional';
                const periodCell = tableCell(period);
                periodCell.dataset.label = 'Período';
                row.append(professionalCell, periodCell, situation);
                const actions = document.createElement('td'); actions.className = 'vitalis-patient-appointment-actions';
                actions.dataset.label = 'Ações';
                if (['agendada', 'confirmada'].includes(appointment.status)
                    && appointment.futura
                    && !['confirmada', 'recusada'].includes(appointment.confirmacao_estado)) {
                    [
                        ['Confirmar presença', 'confirmada', 'btn-success'],
                        ['Não poderei comparecer', 'recusada', 'btn-outline-secondary']
                    ].forEach(([label, answer, cssClass]) => {
                        const button = document.createElement('button'); button.type = 'button';
                        button.className = `btn btn-sm ${cssClass}`; button.textContent = label;
                        button.addEventListener('click', async () => {
                            if (!mutationLock.tryBegin()) return;
                            actions.querySelectorAll('button').forEach((control) => { control.disabled = true; });
                            try {
                                const result = await apiRequest(`/consultas/${appointment.id}/confirmacoes/minha-resposta`, {
                                    method: 'POST', body: JSON.stringify({
                                        resposta: answer, versao: Number(appointment.versao)
                                    })
                                });
                                showMessage(status, result.message, 'success');
                                await loadAgenda();
                            } catch (error) { showMessage(status, error.message); }
                            finally { mutationLock.end(); }
                        });
                        actions.append(button);
                    });
                }
                if (['agendada', 'confirmada'].includes(appointment.status)) {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'btn btn-sm btn-outline-danger';
                    button.textContent = 'Cancelar';
                    button.addEventListener('click', async () => {
                        try {
                            await apiRequest(`/consultas/${appointment.id}`, {
                                method: 'DELETE', body: JSON.stringify({ versao: Number(appointment.versao) })
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
        } catch (error) {
            showMessage(status, error.message);
        }
    }

    try {
        const context = await apiRequest('/consultas/contexto');
        specialties = context.especialidades;
        document.getElementById('paciente-agenda-timezone').textContent = context.timezone;
        specialtySelect.replaceChildren(new Option('Selecione', ''));
        specialties.forEach((specialty) => {
            specialtySelect.append(new Option(specialty.nome, String(specialty.id)));
        });
        const localParts = new Intl.DateTimeFormat('en-US', {
            timeZone: context.timezone, year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(new Date()).reduce((parts, item) => {
            if (item.type !== 'literal') parts[item.type] = item.value;
            return parts;
        }, {});
        dateInput.min = `${localParts.year}-${localParts.month}-${localParts.day}`;
        dateInput.value = dateInput.min;
    } catch (error) {
        showMessage(status, error.message);
        form.hidden = true;
        return;
    }

    specialtySelect.addEventListener('change', fillProfessionals);
    [professionalSelect, dateInput, durationSelect].forEach((control) => {
        control.addEventListener('change', loadSlots);
    });
    vitalisChannelToggle.addEventListener('change', async () => {
        const requested = vitalisChannelToggle.checked;
        vitalisChannelToggle.disabled = true;
        try {
            const result = await apiRequest('/confirmacoes/minhas-preferencias', {
                method: 'PUT', body: JSON.stringify({ ativo: requested })
            });
            vitalisChannelToggle.checked = Boolean(result.confirmacao_vitalis_ativa);
            document.getElementById('patient-channel-state').textContent = vitalisChannelToggle.checked
                ? 'Ativo' : 'Inativo';
            showMessage(vitalisChannelStatus, result.message, 'success');
            await loadAgenda();
        } catch (error) {
            vitalisChannelToggle.checked = !requested;
            showMessage(vitalisChannelStatus, error.message);
        } finally { vitalisChannelToggle.disabled = false; }
    });
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!mutationLock.tryBegin()) return;
        form.querySelectorAll('input, select, button').forEach((control) => { control.disabled = true; });
        try {
            const payload = VitalisCore.appointmentPayload(
                slotSelect.value, durationSelect.value,
                professionalSelect.value, specialtySelect.value
            );
            const data = await apiRequest('/consultas', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            showMessage(status, data.message, 'success');
            form.reset();
            dateInput.value = dateInput.min;
            fillProfessionals();
            await loadAgenda();
        } catch (error) {
            showMessage(status, error.message);
        } finally {
            mutationLock.end();
            form.querySelectorAll('input, select, button').forEach((control) => { control.disabled = false; });
            professionalSelect.disabled = !selectedSpecialty();
            slotSelect.disabled = slotSelect.options.length <= 1;
        }
    });

    await Promise.all([loadChannelPreference(), loadAgenda()]);
    const agendaRefresh = window.setInterval(loadAgenda, 30000);
    window.addEventListener('beforeunload', () => window.clearInterval(agendaRefresh), { once: true });
}

async function setupProfissionalDashboard() {
    const clinic = requireClinicSession('dashboard-medico.html');
    if (!clinic) return;
    applyClinicIdentity(clinic);
    document.querySelectorAll('[data-user-name]').forEach((element) => {
        element.textContent = session.user?.nome || 'profissional';
    });
    const table = document.getElementById('tabela-agenda');
    const status = document.getElementById('agenda-status');
    const refresh = document.getElementById('atualizar-agenda-medico');
    const filters = document.getElementById('filtros-agenda-medico');
    const dateFilter = document.getElementById('filtro-medico-data');
    const statusFilter = document.getElementById('filtro-medico-status');
    const nextContent = document.getElementById('proximo-atendimento-conteudo');
    const mutationLock = VitalisCore.createOperationLock();
    const agendaGate = VitalisCore.createLatestRequestGate();
    let appointments = [];

    function clinicToday(timeZone) {
        if (!timeZone) return '';
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(new Date()).reduce((result, item) => {
            if (item.type !== 'literal') result[item.type] = item.value;
            return result;
        }, {});
        return `${parts.year}-${parts.month}-${parts.day}`;
    }

    function localPeriodLabel(appointment) {
        const start = appointment.inicio_local;
        const end = appointment.fim_local;
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start || '')
            || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(end || '')) return 'Horário indisponível';
        return `${start.slice(8, 10)}/${start.slice(5, 7)}/${start.slice(0, 4)} · ${start.slice(11, 16)}–${end.slice(11, 16)}`;
    }

    function appointmentStatus(value) {
        const labels = {
            agendada: 'Agendada', confirmada: 'Confirmada', realizada: 'Realizada',
            cancelada: 'Cancelada', nao_compareceu: 'Não compareceu'
        };
        const badge = document.createElement('span');
        badge.className = `vitalis-status vitalis-status-${value.replaceAll('_', '-')}`;
        badge.textContent = labels[value] || value;
        return badge;
    }

    function renderMetrics() {
        const timeZone = appointments[0]?.timezone;
        const today = clinicToday(timeZone);
        const active = (item) => ['agendada', 'confirmada'].includes(item.status);
        document.getElementById('medico-consultas-hoje').textContent = String(appointments.filter(
            (item) => item.inicio_local?.slice(0, 10) === today && item.status !== 'cancelada'
        ).length);
        document.getElementById('medico-proximas-consultas').textContent = String(appointments.filter(
            (item) => active(item) && item.futura
        ).length);
        document.getElementById('medico-concluidas-hoje').textContent = String(appointments.filter(
            (item) => item.inicio_local?.slice(0, 10) === today && item.status === 'realizada'
        ).length);
    }

    function renderNextAppointment() {
        const next = appointments.filter((item) => (
            ['agendada', 'confirmada'].includes(item.status) && (item.em_andamento || item.futura)
        )).sort((left, right) => Number(right.em_andamento) - Number(left.em_andamento)
            || String(left.inicio_local).localeCompare(String(right.inicio_local)))[0];
        nextContent.replaceChildren();
        document.getElementById('proximo-atendimento-fuso').textContent = next?.timezone
            ? `Fuso: ${next.timezone}` : 'Fuso da clínica';
        if (!next) {
            const empty = document.createElement('p');
            empty.className = 'text-muted mb-0';
            empty.textContent = 'Nenhum atendimento futuro ou em andamento.';
            nextContent.append(empty); return;
        }
        const date = document.createElement('div');
        date.className = 'vitalis-next-date';
        date.innerHTML = `<i class="bi bi-calendar-event"></i><strong>${localPeriodLabel(next)}</strong>`;
        const details = document.createElement('div');
        details.className = 'vitalis-next-details';
        const patient = document.createElement('strong'); patient.textContent = next.nome_paciente;
        const specialty = document.createElement('span');
        specialty.textContent = next.nome_especialidade || 'Especialidade não informada';
        details.append(patient, specialty);
        const state = document.createElement('div'); state.append(appointmentStatus(next.status));
        nextContent.append(date, details, state);
    }

    function renderAgenda() {
        const date = dateFilter.value;
        const selectedStatus = statusFilter.value;
        const filtered = appointments.filter((appointment) => (
            (!date || appointment.inicio_local?.slice(0, 10) === date)
            && (selectedStatus === 'todos' || appointment.status === selectedStatus)
        ));
        table.replaceChildren();
        filtered.forEach((appointment) => {
            const row = document.createElement('tr');
            const values = [
                ['Data e hora', localPeriodLabel(appointment)],
                ['Paciente', appointment.nome_paciente],
                ['Especialidade', appointment.nome_especialidade || 'Não informada']
            ];
            values.forEach(([label, value]) => {
                const cell = tableCell(value); cell.dataset.label = label; row.append(cell);
            });
            const statusCell = document.createElement('td');
            statusCell.dataset.label = 'Situação'; statusCell.append(appointmentStatus(appointment.status));
            row.append(statusCell);
            const actions = document.createElement('td');
            actions.dataset.label = 'Ação'; actions.className = 'vitalis-appointment-actions';
            if (['agendada', 'confirmada'].includes(appointment.status)) {
                const button = document.createElement('button');
                button.type = 'button'; button.className = 'btn btn-sm btn-success';
                button.innerHTML = '<i class="bi bi-check2-circle"></i> Concluir atendimento';
                button.disabled = !appointment.pode_concluir;
                button.dataset.temporalDisabled = String(!appointment.pode_concluir);
                const note = document.createElement('small');
                note.className = 'vitalis-action-note';
                note.textContent = button.disabled
                    ? `Disponível a partir de ${localPeriodLabel(appointment).split(' · ')[1]?.split('–')[0] || 'seu início'}.`
                    : 'Atendimento disponível para conclusão.';
                button.title = note.textContent;
                button.addEventListener('click', async () => {
                    if (!mutationLock.tryBegin()) return;
                    button.disabled = true;
                    try {
                        const result = await apiRequest(`/consultas/${appointment.id}/concluir`, {
                            method: 'PUT', body: JSON.stringify({ versao: Number(appointment.versao) })
                        });
                        await loadAgenda(); showMessage(status, result.message, 'success');
                    } catch (error) {
                        showMessage(status, error.message);
                        button.disabled = button.dataset.temporalDisabled === 'true';
                    } finally { mutationLock.end(); }
                });
                actions.append(button, note);
            } else {
                const closed = document.createElement('span');
                closed.className = 'vitalis-action-note'; closed.textContent = 'Atendimento encerrado';
                actions.append(closed);
            }
            row.append(actions); table.append(row);
        });
        if (!filtered.length) {
            const row = document.createElement('tr');
            const cell = tableCell('Nenhuma consulta corresponde aos filtros selecionados.');
            cell.colSpan = 5; cell.className = 'text-center py-4 text-muted';
            row.append(cell); table.append(row);
        }
        showMessage(status, `${filtered.length} consulta(s) exibida(s).`, 'muted');
    }

    function renderDashboard() {
        renderMetrics(); renderNextAppointment(); renderAgenda();
    }

    async function loadAgenda() {
        const ticket = agendaGate.begin('agenda-medico');
        refresh.disabled = true;
        try {
            const loaded = await apiRequest('/consultas/minha-agenda');
            if (!agendaGate.isCurrent(ticket, 'agenda-medico')) return;
            appointments = loaded; renderDashboard();
        } catch (error) {
            if (agendaGate.isCurrent(ticket, 'agenda-medico')) showMessage(status, error.message);
        } finally { if (agendaGate.isCurrent(ticket, 'agenda-medico')) refresh.disabled = false; }
    }
    refresh?.addEventListener('click', loadAgenda);
    filters.addEventListener('submit', (event) => { event.preventDefault(); renderAgenda(); });
    document.getElementById('limpar-filtros-medico').addEventListener('click', () => {
        filters.reset(); renderAgenda();
    });
    const agendaTimer = window.setInterval(() => { if (!document.hidden) loadAgenda(); }, 30000);
    window.addEventListener('pagehide', () => window.clearInterval(agendaTimer), { once: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loadAgenda(); });
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

async function setupCalendarPage() {
    const clinic = requireClinicSession('calendario.html');
    if (!clinic) return;
    applyClinicIdentity(clinic);
    const isProfessional = clinic.papel === 'profissional';
    document.querySelectorAll(isProfessional ? '[data-management-only]' : '[data-professional-only]')
        .forEach((element) => element.remove());
    document.getElementById('calendar-role').textContent = isProfessional
        ? 'Agenda do profissional' : clinic.papel === 'administrador' ? 'Administrador da clínica' : 'Secretaria da clínica';
    document.getElementById('calendar-description').textContent = isProfessional
        ? 'Seus atendimentos na clínica ativa, no fuso configurado pela clínica.'
        : 'Atendimentos autorizados da clínica ativa, com filtros por profissional e especialidade.';

    const grid = document.getElementById('calendar-grid');
    const periodLabel = document.getElementById('calendar-period-label');
    const status = document.getElementById('calendar-status');
    const filters = document.getElementById('calendar-filters');
    const professionalFilter = document.getElementById('calendar-professional');
    const specialtyFilter = document.getElementById('calendar-specialty');
    const statusFilter = document.getElementById('calendar-status-filter');
    const selection = document.getElementById('calendar-selection');
    const selectionTitle = document.getElementById('calendar-selection-title');
    const selectionList = document.getElementById('calendar-selection-list');
    const gate = VitalisCore.createLatestRequestGate();
    let view = 'week';
    let referenceDate = '';
    let today = '';
    let timeZone = '';
    let appointments = [];
    let selectedDate = '';

    const dateFromKey = (key) => new Date(`${key}T00:00:00Z`);
    const dateKey = (date) => date.toISOString().slice(0, 10);
    const addDays = (key, amount) => {
        const date = dateFromKey(key); date.setUTCDate(date.getUTCDate() + amount); return dateKey(date);
    };
    const startOfWeek = (key) => {
        const date = dateFromKey(key);
        const offset = (date.getUTCDay() + 6) % 7;
        date.setUTCDate(date.getUTCDate() - offset);
        return dateKey(date);
    };
    const addMonths = (key, amount) => {
        const date = dateFromKey(`${key.slice(0, 7)}-01`);
        date.setUTCMonth(date.getUTCMonth() + amount);
        return dateKey(date);
    };
    const formatDateKey = (key, options) => new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'UTC', ...options
    }).format(dateFromKey(key));

    function currentPeriod() {
        if (view === 'day') return { start: referenceDate, end: referenceDate, dates: [referenceDate] };
        if (view === 'week') {
            const start = startOfWeek(referenceDate);
            return { start, end: addDays(start, 6), dates: Array.from({ length: 7 }, (_, index) => addDays(start, index)) };
        }
        const first = `${referenceDate.slice(0, 7)}-01`;
        const start = startOfWeek(first);
        return { start, end: addDays(start, 41), dates: Array.from({ length: 42 }, (_, index) => addDays(start, index)) };
    }

    function updatePeriodLabel(period) {
        if (view === 'day') {
            periodLabel.textContent = formatDateKey(period.start, {
                weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
            });
        } else if (view === 'week') {
            periodLabel.textContent = `${formatDateKey(period.start, { day: '2-digit', month: 'short' })} – ${formatDateKey(period.end, { day: '2-digit', month: 'short', year: 'numeric' })}`;
        } else {
            periodLabel.textContent = formatDateKey(`${referenceDate.slice(0, 7)}-01`, {
                month: 'long', year: 'numeric'
            });
        }
    }

    function statusMeta(value) {
        return {
            agendada: ['Agendada', 'vitalis-status-agendada'],
            confirmada: ['Confirmada', 'vitalis-status-confirmada'],
            realizada: ['Realizada', 'vitalis-status-realizada'],
            cancelada: ['Cancelada', 'vitalis-status-cancelada'],
            nao_compareceu: ['Não compareceu', 'vitalis-status-nao-compareceu']
        }[value] || [value, ''];
    }

    function eventCard(item, compact = false) {
        const meta = statusMeta(item.status);
        const event = document.createElement('button');
        event.type = 'button';
        event.className = `vitalis-calendar-event vitalis-calendar-event-${item.status.replaceAll('_', '-')}`;
        if (compact) event.classList.add('is-compact');
        event.dataset.consultaId = String(item.id);
        event.setAttribute('aria-label', `${item.inicio_local.slice(11, 16)}, ${item.paciente_nome}, ${meta[0]}`);
        const time = document.createElement('strong');
        time.textContent = `${item.inicio_local.slice(11, 16)}–${item.fim_local.slice(11, 16)}`;
        const patient = document.createElement('span'); patient.textContent = item.paciente_nome;
        const details = document.createElement('small');
        details.textContent = `${item.profissional_nome}${item.especialidade_nome ? ` · ${item.especialidade_nome}` : ''}`;
        const badge = document.createElement('span'); badge.className = `vitalis-status ${meta[1]}`; badge.textContent = meta[0];
        event.append(time, patient, details, badge);
        event.addEventListener('click', () => openAppointment(item));
        return event;
    }

    function selectionCard(item) {
        const meta = statusMeta(item.status);
        const card = document.createElement('article');
        card.className = `vitalis-calendar-detail vitalis-calendar-event-${item.status.replaceAll('_', '-')}`;
        card.dataset.consultaId = String(item.id);
        const period = document.createElement('div'); period.className = 'vitalis-calendar-detail-period';
        const time = document.createElement('strong');
        time.textContent = `${item.inicio_local.slice(11, 16)}–${item.fim_local.slice(11, 16)}`;
        const badge = document.createElement('span'); badge.className = `vitalis-status ${meta[1]}`; badge.textContent = meta[0];
        period.append(time, badge);
        const patient = document.createElement('h3'); patient.textContent = item.paciente_nome;
        const professional = document.createElement('p'); professional.textContent = item.profissional_nome;
        const specialty = document.createElement('small');
        specialty.textContent = item.especialidade_nome || 'Especialidade não informada';
        card.append(period, patient, professional, specialty);
        const confirmationBadge = confirmationStateBadge(item.confirmacao_estado, item.confirmacao_canal);
        if (confirmationBadge) card.append(confirmationBadge);
        if (!isProfessional && ['agendada', 'confirmada'].includes(item.status)) {
            const actions = document.createElement('div'); actions.className = 'vitalis-calendar-detail-actions';
            if (!['confirmada', 'recusada'].includes(item.confirmacao_estado)) {
                const requestButton = document.createElement('button');
                requestButton.type = 'button'; requestButton.className = 'btn btn-sm btn-outline-success';
                requestButton.innerHTML = '<i class="bi bi-chat-square-check"></i> Solicitar confirmação';
                requestButton.addEventListener('click', () => requestAppointmentConfirmation(item, status, loadCalendar));
                actions.append(requestButton);
            }
            actions.append(overflowActionMenu('Mais ações da consulta', [
                { text: 'Reagendar', icon: 'bi-calendar-event', action: () => {
                    window.location.assign(`agenda.html?reagendar=${item.id}&data=${item.inicio_local.slice(0, 10)}`);
                } },
                { text: 'Cancelar consulta', icon: 'bi-x-circle', action: async () => {
                    if (!window.confirm('Cancelar esta consulta? O histórico será preservado.')) return;
                    try {
                        await apiRequest(`/consultas/${item.id}/status`, {
                            method: 'PUT', body: JSON.stringify({ status: 'cancelada', versao: item.versao })
                        });
                        await loadCalendar();
                    } catch (error) { showMessage(status, error.message); }
                } },
                { text: 'Registrar presença', icon: 'bi-person-check', action: () => (
                    registerManualConfirmation(item, 'confirmada', status, loadCalendar)
                ) },
                { text: 'Registrar impossibilidade', icon: 'bi-person-dash', action: () => (
                    registerManualConfirmation(item, 'recusada', status, loadCalendar)
                ) },
                { text: 'Histórico de confirmações', icon: 'bi-clock-history', action: () => (
                    showConfirmationHistory(item, status)
                ) }
            ]));
            card.append(actions);
        } else if (!isProfessional) {
            card.append(overflowActionMenu('Mais ações da consulta', [
                { text: 'Histórico de confirmações', icon: 'bi-clock-history', action: () => (
                    showConfirmationHistory(item, status)
                ) }
            ]));
        }
        return card;
    }

    function showSelection(items, title, focus = true) {
        selectionList.replaceChildren();
        selectionTitle.textContent = title;
        if (items.length) items.forEach((item) => selectionList.append(selectionCard(item)));
        else {
            const empty = document.createElement('p'); empty.className = 'vitalis-calendar-selection-empty';
            empty.textContent = 'Nenhuma consulta nesta data com os filtros atuais.'; selectionList.append(empty);
        }
        selection.hidden = false;
        if (focus) {
            selectionTitle.focus({ preventScroll: true });
            selection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    function openAppointment(item) {
        showSelection([item], `Consulta de ${formatDateKey(item.inicio_local.slice(0, 10), {
            day: '2-digit', month: 'long', year: 'numeric'
        })}`);
    }

    function openDay(key, focus = true) {
        selectedDate = key;
        const items = appointments.filter((item) => item.inicio_local?.slice(0, 10) === key);
        grid.querySelectorAll('[data-calendar-date]').forEach((button) => {
            const selected = button.dataset.calendarDate === key;
            button.setAttribute('aria-pressed', String(selected));
            button.closest('.vitalis-calendar-day')?.classList.toggle('is-selected', selected);
        });
        showSelection(items, formatDateKey(key, {
            weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
        }), focus);
    }

    function renderCalendar() {
        const period = currentPeriod();
        updatePeriodLabel(period);
        grid.replaceChildren();
        grid.className = `vitalis-calendar-grid vitalis-calendar-${view}`;
        if (view !== 'month') selection.hidden = true;
        if (view !== 'day') {
            ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].forEach((name) => {
                const heading = document.createElement('div');
                heading.className = 'vitalis-calendar-weekday'; heading.setAttribute('role', 'columnheader');
                heading.textContent = name; grid.append(heading);
            });
        }
        period.dates.forEach((key) => {
            const day = document.createElement('section');
            day.className = 'vitalis-calendar-day'; day.setAttribute('role', 'gridcell');
            if (key === today) day.classList.add('is-today');
            if (view === 'month' && key.slice(0, 7) !== referenceDate.slice(0, 7)) day.classList.add('is-outside');
            const heading = document.createElement('h3');
            const dayButton = document.createElement('button');
            dayButton.type = 'button'; dayButton.className = 'vitalis-calendar-day-select';
            dayButton.dataset.calendarDate = key; dayButton.setAttribute('aria-pressed', 'false');
            dayButton.textContent = view === 'day'
                ? formatDateKey(key, { weekday: 'long', day: '2-digit', month: 'long' })
                : view === 'month' ? String(Number(key.slice(8, 10))) : formatDateKey(key, { day: '2-digit', month: 'short' });
            dayButton.addEventListener('click', () => openDay(key)); heading.append(dayButton);
            const events = document.createElement('div'); events.className = 'vitalis-calendar-events';
            const dayAppointments = appointments.filter((item) => item.inicio_local?.slice(0, 10) === key);
            dayButton.setAttribute('aria-label', `${formatDateKey(key, {
                day: '2-digit', month: 'long', year: 'numeric'
            })}, ${dayAppointments.length} consulta(s)`);
            if (key === today) dayButton.setAttribute('aria-current', 'date');
            let markers = null;
            const visibleAppointments = view === 'month' ? dayAppointments.slice(0, 3) : dayAppointments;
            visibleAppointments.forEach((item) => events.append(eventCard(item, view === 'month')));
            if (view === 'month' && dayAppointments.length > 3) {
                const more = document.createElement('button'); more.type = 'button';
                more.className = 'vitalis-calendar-more';
                more.textContent = `+ ${dayAppointments.length - 3} consultas`;
                more.addEventListener('click', () => openDay(key)); events.append(more);
            }
            if (view === 'month' && dayAppointments.length) {
                markers = document.createElement('div'); markers.className = 'vitalis-calendar-markers';
                dayAppointments.slice(0, 4).forEach((item) => {
                    const marker = document.createElement('span');
                    marker.className = `vitalis-calendar-marker vitalis-calendar-marker-${item.status.replaceAll('_', '-')}`;
                    markers.append(marker);
                });
                const count = document.createElement('small'); count.textContent = String(dayAppointments.length);
                markers.append(count);
            }
            if (!dayAppointments.length) {
                const empty = document.createElement('p'); empty.className = 'vitalis-calendar-empty';
                empty.textContent = 'Sem consultas'; events.append(empty);
            }
            day.append(heading); if (markers) day.append(markers); day.append(events); grid.append(day);
        });
        if (view === 'month') {
            const firstOfMonth = `${referenceDate.slice(0, 7)}-01`;
            if (!period.dates.includes(selectedDate)) selectedDate = period.dates.includes(today) ? today : firstOfMonth;
            openDay(selectedDate, false);
        }
        grid.setAttribute('aria-busy', 'false');
    }

    async function loadCalendar() {
        const period = currentPeriod();
        const key = [view, period.start, period.end, professionalFilter.value, specialtyFilter.value, statusFilter.value].join(':');
        const ticket = gate.begin(key);
        grid.setAttribute('aria-busy', 'true');
        const params = new URLSearchParams({
            data_inicio: period.start, data_fim: period.end, status: statusFilter.value
        });
        if (professionalFilter.value) params.set('profissional_id', professionalFilter.value);
        if (specialtyFilter.value) params.set('especialidade_id', specialtyFilter.value);
        try {
            const data = await apiRequest(`/consultas/calendario?${params}`);
            if (!gate.isCurrent(ticket, key)) return;
            appointments = data.consultas; renderCalendar();
            showMessage(status, `${appointments.length} consulta(s) no período selecionado.`, 'muted');
        } catch (error) {
            if (!gate.isCurrent(ticket, key)) return;
            grid.setAttribute('aria-busy', 'false'); showMessage(status, error.message);
        }
    }

    function selectView(selected) {
        view = selected;
        document.querySelectorAll('[data-calendar-view]').forEach((button) => {
            const active = button.dataset.calendarView === view;
            button.setAttribute('aria-pressed', String(active)); button.classList.toggle('active', active);
        });
        loadCalendar();
    }

    try {
        const context = await apiRequest('/consultas/calendario/contexto');
        timeZone = context.timezone; today = context.today; referenceDate = today;
        document.getElementById('calendar-timezone').textContent = timeZone;
        context.profissionais.forEach((item) => professionalFilter.append(new Option(item.nome_exibicao, String(item.id))));
        context.especialidades.forEach((item) => specialtyFilter.append(new Option(item.nome, String(item.id))));
        if (isProfessional) {
            professionalFilter.value = String(context.professional_id);
            professionalFilter.disabled = true;
        }
    } catch (error) {
        showMessage(status, error.message); filters.hidden = true; grid.setAttribute('aria-busy', 'false'); return;
    }

    document.querySelectorAll('[data-calendar-view]').forEach((button) => {
        button.addEventListener('click', () => selectView(button.dataset.calendarView));
    });
    document.getElementById('calendar-previous').addEventListener('click', () => {
        referenceDate = view === 'month' ? addMonths(referenceDate, -1) : addDays(referenceDate, view === 'week' ? -7 : -1);
        loadCalendar();
    });
    document.getElementById('calendar-next').addEventListener('click', () => {
        referenceDate = view === 'month' ? addMonths(referenceDate, 1) : addDays(referenceDate, view === 'week' ? 7 : 1);
        loadCalendar();
    });
    document.getElementById('calendar-today').addEventListener('click', () => { referenceDate = today; loadCalendar(); });
    filters.addEventListener('submit', (event) => { event.preventDefault(); loadCalendar(); });
    document.getElementById('calendar-clear-filters').addEventListener('click', () => {
        filters.reset();
        if (isProfessional) professionalFilter.value = professionalFilter.options[1]?.value || '';
        loadCalendar();
    });
    document.getElementById('calendar-close-selection').addEventListener('click', () => {
        selection.hidden = true;
    });
    grid.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        const controls = [...grid.querySelectorAll(
            '.vitalis-calendar-day-select, .vitalis-calendar-event, .vitalis-calendar-more'
        )];
        const current = controls.indexOf(document.activeElement);
        if (current < 0 || !controls.length) return;
        event.preventDefault();
        const target = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1
            : Math.max(0, Math.min(controls.length - 1, current + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1)));
        controls[target].focus();
    });
    const timer = window.setInterval(() => { if (!document.hidden) loadCalendar(); }, 30000);
    window.addEventListener('pagehide', () => window.clearInterval(timer), { once: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loadCalendar(); });
    selectView('week');
}

async function setupAppointmentsPage() {
    const clinic = requireClinicSession('agenda.html');
    if (!clinic) return;
    applyClinicIdentity(clinic);
    document.getElementById('clinic-role').textContent = clinic.papel === 'administrador'
        ? 'Administrador da clínica' : 'Secretaria da clínica';

    const form = document.getElementById('consulta-form');
    const formStatus = document.getElementById('consulta-form-status');
    const patientSearch = document.getElementById('consulta-paciente-busca');
    const patientSelect = document.getElementById('consulta-paciente');
    const specialtySelect = document.getElementById('consulta-especialidade');
    const professionalSelect = document.getElementById('consulta-profissional');
    const dateInput = document.getElementById('consulta-data');
    const durationSelect = document.getElementById('consulta-duracao');
    const slotSelect = document.getElementById('consulta-horario');
    const cancelReschedule = document.getElementById('consulta-cancelar-reagendamento');
    const submitLabel = document.getElementById('consulta-submit-label');
    const filterForm = document.getElementById('agenda-filtros');
    const list = document.getElementById('agenda-lista');
    const listStatus = document.getElementById('agenda-status');
    const previous = document.getElementById('agenda-anterior');
    const next = document.getElementById('agenda-proximo');
    const pageLabel = document.getElementById('agenda-pagina');
    const mutationLock = VitalisCore.createOperationLock();
    const patientSearchGate = VitalisCore.createLatestRequestGate();
    const slotsGate = VitalisCore.createLatestRequestGate();
    const listGate = VitalisCore.createLatestRequestGate();
    let specialties = [];
    let editingId = null;
    let editingVersion = null;
    let page = 1;
    let total = 0;
    const limit = 20;
    const agendaQuery = new URLSearchParams(window.location.search);
    let pendingRescheduleId = Number(agendaQuery.get('reagendar')) || null;
    const requestedDate = /^\d{4}-\d{2}-\d{2}$/.test(agendaQuery.get('data') || '')
        ? agendaQuery.get('data') : null;

    let today = new Date().toISOString().slice(0, 10);
    dateInput.min = today;
    dateInput.value = today;
    document.getElementById('agenda-data-inicio').value = today;
    document.getElementById('agenda-data-fim').value = today;

    function setBusy(busy) {
        form.setAttribute('aria-busy', String(busy));
        form.querySelectorAll('input, select, button').forEach((control) => { control.disabled = busy; });
        list.querySelectorAll('button').forEach((button) => {
            button.disabled = busy || button.dataset.temporalDisabled === 'true';
        });
        if (!busy) {
            patientSelect.disabled = Boolean(editingId);
            professionalSelect.disabled = !specialty();
            slotSelect.disabled = slotSelect.options.length <= 1;
        }
    }

    function specialty() {
        return specialties.find((item) => item.id === Number(specialtySelect.value));
    }

    function fillProfessionals(selected = '') {
        professionalSelect.replaceChildren(new Option('Selecione', ''));
        (specialty()?.profissionais || []).forEach((item) => {
            professionalSelect.append(new Option(item.nome_exibicao, String(item.id)));
        });
        professionalSelect.disabled = !specialty();
        professionalSelect.value = String(selected || '');
        slotSelect.replaceChildren(new Option('Informe data e profissional', ''));
        slotSelect.disabled = true;
    }

    async function searchPatients() {
        const query = patientSearch.value.trim();
        patientSearchGate.invalidate();
        if (query.length < 2) {
            showMessage(formStatus, 'Informe pelo menos dois caracteres para buscar pacientes.');
            return;
        }
        const ticket = patientSearchGate.begin(query);
        try {
            const patients = await apiRequest(`/pacientes/busca?q=${encodeURIComponent(query)}`);
            if (!patientSearchGate.isCurrent(ticket, query) || patientSearch.value.trim() !== query) return;
            patientSelect.replaceChildren(new Option('Selecione o paciente', ''));
            patients.forEach((patient) => {
                const suffix = patient.ano_nascimento ? ` — ${patient.ano_nascimento}` : '';
                patientSelect.append(new Option(`${patient.nome}${suffix}`, String(patient.id)));
            });
            showMessage(formStatus, `${patients.length} paciente(s) encontrado(s).`, 'muted');
        } catch (error) {
            if (patientSearchGate.isCurrent(ticket, query)) showMessage(formStatus, error.message);
        }
    }

    async function loadSlots() {
        slotsGate.invalidate();
        const professionalId = professionalSelect.value;
        const specialtyId = specialtySelect.value;
        if (!professionalId || !specialtyId || !dateInput.value) {
            slotSelect.replaceChildren(new Option('Informe data e profissional', ''));
            slotSelect.disabled = true;
            return;
        }
        const key = `${professionalId}:${specialtyId}:${dateInput.value}:${durationSelect.value}`;
        const ticket = slotsGate.begin(key);
        slotSelect.replaceChildren(new Option('Consultando horários...', ''));
        slotSelect.disabled = true;
        try {
            const params = new URLSearchParams({
                profissional_id: professionalId, especialidade_id: specialtyId,
                data: dateInput.value, duracao_minutos: durationSelect.value
            });
            const data = await apiRequest(`/consultas/horarios?${params}`);
            if (!slotsGate.isCurrent(ticket, key)) return;
            slotSelect.replaceChildren(new Option(
                data.horarios.length ? 'Selecione um horário' : 'Nenhum horário disponível', ''
            ));
            data.horarios.forEach((slot) => {
                slotSelect.append(new Option(slot.inicio_local.slice(11, 16), slot.inicio_local));
            });
            slotSelect.disabled = data.horarios.length === 0;
        } catch (error) {
            if (slotsGate.isCurrent(ticket, key)) {
                slotSelect.replaceChildren(new Option('Falha ao consultar horários', ''));
                showMessage(formStatus, error.message);
            }
        }
    }

    function badge(status) {
        const labels = {
            agendada: 'Agendada', confirmada: 'Confirmada', realizada: 'Realizada',
            cancelada: 'Cancelada', nao_compareceu: 'Não compareceu'
        };
        const element = document.createElement('span');
        element.className = `vitalis-status vitalis-status-${status.replaceAll('_', '-')}`;
        element.textContent = labels[status] || status;
        return element;
    }

    function actionButton(label, icon, style, handler) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = `btn btn-sm ${style}`;
        button.innerHTML = `<i class="bi ${icon}"></i> ${label}`;
        button.addEventListener('click', handler);
        return button;
    }

    async function mutate(path, options, confirmation) {
        if (!mutationLock.tryBegin()) return;
        if (confirmation && !window.confirm(confirmation)) { mutationLock.end(); return; }
        setBusy(true);
        try {
            const result = await apiRequest(path, options);
            showMessage(listStatus, result.message, 'success');
            await loadAgenda();
        } catch (error) { showMessage(listStatus, error.message); }
        finally { mutationLock.end(); setBusy(false); }
    }

    function beginReschedule(item) {
        editingId = item.id;
        editingVersion = Number(item.versao);
        patientSelect.replaceChildren(new Option(item.paciente_nome, String(item.paciente_id), true, true));
        patientSelect.disabled = true;
        specialtySelect.value = String(item.especialidade_id || '');
        fillProfessionals(item.profissional_id);
        dateInput.value = item.inicio_local.slice(0, 10);
        const localMinutes = (value) => Number(value.slice(11, 13)) * 60 + Number(value.slice(14, 16));
        const duration = localMinutes(item.fim_local) - localMinutes(item.inicio_local);
        if (![...durationSelect.options].some((option) => Number(option.value) === duration)) {
            durationSelect.append(new Option(`${duration} min`, String(duration)));
        }
        durationSelect.value = String(duration);
        submitLabel.textContent = 'Confirmar reagendamento';
        document.getElementById('appointment-form-title').textContent = 'Reagendar consulta';
        cancelReschedule.hidden = false;
        loadSlots();
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function resetForm() {
        editingId = null; editingVersion = null; form.reset();
        patientSelect.replaceChildren(new Option('Busque e selecione um paciente', ''));
        patientSelect.disabled = false;
        dateInput.min = today; dateInput.value = today; fillProfessionals();
        submitLabel.textContent = 'Agendar consulta';
        document.getElementById('appointment-form-title').textContent = 'Nova consulta';
        cancelReschedule.hidden = true;
        showMessage(formStatus, '', 'muted');
    }

    function render(items) {
        list.replaceChildren();
        if (!items.length) {
            const row = document.createElement('tr'); const cell = tableCell('Nenhuma consulta encontrada.');
            cell.colSpan = 5; cell.className = 'text-center py-4 text-muted'; row.append(cell); list.append(row); return;
        }
        items.forEach((item) => {
            const row = document.createElement('tr');
            const values = [
                ['Data', `${item.inicio_local.slice(8, 10)}/${item.inicio_local.slice(5, 7)}/${item.inicio_local.slice(0, 4)} ${item.inicio_local.slice(11, 16)}`],
                ['Paciente', item.paciente_nome],
                ['Atendimento', `${item.profissional_nome}${item.especialidade_nome ? ` — ${item.especialidade_nome}` : ''}`]
            ];
            values.forEach(([label, value]) => { const cell = tableCell(value); cell.dataset.label = label; row.append(cell); });
            const status = document.createElement('td'); status.dataset.label = 'Situação';
            status.append(badge(item.status));
            const confirmationBadge = confirmationStateBadge(item.confirmacao_estado, item.confirmacao_canal);
            if (confirmationBadge) status.append(confirmationBadge);
            row.append(status);
            const actions = document.createElement('td'); actions.dataset.label = 'Ações'; actions.className = 'vitalis-appointment-actions';
            if (['agendada', 'confirmada'].includes(item.status)) {
                if (!['confirmada', 'recusada'].includes(item.confirmacao_estado)) {
                    actions.append(actionButton('Solicitar confirmação',
                        'bi-chat-square-check', 'btn-success', () => (
                        requestAppointmentConfirmation(item, listStatus, loadAgenda)
                    )));
                }
            }
            const active = ['agendada', 'confirmada'].includes(item.status);
            actions.append(overflowActionMenu('Mais ações da consulta', [
                active && { text: 'Reagendar', icon: 'bi-calendar-event', action: () => beginReschedule(item) },
                active && { text: 'Cancelar consulta', icon: 'bi-x-circle', action: () => mutate(
                    `/consultas/${item.id}/status`, { method: 'PUT', body: JSON.stringify({ status: 'cancelada', versao: item.versao }) },
                    'Cancelar esta consulta? O histórico será preservado.'
                ) },
                active && { text: 'Registrar presença', icon: 'bi-person-check', action: () => (
                    registerManualConfirmation(item, 'confirmada', listStatus, loadAgenda)
                ) },
                active && { text: 'Registrar impossibilidade', icon: 'bi-person-dash', action: () => (
                    registerManualConfirmation(item, 'recusada', listStatus, loadAgenda)
                ) },
                item.status === 'agendada' && { text: 'Confirmar consulta', icon: 'bi-check-circle', action: () => mutate(
                    `/consultas/${item.id}/status`, { method: 'PUT', body: JSON.stringify({ status: 'confirmada', versao: item.versao }) }
                ) },
                active && { text: 'Registrar falta', icon: 'bi-person-x', disabled: !item.pode_marcar_falta,
                    title: item.pode_marcar_falta ? '' : 'Disponível somente após o término da consulta.', action: () => mutate(
                        `/consultas/${item.id}/status`, { method: 'PUT', body: JSON.stringify({ status: 'nao_compareceu', versao: item.versao }) }
                    ) },
                { text: 'Histórico de confirmações', icon: 'bi-clock-history', action: () => (
                    showConfirmationHistory(item, listStatus)
                ) }
            ]));
            if (!actions.children.length) actions.textContent = 'Histórico preservado';
            row.append(actions); list.append(row);
        });
    }

    async function loadAgenda() {
        const key = `${page}:${document.getElementById('agenda-data-inicio').value}:${document.getElementById('agenda-data-fim').value}:${document.getElementById('agenda-filtro-status').value}`;
        const ticket = listGate.begin(key);
        const params = new URLSearchParams({
            data_inicio: document.getElementById('agenda-data-inicio').value,
            data_fim: document.getElementById('agenda-data-fim').value,
            status: document.getElementById('agenda-filtro-status').value,
            pagina: String(page), limite: String(limit)
        });
        try {
            const data = await apiRequest(`/consultas/gestao?${params}`);
            if (!listGate.isCurrent(ticket, key)) return;
            total = data.paginacao.total; render(data.consultas);
            if (pendingRescheduleId) {
                const requested = data.consultas.find((item) => Number(item.id) === pendingRescheduleId);
                if (requested) {
                    pendingRescheduleId = null;
                    window.history.replaceState({}, '', 'agenda.html');
                    beginReschedule(requested);
                }
            }
            pageLabel.textContent = `Página ${page} de ${Math.max(1, Math.ceil(total / limit))}`;
            previous.disabled = page <= 1; next.disabled = page * limit >= total;
            showMessage(listStatus, `${total} consulta(s) encontrada(s).`, 'muted');
        } catch (error) { if (listGate.isCurrent(ticket, key)) showMessage(listStatus, error.message); }
    }

    try {
        const context = await apiRequest('/consultas/contexto');
        specialties = context.especialidades;
        document.getElementById('agenda-timezone').textContent = context.timezone;
        const dateParts = new Intl.DateTimeFormat('en-US', {
            timeZone: context.timezone, year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(new Date()).reduce((parts, item) => {
            if (item.type !== 'literal') parts[item.type] = item.value;
            return parts;
        }, {});
        today = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
        dateInput.min = today;
        dateInput.value = today;
        document.getElementById('agenda-data-inicio').value = requestedDate || today;
        document.getElementById('agenda-data-fim').value = requestedDate || today;
        specialties.forEach((item) => specialtySelect.append(new Option(item.nome, String(item.id))));
    } catch (error) { showMessage(formStatus, error.message); form.hidden = true; return; }

    document.getElementById('consulta-paciente-buscar').addEventListener('click', searchPatients);
    patientSearch.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); searchPatients(); } });
    patientSearch.addEventListener('input', () => patientSearchGate.invalidate());
    specialtySelect.addEventListener('change', () => { fillProfessionals(); });
    [professionalSelect, dateInput, durationSelect].forEach((control) => control.addEventListener('change', loadSlots));
    cancelReschedule.addEventListener('click', resetForm);
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!mutationLock.tryBegin()) return;
        setBusy(true);
        const payload = {
            paciente_id: Number(patientSelect.value), especialidade_id: Number(specialtySelect.value),
            profissional_id: Number(professionalSelect.value), inicio_local: slotSelect.value,
            duracao_minutos: Number(durationSelect.value),
            ...(editingId ? { versao: editingVersion } : {})
        };
        try {
            const result = await apiRequest(editingId ? `/consultas/${editingId}/reagendar` : '/consultas', {
                method: editingId ? 'PATCH' : 'POST', body: JSON.stringify(payload)
            });
            resetForm(); page = 1; await loadAgenda(); showMessage(formStatus, result.message, 'success');
        } catch (error) { showMessage(formStatus, error.message); }
        finally { mutationLock.end(); setBusy(false); }
    });
    filterForm.addEventListener('submit', (event) => { event.preventDefault(); page = 1; loadAgenda(); });
    previous.addEventListener('click', () => { if (page > 1) { page -= 1; loadAgenda(); } });
    next.addEventListener('click', () => { if (page * limit < total) { page += 1; loadAgenda(); } });
    document.getElementById('agenda-atualizar').addEventListener('click', loadAgenda);
    const agendaTimer = window.setInterval(() => { if (!document.hidden) loadAgenda(); }, 30000);
    window.addEventListener('pagehide', () => window.clearInterval(agendaTimer), { once: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loadAgenda(); });
    await loadAgenda();
}

async function setupPatientsPage() {
    const clinic = requireClinicSession('pacientes.html');
    if (!clinic) return;
    applyClinicIdentity(clinic);
    document.getElementById('clinic-role').textContent = clinic.papel === 'administrador'
        ? 'Administrador da clínica' : 'Secretaria da clínica';

    const form = document.getElementById('paciente-form');
    const list = document.getElementById('pacientes-lista');
    const formStatus = document.getElementById('paciente-form-status');
    const listStatus = document.getElementById('pacientes-status');
    const title = document.getElementById('paciente-form-title');
    const cancel = document.getElementById('cancelar-edicao-paciente');
    const searchForm = document.getElementById('pacientes-filtros');
    const previous = document.getElementById('pacientes-anterior');
    const next = document.getElementById('pacientes-proximo');
    const pageLabel = document.getElementById('pacientes-pagina');
    const duplicatePanel = document.getElementById('paciente-duplicidades');
    const loadGate = VitalisCore.createLatestRequestGate();
    const editGate = VitalisCore.createLatestRequestGate();
    const mutationLock = VitalisCore.createOperationLock();
    let editingId = null;
    let editLoading = false;
    let approvedDuplicateReview = null;
    let page = 1;
    let total = 0;
    const limit = 20;

    function setFormDisabled(disabled) {
        form.setAttribute('aria-busy', String(disabled));
        form.querySelectorAll('input, select, button').forEach((control) => {
            control.disabled = disabled;
        });
    }

    function setEditActionsDisabled(disabled) {
        list.querySelectorAll('[data-patient-edit]').forEach((button) => {
            button.disabled = disabled;
        });
    }

    function statusBadge(status) {
        const badge = document.createElement('span');
        badge.className = `vitalis-status ${status === 'ativo' ? 'vitalis-status-confirmada' : 'vitalis-status-inativo'}`;
        badge.textContent = status === 'ativo' ? 'Ativo' : 'Inativo';
        return badge;
    }

    function clearPatientForm() {
        editingId = null;
        approvedDuplicateReview = null;
        duplicatePanel.hidden = true;
        duplicatePanel.replaceChildren();
        form.reset();
        document.getElementById('paciente-status').value = 'ativo';
        title.textContent = 'Cadastrar paciente';
        cancel.hidden = true;
    }

    function patientFormPayload() {
        return {
            nome: document.getElementById('paciente-nome').value,
            email: document.getElementById('paciente-email').value,
            telefone: document.getElementById('paciente-telefone').value,
            preferencia_contato: document.getElementById('paciente-preferencia-contato').value,
            data_nascimento: document.getElementById('paciente-nascimento').value,
            status: document.getElementById('paciente-status').value,
            ...(approvedDuplicateReview ? {
                revisao_duplicidade: true, motivo_revisao: approvedDuplicateReview
            } : {})
        };
    }

    function showDuplicateCandidates(data) {
        duplicatePanel.replaceChildren();
        duplicatePanel.hidden = false;
        duplicatePanel.className = 'vitalis-duplicate-review alert alert-warning mt-3';
        const heading = document.createElement('strong');
        heading.textContent = data.bloqueante
            ? 'Cadastro possivelmente já existente'
            : 'Revise os pacientes semelhantes';
        const description = document.createElement('p');
        description.className = 'mb-2';
        description.textContent = data.bloqueante
            ? 'Use um paciente existente ou informe dados adicionais para diferenciar homônimos.'
            : 'Confirme um cadastro existente ou registre que os dados foram conferidos.';
        const listElement = document.createElement('div');
        listElement.className = 'vitalis-duplicate-list';
        (data.candidatos || []).forEach((candidate) => {
            const item = document.createElement('div');
            item.className = 'vitalis-duplicate-candidate';
            const summary = document.createElement('span');
            summary.textContent = [
                candidate.nome,
                candidate.ano_nascimento ? `nasc. ${candidate.ano_nascimento}` : 'nascimento não informado',
                candidate.email_mascarado || candidate.telefone_mascarado || 'contato não informado'
            ].join(' — ');
            const use = document.createElement('button');
            use.type = 'button'; use.className = 'btn btn-sm btn-outline-primary';
            use.textContent = 'Usar paciente existente';
            use.addEventListener('click', () => startEdit(candidate.id));
            item.append(summary, use); listElement.append(item);
        });
        duplicatePanel.append(heading, description, listElement);
        if (data.revisao_permitida) {
            const review = document.createElement('div');
            review.className = 'vitalis-duplicate-confirm';
            const reason = document.createElement('select');
            reason.className = 'form-select form-select-sm';
            reason.setAttribute('aria-label', 'Motivo para cadastrar pessoa distinta');
            reason.append(
                new Option('Selecione o motivo da revisão', ''),
                new Option('Homônimo confirmado', 'homonimo_confirmado'),
                new Option('Contato compartilhado', 'contato_compartilhado'),
                new Option('Dados conferidos', 'dados_conferidos')
            );
            const confirm = document.createElement('button');
            confirm.type = 'button'; confirm.className = 'btn btn-sm btn-warning';
            confirm.textContent = 'Cadastrar como pessoa distinta';
            confirm.addEventListener('click', () => {
                if (!reason.value) {
                    showMessage(formStatus, 'Selecione o motivo da revisão antes de continuar.');
                    return;
                }
                approvedDuplicateReview = reason.value;
                form.requestSubmit();
            });
            review.append(reason, confirm); duplicatePanel.append(review);
        }
    }

    function resetForm() {
        clearPatientForm();
        showMessage(formStatus, '', 'muted');
    }

    async function startEdit(id) {
        if (mutationLock.active) return;
        const patientId = Number(id);
        const ticket = editGate.begin(patientId);
        editLoading = true;
        clearPatientForm();
        setFormDisabled(true);
        showMessage(formStatus, 'Carregando paciente...', 'secondary');
        try {
            const patient = await apiRequest(`/pacientes/gestao/${patientId}`);
            if (!editGate.isCurrent(ticket, patientId)) return;
            if (VitalisCore.matchingSelectionId(patient.id, patientId) !== patientId) {
                clearPatientForm();
                showMessage(formStatus, 'Não foi possível confirmar o paciente selecionado. Tente novamente.');
                return;
            }
            editingId = patient.id;
            title.textContent = 'Editar paciente';
            document.getElementById('paciente-nome').value = patient.nome;
            document.getElementById('paciente-email').value = patient.email ?? '';
            document.getElementById('paciente-telefone').value = patient.telefone ?? '';
            document.getElementById('paciente-preferencia-contato').value = patient.preferencia_contato ?? 'nenhum';
            document.getElementById('paciente-nascimento').value = patient.data_nascimento
                ? String(patient.data_nascimento).slice(0, 10) : '';
            document.getElementById('paciente-status').value = patient.status;
            cancel.hidden = false;
            showMessage(formStatus, '', 'muted');
            form.scrollIntoView({ behavior: 'smooth', block: 'start' });
            document.getElementById('paciente-nome').focus();
        } catch (error) {
            if (editGate.isCurrent(ticket, patientId)) {
                clearPatientForm();
                showMessage(formStatus, error.message);
            }
        } finally {
            if (editGate.isCurrent(ticket, patientId)) {
                editLoading = false;
                if (!mutationLock.active) setFormDisabled(false);
            }
        }
    }

    function render(patients) {
        list.replaceChildren();
        if (!patients.length) {
            const row = document.createElement('tr');
            const cell = tableCell('Nenhum paciente encontrado nesta clínica.');
            cell.colSpan = 6;
            cell.className = 'text-center py-4 text-muted';
            row.append(cell);
            list.append(row);
            return;
        }
        patients.forEach((patient) => {
            const row = document.createElement('tr');
            const values = [
                ['Paciente', patient.nome],
                ['E-mail', patient.email_mascarado || 'Não informado'],
                ['Telefone', patient.telefone_mascarado || 'Não informado'],
                ['Nascimento', patient.ano_nascimento || 'Não informado']
            ];
            values.forEach(([label, value]) => {
                const cell = tableCell(value);
                cell.dataset.label = label;
                if (label === 'Paciente') cell.className = 'vitalis-patient-name';
                row.append(cell);
            });
            const statusCell = document.createElement('td');
            statusCell.dataset.label = 'Situação';
            statusCell.append(statusBadge(patient.status));
            row.append(statusCell);
            const actions = document.createElement('td');
            actions.dataset.label = 'Ações';
            actions.className = 'vitalis-table-actions';
            const edit = document.createElement('button');
            edit.type = 'button';
            edit.className = 'btn btn-sm btn-outline-primary';
            edit.dataset.patientEdit = '';
            edit.disabled = mutationLock.active;
            edit.innerHTML = '<i class="bi bi-pencil"></i> Editar';
            edit.setAttribute('aria-label', `Editar ${patient.nome}`);
            edit.addEventListener('click', () => startEdit(patient.id));
            actions.append(edit);
            row.append(actions);
            list.append(row);
        });
    }

    async function loadPatients() {
        const ticket = loadGate.begin(page);
        searchForm.querySelectorAll('input, select, button').forEach((control) => { control.disabled = true; });
        const params = new URLSearchParams({
            busca: document.getElementById('pacientes-busca').value.trim(),
            status: document.getElementById('pacientes-filtro-status').value,
            pagina: String(page), limite: String(limit)
        });
        try {
            const data = await apiRequest(`/pacientes/gestao?${params}`);
            if (!loadGate.isCurrent(ticket, page)) return;
            total = data.paginacao.total;
            render(data.pacientes);
            pageLabel.textContent = `Página ${page} de ${Math.max(1, Math.ceil(total / limit))}`;
            previous.disabled = page <= 1;
            next.disabled = page * limit >= total;
            showMessage(listStatus, `${total} paciente(s) encontrado(s).`, 'muted');
        } catch (error) {
            if (loadGate.isCurrent(ticket, page)) showMessage(listStatus, error.message);
        } finally {
            if (loadGate.isCurrent(ticket, page)) {
                searchForm.querySelectorAll('input, select, button').forEach((control) => { control.disabled = false; });
            }
        }
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (editLoading || !mutationLock.tryBegin()) return;
        editGate.invalidate();
        const targetId = editingId;
        setFormDisabled(true);
        setEditActionsDisabled(true);
        const payload = patientFormPayload();
        try {
            if (!targetId && !approvedDuplicateReview) {
                const preview = await apiRequest('/pacientes/duplicidades', {
                    method: 'POST', body: JSON.stringify(payload)
                });
                if (preview.possui_candidatos) {
                    showDuplicateCandidates(preview);
                    showMessage(formStatus, 'Revise os possíveis cadastros antes de continuar.', 'warning');
                    return;
                }
            }
            const result = await apiRequest(targetId ? `/pacientes/${targetId}` : '/pacientes', {
                method: targetId ? 'PUT' : 'POST', body: JSON.stringify(payload)
            });
            resetForm();
            page = 1;
            await loadPatients();
            showMessage(formStatus, result.message, 'success');
        } catch (error) {
            if (error.details?.candidatos?.length) showDuplicateCandidates({
                ...error.details, bloqueante: error.code === 'PATIENT_DUPLICATE'
            });
            showMessage(formStatus, error.message);
        } finally {
            mutationLock.end();
            setFormDisabled(false);
            setEditActionsDisabled(false);
        }
    });
    ['paciente-nome', 'paciente-email', 'paciente-telefone', 'paciente-nascimento'].forEach((id) => {
        document.getElementById(id).addEventListener('input', () => {
            approvedDuplicateReview = null;
            duplicatePanel.hidden = true;
            duplicatePanel.replaceChildren();
        });
    });
    cancel.addEventListener('click', () => {
        if (mutationLock.active || editLoading) return;
        editGate.invalidate();
        resetForm();
    });
    searchForm.addEventListener('submit', (event) => { event.preventDefault(); page = 1; loadPatients(); });
    previous.addEventListener('click', () => { if (page > 1) { page -= 1; loadPatients(); } });
    next.addEventListener('click', () => { if (page * limit < total) { page += 1; loadPatients(); } });
    await loadPatients();
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
    const identityFields = document.getElementById('profissional-identidade-fields');
    const fullNameInput = document.getElementById('profissional-nome-completo');
    const emailInput = document.getElementById('profissional-email');
    const statusField = document.getElementById('profissional-status-field');
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
        identityFields.hidden = false;
        fullNameInput.required = true;
        emailInput.required = true;
        statusField.hidden = false;
        cancelButton.hidden = true;
        specialtyContainer.querySelectorAll('input').forEach((input) => { input.checked = false; });
        showMessage(formStatus, '', 'muted');
    }

    function startEdit(professional) {
        editingId = professional.id;
        formTitle.textContent = 'Editar profissional';
        identityFields.hidden = true;
        fullNameInput.required = false;
        emailInput.required = false;
        statusField.hidden = true;
        cancelButton.hidden = false;
        document.getElementById('profissional-nome').value = professional.nome;
        document.getElementById('profissional-tipo').value = professional.tipo_profissional ?? 'Profissional de saúde';
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
            cell.colSpan = 7;
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
            row.append(tableCell(professional.tipo_profissional ?? 'Profissional de saúde'));
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
            const accessCell = document.createElement('td');
            accessCell.append(statusBadge(professional.acesso_status === 'ativo' ? 'ativo' : 'inativo'));
            accessCell.querySelector('.vitalis-status').textContent = professional.acesso_status === 'ativo'
                ? 'Liberado'
                : 'Convite pendente';
            row.append(accessCell);

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
            if (professional.acesso_status !== 'ativo') {
                const invitationLink = document.createElement('a');
                invitationLink.className = 'btn btn-sm btn-outline-primary';
                invitationLink.href = 'equipe.html';
                invitationLink.textContent = 'Convite';
                invitationLink.setAttribute('aria-label', `Gerenciar convite de ${professional.nome}`);
                actions.append(invitationLink);
            }
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
            tipo_profissional: document.getElementById('profissional-tipo').value,
            conselho_tipo: document.getElementById('profissional-conselho-tipo').value,
            conselho_numero: document.getElementById('profissional-conselho-numero').value,
            especialidade_ids: selectedSpecialties()
        };
        if (!editingId) {
            payload.nome_completo = fullNameInput.value;
            payload.email = emailInput.value;
            payload.status = document.getElementById('profissional-status').value;
        }
        try {
            const result = await apiRequest(
                editingId ? `/profissionais/${editingId}` : '/profissionais/cadastro-completo', {
                method: editingId ? 'PUT' : 'POST',
                body: JSON.stringify(payload)
                }
            );
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
