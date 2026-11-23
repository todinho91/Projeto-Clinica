const pool = require('../config/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/environment');
const { professionalIdentity } = require('../support/professional-identity');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PUBLIC_REGISTRATION_CONFLICT = 'Não foi possível concluir o cadastro com os dados informados.';

function logAuthFailure(operation, error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
        ? error.code : 'UNEXPECTED';
    console.error('[auth] operation_failed', { operation, code });
}

function identityToken(userId) {
    return jwt.sign(
        { token_type: 'identity' },
        jwtSecret,
        { algorithm: 'HS256', expiresIn: '8h', subject: String(userId) }
    );
}

function clinicToken(userId, clinicId, membershipVersion) {
    return jwt.sign(
        { token_type: 'clinic', clinic_id: clinicId, membership_version: membershipVersion },
        jwtSecret,
        { algorithm: 'HS256', expiresIn: '8h', subject: String(userId) }
    );
}

function validString(value, min, max) {
    return typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;
}

async function activeClinicsForUser(executor, userId) {
    const [rows] = await executor.execute(`
        SELECT c.id, c.nome, c.slug, cu.papel,
               CASE WHEN cp.clinica_id IS NULL THEN 'clinica' ELSE 'consultorio' END AS tipo_contexto,
               CASE WHEN cp.titular_usuario_id = cu.usuario_id
                          AND ip.status_verificacao = 'verificada' THEN 1 ELSE 0 END AS titular
        FROM clinica_usuarios cu
        JOIN clinicas c ON c.id = cu.clinica_id
        JOIN usuarios u ON u.id = cu.usuario_id
        LEFT JOIN consultorios_profissionais cp ON cp.clinica_id = c.id AND cp.status = 'ativo'
        LEFT JOIN identidades_profissionais ip ON ip.usuario_id = cp.titular_usuario_id
        WHERE cu.usuario_id = ?
          AND cu.status = 'ativo'
          AND c.status = 'ativa'
          AND u.status = 'ativo'
          AND (cp.clinica_id IS NULL OR cp.titular_usuario_id <> cu.usuario_id
               OR ip.status_verificacao = 'verificada')
        ORDER BY c.nome
    `, [userId]);
    return rows.map((row) => ({
        id: Number(row.id),
        nome: row.nome,
        slug: row.slug,
        papel: row.papel,
        tipo_contexto: row.tipo_contexto,
        titular: Boolean(row.titular)
    }));
}

exports.register = async (req, res) => {
    const { nome, email, senha, clinica_slug: clinicSlug } = req.body ?? {};
    const requestedRole = req.body?.papel ?? req.body?.tipo ?? req.body?.role;

    if (requestedRole && requestedRole !== 'paciente') {
        return res.status(403).json({
            error: 'O cadastro público permite somente o papel paciente.'
        });
    }
    if (!validString(nome, 2, 160)) {
        return res.status(400).json({ error: 'Nome inválido.' });
    }
    if (!validString(email, 3, 254) || !EMAIL_PATTERN.test(email.trim())) {
        return res.status(400).json({ error: 'E-mail inválido.' });
    }
    if (!validString(senha, 12, 200)) {
        return res.status(400).json({ error: 'A senha deve ter entre 12 e 200 caracteres.' });
    }
    if (!validString(clinicSlug, 1, 100)) {
        return res.status(400).json({ error: 'A clínica é obrigatória.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const [clinics] = await connection.execute(
            'SELECT id FROM clinicas WHERE slug = ? AND status = \'ativa\' LIMIT 1 FOR UPDATE',
            [clinicSlug.trim()]
        );
        if (clinics.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Clínica não encontrada ou inativa.' });
        }

        const normalizedEmail = email.trim().toLowerCase();
        const normalizedName = nome.trim().replace(/\s+/g, ' ');
        const clinicId = Number(clinics[0].id);
        // Mantém o custo de derivação equivalente nos dois tipos de conflito,
        // evitando que a resposta ou o tempo revelem a origem do cadastro.
        const senhaHash = await bcrypt.hash(senha, 10);
        const [existingProfiles] = await connection.execute(`
            SELECT id FROM pacientes
            WHERE clinica_id = ?
              AND (email = ? OR LOWER(REGEXP_REPLACE(TRIM(nome), '[[:space:]]+', ' ')) = LOWER(?))
            FOR UPDATE
        `, [clinicId, normalizedEmail, normalizedName]);
        if (existingProfiles.length > 0) {
            await connection.rollback();
            return res.status(409).json({ error: PUBLIC_REGISTRATION_CONFLICT });
        }
        const [userResult] = await connection.execute(`
            INSERT INTO usuarios (nome, email, senha_hash, status)
            VALUES (?, ?, ?, 'ativo')
        `, [normalizedName, normalizedEmail, senhaHash]);

        await connection.execute(`
            INSERT INTO clinica_usuarios (clinica_id, usuario_id, papel, status)
            VALUES (?, ?, 'paciente', 'ativo')
        `, [clinicId, userResult.insertId]);
        await connection.execute(`
            INSERT INTO pacientes (clinica_id, usuario_id, nome, email, status)
            VALUES (?, ?, ?, ?, 'ativo')
        `, [clinicId, userResult.insertId, normalizedName, normalizedEmail]);

        await connection.commit();
        return res.status(201).json({ message: 'Paciente cadastrado com sucesso.' });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: PUBLIC_REGISTRATION_CONFLICT });
        }
        logAuthFailure('register', error);
        return res.status(500).json({ error: 'Erro ao cadastrar paciente.' });
    } finally {
        connection?.release();
    }
};

