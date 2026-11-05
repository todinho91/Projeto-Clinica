const pool = require('../config/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/environment');

// Função para CADASTRAR um novo usuário
exports.register = async (req, res) => {
    const { nome, email, senha, tipo } = req.body;

    try {
        // Criptografa a senha antes de salvar no banco
        const senhaHash = await bcrypt.hash(senha, 10);

        const [result] = await pool.query(
            'INSERT INTO usuarios (nome, email, senha, tipo) VALUES (?, ?, ?, ?)',
            [nome, email, senhaHash, tipo]
        );
        
        // Importante: Se for um paciente, criar também a entrada na tabela 'pacientes'
        if (tipo === 'paciente') {
            await pool.query('INSERT INTO pacientes (usuario_id) VALUES (?)', [result.insertId]);
        }
        // Adicionar lógica similar para médicos se necessário

        res.status(201).json({ message: 'Usuário cadastrado com sucesso!' });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao cadastrar usuário.' });
    }
};

// Função para LOGAR um usuário
exports.login = async (req, res) => {
    const { email, senha } = req.body;

    try {
        // 1. Encontrar o usuário pelo email
        const [rows] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [email]);
        
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }

        const usuario = rows[0];

        // 2. Comparar a senha fornecida com a senha criptografada no banco
        const senhaValida = await bcrypt.compare(senha, usuario.senha);
        if (!senhaValida) {
            return res.status(401).json({ error: 'Senha inválida.' });
        }

        // 3. Gerar o Token JWT
        const token = jwt.sign(
            { id: usuario.id, tipo: usuario.tipo }, // Informações que estarão no token
            jwtSecret,
            { algorithm: 'HS256', expiresIn: '8h' } // Token expira em 8 horas
        );

        res.status(200).json({ token, tipo: usuario.tipo });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao fazer login.' });
    }
};