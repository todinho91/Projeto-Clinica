ALTER TABLE profissionais
    ADD COLUMN tipo_profissional VARCHAR(80) NOT NULL DEFAULT 'Profissional de saúde'
    AFTER nome_exibicao;
