// server.js
const { port } = require('./config/environment');
const express = require('express');
const cors = require('cors');


const app = express();

// Middlewares
app.use(cors());
app.use(express.json()); // Para entender JSON
app.use(express.urlencoded({ extended: true })); // Para entender formulários


// Rotas da API
const apiRoutes = require('./routes');
app.use('/api', apiRoutes);

if (require.main === module) {
    app.listen(port, () => {
        console.log(`Servidor rodando na porta ${port}`);
    });
}

module.exports = app;
