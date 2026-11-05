const pool = require('../config/database');

exports.getAllMedicos = async (req, res) => {
    try {
        const [profissionais] = await pool.execute(`
            SELECT
                p.id,
                p.nome_exibicao AS nome,
                p.conselho_tipo,
                p.conselho_numero,
                GROUP_CONCAT(e.nome ORDER BY e.nome SEPARATOR ', ') AS especialidades
            FROM profissionais p
            LEFT JOIN profissional_especialidades pe
              ON pe.clinica_id = p.clinica_id
             AND pe.profissional_id = p.id
            LEFT JOIN especialidades e
              ON e.clinica_id = pe.clinica_id
             AND e.id = pe.especialidade_id
             AND e.status = 'ativa'
            WHERE p.clinica_id = ? AND p.status = 'ativo'
            GROUP BY p.id, p.nome_exibicao, p.conselho_tipo, p.conselho_numero
            ORDER BY p.nome_exibicao
        `, [req.tenant.clinicId]);
        return res.status(200).json(profissionais);
    } catch (error) {
        console.error('Erro ao buscar profissionais:', error);
        return res.status(500).json({ error: 'Erro ao buscar profissionais.' });
    }
};
