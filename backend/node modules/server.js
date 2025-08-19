// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');


const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json()); // Para entender JSON
app.use(express.urlencoded({ extended: true })); // Para entender formulários


// Servir arquivos estáticos (como os exames upados)
app.use('/uploads', express.static(path.join(__dirname, 'src/uploads')));

// Rotas da API
const apiRoutes = require('./routes');
app.use('/api', apiRoutes);

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});