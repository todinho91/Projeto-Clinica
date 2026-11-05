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

    function dashboardForRole(role) {
        return {
            administrador: 'dashboard-secretaria.html',
            secretaria: 'dashboard-secretaria.html',
            profissional: 'dashboard-medico.html',
            paciente: 'dashboard-paciente.html'
        }[role] ?? null;
    }

    function roleCanAccessPage(role, page) {
        const allowed = {
            'dashboard-secretaria.html': ['administrador', 'secretaria'],
            'dashboard-medico.html': ['profissional'],
            'dashboard-paciente.html': ['paciente']
        };
        return allowed[page]?.includes(role) ?? false;
    }

    function appointmentPayload(localStart, durationMinutes, professionalId) {
        const start = new Date(localStart);
        const duration = Number(durationMinutes);
        const professional = Number(professionalId);
        if (
            !Number.isFinite(start.getTime())
            || !Number.isInteger(duration)
            || duration < 15
            || duration > 240
            || !Number.isSafeInteger(professional)
            || professional <= 0
        ) {
            throw new Error('Dados do agendamento inválidos.');
        }
        const end = new Date(start.getTime() + duration * 60 * 1000);
        return {
            profissional_id: professional,
            inicio_em: start.toISOString(),
            fim_em: end.toISOString()
        };
    }

    return { KEYS, appointmentPayload, createSession, dashboardForRole, roleCanAccessPage };
}));
