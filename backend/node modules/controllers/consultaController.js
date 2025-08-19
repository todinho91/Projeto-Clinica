const pool = require('../config/database');

exports.agendarConsulta = async (req, res) => {
    // O ID do usuário (paciente) vem do token JWT verificado pelo middleware
    const idUsuarioPaciente = req.userId; 
    const { medico_id, data_hora } = req.body;

    if (!medico_id || !data_hora) {
        return res.status(400).json({ error: 'Médico e data/hora são obrigatórios.' });
    }

    try {
        // Primeiro, precisamos encontrar o ID do paciente correspondente ao ID do usuário
        const [pacienteRows] = await pool.query('SELECT id FROM pacientes WHERE usuario_id = ?', [idUsuarioPaciente]);
        
        if (pacienteRows.length === 0) {
            return res.status(404).json({ error: 'Perfil de paciente não encontrado para este usuário.' });
        }
        const paciente_id = pacienteRows[0].id;

        // Agora, insere a nova consulta no banco
        await pool.query(
            'INSERT INTO consultas (paciente_id, medico_id, data_hora, status) VALUES (?, ?, ?, ?)',
            [paciente_id, medico_id, data_hora, 'agendada']
        );

        res.status(201).json({ message: 'Consulta agendada com sucesso!' });

    } catch (error) {
        console.error("Erro ao agendar consulta:", error);
        res.status(500).json({ error: 'Ocorreu um erro no servidor.' });
    }
};
// ... (função agendarConsulta já existe aqui)

exports.getMinhaAgenda = async (req, res) => {
    // O ID do usuário (médico) vem do token
    const idUsuarioMedico = req.userId;

    try {
        // Query complexa para buscar o nome do paciente e os detalhes da consulta
        const [agenda] = await pool.query(`
            SELECT c.id, c.data_hora, c.status, p_user.nome AS nome_paciente
            FROM consultas c
            JOIN medicos m ON c.medico_id = m.id
            JOIN pacientes p ON c.paciente_id = p.id
            JOIN usuarios p_user ON p.usuario_id = p_user.id
            WHERE m.usuario_id = ?
            ORDER BY c.data_hora ASC
        `, [idUsuarioMedico]);

        res.status(200).json(agenda);

    } catch (error) {
        console.error("Erro ao buscar agenda:", error);
        res.status(500).json({ error: 'Erro ao buscar agenda do médico.' });
    }
};
// ... (outras funções do controller)
exports.updateStatusConsulta = async (req, res) => {
    const { id } = req.params; // ID da consulta
    const { status } = req.body; // Novo status: 'realizada' ou 'cancelada'

    // Validação simples do status
    const statusPermitidos = ['agendada', 'realizada', 'cancelada'];
    if (!statusPermitidos.includes(status)) {
        return res.status(400).json({ error: 'Status inválido.' });
    }

    try {
        const [result] = await pool.query('UPDATE consultas SET status = ? WHERE id = ?', [status, id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Consulta não encontrada.' });
        }

        res.status(200).json({ message: `Status da consulta atualizado para ${status}.` });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao atualizar status da consulta.' });
    }
};
// ... (outras funções do controller)
exports.cancelarConsulta = async (req, res) => {
    const idConsulta = req.params.id;
    const idUsuarioPaciente = req.userId; // ID do usuário logado

    try {
        // Passo 1: Encontrar o ID do paciente associado ao usuário logado
        const [pacienteRows] = await pool.query('SELECT id FROM pacientes WHERE usuario_id = ?', [idUsuarioPaciente]);
        if (pacienteRows.length === 0) {
            return res.status(403).json({ error: 'Acesso negado. Perfil de paciente não encontrado.' });
        }
        const idPaciente = pacienteRows[0].id;

        // Passo 2: Deletar a consulta APENAS SE ela pertencer ao paciente que fez a requisição
        const [result] = await pool.query('DELETE FROM consultas WHERE id = ? AND paciente_id = ?', [idConsulta, idPaciente]);
        
        // Se nenhuma linha foi afetada, significa que a consulta não existe ou não pertence a este paciente
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Consulta não encontrada ou você não tem permissão para cancelá-la.' });
        }

        res.status(200).json({ message: 'Consulta cancelada com sucesso.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao cancelar a consulta.' });
    }
};
// Adicione outras funções aqui, como getMinhaAgenda