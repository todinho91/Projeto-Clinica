const { promises: fs } = require('node:fs');
const pool = require('../config/database');
const { hasExpectedSignature } = require('../support/file-signature');

async function discardUpload(file) {
    if (file?.path) await fs.unlink(file.path).catch(() => {});
}

exports.uploadExame = async (req, res) => {
    const patientId = Number(req.body?.paciente_id);
    const title = req.body?.titulo;
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }
    if (!Number.isSafeInteger(patientId) || patientId <= 0 || typeof title !== 'string' || !title.trim()) {
        await discardUpload(req.file);
        return res.status(400).json({ error: 'Paciente e título são obrigatórios.' });
    }

    try {
        if (!(await hasExpectedSignature(req.file.path, req.file.mimetype))) {
            await discardUpload(req.file);
            return res.status(415).json({ error: 'O conteúdo do arquivo não corresponde ao tipo permitido.' });
        }
    } catch {
        await discardUpload(req.file);
        return res.status(400).json({ error: 'Não foi possível validar o arquivo enviado.' });
    }

    const clinicId = req.tenant.clinicId;
    try {
        const [patients] = await pool.execute(`
            SELECT p.id FROM pacientes p
            WHERE p.clinica_id = ? AND p.id = ? AND p.status = 'ativo'
              AND (
                    ? IN ('administrador', 'secretaria')
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
        `, [clinicId, patientId, req.tenant.role, req.tenant.role, req.userId]);
        if (patients.length === 0) {
            await discardUpload(req.file);
            return res.status(404).json({ error: 'Paciente não encontrado na clínica ativa.' });
        }

        const storageKey = `${clinicId}/${req.file.filename}`;
        const [result] = await pool.execute(`
            INSERT INTO documentos_clinicos (
                clinica_id, paciente_id, titulo, storage_key, mime_type,
                tamanho_bytes, status, enviado_por_usuario_id
            ) VALUES (?, ?, ?, ?, ?, ?, 'ativo', ?)
        `, [
            clinicId,
            patientId,
            title.trim(),
            storageKey,
            req.file.mimetype,
            req.file.size,
            req.userId
        ]);
        return res.status(201).json({
            id: Number(result.insertId),
            message: 'Documento clínico anexado com sucesso.'
        });
    } catch (error) {
        await discardUpload(req.file);
        console.error('Erro ao registrar documento clínico:', error);
        return res.status(500).json({ error: 'Erro ao registrar documento clínico.' });
    }
};

exports.discardUpload = discardUpload;
