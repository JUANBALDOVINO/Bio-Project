# BioMant

Aplicación web de gestión de inventario clínico y mantenimiento.

## Estructura

- `src/server/`: servidor Express y acceso a Supabase/PostgreSQL.
- `public/`: interfaz web y pantalla de inicio de sesión.
- `database/migrations/`: esquemas y migraciones SQL.
- `database/seeds/`: datos SQL de ejemplo o carga inicial.
- `scripts/`: utilidades de migración y generación de inventario.
- `docs/`: guías de configuración.
- `assets/previews/`: capturas de referencia de la interfaz.
- `uploads/`: archivos locales existentes servidos por la aplicación.
- `.env`: configuración privada local; permanece en la raíz y no se incluye en el repositorio.

## Comandos

Ejecuta desde la raíz del proyecto:

- `npm start`: iniciar BioMant en `http://localhost:3000`.
- `npm run migrate:supabase`: copiar datos de MySQL a Supabase/PostgreSQL.
- `npm run generar:inventario`: regenerar el SQL de inventario en `database/seeds/`.
- `scripts/backup_supabase.ps1`: crear un respaldo lógico cifrado de Supabase y verificar la recuperación en tablas temporales con una transacción revertida.

Los respaldos se guardan en `backups/`, excluida de Git. El cifrado AES usa una clave protegida por Windows DPAPI; solo la misma cuenta de Windows puede recuperar la clave local.

No abras ni compartas el contenido de `.env`; contiene credenciales del proyecto.
