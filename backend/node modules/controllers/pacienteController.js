const pool = require('../config/database');
const cepService = require('../services/cep-service');
const {
    cryptoConfiguration,
    identificationPayload,
    maskedCpf,
    protectCpf
} = require('../support/patient-identification');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_PAGE = 100000;
const REVIEW_REASONS = new Set(['homonimo_confirmado', 'contato_compartilhado', 'dados_conferidos']);
const CONTACT_PREFERENCES = new Set(['nenhum', 'whatsapp', 'telefone', 'email']);

function logFailure(operation, error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
        ? error.code : 'UNEXPECTED';
    console.error('[pacientes] operation_failed', { operation, code });
}

function positiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizedText(value, min, max) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().replace(/\s+/g, ' ');
    return normalized.length >= min && normalized.length <= max ? normalized : null;
}

function normalizedEmail(value) {
    if (value === null || value === undefined || value === '') return null;
    const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return email.length <= 254 && EMAIL.test(email) ? email : undefined;
}

function normalizedPhone(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string') return undefined;
    const digits = value.replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 15 ? digits : undefined;
}

function normalizedBirthDate(value, today = new Date()) {
    if (value === null || value === undefined || value === '') return null;
    const match = typeof value === 'string' ? value.match(DATE) : null;
    if (!match) return undefined;
    const [year, month, day] = match.slice(1).map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
        || date.getUTCDate() !== day) return undefined;
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const earliest = Date.UTC(today.getUTCFullYear() - 130, today.getUTCMonth(), today.getUTCDate());
    if (date.getTime() > todayUtc || date.getTime() < earliest) return undefined;
    return value;
}

function patientPayload(body = {}, options = {}) {
    const name = normalizedText(body.nome, 2, 160);
    const email = normalizedEmail(body.email);
    const phone = normalizedPhone(body.telefone);
    const birthDate = normalizedBirthDate(body.data_nascimento);
    const status = body.status ?? 'ativo';
    const contactPreference = body.preferencia_contato ?? 'nenhum';
    if (!name || email === undefined || phone === undefined || birthDate === undefined
        || (options.requireBirthDate === true && !birthDate)
        || !['ativo', 'inativo'].includes(status) || !CONTACT_PREFERENCES.has(contactPreference)
        || (contactPreference === 'whatsapp' && !phone)) return null;
    return { name, email, phone, birthDate, status, contactPreference };
}

function protectedIdentification(body, clinicId, options = {}) {
    const identification = identificationPayload(body, options);
    if (!identification) return null;
    if (identification.pending) return identification;
    let protectedCpf = null;
    if (identification.cpf) {
        protectedCpf = protectCpf(
            identification.cpf,
            clinicId,
            cryptoConfiguration()
        );
    }
    return { ...identification, protectedCpf };
}

function identificationParameters(identification, existing = null) {
    const cpf = identification.preserveCpf ? {
        ciphertext: existing.cpf_cifrado,
        iv: existing.cpf_iv,
        authTag: existing.cpf_auth_tag,
        searchHash: existing.cpf_busca_hash,
        lastFour: existing.cpf_final,
        keyId: existing.cpf_chave_id
    } : identification.protectedCpf;
    const address = identification.address;
    return [
        identification.status,
        cpf?.ciphertext ?? null,
        cpf?.iv ?? null,
        cpf?.authTag ?? null,
        cpf?.searchHash ?? null,
        cpf?.lastFour ?? null,
        cpf?.keyId ?? null,
        identification.cpfException,
        address?.cep ?? null,
        address?.street ?? null,
        address?.number ?? null,
        address?.complement ?? null,
        address?.district ?? null,
        address?.city ?? null,
        address?.state ?? null,
        identification.addressException
    ];
}

