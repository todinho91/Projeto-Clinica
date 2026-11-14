CREATE TABLE IF NOT EXISTS convites_clinica (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    clinica_id BIGINT UNSIGNED NOT NULL,
    clinica_usuario_id BIGINT UNSIGNED NOT NULL,
    email_normalizado VARCHAR(254) NOT NULL,
    papel ENUM('administrador', 'secretaria', 'profissional', 'paciente') NOT NULL,
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status ENUM('pendente', 'aceito', 'revogado') NOT NULL DEFAULT 'pendente',
    expira_em DATETIME(6) NOT NULL,
    aceito_em DATETIME(6) NULL,
    revogado_em DATETIME(6) NULL,
    criado_por_usuario_id BIGINT UNSIGNED NOT NULL,
    criado_em DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_convites_token_hash (token_hash),
    KEY ix_convites_clinica_status (clinica_id, status, expira_em),
    KEY ix_convites_vinculo (clinica_id, clinica_usuario_id, status),
    CONSTRAINT fk_convites_vinculo
        FOREIGN KEY (clinica_id, clinica_usuario_id)
        REFERENCES clinica_usuarios (clinica_id, id),
    CONSTRAINT fk_convites_criador
        FOREIGN KEY (clinica_id, criado_por_usuario_id)
        REFERENCES clinica_usuarios (clinica_id, usuario_id)
) ENGINE=InnoDB;
