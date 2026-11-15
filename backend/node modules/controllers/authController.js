const pool = require('../config/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/environment');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
        SELECT c.id, c.nome, c.slug, cu.papel
        FROM clinica_usuarios cu
        JOIN clinicas c ON c.id = cu.clinica_id
        JOIN usuarios u ON u.id = cu.usuario_id
        WHERE cu.usuario_id = ?
          AND cu.status = 'ativo'
          AND c.status = 'ativa'
          AND u.status = 'ativo'
        ORDER BY c.nome
    `, [userId]);
    return rows.map((row) => ({
        id: Number(row.id),
        nome: row.nome,
        slug: row.slug,
        papel: row.papel
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
        const clinicId = Number(clinics[0].id);
        const [existingProfiles] = await connection.execute(`
            SELECT id FROM pacientes
            WHERE clinica_id = ? AND email = ?
            LIMIT 1 FOR UPDATE
        `, [clinicId, normalizedEmail]);
        if (existingProfiles.length > 0) {
            await connection.rollback();
            return res.status(409).json({
                error: 'Já existe um perfil clínico com este e-mail. Solicite vinculação segura à clínica.'
            });
        }
        const senhaHash = await bcrypt.hash(senha, 10);
        const [userResult] = await connection.execute(`
            INSERT INTO usuarios (nome, email, senha_hash, status)
            VALUES (?, ?, ?, 'ativo')
        `, [nome.trim(), normalizedEmail, senhaHash]);

        await connection.execute(`
            INSERT INTO clinica_usuarios (clinica_id, usuario_id, papel, status)
            VALUES (?, ?, 'paciente', 'ativo')
        `, [clinicId, userResult.insertId]);
        await connection.execute(`
            INSERT INTO pacientes (clinica_id, usuario_id, nome, email, status)
            VALUES (?, ?, ?, ?, 'ativo')
        `, [clinicId, userResult.insertId, nome.trim(), normalizedEmail]);

        await connection.commit();
        return res.status(201).json({ message: 'Paciente cadastrado com sucesso.' });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'E-mail já cadastrado.' });
        }
        logAuthFailure('register', error);
        return res.status(500).json({ error: 'Erro ao cadastrar paciente.' });
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
            SELECT c.id, c.nome, c.slug, cu.papel, cu.sessao_versao
            FROM clinica_usuarios cu
            JOIN clinicas c ON c.id = cu.clinica_id
            JOIN usuarios u ON u.id = cu.usuario_id
            WHERE cu.usuario_id = ?
              AND cu.clinica_id = ?
              AND cu.status = 'ativo'
              AND c.status = 'ativa'
              AND u.status = 'ativo'
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
                papel: rows[0].papel
            }
        });
    } catch (error) {
        logAuthFailure('select_clinic', error);
        return res.status(500).json({ error: 'Erro ao selecionar clínica.' });
    }
};

exports.identityToken = identityToken;
exports.clinicToken = clinicToken;
