-- Deliberately reject any existing plaintext versions. No backfill or deletion.
ALTER TABLE prontuario_versoes
    MODIFY autor_snapshot JSON NULL,
    MODIFY conteudo JSON NULL,
    ADD CONSTRAINT chk_prontuario_sem_texto_puro CHECK (autor_snapshot IS NULL AND conteudo IS NULL);

ALTER TABLE profissionais
    ADD UNIQUE KEY uk_profissionais_prontuario_autor (clinica_id, id, usuario_id);

ALTER TABLE prontuario_registros
    ADD CONSTRAINT fk_prontuario_profissional_autor
    FOREIGN KEY (clinica_id, profissional_id, autor_usuario_id)
    REFERENCES profissionais (clinica_id, id, usuario_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS prontuario_chaves (
    clinica_id BIGINT UNSIGNED NOT NULL,
    chave_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    ativa TINYINT UNSIGNED NULL,
    dek_protegida VARBINARY(32) NOT NULL,
    wrap_iv BINARY(12) NOT NULL,
    wrap_tag BINARY(16) NOT NULL,
    formato SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    criado_em DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (clinica_id, chave_id),
    UNIQUE KEY uk_prontuario_chave_ativa (clinica_id, ativa),
    UNIQUE KEY uk_prontuario_wrap_iv (wrap_iv),
    CONSTRAINT chk_prontuario_chave_ativa CHECK (ativa IS NULL OR ativa = 1),
    CONSTRAINT fk_prontuario_chave_tenant FOREIGN KEY (clinica_id)
        REFERENCES clinicas (id) ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS prontuario_envelopes (
    clinica_id BIGINT UNSIGNED NOT NULL,
    registro_id BIGINT UNSIGNED NOT NULL,
    versao INT UNSIGNED NOT NULL,
    chave_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    conteudo_cifrado MEDIUMBLOB NOT NULL,
    iv BINARY(12) NOT NULL,
    auth_tag BINARY(16) NOT NULL,
    aad_version SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    PRIMARY KEY (clinica_id, registro_id, versao),
    UNIQUE KEY uk_prontuario_nonce (clinica_id, chave_id, iv),
    CONSTRAINT fk_prontuario_envelope_versao FOREIGN KEY (clinica_id, registro_id, versao)
        REFERENCES prontuario_versoes (clinica_id, registro_id, versao)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_prontuario_envelope_chave FOREIGN KEY (clinica_id, chave_id)
        REFERENCES prontuario_chaves (clinica_id, chave_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS prontuario_negativas (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    codigo ENUM('RECORD_FORBIDDEN','RECORD_NOT_FOUND','RECORD_INTEGRITY') NOT NULL,
    criado_em DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
