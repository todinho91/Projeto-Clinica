ALTER TABLE usuarios
    ADD COLUMN motivo_bloqueio ENUM('nenhum', 'ativacao_pendente', 'seguranca')
        NOT NULL DEFAULT 'nenhum' AFTER status;

ALTER TABLE clinica_usuarios
    ADD COLUMN sessao_versao INT UNSIGNED NOT NULL DEFAULT 1 AFTER status;

-- Compatibilidade com os profissionais pré-cadastrados pela migration 004/PR #50.
-- Somente evidência completa de pré-cadastro permite classificar o bloqueio como
-- ativação pendente; os demais bloqueios existentes permanecem administrativos.
UPDATE usuarios u
SET u.motivo_bloqueio = CASE
    WHEN u.status = 'bloqueado' AND EXISTS (
        SELECT 1
        FROM clinica_usuarios cu
        JOIN profissionais p
          ON p.clinica_id = cu.clinica_id AND p.usuario_id = cu.usuario_id
        JOIN auditoria a
          ON a.clinica_id = p.clinica_id
         AND a.entidade_tipo = 'profissional'
         AND a.entidade_id = p.id
         AND a.acao = 'profissional_pre_cadastrado'
        WHERE cu.usuario_id = u.id
          AND cu.papel = 'profissional'
          AND cu.status = 'convite_pendente'
    ) THEN 'ativacao_pendente'
    WHEN u.status = 'bloqueado' THEN 'seguranca'
    ELSE 'nenhum'
END;

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
    envio_status ENUM(
        'not_requested', 'not_configured', 'accepted_by_provider', 'delivered', 'failed'
    ) NOT NULL DEFAULT 'not_requested',
    provedor_mensagem_id VARCHAR(200) NULL,
    envio_atualizado_em DATETIME(6) NULL,
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
