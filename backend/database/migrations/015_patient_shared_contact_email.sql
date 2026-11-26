ALTER TABLE pacientes
    DROP INDEX uk_pacientes_email,
    ADD KEY idx_pacientes_email (clinica_id, email);