function boundedInteger(value, fallback, maximum) {
    if (value === undefined || value === null || value === '') return fallback;
    const text = String(value);
    if (!/^[1-9]\d*$/.test(text)) return null;
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

function maskEmail(value) {
    if (!value) return null;
    const [local, domain] = String(value).split('@');
    return `${local.slice(0, 1)}***@${domain}`;
}

function maskPhone(value) {
    if (!value) return null;
    const digits = String(value).replace(/\D/g, '');
    return digits.length > 4 ? `***${digits.slice(-4)}` : '***';
}

async function audit(connection, req, action, patientId, metadata = {}) {
    await connection.execute(`
        INSERT INTO auditoria (
            clinica_id, usuario_id, acao, entidade_tipo, entidade_id, metadados
        ) VALUES (?, ?, ?, 'paciente', ?, ?)
    `, [
        req.tenant.clinicId, req.userId, action, patientId,
        JSON.stringify(metadata)
    ]);
}

async function lockActiveClinic(connection, clinicId) {
    const [clinics] = await connection.execute(
        "SELECT id FROM clinicas WHERE id = ? AND status = 'ativa' FOR UPDATE",
        [clinicId]
    );
    return clinics.length > 0;
}

async function operatorCanManage(connection, clinicId, userId, membershipVersion) {
    const [rows] = await connection.execute(`
        SELECT cu.id
        FROM clinica_usuarios cu
        JOIN usuarios u ON u.id = cu.usuario_id
        JOIN clinicas c ON c.id = cu.clinica_id AND c.status = 'ativa'
        WHERE cu.clinica_id = ? AND cu.usuario_id = ?
          AND (cu.papel IN ('administrador', 'secretaria') OR (
                cu.papel = 'profissional' AND EXISTS (
                    SELECT 1 FROM consultorios_profissionais cp
                    JOIN identidades_profissionais ip
                      ON ip.usuario_id = cp.titular_usuario_id
                     AND ip.status_verificacao = 'verificada'
                    WHERE cp.clinica_id = cu.clinica_id
                      AND cp.titular_usuario_id = cu.usuario_id
                      AND cp.status = 'ativo'
                )
          ))
          AND cu.status = 'ativo' AND u.status = 'ativo'
          AND cu.sessao_versao = ?
        LIMIT 1 FOR UPDATE
    `, [clinicId, userId, membershipVersion]);
    return rows.length > 0;
}

function canonicalName(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .trim().replace(/\s+/g, ' ').toLowerCase();
}

async function potentialPatients(connection, clinicId, payload, ignoredId = 0, identification = null) {
    const cpfHash = identification?.protectedCpf?.searchHash ?? null;
    const [rows] = await connection.execute(`
        SELECT p.id, p.nome, p.email, p.telefone, p.data_nascimento, p.status,
               pia.cpf_busca_hash
        FROM pacientes p
        LEFT JOIN pacientes_identificacao_administrativa pia
          ON pia.clinica_id = p.clinica_id AND pia.paciente_id = p.id
        WHERE p.clinica_id = ? AND p.id <> ?
          AND (
                LOWER(REGEXP_REPLACE(TRIM(p.nome), '[[:space:]]+', ' ')) = LOWER(?)
             OR (? IS NOT NULL AND (p.email = ? OR TRIM(p.email) = ?))
             OR (? IS NOT NULL AND REGEXP_REPLACE(p.telefone, '[^0-9]', '') = ?)
             OR (? IS NOT NULL AND pia.cpf_busca_hash = ?)
          )
        ORDER BY p.id
        FOR UPDATE
    `, [
        clinicId, ignoredId, payload.name,
        payload.email, payload.email, payload.email, payload.phone, payload.phone,
        cpfHash, cpfHash
    ]);
    const inputName = canonicalName(payload.name);
    return rows.map((row) => {
        const storedBirthDate = row.data_nascimento instanceof Date
            ? row.data_nascimento.toISOString().slice(0, 10) : row.data_nascimento;
        const nameMatch = canonicalName(row.nome) === inputName;
        // A shared contact is a candidate, not a unique patient identity.
        const phoneMatch = Boolean(payload.phone && normalizedPhone(row.telefone) === payload.phone);
        const cpfMatch = Boolean(cpfHash && Buffer.isBuffer(row.cpf_busca_hash)
            && row.cpf_busca_hash.equals(cpfHash));
        const birthNameMatch = Boolean(nameMatch && payload.birthDate
            && String(storedBirthDate || '').slice(0, 10) === payload.birthDate);
        const incompleteNameMatch = nameMatch && !payload.email && !payload.phone && !payload.birthDate;
        return {
            id: Number(row.id), nome: row.nome, status: row.status,
            ano_nascimento: storedBirthDate ? Number(String(storedBirthDate).slice(0, 4)) : null,
            email_mascarado: maskEmail(row.email), telefone_mascarado: maskPhone(row.telefone),
            bloqueante: cpfMatch || birthNameMatch
                || (nameMatch && phoneMatch) || incompleteNameMatch
        };
    });
}

function duplicateReview(body = {}) {
    return body.revisao_duplicidade === true && REVIEW_REASONS.has(body.motivo_revisao)
        ? body.motivo_revisao : null;
}

function duplicateResult(candidates, reviewReason) {
    const blocking = candidates.some((candidate) => candidate.bloqueante);
    return {
        blocked: blocking || (candidates.length > 0 && !reviewReason),
        blocking,
        total: candidates.length,
        candidates: candidates.slice(0, 10).map(({ bloqueante, ...candidate }) => candidate)
    };
}

function duplicateBody(result) {
    return {
        error: result.blocking
            ? 'Possível paciente duplicado. Use o cadastro existente ou informe dados adicionais.'
            : 'Revise os possíveis cadastros existentes antes de criar um novo paciente.',
        code: result.blocking ? 'PATIENT_DUPLICATE' : 'PATIENT_REVIEW_REQUIRED',
        revisao_permitida: !result.blocking,
        total_candidatos: result.total,
        candidatos: result.candidates
    };
}

exports.previewDuplicates = async (req, res) => {
    const payload = patientPayload(req.body, { requireBirthDate: true });
    let identification;
    try {
        identification = protectedIdentification(req.body, req.tenant.clinicId);
    } catch (error) {
        if (error.code === 'PATIENT_PROTECTION_CONFIG') {
            return res.status(503).json({
                error: 'Proteção de documentos indisponível. Tente novamente mais tarde.'
            });
        }
        logFailure('duplicate_validation', error);
        return res.status(500).json({ error: 'Erro ao validar identificação do paciente.' });
    }
    if (!payload || !identification) {
        return res.status(400).json({ error: 'Dados obrigatórios do paciente inválidos.' });
    }
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        if (!(await lockActiveClinic(connection, req.tenant.clinicId))) {
            await connection.rollback();
            return res.status(409).json({ error: 'Clínica ativa não disponível.' });
        }
        if (!(await operatorCanManage(connection, req.tenant.clinicId, req.userId, req.auth?.membershipVersion))) {
            await connection.rollback();
            return res.status(403).json({ error: 'Permissão insuficiente para gerenciar pacientes.' });
        }
        const candidates = await potentialPatients(
            connection, req.tenant.clinicId, payload, 0, identification
        );
        await connection.rollback();
        const result = duplicateResult(candidates, null);
        return res.status(200).json({
            possui_candidatos: candidates.length > 0,
            bloqueante: result.blocking,
            revisao_permitida: candidates.length > 0 && !result.blocking,
            total_candidatos: result.total, candidatos: result.candidates
        });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        logFailure('duplicate_preview', error);
        return res.status(500).json({ error: 'Erro ao verificar possíveis duplicidades.' });
    } finally {
        connection?.release();
    }
};

