ALTER TABLE consultas
    ADD UNIQUE KEY uk_consultas_prontuario (clinica_id, id, paciente_id, profissional_id);

CREATE TABLE IF NOT EXISTS prontuario_registros (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    clinica_id BIGINT UNSIGNED NOT NULL,
    paciente_id BIGINT UNSIGNED NOT NULL,
    consulta_id BIGINT UNSIGNED NOT NULL,
    profissional_id BIGINT UNSIGNED NOT NULL,
    autor_usuario_id BIGINT UNSIGNED NOT NULL,
    estado ENUM('rascunho', 'finalizado', 'descartado') NOT NULL DEFAULT 'rascunho',
    versao_atual INT UNSIGNED NOT NULL,
    atendimento_inicio_em DATETIME(6) NOT NULL,
    criado_em DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_prontuario_consulta (clinica_id, consulta_id),
    UNIQUE KEY uk_prontuario_autor (clinica_id, id, autor_usuario_id),
    KEY idx_prontuario_paciente (clinica_id, paciente_id, profissional_id, criado_em, id),
    CONSTRAINT chk_prontuario_versao CHECK (versao_atual >= 1),
    CONSTRAINT fk_prontuario_consulta
        FOREIGN KEY (clinica_id, consulta_id, paciente_id, profissional_id)
        REFERENCES consultas (clinica_id, id, paciente_id, profissional_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_prontuario_autor
        FOREIGN KEY (clinica_id, autor_usuario_id)
        REFERENCES clinica_usuarios (clinica_id, usuario_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS prontuario_versoes (
    clinica_id BIGINT UNSIGNED NOT NULL,
    registro_id BIGINT UNSIGNED NOT NULL,
    versao INT UNSIGNED NOT NULL,
    versao_anterior INT UNSIGNED NULL,
    tipo ENUM('rascunho', 'finalizacao', 'adendo', 'descarte') NOT NULL,
    autor_usuario_id BIGINT UNSIGNED NOT NULL,
    autor_snapshot JSON NOT NULL,
    schema_version SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    conteudo JSON NOT NULL,
    criado_em DATETIME(6) NOT NULL,
    PRIMARY KEY (clinica_id, registro_id, versao),
    CONSTRAINT chk_prontuario_sequencia CHECK (
        (versao = 1 AND versao_anterior IS NULL AND tipo = 'rascunho')
        OR (versao > 1 AND versao_anterior IS NOT NULL AND versao_anterior = versao - 1)
    ),
    CONSTRAINT fk_prontuario_versao_registro
        FOREIGN KEY (clinica_id, registro_id, autor_usuario_id)
        REFERENCES prontuario_registros (clinica_id, id, autor_usuario_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_prontuario_versao_anterior
        FOREIGN KEY (clinica_id, registro_id, versao_anterior)
        REFERENCES prontuario_versoes (clinica_id, registro_id, versao)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
