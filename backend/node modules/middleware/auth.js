const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/environment');

module.exports = (req, res, next) => {
    // Pega o token do cabeçalho 'Authorization'
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        return res.status(401).json({ error: 'Token não fornecido.' });
    }

    // O token vem no formato "Bearer TOKEN_AQUI"
    const parts = authHeader.split(' ');
    if (parts.length !== 2) {
        return res.status(401).json({ error: 'Erro no formato do token.' });
    }

    const [scheme, token] = parts;
    if (!/^Bearer$/i.test(scheme)) {
        return res.status(401).json({ error: 'Token mal formatado.' });
    }

    // Verifica se o token é válido
    jwt.verify(token, jwtSecret, { algorithms: ['HS256'] }, (err, decoded) => {
        if (err) {
            return res.status(401).json({ error: 'Token inválido.' });
        }

        // Se for válido, anexa as informações do usuário na requisição
        req.userId = decoded.id;
        req.userTipo = decoded.tipo;
        return next();
    });
};