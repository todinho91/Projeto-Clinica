const pool = require('../config/database');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_PAGE = 100000;
const REVIEW_REASONS = new Set(['homonimo_confirmado', 'contato_compartilhado', 'dados_conferidos']);

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

function patientPayload(body = {}) {
    const name = normalizedText(body.nome, 2, 160);
    const email = normalizedEmail(body.email);
    const phone = normalizedPhone(body.telefone);
    const birthDate = normalizedBirthDate(body.data_nascimento);
    const status = body.status ?? 'ativo';
    if (!name || email === undefined || phone === undefined || birthDate === undefined
        || !['ativo', 'inativo'].includes(status)) return null;
    return { name, email, phone, birthDate, status };
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

async function operatorCanManage(connection, clinicId, userId) {
    const [rows] = await connection.execute(`
        SELECT cu.id
        FROM clinica_usuarios cu
        JOIN usuarios u ON u.id = cu.usuario_id
        WHERE cu.clinica_id = ? AND cu.usuario_id = ?
          AND cu.papel IN ('administrador', 'secretaria')
          AND cu.status = 'ativo' AND u.status = 'ativo'
        LIMIT 1 FOR UPDATE
    `, [clinicId, userId]);
    return rows.length > 0;
}

function canonicalName(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .trim().replace(/\s+/g, ' ').toLowerCase();
}

async function potentialPatients(connection, clinicId, payload, ignoredId = 0) {
    const [rows] = await connection.execute(`
        SELECT id, nome, email, telefone, data_nascimento, status
        FROM pacientes
        WHERE clinica_id = ? AND id <> ?
          AND (
                LOWER(REGEXP_REPLACE(TRIM(nome), '[[:space:]]+', ' ')) = LOWER(?)
             OR (? IS NOT NULL AND email = ?)
             OR (? IS NOT NULL AND telefone = ?)
          )
        ORDER BY id
        LIMIT 10 FOR UPDATE
    `, [
        clinicId, ignoredId, payload.name,
        payload.email, payload.email, payload.phone, payload.phone
    ]);
    const inputName = canonicalName(payload.name);
    return rows.map((row) => {
        const storedBirthDate = row.data_nascimento instanceof Date
            ? row.data_nascimento.toISOString().slice(0, 10) : row.data_nascimento;
        const nameMatch = canonicalName(row.nome) === inputName;
        const emailMatch = Boolean(payload.email && row.email === payload.email);
        const phoneMatch = Boolean(payload.phone && String(row.telefone || '') === payload.phone);
        const birthNameMatch = Boolean(nameMatch && payload.birthDate
            && String(storedBirthDate || '').slice(0, 10) === payload.birthDate);
        const incompleteNameMatch = nameMatch && !payload.email && !payload.phone && !payload.birthDate;
        return {
            id: Number(row.id), nome: row.nome, status: row.status,
            ano_nascimento: storedBirthDate ? Number(String(storedBirthDate).slice(0, 4)) : null,
            email_mascarado: maskEmail(row.email), telefone_mascarado: maskPhone(row.telefone),
            bloqueante: emailMatch || birthNameMatch || (nameMatch && phoneMatch) || incompleteNameMatch
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
        candidates: candidates.map(({ bloqueante, ...candidate }) => candidate)
    };
}

function duplicateBody(result) {
    return {
        error: result.blocking
            ? 'Possível paciente duplicado. Use o cadastro existente ou informe dados adicionais.'
            : 'Revise os possíveis cadastros existentes antes de criar um novo paciente.',
        code: result.blocking ? 'PATIENT_DUPLICATE' : 'PATIENT_REVIEW_REQUIRED',
        revisao_permitida: !result.blocking,
        candidatos: result.candidates
    };
}

exports.previewDuplicates = async (req, res) => {
    const payload = patientPayload(req.body);
    if (!payload) return res.status(400).json({ error: 'Dados do paciente inválidos.' });
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        if (!(await lockActiveClinic(connection, req.tenant.clinicId))) {
            await connection.rollback();
            return res.status(409).json({ error: 'Clínica ativa não disponível.' });
        }
        if (!(await operatorCanManage(connection, req.tenant.clinicId, req.userId))) {
            await connection.rollback();
            return res.status(403).json({ error: 'Permissão insuficiente para gerenciar pacientes.' });
        }
        const candidates = await potentialPatients(connection, req.tenant.clinicId, payload);
        await connection.rollback();
        const result = duplicateResult(candidates, null);
        return res.status(200).json({
            possui_candidatos: candidates.length > 0,
            bloqueante: result.blocking,
            revisao_permitida: candidates.length > 0 && !result.blocking,
            candidatos: result.candidates
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
                SELECT id, nome, email, telefone, YEAR(data_nascimento) AS ano_nascimento, status
                FROM pacientes
                WHERE clinica_id = ?
                  AND (? = 'todos' OR status = ?)
                  AND (? = '' OR nome LIKE ? OR email LIKE ? OR telefone LIKE ?)
                ORDER BY nome, id
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
                status: patient.status
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
            SELECT id, nome, email, telefone,
                   DATE_FORMAT(data_nascimento, '%Y-%m-%d') AS data_nascimento, status
            FROM pacientes WHERE clinica_id = ? AND id = ? LIMIT 1
        `, [req.tenant.clinicId, patientId]);
        if (!rows[0]) return res.status(404).json({ error: 'Paciente não encontrado na clínica ativa.' });
        return res.status(200).json({ ...rows[0], id: Number(rows[0].id) });
    } catch (error) {
        logFailure('get_management', error);
        return res.status(500).json({ error: 'Erro ao consultar paciente.' });
    }
};

exports.createPatient = async (req, res) => {
    const payload = patientPayload(req.body);
    if (!payload) return res.status(400).json({ error: 'Dados do paciente inválidos.' });
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        if (!(await lockActiveClinic(connection, req.tenant.clinicId))) {
            await connection.rollback();
            return res.status(409).json({ error: 'Clínica ativa não disponível.' });
        }
        if (!(await operatorCanManage(connection, req.tenant.clinicId, req.userId))) {
            await connection.rollback();
            return res.status(403).json({ error: 'Permissão insuficiente para gerenciar pacientes.' });
        }
        const reviewReason = duplicateReview(req.body);
        const candidates = await potentialPatients(connection, req.tenant.clinicId, payload);
        const duplicate = duplicateResult(candidates, reviewReason);
        if (duplicate.blocked) {
            await connection.rollback();
            return res.status(409).json(duplicateBody(duplicate));
        }
        const [result] = await connection.execute(`
            INSERT INTO pacientes (
                clinica_id, usuario_id, nome, email, telefone, data_nascimento, status
            ) VALUES (?, NULL, ?, ?, ?, ?, ?)
        `, [
            req.tenant.clinicId, payload.name, payload.email, payload.phone,
            payload.birthDate, payload.status
        ]);
        const patientId = Number(result.insertId);
        await audit(connection, req, 'paciente_criado', patientId, {
            status: payload.status, identidade_global_vinculada: false,
            revisao_duplicidade: Boolean(reviewReason), motivo_revisao: reviewReason,
            candidatos_revisados: candidates.length
        });
        await connection.commit();
        return res.status(201).json({ id: patientId, message: 'Paciente cadastrado com sucesso.' });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Possível paciente duplicado nesta clínica.' });
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
        if (!(await operatorCanManage(connection, req.tenant.clinicId, req.userId))) {
            await connection.rollback();
            return res.status(403).json({ error: 'Permissão insuficiente para gerenciar pacientes.' });
        }
        const [rows] = await connection.execute(`
            SELECT id, usuario_id, nome, email, telefone, data_nascimento, status
            FROM pacientes WHERE clinica_id = ? AND id = ? FOR UPDATE
        `, [req.tenant.clinicId, patientId]);
        if (!rows[0]) {
            await connection.rollback();
            return res.status(404).json({ error: 'Paciente não encontrado na clínica ativa.' });
        }
        const reviewReason = duplicateReview(req.body);
        const candidates = await potentialPatients(connection, req.tenant.clinicId, payload, patientId);
        const duplicate = duplicateResult(candidates, reviewReason);
        if (duplicate.blocked) {
            await connection.rollback();
            return res.status(409).json(duplicateBody(duplicate));
        }
        await connection.execute(`
            UPDATE pacientes
            SET nome = ?, email = ?, telefone = ?, data_nascimento = ?, status = ?
            WHERE clinica_id = ? AND id = ?
        `, [
            payload.name, payload.email, payload.phone, payload.birthDate, payload.status,
            req.tenant.clinicId, patientId
        ]);
        const storedBirthDate = rows[0].data_nascimento instanceof Date
            ? rows[0].data_nascimento.toISOString().slice(0, 10)
            : rows[0].data_nascimento;
        const nextValues = {
            nome: payload.name, email: payload.email, telefone: payload.phone,
            data_nascimento: payload.birthDate, status: payload.status
        };
        const storedValues = { ...rows[0], data_nascimento: storedBirthDate };
        const changedFields = Object.keys(nextValues)
            .filter((field) => String(storedValues[field] ?? '') !== String(nextValues[field] ?? ''));
        await audit(connection, req, 'paciente_atualizado', patientId, {
            campos_alterados: changedFields,
            identidade_global_preservada: rows[0].usuario_id !== null,
            revisao_duplicidade: Boolean(reviewReason), motivo_revisao: reviewReason,
            candidatos_revisados: candidates.length
        });
        await connection.commit();
        return res.status(200).json({ message: 'Paciente atualizado com sucesso.' });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Possível paciente duplicado nesta clínica.' });
        }
        logFailure('update', error);
        return res.status(500).json({ error: 'Erro ao atualizar paciente.' });
    } finally {
        connection?.release();
    }
};

exports.canonicalName = canonicalName;
exports.duplicateResult = duplicateResult;

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
                            WHERE c.clinica_id = p.clinica_id
                              AND c.paciente_id = p.id
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
            ORDER BY c.inicio_em DESC
        `, [clinicId, patientId]);

        const [documentos] = await pool.execute(`
            SELECT id, titulo, mime_type, tamanho_bytes, status, criado_em
            FROM documentos_clinicos
            WHERE clinica_id = ? AND paciente_id = ?
            ORDER BY criado_em DESC
        `, [clinicId, patientId]);

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
