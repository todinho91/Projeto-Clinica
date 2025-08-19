const pool = require('../config/database');

exports.uploadExame = async (req, res) => {
    const { paciente_id, titulo } = req.body;
    const upload_por_usuario_id = req.userId; // ID da secretária
    
    // O multer já salvou o arquivo e nos dá informações sobre ele em req.file
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    const caminho_arquivo = req.file.path; // Caminho onde o arquivo foi salvo

    try {
        await pool.query(
            'INSERT INTO exames (paciente_id, titulo, caminho_arquivo, upload_por_usuario_id) VALUES (?, ?, ?, ?)',
            [paciente_id, titulo, caminho_arquivo, upload_por_usuario_id]
        );
        res.status(201).json({ message: 'Exame anexado com sucesso!' });
    } catch (error) {
        console.error("Erro ao salvar exame:", error);
        res.status(500).json({ error: 'Erro ao salvar informações do exame.' });
    }
};