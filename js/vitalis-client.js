(function exposeVitalisCore(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.VitalisCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
    const KEYS = {
        identityToken: 'vitalis.identityToken',
        clinicToken: 'vitalis.clinicToken',
        user: 'vitalis.user',
        clinics: 'vitalis.clinics',
        activeClinic: 'vitalis.activeClinic'
    };

    function parseJson(value, fallback) {
        if (!value) return fallback;
        try {
            return JSON.parse(value);
        } catch {
            return fallback;
        }
    }

    function createSession(storage) {
        return {
            saveIdentity(payload) {
                storage.setItem(KEYS.identityToken, payload.token);
                storage.setItem(KEYS.user, JSON.stringify(payload.usuario));
                storage.setItem(KEYS.clinics, JSON.stringify(payload.clinicas ?? []));
                this.clearClinic();
            },
            saveClinic(payload) {
                storage.setItem(KEYS.clinicToken, payload.token);
                storage.setItem(KEYS.activeClinic, JSON.stringify(payload.clinica));
            },
            clearClinic() {
                storage.removeItem(KEYS.clinicToken);
                storage.removeItem(KEYS.activeClinic);
            },
            clear() {
                Object.values(KEYS).forEach((key) => storage.removeItem(key));
            },
            get identityToken() { return storage.getItem(KEYS.identityToken); },
            get clinicToken() { return storage.getItem(KEYS.clinicToken); },
            get user() { return parseJson(storage.getItem(KEYS.user), null); },
            get clinics() { return parseJson(storage.getItem(KEYS.clinics), []); },
            get activeClinic() { return parseJson(storage.getItem(KEYS.activeClinic), null); }
        };
    }

    function isPracticeOwner(clinic) {
        return clinic?.tipo_contexto === 'consultorio' && clinic?.titular === true;
    }

    function isLastActiveAdministrator(member, members) {
        if (member?.papel !== 'administrador' || member?.status !== 'ativo'
            || (member?.usuario_status != null && member.usuario_status !== 'ativo')
            || !Array.isArray(members)) {
            return false;
        }
        const activeAdministrators = members.filter((candidate) => (
            candidate?.papel === 'administrador'
            && candidate?.status === 'ativo'
            && (candidate?.usuario_status === 'ativo' || candidate?.usuario_status == null)
        ));
        return activeAdministrators.length <= 1;
    }

    function dashboardForRole(role, clinic = null) {
        if (role === 'profissional' && isPracticeOwner(clinic)) return 'consultorio.html';
        return {
            administrador: 'dashboard-secretaria.html',
            secretaria: 'dashboard-secretaria.html',
            profissional: 'dashboard-medico.html',
            paciente: 'dashboard-paciente.html'
        }[role] ?? null;
    }

    function clinicEntryDecision(clinics) {
        if (!Array.isArray(clinics)) return { mode: 'select' };
        const active = clinics.filter((clinic) => Number.isSafeInteger(Number(clinic?.id)) && Number(clinic.id) > 0);
        return active.length === 1
            ? { mode: 'direct', clinicId: Number(active[0].id) }
            : { mode: 'select' };
    }

    function workspaceSwitchState(clinics, clinic) {
        const activeLinks = Array.isArray(clinics)
            ? clinics.filter((item) => Number.isSafeInteger(Number(item?.id)) && Number(item.id) > 0)
            : [];
        return {
            visible: activeLinks.length > 1,
            label: clinic?.tipo_contexto === 'consultorio' ? 'Alternar espaço' : 'Trocar clínica'
        };
    }

    function workspaceCapabilities(clinic) {
        const role = clinic?.papel;
        const practice = clinic?.tipo_contexto === 'consultorio';
        const owner = isPracticeOwner(clinic);
        if (owner) return {
            overview: true, patients: true, specialties: true, availability: true,
            appointments: true, calendar: true, team: true, settings: true,
            professionals: false, clinicalDashboard: true, clinicalRecords: true
        };
        if (practice && role === 'secretaria') return {
            overview: true, patients: true, specialties: false,
            availability: clinic?.permissoes?.gerenciar_disponibilidade === true,
            appointments: true, calendar: true, team: false, settings: false,
            professionals: false, clinicalDashboard: false, clinicalRecords: false
        };
        if (role === 'administrador') return {
            overview: true, patients: true, specialties: true, availability: true,
            appointments: true, calendar: true, team: true, settings: true,
            professionals: true, clinicalDashboard: false, clinicalRecords: false
        };
        if (role === 'secretaria') return {
            overview: true, patients: true, specialties: true, availability: true,
            appointments: true, calendar: true, team: true, settings: false,
            professionals: true, clinicalDashboard: false, clinicalRecords: false
        };
        if (role === 'profissional') return {
            overview: true, patients: false, specialties: false, availability: true,
            appointments: false, calendar: true, team: false, settings: false,
            professionals: false, clinicalDashboard: true, clinicalRecords: true
        };
        return {
            overview: role === 'paciente', patients: false, specialties: false,
            availability: false, appointments: false, calendar: false, team: false,
            settings: false, professionals: false, clinicalDashboard: false, clinicalRecords: false
        };
    }

    function workspaceNavigation(clinic) {
        const capabilities = workspaceCapabilities(clinic);
        const owner = isPracticeOwner(clinic);
        const practice = clinic?.tipo_contexto === 'consultorio';
        const items = owner ? [
            ['overview', 'consultorio.html', 'bi-house-heart', 'Meu consultório'],
            ['clinicalDashboard', 'dashboard-medico.html', 'bi-person-badge', 'Meus atendimentos'],
            ['clinicalRecords', 'prontuario-experimental.html', 'bi-journal-medical', 'Prontuários'],
            ['patients', 'pacientes.html', 'bi-person-vcard', 'Pacientes'],
            ['specialties', 'especialidades.html', 'bi-tags', 'Minhas especialidades'],
            ['availability', 'disponibilidade.html', 'bi-calendar-week', 'Minha disponibilidade'],
            ['appointments', 'agenda.html', 'bi-calendar3', 'Minha agenda'],
            ['calendar', 'calendario.html', 'bi-calendar-event', 'Calendário'],
            ['team', 'equipe.html', 'bi-people', 'Secretária e acessos'],
            ['settings', 'configuracoes-clinica.html', 'bi-gear', 'Configurações']
        ] : [
            ['overview', dashboardForRole(clinic?.papel, clinic), 'bi-grid-1x2-fill',
                practice ? 'Visão do consultório' : 'Visão geral'],
            ['clinicalRecords', 'prontuario-experimental.html', 'bi-journal-medical', 'Prontuários'],
            ['patients', 'pacientes.html', 'bi-person-vcard', 'Pacientes'],
            ['professionals', 'profissionais.html', 'bi-person-badge', 'Profissionais'],
            ['availability', 'disponibilidade.html', 'bi-calendar-week', 'Disponibilidade'],
            ['specialties', 'especialidades.html', 'bi-tags', 'Especialidades'],
            ['appointments', 'agenda.html', 'bi-calendar3', 'Agenda'],
            ['calendar', 'calendario.html', 'bi-calendar-event', 'Calendário'],
            ['team', 'equipe.html', 'bi-people', 'Equipe e acessos'],
            ['settings', 'configuracoes-clinica.html', 'bi-gear', 'Configurações']
        ];
        return items.filter(([capability, href]) => capabilities[capability] && href)
            .map(([capability, href, icon, label]) => ({ capability, href, icon, label }));
    }

    function roleCanAccessPage(role, page, clinic = null) {
        if (page === 'dashboard-secretaria.html') {
            return ['administrador', 'secretaria'].includes(role);
        }
        if (page === 'consultorio.html') return isPracticeOwner(clinic);
        if (page === 'dashboard-medico.html') return role === 'profissional';
        if (page === 'dashboard-paciente.html') return role === 'paciente';
        const capabilities = workspaceCapabilities({ ...(clinic || {}), papel: role });
        const pageCapability = {
            'profissionais.html': 'professionals',
            'especialidades.html': 'specialties',
            'pacientes.html': 'patients',
            'agenda.html': 'appointments',
            'calendario.html': 'calendar',
            'equipe.html': 'team',
            'configuracoes-clinica.html': 'settings',
            'disponibilidade.html': 'availability',
            'prontuario-experimental.html': 'clinicalRecords'
        }[page];
        if (pageCapability) return capabilities[pageCapability] === true;
        const allowed = {
            'dashboard-secretaria.html': ['administrador', 'secretaria'],
            'profissionais.html': ['administrador', 'secretaria'],
            'especialidades.html': ['administrador', 'secretaria'],
            'pacientes.html': ['administrador', 'secretaria'],
            'agenda.html': ['administrador', 'secretaria'],
            'calendario.html': ['administrador', 'secretaria', 'profissional'],
            'equipe.html': ['administrador', 'secretaria'],
            'configuracoes-clinica.html': ['administrador'],
            'disponibilidade.html': ['administrador', 'secretaria', 'profissional'],
            'dashboard-medico.html': ['profissional'],
            'dashboard-paciente.html': ['paciente']
        };
        return allowed[page]?.includes(role) ?? false;
    }

    function platformAccessState(capabilities, communicationFailed = false) {
        if (communicationFailed) return 'unavailable';
        return capabilities?.provisionar_clinicas === true ? 'authorized' : 'restricted';
    }

    function createLatestRequestGate() {
        let sequence = 0;
        return {
            begin(value) {
                sequence += 1;
                return { sequence, value: String(value) };
            },
            invalidate() { sequence += 1; },
            isCurrent(ticket, value) {
                return ticket?.sequence === sequence && ticket.value === String(value);
            }
        };
    }

    function createOperationLock() {
        let active = false;
        return {
            tryBegin() {
                if (active) return false;
                active = true;
                return true;
            },
            end() { active = false; },
            get active() { return active; }
        };
    }

    function matchingSelectionId(loadedId, selectedId) {
        const loaded = Number(loadedId);
        const selected = Number(selectedId);
        return Number.isSafeInteger(loaded) && loaded > 0 && loaded === selected ? loaded : null;
    }

    function onlyDigits(value) {
        return typeof value === 'string' ? value.replace(/\D/g, '') : '';
    }

    function isValidCpf(value) {
        const cpf = onlyDigits(value);
        if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
        const verifier = (length) => {
            let sum = 0;
            for (let index = 0; index < length; index += 1) {
                sum += Number(cpf[index]) * (length + 1 - index);
            }
            const remainder = (sum * 10) % 11;
            return remainder === 10 ? 0 : remainder;
        };
        return verifier(9) === Number(cpf[9]) && verifier(10) === Number(cpf[10]);
    }

    function formatCpf(value) {
        const cpf = onlyDigits(value).slice(0, 11);
        return cpf.replace(/^(\d{3})(\d)/, '$1.$2')
            .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
            .replace(/\.(\d{3})(\d)/, '.$1-$2');
    }

    function formatCep(value) {
        const cep = onlyDigits(value).slice(0, 8);
        return cep.replace(/^(\d{5})(\d)/, '$1-$2');
    }

    function mergePatientCepAddress(snapshot, current, address) {
        const fields = ['logradouro', 'bairro', 'cidade', 'uf'];
        const values = { ...current };
        if (!address || typeof address !== 'object') {
            return { values, addressChanged: false, numberCleared: false };
        }

        const normalizedAddress = Object.fromEntries(fields.map((field) => [
            field, String(address[field] ?? '')
        ]));
        const addressChanged = fields.some((field) => (
            normalizedAddress[field]
            && normalizedAddress[field].trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR')
                !== String(snapshot[field] ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR')
        ));
        fields.forEach((field) => {
            if (String(current[field] ?? '') === String(snapshot[field] ?? '')) {
                values[field] = normalizedAddress[field];
            }
        });

        const numberWasUntouched = String(current.numero ?? '') === String(snapshot.numero ?? '');
        const numberCleared = addressChanged && numberWasUntouched && Boolean(snapshot.numero);
        if (addressChanged && numberWasUntouched) values.numero = '';

        return { values, addressChanged, numberCleared };
    }

    function createPatientCepLookup({ gate, readCep, readFields, lookup, writeFields, onStatus }) {
        if (!gate || typeof gate.begin !== 'function' || typeof gate.isCurrent !== 'function'
            || typeof readCep !== 'function' || typeof readFields !== 'function'
            || typeof lookup !== 'function' || typeof writeFields !== 'function') {
            throw new Error('Configuração inválida para consulta de CEP.');
        }

        return async function runPatientCepLookup() {
            const cep = String(readCep() ?? '').replace(/\D/g, '');
            if (cep.length !== 8) return;
            const ticket = gate.begin(cep);
            const snapshot = readFields();
            onStatus?.({ type: 'loading' });
            try {
                const address = await lookup(cep);
                if (!gate.isCurrent(ticket, String(readCep() ?? '').replace(/\D/g, ''))) return;
                const merged = mergePatientCepAddress(snapshot, readFields(), address);
                writeFields(merged.values);
                onStatus?.({ type: 'success', address, ...merged });
            } catch (error) {
                if (!gate.isCurrent(ticket, String(readCep() ?? '').replace(/\D/g, ''))) return;
                onStatus?.({ type: 'unavailable', error });
            }
        };
    }

    function appointmentPayload(localStart, durationMinutes, professionalId, specialtyId) {
        const duration = Number(durationMinutes);
        const professional = Number(professionalId);
        const specialty = Number(specialtyId);
        if (
            typeof localStart !== 'string'
            || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localStart)
            || !Number.isInteger(duration)
            || duration < 15
            || duration > 240
            || !Number.isSafeInteger(professional)
            || professional <= 0
            || !Number.isSafeInteger(specialty)
            || specialty <= 0
        ) {
            throw new Error('Dados do agendamento inválidos.');
        }
        return {
            profissional_id: professional,
            especialidade_id: specialty,
            inicio_local: localStart,
            duracao_minutos: duration
        };
    }

    function dashboardSummary(professionals, appointments, currentDate = new Date()) {
        const now = currentDate instanceof Date ? currentDate : new Date(currentDate);
        if (!Array.isArray(professionals) || !Array.isArray(appointments) || !Number.isFinite(now.getTime())) {
            throw new Error('Dados do resumo inválidos.');
        }

        const localDateKey = (date) => [
            date.getFullYear(),
            String(date.getMonth() + 1).padStart(2, '0'),
            String(date.getDate()).padStart(2, '0')
        ].join('-');
        const today = localDateKey(now);
        const validAppointments = appointments
            .map((appointment) => ({
                ...appointment,
                start: new Date(appointment.inicio_em)
            }))
            .filter((appointment) => Number.isFinite(appointment.start.getTime()));

        return {
            professionals: professionals.length,
            today: validAppointments.filter((appointment) => (
                appointment.status !== 'cancelada'
                && localDateKey(appointment.start) === today
            )).length,
            upcoming: validAppointments.filter((appointment) => (
                ['agendada', 'confirmada'].includes(appointment.status)
                && appointment.start > now
            )).length
        };
    }

    function dashboardAgenda(appointments, currentDate = new Date(), limit = 5) {
        const now = currentDate instanceof Date ? currentDate : new Date(currentDate);
        if (!Array.isArray(appointments) || !Number.isFinite(now.getTime()) || !Number.isInteger(limit) || limit < 1) {
            throw new Error('Dados da agenda inválidos.');
        }
        return appointments
            .map((appointment) => ({
                id: appointment.id,
                inicio_em: appointment.inicio_em,
                fim_em: appointment.fim_em,
                status: appointment.status,
                nome_profissional: appointment.nome_profissional,
                start: new Date(appointment.inicio_em)
            }))
            .filter((appointment) => (
                Number.isFinite(appointment.start.getTime())
                && appointment.start > now
                && ['agendada', 'confirmada'].includes(appointment.status)
            ))
            .sort((first, second) => first.start - second.start)
            .slice(0, limit)
            .map(({ start, ...appointment }) => appointment);
    }

    return {
        KEYS,
        appointmentPayload,
        clinicEntryDecision,
        createSession,
        createPatientCepLookup,
        createLatestRequestGate,
        createOperationLock,
        dashboardForRole,
        dashboardAgenda,
        dashboardSummary,
        formatCep,
        mergePatientCepAddress,
        formatCpf,
        isValidCpf,
        platformAccessState,
        matchingSelectionId,
        isPracticeOwner,
        isLastActiveAdministrator,
        workspaceCapabilities,
        workspaceNavigation,
        workspaceSwitchState,
        roleCanAccessPage
    };
}));

