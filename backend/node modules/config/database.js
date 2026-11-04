// Usaremos 'mysql2/promise' para usar async/await, que é mais moderno
const mysql = require('mysql2/promise');
const { database } = require('./environment');

// Pool de conexões é mais eficiente que criar uma conexão para cada requisição
const pool = mysql.createPool({
    ...database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool;