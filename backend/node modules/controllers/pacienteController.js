const pool = require('../config/database');

function positiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

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
        console.error('Erro ao buscar detalhes do paciente:', error);
        return res.status(500).json({ error: 'Erro ao buscar detalhes do paciente.' });
    }
};
