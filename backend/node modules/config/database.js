// Usaremos 'mysql2/promise' para usar async/await, que é mais moderno
const mysql = require('mysql2/promise');
const { database } = require('./environment');

// Pool de conexões é mais eficiente que criar uma conexão para cada requisição
const pool = mysql.createPool({
    ...database,
    // Consultas são normalizadas para UTC antes de serem persistidas em DATETIME.
    // Fixar o fuso evita que o mesmo valor seja interpretado de forma diferente
    // conforme o fuso horário do servidor Node.js.
    timezone: 'Z',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool;
