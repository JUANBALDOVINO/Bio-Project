-- BioMant: fecha del próximo mantenimiento preventivo para alertas.
-- Las fechas existentes quedan NULL hasta que un Administrador las programe.
USE biomant;

ALTER TABLE equipos
    ADD COLUMN IF NOT EXISTS proximo_mto_preventivo DATE NULL
    COMMENT 'Fecha programada del próximo mantenimiento preventivo';

ALTER TABLE equipos
    ADD COLUMN IF NOT EXISTS foto_equipo VARCHAR(255) NULL
    COMMENT 'Ruta pública de la fotografía del equipo';

CREATE TABLE IF NOT EXISTS notificaciones_mantenimiento (
    id_notificacion BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    id_equipo VARCHAR(30) NOT NULL,
    fecha_programada DATE NOT NULL,
    estado_alerta ENUM('proximo', 'vencido') NOT NULL,
    enviado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id_notificacion),
    UNIQUE KEY uq_alerta_equipo_fecha_estado (id_equipo, fecha_programada, estado_alerta),
    CONSTRAINT fk_alerta_equipo FOREIGN KEY (id_equipo) REFERENCES equipos (id_equipo) ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

-- Seguimiento individual: cada dirección recibe cada alerta una sola vez,
-- incluso cuando varios usuarios comparten los avisos del mismo equipo.
CREATE TABLE IF NOT EXISTS notificaciones_mantenimiento_destinatarios (
    id_envio BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    id_equipo VARCHAR(30) NOT NULL,
    fecha_programada DATE NOT NULL,
    estado_alerta ENUM('proximo', 'vencido') NOT NULL,
    correo_destinatario VARCHAR(254) NOT NULL,
    enviado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id_envio),
    UNIQUE KEY uq_alerta_equipo_destinatario (id_equipo, fecha_programada, estado_alerta, correo_destinatario),
    KEY idx_alerta_destinatario_correo (correo_destinatario),
    CONSTRAINT fk_alerta_destinatario_equipo FOREIGN KEY (id_equipo) REFERENCES equipos (id_equipo) ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;