exports.listForManagement = async (req, res) => {
    const search = typeof req.query?.busca === 'string' ? req.query.busca.trim() : '';
    const status = req.query?.status || 'todos';
    const page = boundedInteger(req.query?.pagina, 1, MAX_PAGE);
    const limit = boundedInteger(req.query?.limite, 20, 50);
    if (page === null || limit === null || search.length > 100
        || !['todos', 'ativo', 'inativo'].includes(status)) {
        return res.status(400).json({ error: 'Filtros de pacientes inválidos.' });
    }
    const offset = (page - 1) * limit;
    const searchLike = `%${search}%`;
    const params = [req.tenant.clinicId, status, status, search, searchLike, searchLike, searchLike];
    try {
        const [[patients], [totals]] = await Promise.all([
            pool.execute(`
                SELECT p.id, p.nome, p.email, p.telefone,
                       YEAR(p.data_nascimento) AS ano_nascimento, p.status,
                       COALESCE(pia.cadastro_status, 'pendente') AS cadastro_status
                FROM pacientes p
                LEFT JOIN pacientes_identificacao_administrativa pia
                  ON pia.clinica_id = p.clinica_id AND pia.paciente_id = p.id
                WHERE p.clinica_id = ?
                  AND (? = 'todos' OR p.status = ?)
                  AND (? = '' OR p.nome LIKE ? OR p.email LIKE ? OR p.telefone LIKE ?)
                ORDER BY p.nome, p.id
                LIMIT ${limit} OFFSET ${offset}
            `, params),
            pool.execute(`
                SELECT COUNT(*) AS total
                FROM pacientes
                WHERE clinica_id = ?
                  AND (? = 'todos' OR status = ?)
                  AND (? = '' OR nome LIKE ? OR email LIKE ? OR telefone LIKE ?)
            `, params)
        ]);
        return res.status(200).json({
            pacientes: patients.map((patient) => ({
                id: Number(patient.id),
                nome: patient.nome,
                email_mascarado: maskEmail(patient.email),
                telefone_mascarado: maskPhone(patient.telefone),
                ano_nascimento: patient.ano_nascimento === null ? null : Number(patient.ano_nascimento),
                status: patient.status,
                cadastro_status: patient.cadastro_status
            })),
            paginacao: {
                pagina: page, limite: limit, total: Number(totals[0]?.total || 0)
            }
        });
    } catch (error) {
        logFailure('list', error);
        return res.status(500).json({ error: 'Erro ao listar pacientes.' });
    }
};

