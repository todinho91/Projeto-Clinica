// Usaremos 'mysql2/promise' para usar async/await, que é mais moderno
const mysql = require('mysql2/promise');
require('dotenv').config();

// Pool de conexões é mais eficiente que criar uma conexão para cada requisição
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool;