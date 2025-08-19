const pool = require('../config/database');

// Função para buscar todos os médicos e suas especialidades
exports.getAllMedicos = async (req, res) => {
    try {
        // JOIN para buscar o nome do médico (tabela usuarios) e o nome da especialidade
        const [medicos] = await pool.query(`
            SELECT u.id, u.nome, e.nome AS especialidade
            FROM medicos m
            JOIN usuarios u ON m.usuario_id = u.id
            JOIN especialidades e ON m.especialidade_id = e.id
        `);
        res.status(200).json(medicos);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao buscar médicos.' });
    }
};