if (typeof window !== 'undefined' && window.document) {
    let active = Promise.resolve();
    function confirmOnce(message) {
        return new Promise((resolve) => {
            const dialog = document.createElement('dialog');
            dialog.className = 'vitalis-confirm-dialog';
            dialog.setAttribute('aria-labelledby', 'vitalis-confirm-title');
            dialog.setAttribute('aria-describedby', 'vitalis-confirm-message');
            const card = document.createElement('div'); card.className = 'vitalis-confirm-card';
            const eyebrow = document.createElement('p'); eyebrow.className = 'vitalis-eyebrow'; eyebrow.textContent = 'Vitalis · confirmação';
            const title = document.createElement('h2'); title.id = 'vitalis-confirm-title'; title.textContent = 'Confirmar ação';
            const text = document.createElement('p'); text.id = 'vitalis-confirm-message'; text.className = 'vitalis-confirm-message'; text.textContent = String(message);
            const actions = document.createElement('div'); actions.className = 'vitalis-confirm-actions';
            const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'vitalis-confirm-button secondary'; cancel.textContent = 'Cancelar';
            const accept = document.createElement('button'); accept.type = 'button'; accept.className = 'vitalis-confirm-button primary'; accept.textContent = 'Confirmar';
            actions.append(cancel, accept); card.append(eyebrow, title, text, actions); dialog.append(card); document.body.append(dialog);
            let settled = false;
            const finish = (value) => {
                if (settled) return; settled = true;
                dialog.close(); dialog.remove(); resolve(value);
            };
            cancel.addEventListener('click', () => finish(false));
            accept.addEventListener('click', () => finish(true));
            dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(false); });
            dialog.showModal(); cancel.focus();
        });
    }
    window.VitalisConfirm = window.VitalisConfirm || {
        ask(message) {
            const next = active.then(() => confirmOnce(message));
            active = next.then(() => undefined, () => undefined);
            return next;
        }
    };
}
