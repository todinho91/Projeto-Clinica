CREATE TABLE IF NOT EXISTS operadores_plataforma (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    usuario_id BIGINT UNSIGNED NOT NULL,
    status ENUM('ativo', 'inativo') NOT NULL DEFAULT 'ativo',
    criado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    atualizado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uk_operadores_plataforma_usuario (usuario_id),
    CONSTRAINT fk_operadores_plataforma_usuario
        FOREIGN KEY (usuario_id) REFERENCES usuarios (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS auditoria_plataforma (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    operador_plataforma_id BIGINT UNSIGNED NOT NULL,
    clinica_id BIGINT UNSIGNED NULL,
    acao VARCHAR(100) NOT NULL,
    entidade_tipo VARCHAR(100) NOT NULL,
    entidade_id BIGINT UNSIGNED NULL,
    metadados JSON NULL,
    criado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    KEY idx_auditoria_plataforma_operador (operador_plataforma_id, criado_em),
    KEY idx_auditoria_plataforma_clinica (clinica_id, criado_em),
    CONSTRAINT fk_auditoria_plataforma_operador
        FOREIGN KEY (operador_plataforma_id) REFERENCES operadores_plataforma (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_auditoria_plataforma_clinica
        FOREIGN KEY (clinica_id) REFERENCES clinicas (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE convites_clinica
    MODIFY COLUMN criado_por_usuario_id BIGINT UNSIGNED NULL,
    ADD COLUMN criado_por_operador_id BIGINT UNSIGNED NULL AFTER criado_por_usuario_id,
    ADD KEY ix_convites_operador (criado_por_operador_id, criado_em),
    ADD CONSTRAINT fk_convites_operador
        FOREIGN KEY (criado_por_operador_id) REFERENCES operadores_plataforma (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    ADD CONSTRAINT chk_convites_criador
        CHECK ((criado_por_usuario_id IS NOT NULL) <> (criado_por_operador_id IS NOT NULL));
