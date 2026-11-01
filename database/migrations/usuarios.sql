-- =============================================================================
-- BioMant / Clínica de los Ríos
-- Módulo de autenticación: tabla `usuarios` y cuentas iniciales
-- Base de datos: biomant  |  Ejecutar en phpMyAdmin > pestaña SQL
-- =============================================================================

SET NAMES utf8mb4;
USE biomant;

-- Si ya tenías una tabla `usuarios` con otra estructura, descomenta la
-- siguiente línea para recrearla (borra los usuarios existentes):
-- DROP TABLE IF EXISTS usuarios;

CREATE TABLE IF NOT EXISTS usuarios (
    id_usuario INT UNSIGNED NOT NULL AUTO_INCREMENT,
    nombre     VARCHAR(100)  NOT NULL,
    correo     VARCHAR(150)  NOT NULL,
    password   VARCHAR(255)  NOT NULL COMMENT 'Hash bcrypt. Nunca texto plano.',
    rol        ENUM('Administrador', 'Tecnico') NOT NULL DEFAULT 'Tecnico',
    creado_en  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id_usuario),
    UNIQUE KEY uq_usuarios_correo (correo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cuentas iniciales (INSERT IGNORE: si el correo ya existe, no lo duplica).
--   Didier (Administrador)  ->  didier@biomant.com      /  Biomant2026*
--   Diego Soto (Técnico)    ->  diego.soto@biomant.com  /  Tecnico2026*
-- Cambia estas contraseñas apenas ingreses por primera vez.
INSERT IGNORE INTO usuarios (nombre, correo, password, rol) VALUES
('Didier', 'didier@biomant.com',
 '$2b$10$LWVDFi52b3PvvpM4uXbnleZpLd14z1cv6zl7UpvykKbXEnT1aj8Na', 'Administrador'),
('Diego Soto', 'diego.soto@biomant.com',
 '$2b$10$Tlt/JB7SHTXBAvw0taroUOBfGEwTqtL7lAs5VIp0j0LGheU3W6RlC', 'Tecnico');

-- Para generar el hash de otra contraseña (desde la carpeta del proyecto):
--   node -e "console.log(require('bcryptjs').hashSync('TuNuevaClave', 10))"