exports.searchForScheduling = async (req, res) => {
    const search = typeof req.query?.q === 'string' ? req.query.q.trim() : '';
    if (search.length < 2 || search.length > 100) {
        return res.status(400).json({ error: 'Informe pelo menos dois caracteres para buscar pacientes.' });
    }
    const like = `%${search}%`;
    try {
        const [rows] = await pool.execute(`
            SELECT id, nome, YEAR(data_nascimento) AS ano_nascimento
            FROM pacientes
            WHERE clinica_id = ? AND status = 'ativo'
              AND (nome LIKE ? OR email LIKE ? OR telefone LIKE ?)
            ORDER BY nome, id
            LIMIT 15
        `, [req.tenant.clinicId, like, like, like]);
        return res.status(200).json(rows.map((patient) => ({
            id: Number(patient.id), nome: patient.nome,
            ano_nascimento: patient.ano_nascimento === null ? null : Number(patient.ano_nascimento)
        })));
    } catch (error) {
        logFailure('search', error);
        return res.status(500).json({ error: 'Erro ao buscar pacientes.' });
    }
};

exports.getForManagement = async (req, res) => {
    const patientId = positiveId(req.params.id);
    if (!patientId) return res.status(400).json({ error: 'Paciente inválido.' });
    try {
        const [rows] = await pool.execute(`
            SELECT p.id, p.nome, p.email, p.telefone, p.preferencia_contato,
                   DATE_FORMAT(p.data_nascimento, '%Y-%m-%d') AS data_nascimento,
                   p.status, COALESCE(pia.cadastro_status, 'pendente') AS cadastro_status,
                   pia.cpf_final, pia.cpf_excecao, pia.cep, pia.logradouro, pia.numero,
                   pia.complemento, pia.bairro, pia.cidade, pia.uf, pia.endereco_excecao
            FROM pacientes p
            LEFT JOIN pacientes_identificacao_administrativa pia
              ON pia.clinica_id = p.clinica_id AND pia.paciente_id = p.id
            WHERE p.clinica_id = ? AND p.id = ? LIMIT 1
        `, [req.tenant.clinicId, patientId]);
        if (!rows[0]) return res.status(404).json({ error: 'Paciente não encontrado na clínica ativa.' });
        const patient = rows[0];
        return res.status(200).json({
            id: Number(patient.id),
            nome: patient.nome,
            email: patient.email,
            telefone: patient.telefone,
            preferencia_contato: patient.preferencia_contato,
            data_nascimento: patient.data_nascimento,
            status: patient.status,
            cadastro_status: patient.cadastro_status,
            cpf_mascarado: maskedCpf(patient.cpf_final),
            cpf_cadastrado: Boolean(patient.cpf_final),
            cpf_excecao: patient.cpf_excecao,
            cep: patient.cep,
            logradouro: patient.logradouro,
            numero: patient.numero,
            complemento: patient.complemento,
            bairro: patient.bairro,
            cidade: patient.cidade,
            uf: patient.uf,
            endereco_excecao: patient.endereco_excecao
        });
    } catch (error) {
        logFailure('get_management', error);
        return res.status(500).json({ error: 'Erro ao consultar paciente.' });
    }
};

