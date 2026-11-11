// server.js
const { port, corsOrigins } = require('./config/environment');
const express = require('express');
const cors = require('cors');
const multer = require('multer');


const app = express();

// Middlewares
app.use(cors({
    origin(origin, callback) {
        if (!origin || corsOrigins.includes(origin)) return callback(null, true);
        const error = new Error('Origem não autorizada pelo CORS.');
        error.code = 'CORS_NOT_ALLOWED';
        return callback(error);
    }
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb', parameterLimit: 200 }));


// Rotas da API
const apiRoutes = require('./routes');
app.use('/api', apiRoutes);

app.use((error, req, res, next) => {
    if (error?.code === 'CORS_NOT_ALLOWED') {
        return res.status(403).json({ error: 'Origem não autorizada.' });
    }
    if (error instanceof multer.MulterError) {
        const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 415;
        return res.status(status).json({
            error: status === 413 ? 'Arquivo excede o limite permitido.' : 'Arquivo não permitido.'
        });
    }
    return next(error);
});

if (require.main === module) {
    app.listen(port, () => {
        console.log(`Servidor rodando na porta ${port}`);
    });
}

module.exports = app;
