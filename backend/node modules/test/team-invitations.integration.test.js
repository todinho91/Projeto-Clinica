const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const path = require('node:path');
const { test } = require('node:test');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const { loadDatabaseConfig } = require('../scripts/db/config');
const { runMigrations } = require('../scripts/db/migrator');
const { assertTeamDisposableDatabaseName } = require('../support/mysql-test-safety');

const enabled = process.env.TEAM_INTEGRATION_TEST === '1';
const migrationsDir = path.join(__dirname, '..', '..', 'database', 'migrations');

function response() {
    return { statusCode:null, body:null, status(code){this.statusCode=code;return this;}, json(body){this.body=body;return this;} };
}

async function resetTestSchema(connection, expectedDatabase) {
    assertTeamDisposableDatabaseName(expectedDatabase);
    const [[selected]] = await connection.query('SELECT DATABASE() AS database_name');
    if (selected.database_name !== expectedDatabase) throw new Error('Conexão não aponta para o banco descartável esperado.');
    const tables = [
        'consultorio_locais', 'consultorios_profissionais', 'identidades_profissionais',
        'bloqueios_profissional',
        'disponibilidades_profissional',
        'auditoria_plataforma','convites_clinica','auditoria','documentos_clinicos','consultas_historico','consultas','pacientes',
        'profissional_especialidades','profissionais','especialidades','clinica_usuarios',
        'operadores_plataforma','usuarios','clinicas','schema_migrations'
    ];
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        for (const table of tables) await connection.query(`DROP TABLE IF EXISTS \`${table}\``);
    } finally { await connection.query('SET FOREIGN_KEY_CHECKS = 1'); }
}

test('MySQL 8 mantém aceite único sob concorrência e bloqueia revogação cross-tenant', {
    skip: !enabled
}, async () => {
    const config=loadDatabaseConfig(process.env,'TEST_DB_');
    assertTeamDisposableDatabaseName(config.database);
    Object.assign(process.env,{
        DB_HOST:config.host,DB_PORT:String(config.port),DB_USER:config.user,
        DB_PASSWORD:config.password,DB_DATABASE:config.database,
        JWT_SECRET:randomBytes(32).toString('hex'),MAIL_PROVIDER:'disabled',
        APP_PUBLIC_ORIGIN:'http://127.0.0.1:5500'
    });
    const setup=await mysql.createConnection({...config,multipleStatements:true});
    let pool;
    try {
        await resetTestSchema(setup,config.database);
        await runMigrations({connection:setup,migrationsDir,logger:{info(){}}});
        const passwordHash=await bcrypt.hash(randomBytes(32).toString('hex'),4);
        await setup.query(`INSERT INTO clinicas (nome,slug,status) VALUES
            ('Clínica A','convites-a','ativa'),('Clínica B','convites-b','ativa')`);
        const [clinicRows]=await setup.query("SELECT id, slug FROM clinicas WHERE slug IN ('convites-a','convites-b')");
        const clinicA=Number(clinicRows.find(({slug})=>slug==='convites-a').id);
        const clinicB=Number(clinicRows.find(({slug})=>slug==='convites-b').id);
        await setup.query(`INSERT INTO usuarios (nome,email,senha_hash,status,motivo_bloqueio) VALUES
            ('Admin A','admin.a@example.test',?,'ativo','nenhum'),
            ('Admin B','admin.b@example.test',?,'ativo','nenhum'),
            ('Profissional A','prof.a@example.test',?,'bloqueado','ativacao_pendente')`,
        [passwordHash,passwordHash,passwordHash]);
        const [userRows]=await setup.query("SELECT id, email FROM usuarios WHERE email IN ('admin.a@example.test','admin.b@example.test','prof.a@example.test')");
        const userId=(email)=>Number(userRows.find((row)=>row.email===email).id);
        const adminA=userId('admin.a@example.test');
        const adminB=userId('admin.b@example.test');
        const professional=userId('prof.a@example.test');
        await setup.query(`INSERT INTO clinica_usuarios (clinica_id,usuario_id,papel,status) VALUES
            (?,?,'administrador','ativo'),(?,?,'administrador','ativo'),
            (?,?,'profissional','convite_pendente')`,[clinicA,adminA,clinicB,adminB,clinicA,professional]);
        const [[link]]=await setup.query('SELECT id FROM clinica_usuarios WHERE clinica_id=? AND usuario_id=?',[clinicA,professional]);
        await setup.query(`INSERT INTO profissionais
            (clinica_id,usuario_id,nome_exibicao,tipo_profissional,status)
            VALUES (?,?,'Profissional A','outro','ativo')`,[clinicA,professional]);
        const token=randomBytes(32).toString('base64url');
        const hash=createHash('sha256').update(token).digest('hex');
        const [invite]=await setup.query(`INSERT INTO convites_clinica
            (clinica_id,clinica_usuario_id,email_normalizado,papel,token_hash,expira_em,criado_por_usuario_id)
            VALUES (?,?,'prof.a@example.test','profissional',?,DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 1 HOUR),?)`,
        [clinicA,link.id,hash,adminA]);

        pool=require('../config/database');
        const controller=require('../controllers/equipeController');
        const first=response(); const second=response();
        await Promise.all([
            controller.acceptInvitation({params:{token},body:{senha:'senha-concorrente-123'}},first),
            controller.acceptInvitation({params:{token},body:{senha:'senha-concorrente-123'}},second)
        ]);
        assert.deepEqual([first.statusCode,second.statusCode].sort(),[200,410]);
        const [[accepted]]=await setup.query("SELECT COUNT(*) AS total FROM convites_clinica WHERE id=? AND status='aceito'",[invite.insertId]);
        assert.equal(Number(accepted.total),1);

        const crossTenant=response();
        await controller.revoke({
            params:{id:String(invite.insertId)},tenant:{clinicId:clinicB,role:'administrador'},
            auth:{membershipVersion:1},userId:adminB
        },crossTenant);
        assert.equal(crossTenant.statusCode,404);
    } finally {
        if (pool) await pool.end();
        await setup.end();
    }
});