exports.createPatient = async (req, res) => {
    const payload = patientPayload(req.body, { requireBirthDate: true });
    let identification;
    try {
        identification = protectedIdentification(req.body, req.tenant.clinicId);
    } catch (error) {
        if (error.code === 'PATIENT_PROTECTION_CONFIG') {
            return res.status(503).json({
                error: 'Proteção de documentos indisponível. Tente novamente mais tarde.'
            });
        }
        logFailure('create_validation', error);
        return res.status(500).json({ error: 'Erro ao validar identificação do paciente.' });
    }
    if (!payload || !identification || identification.pending) {
        return res.status(400).json({ error: 'Dados obrigatórios do paciente inválidos.' });
    }
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        if (!(await lockActiveClinic(connection, req.tenant.clinicId))) {
            await connection.rollback();
            return res.status(409).json({ error: 'Clínica ativa não disponível.' });
        }
        if (!(await operatorCanManage(connection, req.tenant.clinicId, req.userId, req.auth?.membershipVersion))) {
            await connection.rollback();
            return res.status(403).json({ error: 'Permissão insuficiente para gerenciar pacientes.' });
        }
        const reviewReason = duplicateReview(req.body);
        const candidates = await potentialPatients(
            connection, req.tenant.clinicId, payload, 0, identification
        );
        const duplicate = duplicateResult(candidates, reviewReason);
        if (duplicate.blocked) {
            await connection.rollback();
            return res.status(409).json(duplicateBody(duplicate));
        }
        const [result] = await connection.execute(`
            INSERT INTO pacientes (
                clinica_id, usuario_id, nome, email, telefone, preferencia_contato, data_nascimento, status
            ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)
        `, [
            req.tenant.clinicId, payload.name, payload.email, payload.phone,
            payload.contactPreference, payload.birthDate, payload.status
        ]);
        const patientId = Number(result.insertId);
        await connection.execute(`
            INSERT INTO pacientes_identificacao_administrativa (
                clinica_id, paciente_id, cadastro_status,
                cpf_cifrado, cpf_iv, cpf_auth_tag, cpf_busca_hash, cpf_final,
                cpf_chave_id, cpf_excecao, cep, logradouro, numero, complemento,
                bairro, cidade, uf, endereco_excecao, atualizado_por_usuario_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            req.tenant.clinicId, patientId,
            ...identificationParameters(identification), req.userId
        ]);
        await audit(connection, req, 'paciente_criado', patientId, {
            status: payload.status, identidade_global_vinculada: false,
            revisao_duplicidade: Boolean(reviewReason), motivo_revisao: reviewReason,
            candidatos_revisados: candidates.length,
            cadastro_status: identification.status,
            cpf_protegido: Boolean(identification.protectedCpf),
            cpf_excecao: identification.cpfException,
            endereco_excecao: identification.addressException
        });
        await connection.commit();
        return res.status(201).json({ id: patientId, message: 'Paciente cadastrado com sucesso.' });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({
                error: 'Já existe paciente com dados identificadores equivalentes nesta clínica.'
            });
        }
        logFailure('create', error);
        return res.status(500).json({ error: 'Erro ao cadastrar paciente.' });
    } finally {
        connection?.release();
    }
};

exports.updatePatient = async (req, res) => {
    const patientId = positiveId(req.params.id);
    const payload = patientPayload(req.body);
    if (!patientId || !payload) return res.status(400).json({ error: 'Paciente ou dados inválidos.' });
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        if (!(await lockActiveClinic(connection, req.tenant.clinicId))) {
            await connection.rollback();
            return res.status(409).json({ error: 'Clínica ativa não disponível.' });
        }
        if (!(await operatorCanManage(connection, req.tenant.clinicId, req.userId, req.auth?.membershipVersion))) {
            await connection.rollback();
            return res.status(403).json({ error: 'Permissão insuficiente para gerenciar pacientes.' });
        }
        const [rows] = await connection.execute(`
            SELECT p.id, p.usuario_id, p.nome, p.email, p.telefone,
                   p.preferencia_contato, p.data_nascimento, p.status,
                   pia.paciente_id AS identificacao_paciente_id,
                   COALESCE(pia.cadastro_status, 'pendente') AS cadastro_status,
                   pia.cpf_cifrado, pia.cpf_iv, pia.cpf_auth_tag, pia.cpf_busca_hash,
                   pia.cpf_final, pia.cpf_chave_id, pia.cpf_excecao,
                   pia.cep, pia.logradouro, pia.numero, pia.complemento,
                   pia.bairro, pia.cidade, pia.uf, pia.endereco_excecao
            FROM pacientes p
            LEFT JOIN pacientes_identificacao_administrativa pia
              ON pia.clinica_id = p.clinica_id AND pia.paciente_id = p.id
            WHERE p.clinica_id = ? AND p.id = ? FOR UPDATE
        `, [req.tenant.clinicId, patientId]);
        if (!rows[0]) {
            await connection.rollback();
            return res.status(404).json({ error: 'Paciente não encontrado na clínica ativa.' });
        }
        const current = rows[0];
        const keepPending = req.body?.manter_cadastro_pendente === true;
        const pendingAllowed = keepPending && current.cadastro_status === 'pendente';
        if (!payload.birthDate && (!pendingAllowed || current.data_nascimento)) {
            await connection.rollback();
            return res.status(400).json({ error: 'A data de nascimento é obrigatória.' });
        }
        let identification;
        try {
            identification = protectedIdentification(req.body, req.tenant.clinicId, {
                existingCpf: Boolean(current.cpf_cifrado),
                allowPending: pendingAllowed
            });
        } catch (error) {
            await connection.rollback();
            if (error.code === 'PATIENT_PROTECTION_CONFIG') {
                return res.status(503).json({
                    error: 'Proteção de documentos indisponível. Tente novamente mais tarde.'
                });
            }
            throw error;
        }
        if (!identification || (identification.pending && !pendingAllowed)) {
            await connection.rollback();
            return res.status(400).json({
                error: 'Complete CPF e endereço ou registre uma exceção autorizada.'
            });
        }
        const reviewReason = duplicateReview(req.body);
        const candidates = await potentialPatients(
            connection, req.tenant.clinicId, payload, patientId, identification
        );
        const duplicate = duplicateResult(candidates, reviewReason);
        if (duplicate.blocked) {
            await connection.rollback();
            return res.status(409).json(duplicateBody(duplicate));
        }
        const storedBirthDate = current.data_nascimento instanceof Date
            ? current.data_nascimento.toISOString().slice(0, 10)
            : current.data_nascimento;
        const nextValues = {
            nome: payload.name, email: payload.email, telefone: payload.phone,
            preferencia_contato: payload.contactPreference,
            data_nascimento: payload.birthDate, status: payload.status
        };
        const storedValues = { ...current, data_nascimento: storedBirthDate };
        const changedFields = Object.keys(nextValues)
            .filter((field) => String(storedValues[field] ?? '') !== String(nextValues[field] ?? ''));
        await connection.execute(`
            UPDATE pacientes
            SET nome = ?, email = ?, telefone = ?, preferencia_contato = ?, data_nascimento = ?, status = ?
            WHERE clinica_id = ? AND id = ?
        `, [
            payload.name, payload.email, payload.phone, payload.contactPreference, payload.birthDate, payload.status,
            req.tenant.clinicId, patientId
        ]);
        if (!identification.pending) {
            const identificationValues = identificationParameters(identification, current);
            if (current.identificacao_paciente_id) {
                await connection.execute(`
                    UPDATE pacientes_identificacao_administrativa
                    SET cadastro_status = ?, cpf_cifrado = ?, cpf_iv = ?, cpf_auth_tag = ?,
                        cpf_busca_hash = ?, cpf_final = ?, cpf_chave_id = ?, cpf_excecao = ?,
                        cep = ?, logradouro = ?, numero = ?, complemento = ?, bairro = ?,
                        cidade = ?, uf = ?, endereco_excecao = ?, atualizado_por_usuario_id = ?
                    WHERE clinica_id = ? AND paciente_id = ?
                `, [
                    ...identificationValues, req.userId, req.tenant.clinicId, patientId
                ]);
            } else {
                await connection.execute(`
                    INSERT INTO pacientes_identificacao_administrativa (
                        clinica_id, paciente_id, cadastro_status,
                        cpf_cifrado, cpf_iv, cpf_auth_tag, cpf_busca_hash, cpf_final,
                        cpf_chave_id, cpf_excecao, cep, logradouro, numero, complemento,
                        bairro, cidade, uf, endereco_excecao, atualizado_por_usuario_id
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    req.tenant.clinicId, patientId,
                    ...identificationValues, req.userId
                ]);
            }
        }
        const invalidatesConfirmations = changedFields.includes('telefone')
            || changedFields.includes('preferencia_contato')
            || (changedFields.includes('status') && payload.status !== 'ativo');
        let revokedConfirmations = 0;
        if (invalidatesConfirmations) {
            const reason = payload.status !== 'ativo'
                ? 'paciente_inativado' : 'contato_whatsapp_alterado';
            await connection.execute(`INSERT INTO confirmacoes_consulta_eventos
                (clinica_id, confirmacao_id, evento, origem, usuario_id, metadados)
                SELECT cc.clinica_id, cc.id, 'revogada', 'operador', ?, JSON_OBJECT('motivo', ?)
                FROM confirmacoes_consulta cc
                JOIN consultas c ON c.clinica_id = cc.clinica_id AND c.id = cc.consulta_id
                WHERE cc.clinica_id = ? AND c.paciente_id = ? AND cc.estado = 'preparada'`,
            [req.userId, reason, req.tenant.clinicId, patientId]);
            const [revoked] = await connection.execute(`UPDATE confirmacoes_consulta cc
                JOIN consultas c ON c.clinica_id = cc.clinica_id AND c.id = cc.consulta_id
                SET cc.estado = 'revogada', cc.revogado_em = UTC_TIMESTAMP(6), cc.motivo_revogacao = ?
                WHERE cc.clinica_id = ? AND c.paciente_id = ? AND cc.estado = 'preparada'`,
            [reason, req.tenant.clinicId, patientId]);
            revokedConfirmations = Number(revoked.affectedRows || 0);
        }
        await audit(connection, req, 'paciente_atualizado', patientId, {
            campos_alterados: changedFields,
            identidade_global_preservada: current.usuario_id !== null,
            revisao_duplicidade: Boolean(reviewReason), motivo_revisao: reviewReason,
            candidatos_revisados: candidates.length,
            confirmacoes_revogadas: revokedConfirmations,
            cadastro_status: identification.status,
            identificacao_atualizada: !identification.pending,
            cpf_alterado: Boolean(identification.protectedCpf),
            cpf_excecao: identification.cpfException,
            endereco_excecao: identification.addressException
        });
        await connection.commit();
        return res.status(200).json({ message: 'Paciente atualizado com sucesso.' });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({
                error: 'Já existe paciente com dados identificadores equivalentes nesta clínica.'
            });
        }
        logFailure('update', error);
        return res.status(500).json({ error: 'Erro ao atualizar paciente.' });
    } finally {
        connection?.release();
    }
};

