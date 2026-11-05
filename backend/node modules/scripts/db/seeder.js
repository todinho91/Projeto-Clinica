const bcrypt = require('bcryptjs');
const seedData = require('./seed-data');

function readSeedPassword(env = process.env) {
    const password = env.SEED_PASSWORD;
    if (!password || password.length < 12) {
        throw new Error('SEED_PASSWORD é obrigatória e deve ter pelo menos 12 caracteres.');
    }
    return password;
}

function readBcryptRounds(env = process.env) {
    const rounds = Number(env.SEED_BCRYPT_ROUNDS ?? 10);
    if (!Number.isInteger(rounds) || rounds < 4 || rounds > 15) {
        throw new Error('SEED_BCRYPT_ROUNDS deve ser um inteiro entre 4 e 15.');
    }
    return rounds;
}

async function upsertId(connection, sql, params) {
    const [result] = await connection.execute(sql, params);
    if (!result.insertId) {
        throw new Error('O upsert não retornou um identificador.');
    }
    return result.insertId;
}

async function upsertUsuario(connection, usuario, senhaHash) {
    return upsertId(connection, `
        INSERT INTO usuarios (nome, email, senha_hash, status)
        VALUES (?, ?, ?, 'ativo')
        ON DUPLICATE KEY UPDATE
            id = LAST_INSERT_ID(id),
            nome = VALUES(nome),
            status = 'ativo'
    `, [usuario.nome, usuario.email, senhaHash]);
}

async function seedClinic(connection, item, senhaHash) {
    const clinicaId = await upsertId(connection, `
        INSERT INTO clinicas (nome, slug, status)
        VALUES (?, ?, 'ativa')
        ON DUPLICATE KEY UPDATE
            id = LAST_INSERT_ID(id),
            nome = VALUES(nome),
            status = 'ativa'
    `, [item.nome, item.slug]);

    const usuarios = {};
    for (const [papel, usuario] of Object.entries(item.usuarios)) {
        const usuarioId = await upsertUsuario(connection, usuario, senhaHash);
        await upsertId(connection, `
            INSERT INTO clinica_usuarios (clinica_id, usuario_id, papel, status)
            VALUES (?, ?, ?, 'ativo')
            ON DUPLICATE KEY UPDATE
                id = LAST_INSERT_ID(id),
                papel = VALUES(papel),
                status = 'ativo'
        `, [clinicaId, usuarioId, papel]);
        usuarios[papel] = usuarioId;
    }

    const especialidadeId = await upsertId(connection, `
        INSERT INTO especialidades (clinica_id, nome, status)
        VALUES (?, ?, 'ativa')
        ON DUPLICATE KEY UPDATE
            id = LAST_INSERT_ID(id),
            status = 'ativa'
    `, [clinicaId, item.especialidade]);

    const profissionalId = await upsertId(connection, `
        INSERT INTO profissionais (
            clinica_id, usuario_id, nome_exibicao, conselho_tipo, conselho_numero, status
        ) VALUES (?, ?, ?, NULL, NULL, 'ativo')
        ON DUPLICATE KEY UPDATE
            id = LAST_INSERT_ID(id),
            nome_exibicao = VALUES(nome_exibicao),
            status = 'ativo'
    `, [clinicaId, usuarios.profissional, item.usuarios.profissional.nome]);

    await connection.execute(`
        INSERT IGNORE INTO profissional_especialidades (
            clinica_id, profissional_id, especialidade_id
        ) VALUES (?, ?, ?)
    `, [clinicaId, profissionalId, especialidadeId]);

    const pacienteId = await upsertId(connection, `
        INSERT INTO pacientes (
            clinica_id, usuario_id, nome, email, telefone, data_nascimento, status
        ) VALUES (?, ?, ?, ?, NULL, NULL, 'ativo')
        ON DUPLICATE KEY UPDATE
            id = LAST_INSERT_ID(id),
            nome = VALUES(nome),
            email = VALUES(email),
            status = 'ativo'
    `, [
        clinicaId,
        usuarios.paciente,
        item.usuarios.paciente.nome,
        item.usuarios.paciente.email
    ]);

    await upsertId(connection, `
        INSERT INTO consultas (
            clinica_id, paciente_id, profissional_id, inicio_em, fim_em,
            status, criado_por_usuario_id
        ) VALUES (?, ?, ?, ?, ?, 'agendada', ?)
        ON DUPLICATE KEY UPDATE
            id = LAST_INSERT_ID(id),
            paciente_id = VALUES(paciente_id),
            fim_em = VALUES(fim_em),
            status = 'agendada',
            criado_por_usuario_id = VALUES(criado_por_usuario_id)
    `, [
        clinicaId,
        pacienteId,
        profissionalId,
        item.consulta.inicio,
        item.consulta.fim,
        usuarios.secretaria
    ]);

    await upsertId(connection, `
        INSERT INTO documentos_clinicos (
            clinica_id, paciente_id, titulo, storage_key, mime_type,
            tamanho_bytes, sha256_hex, status, enviado_por_usuario_id
        ) VALUES (?, ?, ?, ?, 'text/plain', 0, NULL, 'sintetico', ?)
        ON DUPLICATE KEY UPDATE
            id = LAST_INSERT_ID(id),
            paciente_id = VALUES(paciente_id),
            titulo = VALUES(titulo),
            status = 'sintetico',
            enviado_por_usuario_id = VALUES(enviado_por_usuario_id)
    `, [
        clinicaId,
        pacienteId,
        item.documento.titulo,
        item.documento.storageKey,
        usuarios.secretaria
    ]);

    await upsertId(connection, `
        INSERT INTO auditoria (
            clinica_id, usuario_id, acao, entidade_tipo, entidade_id,
            request_id, metadados
        ) VALUES (?, ?, 'seed_aplicado', 'clinica', ?, ?, JSON_OBJECT('synthetic', TRUE))
        ON DUPLICATE KEY UPDATE
            id = LAST_INSERT_ID(id),
            usuario_id = VALUES(usuario_id),
            metadados = VALUES(metadados)
    `, [clinicaId, usuarios.administrador, clinicaId, `seed-${item.slug}`]);

    return { clinicaId, pacienteId, profissionalId };
}

async function seedDatabase({ connection, password, rounds = 10 }) {
    const senhaHash = await bcrypt.hash(password, rounds);
    const results = [];
    await connection.beginTransaction();
    try {
        for (const item of seedData.clinicas) {
            results.push(await seedClinic(connection, item, senhaHash));
        }
        await connection.commit();
        return results;
    } catch (error) {
        await connection.rollback();
        throw error;
    }
}

module.exports = {
    readBcryptRounds,
    readSeedPassword,
    seedDatabase
};
