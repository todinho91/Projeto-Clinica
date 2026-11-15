ALTER TABLE pacientes
    ADD UNIQUE KEY uk_pacientes_email (clinica_id, email),
    ADD KEY idx_pacientes_status_nome (clinica_id, status, nome),
    ADD KEY idx_pacientes_nascimento_nome (clinica_id, data_nascimento, nome);