exports.updatePatientStatus = async (req, res) => {
    const patientId = positiveId(req.params.id);
    const status = req.body?.status;
    if (!patientId || !['ativo', 'inativo'].includes(status)) {
        return res.status(400).json({ error: 'Paciente ou situação inválida.' });
    }
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        if (!(await lockActiveClinic(connection, req.tenant.clinicId))) {
            await connection.rollback();
            return res.status(409).json({ error: 'Clínica ativa não disponível.' });
        }
        if (!(await operatorCanManage(
            connection,
            req.tenant.clinicId,
            req.userId,
            req.auth?.membershipVersion
        ))) {
            await connection.rollback();
            return res.status(403).json({
                error: 'Permissão insuficiente para gerenciar pacientes.'
            });
        }
        const [rows] = await connection.execute(`
            SELECT id, status
            FROM pacientes
            WHERE clinica_id = ? AND id = ?
            FOR UPDATE
        `, [req.tenant.clinicId, patientId]);
        const patient = rows[0];
        if (!patient) {
            await connection.rollback();
            return res.status(404).json({
                error: 'Paciente não encontrado na clínica ativa.'
            });
        }
        if (patient.status === status) {
            await connection.rollback();
            return res.status(200).json({
                message: status === 'ativo'
                    ? 'O paciente já está ativo.' : 'O paciente já está arquivado.'
            });
        }
        let revokedConfirmations = 0;
        if (status === 'inativo') {
            await connection.execute(`INSERT INTO confirmacoes_consulta_eventos
                (clinica_id, confirmacao_id, evento, origem, usuario_id, metadados)
                SELECT cc.clinica_id, cc.id, 'revogada', 'operador', ?,
                       JSON_OBJECT('motivo', 'paciente_arquivado')
                FROM confirmacoes_consulta cc
                JOIN consultas c
                  ON c.clinica_id = cc.clinica_id AND c.id = cc.consulta_id
                WHERE cc.clinica_id = ? AND c.paciente_id = ?
                  AND cc.estado = 'preparada'`,
            [req.userId, req.tenant.clinicId, patientId]);
            const [revoked] = await connection.execute(`UPDATE confirmacoes_consulta cc
                JOIN consultas c
                  ON c.clinica_id = cc.clinica_id AND c.id = cc.consulta_id
                SET cc.estado = 'revogada', cc.revogado_em = UTC_TIMESTAMP(6),
                    cc.motivo_revogacao = 'paciente_arquivado'
                WHERE cc.clinica_id = ? AND c.paciente_id = ?
                  AND cc.estado = 'preparada'`,
            [req.tenant.clinicId, patientId]);
            revokedConfirmations = Number(revoked.affectedRows || 0);
        }
        await connection.execute(`
            UPDATE pacientes SET status = ?
            WHERE clinica_id = ? AND id = ?
        `, [status, req.tenant.clinicId, patientId]);
        await audit(
            connection,
            req,
            status === 'ativo' ? 'paciente_reativado' : 'paciente_arquivado',
            patientId,
            {
                status_anterior: patient.status,
                status_novo: status,
                confirmacoes_revogadas: revokedConfirmations,
                historico_preservado: true
            }
        );
        await connection.commit();
        return res.status(200).json({
            message: status === 'ativo'
                ? 'Paciente reativado com sucesso.'
                : 'Paciente arquivado. Consultas e históricos foram preservados.'
        });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        logFailure('update_status', error);
        return res.status(500).json({ error: 'Erro ao alterar a situação do paciente.' });
    } finally {
        connection?.release();
    }
};

