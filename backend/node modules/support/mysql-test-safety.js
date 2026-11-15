const TEST_DATABASE_PATTERN = /^vitalis_profissionais(?:_[a-z0-9_]+)?_test$/;
const SPECIALTY_TEST_DATABASE_PATTERN = /^vitalis_especialidades(?:_[a-z0-9_]+)?_test$/;
const TEAM_TEST_DATABASE_PATTERN = /^vitalis_convites(?:_[a-z0-9_]+)?_test$/;
const PROVISIONING_TEST_DATABASE_PATTERN = /^vitalis_provisionamento(?:_[a-z0-9_]+)?_test$/;
const AVAILABILITY_TEST_DATABASE_PATTERN = /^vitalis_disponibilidade(?:_[a-z0-9_]+)?_test$/;

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

module.exports = {
    assertDisposableDatabaseName,
    assertSpecialtyDisposableDatabaseName,
    assertTeamDisposableDatabaseName,
    assertProvisioningDisposableDatabaseName,
    assertAvailabilityDisposableDatabaseName,
    TEST_DATABASE_PATTERN,
    SPECIALTY_TEST_DATABASE_PATTERN,
    TEAM_TEST_DATABASE_PATTERN,
    PROVISIONING_TEST_DATABASE_PATTERN,
    AVAILABILITY_TEST_DATABASE_PATTERN
};
