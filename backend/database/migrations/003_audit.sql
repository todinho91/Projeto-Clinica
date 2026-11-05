CREATE TABLE IF NOT EXISTS auditoria (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    clinica_id BIGINT UNSIGNED NOT NULL,
    usuario_id BIGINT UNSIGNED NULL,
    acao VARCHAR(100) NOT NULL,
    entidade_tipo VARCHAR(100) NOT NULL,
    entidade_id BIGINT UNSIGNED NULL,
    request_id VARCHAR(100) NULL,
    metadados JSON NULL,
    criado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uk_auditoria_request (clinica_id, request_id),
    KEY idx_auditoria_entidade (clinica_id, entidade_tipo, entidade_id),
    KEY idx_auditoria_usuario_data (clinica_id, usuario_id, criado_em),
    CONSTRAINT fk_auditoria_clinica
        FOREIGN KEY (clinica_id) REFERENCES clinicas (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_auditoria_vinculo
        FOREIGN KEY (clinica_id, usuario_id)
        REFERENCES clinica_usuarios (clinica_id, usuario_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
