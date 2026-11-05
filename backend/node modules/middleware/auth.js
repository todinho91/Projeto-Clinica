const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/environment');

module.exports = (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        return res.status(401).json({ error: 'Token não fornecido.' });
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2) {
        return res.status(401).json({ error: 'Erro no formato do token.' });
    }

    const [scheme, token] = parts;
    if (!/^Bearer$/i.test(scheme)) {
        return res.status(401).json({ error: 'Token mal formatado.' });
    }

    jwt.verify(token, jwtSecret, { algorithms: ['HS256'] }, (err, decoded) => {
        if (err) {
            return res.status(401).json({ error: 'Token inválido.' });
        }

        const userId = Number(decoded.sub);
        if (!Number.isSafeInteger(userId) || userId <= 0) {
            return res.status(401).json({ error: 'Token inválido.' });
        }

        req.userId = userId;
        req.auth = {
            tokenType: decoded.token_type,
            clinicId: decoded.clinic_id === undefined ? null : Number(decoded.clinic_id)
        };
        return next();
    });
};
