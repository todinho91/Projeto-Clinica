const TEST_DATABASE_PATTERN = /^vitalis_profissionais(?:_[a-z0-9_]+)?_test$/;

function assertDisposableDatabaseName(databaseName) {
    if (!TEST_DATABASE_PATTERN.test(databaseName)) {
        throw new Error(
            'Operação recusada: TEST_DB_DATABASE deve começar com vitalis_profissionais e terminar com _test.'
        );
    }
    return databaseName;
}

module.exports = { assertDisposableDatabaseName, TEST_DATABASE_PATTERN };
