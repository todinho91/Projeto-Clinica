const pool = require('../config/database');

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UF = /^[A-Z]{2}$/;

function text(value, min, max) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().replace(/\s+/g, ' ');
    return normalized.length >= min && normalized.length <= max ? normalized : null;
}

function positiveId(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function timezone(value) {
    const normalized = text(value, 1, 64);
    if (!normalized) return null;
    try {
        new Intl.DateTimeFormat('pt-BR', { timeZone: normalized }).format(new Date());
        return normalized;
    } catch { return null; }
}

function professionalIdentity(body = {}) {
    const professionalType = text(body.tipo_profissional, 2, 80);
    const councilType = text(body.conselho_tipo, 2, 30)?.toUpperCase();
    const councilNumber = text(body.conselho_numero, 2, 40)?.toUpperCase();
    const councilState = text(body.conselho_uf, 2, 2)?.toUpperCase();
    return professionalType && councilType && councilNumber && UF.test(councilState)
        ? { professionalType, councilType, councilNumber, councilState } : null;
}

async function platformOperator(executor, userId, lock = false) {
    const [rows] = await executor.execute(`
        SELECT op.id FROM operadores_plataforma op
        JOIN usuarios u ON u.id = op.usuario_id AND u.status = 'ativo'
        WHERE op.usuario_id = ? AND op.status = 'ativo'${lock ? ' FOR UPDATE' : ''}
    `, [userId]);
    return rows[0] ? Number(rows[0].id) : null;
}

async function ownerContext(executor, clinicId, userId, lock = false) {
    const [rows] = await executor.execute(`
        SELECT cp.clinica_id, cp.titular_usuario_id, cp.status,
               c.nome, c.slug, c.timezone, c.status AS clinica_status,
               cu.status AS vinculo_status, cu.papel, u.status AS usuario_status,
               p.id AS profissional_id, p.status AS profissional_status
        FROM consultorios_profissionais cp
        JOIN clinicas c ON c.id = cp.clinica_id
        JOIN clinica_usuarios cu ON cu.clinica_id = cp.clinica_id
          AND cu.usuario_id = cp.titular_usuario_id
        JOIN usuarios u ON u.id = cp.titular_usuario_id
        JOIN identidades_profissionais ip ON ip.usuario_id = cp.titular_usuario_id
          AND ip.status_verificacao = 'verificada'
        JOIN profissionais p ON p.clinica_id = cp.clinica_id
          AND p.usuario_id = cp.titular_usuario_id
        WHERE cp.clinica_id = ? AND cp.titular_usuario_id = ?${lock ? ' FOR UPDATE' : ''}
    `, [clinicId, userId]);
    const row = rows[0];
    if (!row || row.status !== 'ativo' || row.clinica_status !== 'ativa'
        || row.vinculo_status !== 'ativo' || row.papel !== 'profissional'
        || row.usuario_status !== 'ativo' || row.profissional_status !== 'ativo') return null;
    return row;
}

function logFailure(operation, error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
        ? error.code : 'UNEXPECTED';
    console.error('[consultorios] operation_failed', { operation, code });
}

exports.getIdentity = async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT tipo_profissional, conselho_tipo, conselho_numero, conselho_uf,
                   status_verificacao, verificado_em
            FROM identidades_profissionais WHERE usuario_id = ? LIMIT 1
        `, [req.userId]);
        return rows[0]
            ? res.status(200).json(rows[0])
            : res.status(404).json({
                error: 'Identidade profissional ainda não cadastrada.',
                code: 'PROFESSIONAL_IDENTITY_NOT_FOUND'
            });
    } catch (error) {
        logFailure('identity_get', error);
        return res.status(500).json({ error: 'Erro ao consultar identidade profissional.' });
    }
};

exports.createIdentity = async (req, res) => {
    const payload = professionalIdentity(req.body);
    if (!payload) return res.status(400).json({ error: 'Dados profissionais inválidos.' });
    try {
        const [result] = await pool.execute(`
            INSERT INTO identidades_profissionais (
                usuario_id, tipo_profissional, conselho_tipo, conselho_numero, conselho_uf
            ) VALUES (?, ?, ?, ?, ?)
        `, [req.userId, payload.professionalType, payload.councilType,
            payload.councilNumber, payload.councilState]);
        return res.status(201).json({
            id: Number(result.insertId || req.userId),
            status_verificacao: 'pendente',
            message: 'Identidade profissional enviada para verificação.'
        });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'A identidade ou o registro profissional já está cadastrado.' });
        }
        logFailure('identity_create', error);
        return res.status(500).json({ error: 'Erro ao cadastrar identidade profissional.' });
    }
};

exports.verifyIdentity = async (req, res) => {
    const userId = positiveId(req.params.userId);
    const nextStatus = req.body?.status_verificacao;
    if (!userId || !['verificada', 'suspensa'].includes(nextStatus)) {
        return res.status(400).json({ error: 'Usuário ou situação de verificação inválida.' });
    }
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const operatorId = await platformOperator(connection, req.userId, true);
        if (!operatorId) {
            await connection.rollback();
            return res.status(403).json({ error: 'Operação restrita à plataforma.' });
        }
        const [identities] = await connection.execute(`
            SELECT usuario_id, status_verificacao FROM identidades_profissionais
            WHERE usuario_id = ? FOR UPDATE
        `, [userId]);
        if (!identities[0]) {
            await connection.rollback();
            return res.status(404).json({ error: 'Identidade profissional não encontrada.' });
        }
        await connection.execute(`
            UPDATE identidades_profissionais
            SET status_verificacao = ?, verificado_por_operador_id = ?,
                verificado_em = UTC_TIMESTAMP(6)
            WHERE usuario_id = ?
        `, [nextStatus, operatorId, userId]);
        await connection.execute(`
            INSERT INTO auditoria_plataforma (
                operador_plataforma_id, acao, entidade_tipo, entidade_id, metadados
            ) VALUES (?, 'identidade_profissional_verificada', 'usuario', ?, ?)
        `, [operatorId, userId, JSON.stringify({ status: nextStatus })]);
        await connection.commit();
        return res.status(200).json({ message: 'Verificação profissional atualizada.' });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        logFailure('identity_verify', error);
        return res.status(500).json({ error: 'Erro ao atualizar verificação profissional.' });
    } finally { connection?.release(); }
};

exports.provision = async (req, res) => {
    const name = text(req.body?.nome, 2, 160);
    const practiceSlug = text(req.body?.slug, 3, 100)?.toLowerCase();
    const practiceTimezone = timezone(req.body?.timezone);
    const displayName = text(req.body?.nome_exibicao, 2, 160);
    if (!name || !practiceSlug || !SLUG.test(practiceSlug) || !practiceTimezone || !displayName) {
        return res.status(400).json({ error: 'Nome, slug, fuso e nome de exibição devem ser válidos.' });
    }
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const [users] = await connection.execute(`
            SELECT u.id, u.status, ip.tipo_profissional, ip.conselho_tipo,
                   ip.conselho_numero, ip.status_verificacao
            FROM usuarios u
            JOIN identidades_profissionais ip ON ip.usuario_id = u.id
            WHERE u.id = ? FOR UPDATE
        `, [req.userId]);
        const identity = users[0];
        if (!identity || identity.status !== 'ativo' || identity.status_verificacao !== 'verificada') {
            await connection.rollback();
            return res.status(403).json({
                error: 'É necessária uma identidade profissional ativa e verificada para criar um consultório.'
            });
        }
        const [existing] = await connection.execute(`
            SELECT cp.clinica_id FROM consultorios_profissionais cp
            WHERE cp.titular_usuario_id = ? FOR UPDATE
        `, [req.userId]);
        if (existing[0]) {
            await connection.rollback();
            return res.status(409).json({ error: 'Este profissional já possui um consultório.' });
        }
        const [slugRows] = await connection.execute(
            'SELECT id FROM clinicas WHERE slug = ? LIMIT 1 FOR UPDATE', [practiceSlug]
        );
        if (slugRows[0]) {
            await connection.rollback();
            return res.status(409).json({ error: 'Este endereço do consultório já está em uso.' });
        }
        const [clinicResult] = await connection.execute(`
            INSERT INTO clinicas (nome, slug, timezone, status) VALUES (?, ?, ?, 'ativa')
        `, [name, practiceSlug, practiceTimezone]);
        const clinicId = Number(clinicResult.insertId);
        await connection.execute(`
            INSERT INTO clinica_usuarios (clinica_id, usuario_id, papel, status)
            VALUES (?, ?, 'profissional', 'ativo')
        `, [clinicId, req.userId]);
        const [professionalResult] = await connection.execute(`
            INSERT INTO profissionais (
                clinica_id, usuario_id, nome_exibicao, tipo_profissional,
                conselho_tipo, conselho_numero, status
            ) VALUES (?, ?, ?, ?, ?, ?, 'ativo')
        `, [clinicId, req.userId, displayName, identity.tipo_profissional,
            identity.conselho_tipo, identity.conselho_numero]);
        await connection.execute(`
            INSERT INTO consultorios_profissionais (
                clinica_id, titular_usuario_id, status, catalogo_status
            ) VALUES (?, ?, 'ativo', 'privado')
        `, [clinicId, req.userId]);
        await connection.execute(`
            INSERT INTO auditoria (
                clinica_id, usuario_id, acao, entidade_tipo, entidade_id, metadados
            ) VALUES (?, ?, 'consultorio_provisionado', 'consultorio', ?, ?)
        `, [clinicId, req.userId, clinicId, JSON.stringify({
            profissional_id: Number(professionalResult.insertId), catalogo_status: 'privado'
        })]);
        await connection.commit();
        return res.status(201).json({
            id: clinicId,
            message: 'Consultório criado com segurança.',
            consultorio: { id: clinicId, nome: name, slug: practiceSlug, timezone: practiceTimezone }
        });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'O consultório, vínculo ou registro já existe.' });
        }
        logFailure('provision', error);
        return res.status(500).json({ error: 'Erro ao criar consultório.' });
    } finally { connection?.release(); }
};

exports.context = async (req, res) => {
    try {
        const owner = await ownerContext(pool, req.tenant.clinicId, req.userId);
        if (!owner) return res.status(403).json({ error: 'Acesso restrito ao titular do consultório.' });
        const [locations] = await pool.execute(`
            SELECT id, nome, endereco_linha, cidade, uf, cep, status
            FROM consultorio_locais WHERE clinica_id = ? ORDER BY nome, id
        `, [req.tenant.clinicId]);
        return res.status(200).json({
            consultorio: {
                id: Number(owner.clinica_id), nome: owner.nome, slug: owner.slug,
                timezone: owner.timezone, profissional_id: Number(owner.profissional_id)
            },
            locais: locations.map((location) => ({ ...location, id: Number(location.id) }))
        });
    } catch (error) {
        logFailure('context', error);
        return res.status(500).json({ error: 'Erro ao carregar consultório.' });
    }
};

function locationPayload(body = {}) {
    const name = text(body.nome, 2, 120);
    const address = text(body.endereco_linha, 3, 200);
    const city = text(body.cidade, 2, 120);
    const state = text(body.uf, 2, 2)?.toUpperCase();
    const postalCode = body.cep ? String(body.cep).replace(/\D/g, '') : null;
    return name && address && city && UF.test(state) && (!postalCode || postalCode.length === 8)
        ? { name, address, city, state, postalCode } : null;
}

exports.createLocation = async (req, res) => {
    const payload = locationPayload(req.body);
    if (!payload) return res.status(400).json({ error: 'Dados do local de atendimento inválidos.' });
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        if (!await ownerContext(connection, req.tenant.clinicId, req.userId, true)) {
            await connection.rollback();
            return res.status(403).json({ error: 'Acesso restrito ao titular do consultório.' });
        }
        const [result] = await connection.execute(`
            INSERT INTO consultorio_locais (
                clinica_id, nome, endereco_linha, cidade, uf, cep, status
            ) VALUES (?, ?, ?, ?, ?, ?, 'ativo')
        `, [req.tenant.clinicId, payload.name, payload.address, payload.city,
            payload.state, payload.postalCode]);
        const locationId = Number(result.insertId);
        await connection.execute(`
            INSERT INTO auditoria (clinica_id, usuario_id, acao, entidade_tipo, entidade_id)
            VALUES (?, ?, 'local_atendimento_criado', 'consultorio_local', ?)
        `, [req.tenant.clinicId, req.userId, locationId]);
        await connection.commit();
        return res.status(201).json({ id: locationId, message: 'Local de atendimento cadastrado.' });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Já existe um local com este nome no consultório.' });
        }
        logFailure('location_create', error);
        return res.status(500).json({ error: 'Erro ao cadastrar local de atendimento.' });
    } finally { connection?.release(); }
};

exports.updateLocationStatus = async (req, res) => {
    const locationId = positiveId(req.params.id);
    const status = req.body?.status;
    if (!locationId || !['ativo', 'inativo'].includes(status)) {
        return res.status(400).json({ error: 'Local ou situação inválida.' });
    }
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        if (!await ownerContext(connection, req.tenant.clinicId, req.userId, true)) {
            await connection.rollback();
            return res.status(403).json({ error: 'Acesso restrito ao titular do consultório.' });
        }
        const [result] = await connection.execute(`
            UPDATE consultorio_locais SET status = ? WHERE clinica_id = ? AND id = ?
        `, [status, req.tenant.clinicId, locationId]);
        if (result.affectedRows !== 1) {
            await connection.rollback();
            return res.status(404).json({ error: 'Local não encontrado no consultório ativo.' });
        }
        await connection.execute(`
            INSERT INTO auditoria (clinica_id, usuario_id, acao, entidade_tipo, entidade_id, metadados)
            VALUES (?, ?, 'local_atendimento_status_alterado', 'consultorio_local', ?, ?)
        `, [req.tenant.clinicId, req.userId, locationId, JSON.stringify({ status })]);
        await connection.commit();
        return res.status(200).json({ message: 'Situação do local atualizada.' });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        logFailure('location_status', error);
        return res.status(500).json({ error: 'Erro ao atualizar local de atendimento.' });
    } finally { connection?.release(); }
};

exports.ownerContext = ownerContext;
exports.professionalIdentity = professionalIdentity;
exports.locationPayload = locationPayload;