exports.registerProfessional = async (req, res) => {
    const { nome, email, senha } = req.body ?? {};
    const identity = professionalIdentity(req.body);
    if (!validString(nome, 2, 160)) return res.status(400).json({ error: 'Nome inválido.' });
    if (!validString(email, 3, 254) || !EMAIL_PATTERN.test(email.trim())) {
        return res.status(400).json({ error: 'E-mail inválido.' });
    }
    if (!validString(senha, 12, 200)) {
        return res.status(400).json({ error: 'A senha deve ter entre 12 e 200 caracteres.' });
    }
    if (!identity) return res.status(400).json({ error: 'Dados profissionais inválidos.' });

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const passwordHash = await bcrypt.hash(senha, 12);
        const [userResult] = await connection.execute(`
            INSERT INTO usuarios (nome, email, senha_hash, status)
            VALUES (?, ?, ?, 'ativo')
        `, [nome.trim().replace(/\s+/g, ' '), email.trim().toLowerCase(), passwordHash]);
        await connection.execute(`
            INSERT INTO identidades_profissionais (
                usuario_id, tipo_profissional, conselho_tipo, conselho_numero, conselho_uf
            ) VALUES (?, ?, ?, ?, ?)
        `, [userResult.insertId, identity.professionalType, identity.councilType,
            identity.councilNumber, identity.councilState]);
        await connection.commit();
        return res.status(201).json({
            message: 'Conta profissional criada. Entre para acompanhar a verificação do registro.'
        });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({
                error: 'Não foi possível concluir o cadastro profissional com os dados informados.'
            });
        }
        logAuthFailure('register_professional', error);
        return res.status(500).json({ error: 'Erro ao cadastrar conta profissional.' });
    } finally {
        connection?.release();
    }
};

exports.login = async (req, res) => {
    const { email, senha } = req.body ?? {};
    if (!validString(email, 3, 254) || typeof senha !== 'string') {
        return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
    }

    try {
        const [rows] = await pool.execute(`
            SELECT id, nome, email, senha_hash
            FROM usuarios
            WHERE email = ? AND status = 'ativo'
            LIMIT 1
        `, [email.trim().toLowerCase()]);

        if (rows.length === 0 || !(await bcrypt.compare(senha, rows[0].senha_hash))) {
            return res.status(401).json({ error: 'Credenciais inválidas.' });
        }

        const usuario = rows[0];
        const clinicas = await activeClinicsForUser(pool, usuario.id);
        return res.status(200).json({
            token: identityToken(usuario.id),
            usuario: { id: Number(usuario.id), nome: usuario.nome, email: usuario.email },
            clinicas
        });
    } catch (error) {
        logAuthFailure('login', error);
        return res.status(500).json({ error: 'Erro ao fazer login.' });
    }
};

exports.listClinics = async (req, res) => {
    try {
        return res.status(200).json(await activeClinicsForUser(pool, req.userId));
    } catch (error) {
        logAuthFailure('list_clinics', error);
        return res.status(500).json({ error: 'Erro ao listar clínicas.' });
    }
};

exports.selectClinic = async (req, res) => {
    const clinicId = Number(req.body?.clinica_id);
    if (!Number.isSafeInteger(clinicId) || clinicId <= 0) {
        return res.status(400).json({ error: 'Clínica inválida.' });
    }

    try {
        const [rows] = await pool.execute(`
            SELECT c.id, c.nome, c.slug, cu.papel, cu.sessao_versao,
                   CASE WHEN cp.clinica_id IS NULL THEN 'clinica' ELSE 'consultorio' END AS tipo_contexto,
                   CASE WHEN cp.titular_usuario_id = cu.usuario_id
                              AND ip.status_verificacao = 'verificada' THEN 1 ELSE 0 END AS titular
            FROM clinica_usuarios cu
            JOIN clinicas c ON c.id = cu.clinica_id
            JOIN usuarios u ON u.id = cu.usuario_id
            LEFT JOIN consultorios_profissionais cp ON cp.clinica_id = c.id AND cp.status = 'ativo'
            LEFT JOIN identidades_profissionais ip ON ip.usuario_id = cp.titular_usuario_id
            WHERE cu.usuario_id = ?
              AND cu.clinica_id = ?
              AND cu.status = 'ativo'
              AND c.status = 'ativa'
              AND u.status = 'ativo'
              AND (cp.clinica_id IS NULL OR cp.titular_usuario_id <> cu.usuario_id
                   OR ip.status_verificacao = 'verificada')
            LIMIT 1
        `, [req.userId, clinicId]);

        if (rows.length === 0) {
            return res.status(403).json({ error: 'Vínculo com a clínica inexistente ou inativo.' });
        }

        return res.status(200).json({
            token: clinicToken(req.userId, clinicId, Number(rows[0].sessao_versao)),
            clinica: {
                id: Number(rows[0].id),
                nome: rows[0].nome,
                slug: rows[0].slug,
                papel: rows[0].papel,
                tipo_contexto: rows[0].tipo_contexto,
                titular: Boolean(rows[0].titular)
            }
        });
    } catch (error) {
        logAuthFailure('select_clinic', error);
        return res.status(500).json({ error: 'Erro ao selecionar clínica.' });
    }
};

exports.identityToken = identityToken;
exports.clinicToken = clinicToken;
