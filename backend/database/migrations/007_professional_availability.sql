CREATE TABLE IF NOT EXISTS disponibilidades_profissional (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    clinica_id BIGINT UNSIGNED NOT NULL,
    profissional_id BIGINT UNSIGNED NOT NULL,
    dia_semana TINYINT UNSIGNED NOT NULL,
    tipo ENUM('atendimento', 'descanso') NOT NULL,
    inicio_local TIME NOT NULL,
    fim_local TIME NOT NULL,
    status ENUM('ativo', 'inativo') NOT NULL DEFAULT 'ativo',
    criado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    atualizado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uk_disponibilidade_tenant_id (clinica_id, id),
    UNIQUE KEY uk_disponibilidade_intervalo (
        clinica_id, profissional_id, dia_semana, tipo, inicio_local, fim_local
    ),
    KEY idx_disponibilidade_grade (
        clinica_id, profissional_id, status, dia_semana, inicio_local, fim_local
    ),
    CONSTRAINT chk_disponibilidade_dia CHECK (dia_semana BETWEEN 0 AND 6),
    CONSTRAINT chk_disponibilidade_periodo CHECK (fim_local > inicio_local),
    CONSTRAINT fk_disponibilidade_profissional
        FOREIGN KEY (clinica_id, profissional_id)
        REFERENCES profissionais (clinica_id, id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS bloqueios_profissional (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    clinica_id BIGINT UNSIGNED NOT NULL,
    profissional_id BIGINT UNSIGNED NOT NULL,
    tipo ENUM('ferias', 'feriado', 'indisponibilidade') NOT NULL,
    inicio_em DATETIME(6) NOT NULL,
    fim_em DATETIME(6) NOT NULL,
    motivo VARCHAR(240) NULL,
    status ENUM('ativo', 'cancelado') NOT NULL DEFAULT 'ativo',
    criado_por_usuario_id BIGINT UNSIGNED NOT NULL,
    cancelado_por_usuario_id BIGINT UNSIGNED NULL,
    criado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    cancelado_em TIMESTAMP(6) NULL,
    atualizado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uk_bloqueio_tenant_id (clinica_id, id),
    KEY idx_bloqueio_periodo (
        clinica_id, profissional_id, status, inicio_em, fim_em
    ),
    CONSTRAINT chk_bloqueio_periodo CHECK (fim_em > inicio_em),
    CONSTRAINT fk_bloqueio_profissional
        FOREIGN KEY (clinica_id, profissional_id)
        REFERENCES profissionais (clinica_id, id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_bloqueio_criador
        FOREIGN KEY (clinica_id, criado_por_usuario_id)
        REFERENCES clinica_usuarios (clinica_id, usuario_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_bloqueio_cancelador
        FOREIGN KEY (clinica_id, cancelado_por_usuario_id)
        REFERENCES clinica_usuarios (clinica_id, usuario_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
