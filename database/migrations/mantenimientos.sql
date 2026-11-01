-- =============================================================================
-- BioMant / Clínica de los Ríos
-- Módulo de mantenimientos: tabla `mantenimientos` + migración del historial
-- Base de datos: biomant  |  Ejecutar en phpMyAdmin > pestaña SQL
-- Requiere que ya existan las tablas `equipos` y `usuarios`.
-- =============================================================================

SET NAMES utf8mb4;
USE biomant;

-- Un registro por intervención (un equipo puede tener muchos).
-- Si phpMyAdmin marca error 1005/1215 en alguna FOREIGN KEY (por ejemplo, si
-- `equipos` no es InnoDB), borra esa línea: la API ya valida que el equipo exista.
CREATE TABLE IF NOT EXISTS mantenimientos (
    id_mantenimiento INT UNSIGNED NOT NULL AUTO_INCREMENT,
    id_equipo        VARCHAR(30)  NOT NULL,
    tipo             ENUM('Preventivo', 'Correctivo') NOT NULL,
    fecha            DATE         NOT NULL,
    detalle          TEXT         NOT NULL,
    id_usuario       INT UNSIGNED NULL COMMENT 'Quién lo registró (NULL = migrado del inventario)',
    creado_en        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id_mantenimiento),
    KEY idx_mant_equipo (id_equipo),
    KEY idx_mant_fecha (fecha),
    CONSTRAINT fk_mant_equipo  FOREIGN KEY (id_equipo)  REFERENCES equipos (id_equipo)   ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_mant_usuario FOREIGN KEY (id_usuario) REFERENCES usuarios (id_usuario) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Migra el último preventivo y correctivo que ya tenías en `equipos`.
-- Se puede ejecutar más de una vez: NOT EXISTS evita duplicar lo ya migrado.
INSERT INTO mantenimientos (id_equipo, tipo, fecha, detalle)
SELECT e.id_equipo, 'Preventivo', e.fecha_mto_preventivo, e.hist_mto_preventivo
FROM equipos e
WHERE e.fecha_mto_preventivo IS NOT NULL
  AND e.hist_mto_preventivo IS NOT NULL AND e.hist_mto_preventivo <> ''
  AND NOT EXISTS (SELECT 1 FROM mantenimientos m
                  WHERE m.id_equipo = e.id_equipo AND m.tipo = 'Preventivo' AND m.fecha = e.fecha_mto_preventivo);

INSERT INTO mantenimientos (id_equipo, tipo, fecha, detalle)
SELECT e.id_equipo, 'Correctivo', e.fecha_mto_correctivo, e.hist_mto_correctivo
FROM equipos e
WHERE e.fecha_mto_correctivo IS NOT NULL
  AND e.hist_mto_correctivo IS NOT NULL AND e.hist_mto_correctivo <> ''
  AND e.hist_mto_correctivo NOT LIKE 'Sin intervenciones%'
  AND NOT EXISTS (SELECT 1 FROM mantenimientos m
                  WHERE m.id_equipo = e.id_equipo AND m.tipo = 'Correctivo' AND m.fecha = e.fecha_mto_correctivo);

-- Unifica el texto del estado ("En Mantenimiento" -> "En mantenimiento")
UPDATE equipos SET estado = 'En mantenimiento' WHERE LOWER(estado) = 'en mantenimiento' AND estado <> 'En mantenimiento';