exports.lookupCep = async (req, res) => {
    const cep = typeof req.params?.cep === 'string' ? req.params.cep.replace(/\D/g, '') : '';
    if (!/^\d{8}$/.test(cep)) {
        return res.status(400).json({ error: 'CEP deve conter oito dígitos.' });
    }
    const result = await cepService.lookupCep(cep, {
        rateKey: `${req.tenant.clinicId}:${req.userId}`
    });
    res.set?.('Cache-Control', 'no-store');
    if (result.kind === 'limited') {
        return res.status(429).json({ error: 'Limite de consultas de CEP atingido. Tente novamente em instantes.' });
    }
    if (result.kind === 'not_found') {
        return res.status(404).json({
            error: 'CEP não encontrado. Preencha o endereço manualmente.'
        });
    }
    if (result.kind !== 'found') {
        return res.status(503).json({
            error: 'Consulta de CEP indisponível. Os campos informados foram preservados.'
        });
    }
    return res.status(200).json(result.address);
};

exports.canonicalName = canonicalName;
exports.duplicateResult = duplicateResult;
exports.patientPayload = patientPayload;
exports.protectedIdentification = protectedIdentification;

exports.getPacienteDetails = async (req, res) => {
    const patientId = positiveId(req.params.id);
    if (!patientId) {
        return res.status(400).json({ error: 'Paciente inválido.' });
    }

    const clinicId = req.tenant.clinicId;
    try {
        const [patientRows] = await pool.execute(`
            SELECT p.id, p.nome, p.email, p.telefone, p.data_nascimento, p.status
            FROM pacientes p
            WHERE p.clinica_id = ?
              AND p.id = ?
              AND (
                    ? IN ('administrador', 'secretaria')
                 OR (? = 'paciente' AND p.usuario_id = ?)
                 OR (
                        ? = 'profissional'
                    AND EXISTS (
                            SELECT 1
                            FROM consultas c
                            JOIN profissionais pr
                              ON pr.clinica_id = c.clinica_id
                             AND pr.id = c.profissional_id
                             AND pr.status = 'ativo'
                            JOIN clinica_usuarios cu
                              ON cu.clinica_id = c.clinica_id
                             AND cu.usuario_id = pr.usuario_id
                             AND cu.papel = 'profissional'
                             AND cu.status = 'ativo'
                            JOIN usuarios professional_user
                              ON professional_user.id = pr.usuario_id
                             AND professional_user.status = 'ativo'
                            WHERE c.clinica_id = p.clinica_id
                              AND c.paciente_id = p.id
                              AND c.status IN ('agendada', 'confirmada', 'realizada')
                              AND pr.usuario_id = ?
                        )
                    )
              )
            LIMIT 1
        `, [
            clinicId,
            patientId,
            req.tenant.role,
            req.tenant.role,
            req.userId,
            req.tenant.role,
            req.userId
        ]);

        if (patientRows.length === 0) {
            return res.status(404).json({ error: 'Paciente não encontrado.' });
        }

        const [consultas] = await pool.execute(`
            SELECT
                c.id, c.inicio_em, c.fim_em, c.status,
                p.nome_exibicao AS nome_profissional
            FROM consultas c
            JOIN profissionais p
              ON p.clinica_id = c.clinica_id
             AND p.id = c.profissional_id
            WHERE c.clinica_id = ? AND c.paciente_id = ?
              AND (? <> 'profissional' OR (p.usuario_id = ? AND p.status = 'ativo'))
            ORDER BY c.inicio_em DESC
        `, [clinicId, patientId, req.tenant.role, req.userId]);

        // A secretária do consultório recebe somente os dados administrativos.
        // A clínica institucional mantém o comportamento já publicado, enquanto
        // o consultório impede que uma delegação administrativa amplie o acesso
        // para documentos clínicos.
        let documentos = [];
        if (!(req.tenant.isPractice && req.tenant.role === 'secretaria')) {
            [documentos] = await pool.execute(`
                SELECT id, titulo, mime_type, tamanho_bytes, status, criado_em
                FROM documentos_clinicos
                WHERE clinica_id = ? AND paciente_id = ?
                  AND (? <> 'profissional' OR enviado_por_usuario_id = ?)
                ORDER BY criado_em DESC
            `, [clinicId, patientId, req.tenant.role, req.userId]);
        }

        return res.status(200).json({
            info: patientRows[0],
            consultas,
            documentos
        });
    } catch (error) {
        logFailure('details', error);
        return res.status(500).json({ error: 'Erro ao buscar detalhes do paciente.' });
    }
};

exports.patientPayload = patientPayload;
exports.boundedInteger = boundedInteger;
