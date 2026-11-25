const TEST_DATABASE_PATTERN = /^vitalis_profissionais(?:_[a-z0-9_]+)?_test$/;
const SPECIALTY_TEST_DATABASE_PATTERN = /^vitalis_especialidades(?:_[a-z0-9_]+)?_test$/;
const TEAM_TEST_DATABASE_PATTERN = /^vitalis_convites(?:_[a-z0-9_]+)?_test$/;
const PROVISIONING_TEST_DATABASE_PATTERN = /^vitalis_provisionamento(?:_[a-z0-9_]+)?_test$/;
const AVAILABILITY_TEST_DATABASE_PATTERN = /^vitalis_disponibilidade(?:_[a-z0-9_]+)?_test$/;
const PATIENT_TEST_DATABASE_PATTERN = /^vitalis_pacientes(?:_[a-z0-9_]+)?_test$/;
const APPOINTMENT_TEST_DATABASE_PATTERN = /^vitalis_agendamento(?:_[a-z0-9_]+)?_test$/;
const PRACTICE_TEST_DATABASE_PATTERN = /^vitalis_consultorios(?:_[a-z0-9_]+)?_test$/;

function assertDisposableDatabaseName(databaseName) {
    if (!TEST_DATABASE_PATTERN.test(databaseName)) {
        throw new Error(
            'Operação recusada: TEST_DB_DATABASE deve começar com vitalis_profissionais e terminar com _test.'
        );
    }
    return databaseName;
}

function assertSpecialtyDisposableDatabaseName(databaseName) {
    if (!SPECIALTY_TEST_DATABASE_PATTERN.test(databaseName)) {
        throw new Error(
            'Operação recusada: TEST_DB_DATABASE deve começar com vitalis_especialidades e terminar com _test.'
        );
    }
    return databaseName;
}

function assertTeamDisposableDatabaseName(databaseName) {
    if (!TEAM_TEST_DATABASE_PATTERN.test(databaseName)) {
        throw new Error(
            'Operação recusada: TEST_DB_DATABASE deve começar com vitalis_convites e terminar com _test.'
        );
    }
    return databaseName;
}

function assertProvisioningDisposableDatabaseName(databaseName) {
    if (!PROVISIONING_TEST_DATABASE_PATTERN.test(databaseName)) {
        throw new Error(
            'Operação recusada: TEST_DB_DATABASE deve começar com vitalis_provisionamento e terminar com _test.'
        );
    }
    return databaseName;
}

function assertAvailabilityDisposableDatabaseName(databaseName) {
    if (!AVAILABILITY_TEST_DATABASE_PATTERN.test(databaseName)) {
        throw new Error(
            'Operação recusada: TEST_DB_DATABASE deve começar com vitalis_disponibilidade e terminar com _test.'
        );
    }
    return databaseName;
}

async function confirmAvailabilityTestEnvironment(connection, databaseName) {
    assertAvailabilityDisposableDatabaseName(databaseName);
    const [[selected]] = await connection.query('SELECT DATABASE() AS database_name');
    if (selected?.database_name !== databaseName) {
        throw new Error('Conexão não aponta para o banco descartável autorizado.');
    }
    const [[server]] = await connection.query('SELECT VERSION() AS version');
    if (!/^8\./.test(server?.version || '')) {
        throw new Error('A integração de disponibilidade exige MySQL 8.');
    }
    return { database: selected.database_name, version: server.version };
}

function assertPatientDisposableDatabaseName(databaseName) {
    if (!PATIENT_TEST_DATABASE_PATTERN.test(databaseName)) {
        throw new Error(
            'Operação recusada: TEST_DB_DATABASE deve começar com vitalis_pacientes e terminar com _test.'
        );
    }
    return databaseName;
}

async function confirmPatientTestEnvironment(connection, databaseName) {
    assertPatientDisposableDatabaseName(databaseName);
    const [[selected]] = await connection.query('SELECT DATABASE() AS database_name');
    if (selected?.database_name !== databaseName) {
        throw new Error('Conexão não aponta para o banco descartável autorizado.');
    }
    const [[server]] = await connection.query('SELECT VERSION() AS version');
    if (!/^8\./.test(server?.version || '')) {
        throw new Error('A integração de pacientes exige MySQL 8.');
    }
    return { database: selected.database_name, version: server.version };
}

function assertAppointmentDisposableDatabaseName(databaseName) {
    if (!APPOINTMENT_TEST_DATABASE_PATTERN.test(databaseName)) {
        throw new Error(
            'Operação recusada: TEST_DB_DATABASE deve começar com vitalis_agendamento e terminar com _test.'
        );
    }
    return databaseName;
}

async function confirmAppointmentTestEnvironment(connection, databaseName) {
    assertAppointmentDisposableDatabaseName(databaseName);
    const [[selected]] = await connection.query('SELECT DATABASE() AS database_name');
    if (selected?.database_name !== databaseName) {
        throw new Error('Conexão não aponta para o banco descartável autorizado.');
    }
    const [[server]] = await connection.query('SELECT VERSION() AS version');
    if (!/^8\./.test(server?.version || '')) {
        throw new Error('A integração de agendamento exige MySQL 8.');
    }
    return { database: selected.database_name, version: server.version };
}

function assertPracticeDisposableDatabaseName(databaseName) {
    if (!PRACTICE_TEST_DATABASE_PATTERN.test(databaseName)) {
        throw new Error(
            'Operação recusada: TEST_DB_DATABASE deve começar com vitalis_consultorios e terminar com _test.'
        );
    }
    return databaseName;
}

async function confirmPracticeTestEnvironment(connection, databaseName) {
    assertPracticeDisposableDatabaseName(databaseName);
    const [[selected]] = await connection.query('SELECT DATABASE() AS database_name');
    if (selected?.database_name !== databaseName) {
        throw new Error('Conexão não aponta para o banco descartável autorizado.');
    }
    const [[server]] = await connection.query('SELECT VERSION() AS version');
    if (!/^8\./.test(server?.version || '')) {
        throw new Error('A integração de consultórios exige MySQL 8.');
    }
    return { database: selected.database_name, version: server.version };
}

module.exports = {
    assertDisposableDatabaseName,
    assertSpecialtyDisposableDatabaseName,
    assertTeamDisposableDatabaseName,
    assertProvisioningDisposableDatabaseName,
    assertAvailabilityDisposableDatabaseName,
    confirmAvailabilityTestEnvironment,
    assertPatientDisposableDatabaseName,
    confirmPatientTestEnvironment,
    assertAppointmentDisposableDatabaseName,
    confirmAppointmentTestEnvironment,
    assertPracticeDisposableDatabaseName,
    confirmPracticeTestEnvironment,
    TEST_DATABASE_PATTERN,
    SPECIALTY_TEST_DATABASE_PATTERN,
    TEAM_TEST_DATABASE_PATTERN,
    PROVISIONING_TEST_DATABASE_PATTERN,
    AVAILABILITY_TEST_DATABASE_PATTERN,
    PATIENT_TEST_DATABASE_PATTERN,
    APPOINTMENT_TEST_DATABASE_PATTERN,
    PRACTICE_TEST_DATABASE_PATTERN
};
