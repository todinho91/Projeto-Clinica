const pool = require('../config/database');

// Função para buscar um paciente por ID com todos os seus dados
exports.getPacienteDetails = async (req, res) => {
    const { id } = req.params; // Pega o ID da URL (ex: /api/pacientes/15)

    try {
        // Busca os dados básicos do paciente
        const [pacienteInfo] = await pool.query(`
            SELECT u.nome, u.email, p.telefone, p.data_nascimento
            FROM pacientes p
            JOIN usuarios u ON p.usuario_id = u.id
            WHERE p.id = ?
        `, [id]);

        if (pacienteInfo.length === 0) {
            return res.status(404).json({ error: 'Paciente não encontrado.' });
        }

        // Busca o histórico de consultas do paciente
        const [consultas] = await pool.query(`
            SELECT c.data_hora, c.status, u.nome AS nome_medico
            FROM consultas c
            JOIN medicos m ON c.medico_id = m.id
            JOIN usuarios u ON m.usuario_id = u.id
            WHERE c.paciente_id = ?
            ORDER BY c.data_hora DESC
        `, [id]);

        // Busca os exames do paciente
        const [exames] = await pool.query('SELECT id, titulo, caminho_arquivo, data_upload FROM exames WHERE paciente_id = ?', [id]);

        res.status(200).json({
            info: pacienteInfo[0],
            consultas,
            exames
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao buscar detalhes do paciente.' });
    }
};