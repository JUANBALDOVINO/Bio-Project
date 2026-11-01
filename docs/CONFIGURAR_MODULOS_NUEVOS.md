# Configuración de importación, fotos, QR y alertas por correo

## Base de datos

Ejecuta `database/migrations/alertas_analitica.sql` en la base `biomant`. Si ya lo habías ejecutado, ejecútalo nuevamente para crear la tabla de seguimiento por destinatario; las instrucciones `IF NOT EXISTS` conservan las tablas y columnas existentes.

Las migraciones y scripts se guardan en `database/migrations/`. Para iniciar el servidor desde la raíz del proyecto usa `npm start`; para migrar datos ejecuta `npm run migrate:supabase`.

## Importar inventario

La importación está disponible para Administradores desde **Importar Inventario**. Acepta `.xlsx` y PDF con texto seleccionable. El Excel toma la primera hoja y la fila 1 como encabezados. Columnas requeridas:

`id_equipo, nombre_equipo, marca, modelo, numero_serie, nivel_riesgo, ubicacion, estado, tipo_categoria`

Columnas opcionales: `proximo_mto_preventivo` (formato `AAAA-MM-DD`) y `foto_equipo`. Estados permitidos: `Operativo`, `En mantenimiento`, `Fuera de servicio`. Categorías: `Biomédico`, `Tecnología`. Riesgos aceptados: `I`/`Bajo`, `IIA`/`Moderado`/`Medio`, `IIB`/`Alto`, `III`/`Muy Alto`. Los alias se guardan con el código normalizado (por ejemplo, `Alto` como `IIB`). IDs ya existentes se omiten; las filas inválidas se reportan al final indicando el campo. Se admiten hasta 5.000 filas y archivos de 15 MB.

Para importar un PDF, debe contener una tabla de texto con una fila de encabezados y celdas separadas por `|`, punto y coma, tabuladores o espacios múltiples. El sistema no aplica OCR a PDF escaneados.

## Fotos y códigos QR

Las fotos nuevas se guardan en el bucket privado `biomant-equipo-fotos` de Supabase Storage. La aplicación crea el bucket al subir la primera imagen; limita las cargas a JPEG, PNG o WebP de hasta 5 MB y exige el rol Administrador. La tabla `equipos` guarda solo la ruta del objeto. BioMant genera una URL firmada temporal para mostrar la imagen.

Añade al `.env` del servidor la URL del proyecto y una clave secreta de servidor (`sb_secret_...`):

```env
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SECRET_KEY=<clave-secreta-de-servidor>
SUPABASE_STORAGE_BUCKET=biomant-equipo-fotos
```

La clave secreta tiene acceso elevado: consérvala únicamente en el `.env` del servidor, nunca en `public/index.html` ni en código que se envíe al navegador. Los proyectos que aún usan la clave JWT legacy `service_role` pueden definir `SUPABASE_SERVICE_ROLE_KEY` en lugar de `SUPABASE_SECRET_KEY`. Reinicia BioMant después de configurar las variables. Para que un QR abra la ficha desde otros dispositivos, configura `APP_PUBLIC_URL` con la dirección HTTP(S) accesible desde esos equipos, por ejemplo la URL de la intranet. El QR abre BioMant y presenta el detalle del equipo después del inicio de sesión.

## Notificaciones por correo

Configura estas variables en `.env` y reinicia el servidor:

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=usuario
SMTP_PASS=contraseña
MAIL_FROM=BioMant <biomant@example.com>
MAINTENANCE_ALERT_CRON=0 8 * * *
APP_TIMEZONE=America/Bogota
APP_PUBLIC_URL=http://servidor-biomant:3000
```

El trabajo diario consulta los preventivos con fecha igual o anterior a 15 días desde `CURRENT_DATE` y envía un resumen individual a cada correo de usuarios con rol Administrador o Técnico. Se aceptan direcciones de Gmail, Hotmail, Outlook, dominios institucionales y otros dominios válidos; BioMant no limita el dominio del destinatario. El servidor SMTP configurado en `.env` debe permitir enviar a esas direcciones y el servidor receptor puede entregar el mensaje en spam o rechazarlo. Cada alerta se registra por dirección de destino, de modo que un usuario nuevo también pueda recibir alertas que sigan activas. Los fallos de entrega quedan en la consola del servidor. Si SMTP no está configurado, las notificaciones quedan desactivadas y se informa en consola.

## Filtros

El filtro de ubicación usa la columna `ubicacion` disponible en el inventario; se muestra como departamento/ubicación porque el esquema actual no tiene una columna separada de hospital o departamento.

