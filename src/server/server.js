const path = require('path');
const projectRoot = path.resolve(__dirname, '../..');
require('dotenv').config({ path: path.join(projectRoot, '.env') });
const express = require('express');
const db = require('./database');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const QRCode = require('qrcode');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRA = process.env.JWT_EXPIRA || '8h';

if (!JWT_SECRET) {
    console.error('Falta JWT_SECRET en el archivo .env (ver instrucciones de instalación).');
    process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use('/uploads', express.static(path.join(projectRoot, 'uploads')));

// Auditoría general: registrar solo datos operativos explícitos, nunca credenciales.
async function registrarAuditoria(req, evento, executor = db) {
    const usuario = req.usuario || {};
    await executor.query(`INSERT INTO auditoria_eventos
        (id_usuario, nombre_usuario, rol_usuario, modulo, accion, entidad, id_entidad, resumen,
         valores_anteriores, valores_nuevos, metadatos)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb)`, [
        usuario.id_usuario || null,
        String(usuario.nombre || 'Sistema').slice(0, 100),
        usuario.rol || null,
        evento.modulo,
        evento.accion,
        evento.entidad,
        evento.id_entidad == null ? null : String(evento.id_entidad).slice(0, 120),
        String(evento.resumen).slice(0, 300),
        JSON.stringify(evento.anteriores || {}),
        JSON.stringify(evento.nuevos || {}),
        JSON.stringify({ metodo: req.method, ruta: req.path })
    ]);
}

const carpetaImagenesEquipos = path.join(projectRoot, 'uploads', 'equipos');
fs.mkdirSync(carpetaImagenesEquipos, { recursive: true });

const uploadImportacion = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } }).single('archivo');
const uploadImagenEquipo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }).single('imagen');
const uploadAdjuntosOrden = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 5 } }).array('archivos', 5);
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'biomant-equipo-fotos';
const SUPABASE_ORDENES_BUCKET = process.env.SUPABASE_ORDENES_BUCKET || 'biomant-ordenes-informes';
let bucketStoragePreparado = null;
let bucketOrdenesPreparado = null;

function obtenerConfiguracionStorage() {
    const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceKey) throw new Error('Falta SUPABASE_SECRET_KEY en el archivo .env.');

    let baseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
    if (!baseUrl) {
        try {
            const databaseUrl = new URL(process.env.SUPABASE_DATABASE_URL || '');
            const usuario = decodeURIComponent(databaseUrl.username || '');
            const projectRef = usuario.match(/^postgres\.([a-z0-9]+)$/i)?.[1]
                || databaseUrl.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i)?.[1];
            if (projectRef) baseUrl = `https://${projectRef}.supabase.co`;
        } catch (_) { /* La validación clara se informa al usar Storage. */ }
    }
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(baseUrl)) {
        throw new Error('Configura SUPABASE_URL con la URL del proyecto Supabase.');
    }
    return { baseUrl, serviceKey };
}

function rutaStorageCodificada(ruta) {
    return String(ruta).split('/').map(encodeURIComponent).join('/');
}

async function solicitarStorage(recurso, opciones = {}) {
    const { baseUrl, serviceKey } = obtenerConfiguracionStorage();
    const headers = { apikey: serviceKey, ...(opciones.body && !Buffer.isBuffer(opciones.body) ? { 'Content-Type': 'application/json' } : {}), ...(opciones.headers || {}) };
    // Las claves secret nuevas se autentican con apikey; solo las legacy service_role
    // son JWT y deben enviarse también como Authorization Bearer.
    if (!serviceKey.startsWith('sb_secret_')) headers.Authorization = `Bearer ${serviceKey}`;
    const respuesta = await fetch(`${baseUrl}/storage/v1/${recurso}`, {
        ...opciones,
        headers
    });
    const texto = await respuesta.text();
    let datos = {};
    try { datos = texto ? JSON.parse(texto) : {}; } catch (_) { datos = { message: texto }; }
    if (!respuesta.ok) {
        const error = new Error(datos.message || datos.error || `Supabase Storage respondió HTTP ${respuesta.status}.`);
        error.status = respuesta.status;
        throw error;
    }
    return { baseUrl, datos };
}

async function asegurarBucketStorage() {
    if (!bucketStoragePreparado) {
        bucketStoragePreparado = (async () => {
            try {
                const existente = await solicitarStorage(`bucket/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}`);
                if (existente.datos.public === true) throw new Error(`El bucket ${SUPABASE_STORAGE_BUCKET} debe ser privado.`);
                return;
            } catch (error) {
                if (error.status !== 404) throw error;
            }
            await solicitarStorage('bucket', {
                method: 'POST',
                body: JSON.stringify({
                    id: SUPABASE_STORAGE_BUCKET,
                    name: SUPABASE_STORAGE_BUCKET,
                    public: false,
                    file_size_limit: 5 * 1024 * 1024,
                    allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp']
                })
            });
        })().catch((error) => {
            bucketStoragePreparado = null;
            throw error;
        });
    }
    return bucketStoragePreparado;
}

async function asegurarBucketOrdenes() {
    if (!bucketOrdenesPreparado) {
        bucketOrdenesPreparado = (async () => {
            const permitidos = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'text/plain'];
            try {
                const existente = await solicitarStorage(`bucket/${encodeURIComponent(SUPABASE_ORDENES_BUCKET)}`);
                if (existente.datos.public === true) throw new Error(`El bucket ${SUPABASE_ORDENES_BUCKET} debe ser privado.`);
                return;
            } catch (error) {
                if (error.status !== 404) throw error;
            }
            await solicitarStorage('bucket', { method: 'POST', body: JSON.stringify({
                id: SUPABASE_ORDENES_BUCKET, name: SUPABASE_ORDENES_BUCKET, public: false,
                file_size_limit: 20 * 1024 * 1024, allowed_mime_types: permitidos
            }) });
        })().catch((error) => { bucketOrdenesPreparado = null; throw error; });
    }
    return bucketOrdenesPreparado;
}

db.connect((err) => {
    if (err) {
        console.error('Error al conectar a Supabase:', err.code || err.message);
        return;
    }
    console.log('Conectado exitosamente a Supabase PostgreSQL.');
});

// Panel visual de inventario (el propio index.html redirige al login si no hay sesión)
app.get('/', (req, res) => {
    res.sendFile(path.join(projectRoot, 'public', 'index.html'));
});

// Vista de login
app.get('/login', (req, res) => {
    res.sendFile(path.join(projectRoot, 'public', 'login.html'));
});

// Iniciar servidor
const PORT = 3000;

// Gestión administrativa de proveedores y órdenes de trabajo externas.
app.get('/api/proveedores-externos', verificarToken, soloAdministrador, async (_req, res) => {
    try { res.json(await db.query(`SELECT p.*, COALESCE(array_agg(pe.id_equipo) FILTER (WHERE pe.id_equipo IS NOT NULL), '{}') AS equipos FROM proveedores_externos p LEFT JOIN proveedor_equipos pe USING(id_proveedor) WHERE p.activo GROUP BY p.id_proveedor ORDER BY p.empresa`)); }
    catch (e) { res.status(500).json({ error: 'No se pudieron cargar los proveedores.' }); }
});
app.post('/api/proveedores-externos', verificarToken, soloAdministrador, async (req, res) => {
    const empresa = String(req.body?.empresa || '').trim(), correo = String(req.body?.correo || '').trim().toLowerCase();
    if (empresa.length < 2 || empresa.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return res.status(400).json({ error: 'Ingresa empresa y correo válidos.' });
    try {
        const r = await db.query('INSERT INTO proveedores_externos (empresa, correo, telefono, servicios) VALUES (?, ?, ?, ?) RETURNING id_proveedor', [empresa, correo, String(req.body?.telefono || '').slice(0,40), String(req.body?.servicios || '').slice(0,1000)]);
        await registrarAuditoria(req, { modulo:'proveedores', accion:'crear', entidad:'proveedor', id_entidad:r.insertId, resumen:`Registró proveedor externo ${empresa}.`, nuevos:{ empresa, correo } });
        res.status(201).json({ id_proveedor:r.insertId, empresa, correo });
    } catch (e) { res.status(500).json({ error:'No se pudo registrar el proveedor.' }); }
});
app.get('/api/ordenes-externas', verificarToken, soloAdministrador, async (_req,res) => {
    try {
        const ordenes = await db.query(`SELECT o.id_orden,o.tipo,o.descripcion,o.protocolo,o.estado,o.creado_en,o.vence_en,o.informe_proveedor,e.id_equipo,e.nombre_equipo,e.marca,e.modelo,e.numero_serie,e.ubicacion,p.empresa,p.correo FROM ordenes_trabajo_externas o JOIN equipos e USING(id_equipo) JOIN proveedores_externos p USING(id_proveedor) ORDER BY o.creado_en DESC LIMIT 250`);
        if (ordenes.length) {
            const archivos = await db.query('SELECT id_archivo,id_orden,nombre_archivo,tipo_mime,tamano_bytes,subido_en FROM ordenes_trabajo_archivos WHERE id_orden IN (?) ORDER BY subido_en DESC', [ordenes.map((orden) => orden.id_orden)]);
            const porOrden = new Map();
            for (const archivo of archivos) {
                if (!porOrden.has(String(archivo.id_orden))) porOrden.set(String(archivo.id_orden), []);
                porOrden.get(String(archivo.id_orden)).push(archivo);
            }
            ordenes.forEach((orden) => { orden.archivos = porOrden.get(String(orden.id_orden)) || []; });
        }
        res.json(ordenes);
    }
    catch(e) { res.status(500).json({error:'No se pudieron cargar las órdenes.'}); }
});
function validarArchivoOrden(file) {
    const nombre = String(file.originalname || '').replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180);
    const extension = path.extname(nombre).toLowerCase();
    const definiciones = {
        '.pdf': ['application/pdf', b => b.subarray(0, 5).toString('ascii') === '%PDF-'],
        '.jpg': ['image/jpeg', b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
        '.jpeg': ['image/jpeg', b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
        '.png': ['image/png', b => b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))],
        '.webp': ['image/webp', b => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'],
        '.doc': ['application/msword', b => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]))],
        '.xls': ['application/vnd.ms-excel', b => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]))],
        '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', b => b.length >= 4 && b.subarray(0, 2).toString('ascii') === 'PK'],
        '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', b => b.length >= 4 && b.subarray(0, 2).toString('ascii') === 'PK'],
        '.csv': ['text/csv', b => !b.includes(0)],
        '.txt': ['text/plain', b => !b.includes(0)]
    };
    const definicion = definiciones[extension];
    if (!definicion || !definicion[1](file.buffer)) return null;
    return { nombre: nombre || `informe${extension}`, extension, mime: definicion[0] };
}
app.patch('/api/ordenes-externas/:id/cerrar', verificarToken, soloAdministrador, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'La orden indicada no es válida.' });
    try {
        const orden = await db.transaction(async (tx) => {
            const actuales = await tx.query('SELECT id_orden,estado,id_equipo FROM ordenes_trabajo_externas WHERE id_orden = ? FOR UPDATE', [id]);
            if (!actuales.length) { const error = new Error('No se encontró la orden.'); error.status = 404; throw error; }
            if (actuales[0].estado !== 'completada') { const error = new Error('Solo puedes validar y cerrar una orden que el proveedor marcó como completada.'); error.status = 409; throw error; }
            await tx.query("UPDATE ordenes_trabajo_externas SET estado='cerrada', actualizado_en=CURRENT_TIMESTAMP WHERE id_orden=?", [id]);
            await registrarAuditoria(req, { modulo: 'proveedores', accion: 'validar_cerrar_orden', entidad: 'orden_externa', id_entidad: id, resumen: `Validó el informe y cerró la orden externa #${id} del equipo ${actuales[0].id_equipo}.`, anteriores: { estado: actuales[0].estado }, nuevos: { estado: 'cerrada' } }, tx);
            return actuales[0];
        });
        res.json({ mensaje: 'Orden validada y cerrada correctamente.', id_orden: orden.id_orden, estado: 'cerrada' });
    } catch (error) { res.status(error.status || 500).json({ error: error.message || 'No se pudo cerrar la orden.' }); }
});
app.get('/api/ordenes-externas/:id/archivos/:archivoId', verificarToken, soloAdministrador, async (req, res) => {
    try {
        const archivos = await db.query('SELECT ruta_storage,nombre_archivo FROM ordenes_trabajo_archivos WHERE id_archivo = ? AND id_orden = ?', [req.params.archivoId, req.params.id]);
        if (!archivos.length) return res.status(404).json({ error: 'No se encontró el archivo solicitado.' });
        const ruta = String(archivos[0].ruta_storage || '');
        if (!ruta.startsWith(`${req.params.id}/`)) return res.status(404).json({ error: 'No se encontró el archivo solicitado.' });
        const { baseUrl, datos } = await solicitarStorage(`object/sign/${encodeURIComponent(SUPABASE_ORDENES_BUCKET)}/${rutaStorageCodificada(ruta)}`, { method: 'POST', body: JSON.stringify({ expiresIn: 300, download: archivos[0].nombre_archivo }) });
        const signedURL = String(datos.signedURL || '');
        const url = /^https?:\/\//i.test(signedURL) ? signedURL : `${baseUrl}${signedURL.startsWith('/storage/v1/') ? '' : '/storage/v1'}${signedURL.startsWith('/') ? signedURL : `/${signedURL}`}`;
        res.json({ url });
    } catch (error) { console.error('No se pudo generar acceso al adjunto de la orden:', error.message || error); res.status(500).json({ error: 'No se pudo abrir el adjunto.' }); }
});
app.post('/api/ordenes-externas', verificarToken, soloAdministrador, async (req,res) => {
    const proveedor=Number(req.body?.id_proveedor), equipoId=String(req.body?.id_equipo||''), tipo=req.body?.tipo, descripcion=String(req.body?.descripcion||'').trim(), protocolo=String(req.body?.protocolo||'').trim();
    if(!Number.isInteger(proveedor)||!equipoId||!['Preventivo','Correctivo'].includes(tipo)||descripcion.length<10) return res.status(400).json({error:'Completa proveedor, equipo, tipo y descripción (mínimo 10 caracteres).'});
    try {
        const info=await db.query(`SELECT p.empresa,p.correo,e.id_equipo,e.nombre_equipo,e.marca,e.modelo,e.numero_serie,e.ubicacion FROM proveedores_externos p JOIN equipos e ON e.id_equipo=? WHERE p.id_proveedor=? AND p.activo`,[equipoId,proveedor]);
        if(!info.length) return res.status(404).json({error:'Proveedor o equipo no disponible.'});
        const token=crypto.randomBytes(32).toString('hex'), hash=crypto.createHash('sha256').update(token).digest('hex'), vence=new Date(Date.now()+14*86400000).toISOString();
        const insert=await db.query(`INSERT INTO ordenes_trabajo_externas (id_proveedor,id_equipo,tipo,descripcion,protocolo,token_hash,vence_en,creado_por) VALUES (?,?,?,?,?,?,?,?) RETURNING id_orden`,[proveedor,equipoId,tipo,descripcion,protocolo,hash,vence,req.usuario.id_usuario]);
        await db.query('INSERT INTO proveedor_equipos (id_proveedor,id_equipo) VALUES (?,?) ON CONFLICT DO NOTHING',[proveedor,equipoId]);
        const base=String(process.env.APP_PUBLIC_URL||`${req.protocol}://${req.get('host')}`).replace(/\/$/,''), enlace=`${base}/orden-proveedor/${token}`;
        const d=info[0];
        const marcaModelo=[d.marca,d.modelo].filter(Boolean).map(escaparHtmlServidor).join(' · ') || 'No registrado';
        const html=`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Orden externa BioMant #${insert.insertId}</title></head><body style="margin:0;padding:0;background:#eef4f6;font-family:Arial,Helvetica,sans-serif;color:#183b40">
        <div style="display:none;max-height:0;overflow:hidden;opacity:0">Nueva orden ${tipo.toLowerCase()} para ${escaparHtmlServidor(equipoId)}. Consulta el detalle y registra el avance del servicio.</div>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#eef4f6"><tr><td align="center" style="padding:28px 12px">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;background:#ffffff;border:1px solid #dce8e9;border-radius:18px;overflow:hidden">
        <tr><td style="padding:25px 28px;background:#0b3b3d;background-image:linear-gradient(115deg,#0b3436,#087c79);color:#ffffff">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td width="58" valign="middle"><div style="width:46px;height:46px;line-height:46px;text-align:center;border-radius:14px;background:#0d7778;color:#ffffff;font-size:24px;font-weight:bold">B</div></td><td valign="middle"><div style="font-size:22px;line-height:26px;font-weight:bold">BioMant</div><div style="margin-top:4px;color:#b9e6e2;font-size:12px;letter-spacing:.4px">CLÍNICA DE LOS RÍOS · GESTIÓN DE ACTIVOS CLÍNICOS</div></td></tr></table>
        </td></tr>
        <tr><td style="padding:28px 28px 12px"><div style="font-size:11px;line-height:16px;font-weight:bold;letter-spacing:1.2px;color:#0c7776;text-transform:uppercase">Orden de trabajo externa · #${insert.insertId}</div><h1 style="margin:9px 0 8px;font-size:24px;line-height:31px;color:#123b3e">${escaparHtmlServidor(tipo)} · ${escaparHtmlServidor(d.nombre_equipo)}</h1><p style="margin:0;color:#60777b;font-size:14px;line-height:22px">BioMant ha asignado una solicitud de mantenimiento a su empresa. Revise la información y actualice el avance desde el enlace seguro.</p></td></tr>
        <tr><td style="padding:10px 28px 4px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f3f8f8;border:1px solid #e1ecec;border-radius:13px"><tr><td style="padding:17px 18px"><div style="font-size:10px;line-height:15px;color:#70868a;font-weight:bold;letter-spacing:1px;text-transform:uppercase">Activo biomédico</div><div style="margin-top:7px;font-size:17px;line-height:23px;color:#173c40;font-weight:bold">${escaparHtmlServidor(d.nombre_equipo)}</div><div style="margin-top:9px"><span style="display:inline-block;padding:5px 9px;border-radius:7px;background:#dff4f0;color:#086762;font-family:Arial,sans-serif;font-size:12px;font-weight:bold">${escaparHtmlServidor(equipoId)}</span></div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:13px"><tr><td width="50%" valign="top" style="padding:0 10px 9px 0"><div style="font-size:10px;color:#819296;font-weight:bold;letter-spacing:.7px;text-transform:uppercase">Marca y modelo</div><div style="margin-top:4px;font-size:13px;line-height:19px;color:#304d51">${marcaModelo}</div></td><td width="50%" valign="top" style="padding:0 0 9px 10px"><div style="font-size:10px;color:#819296;font-weight:bold;letter-spacing:.7px;text-transform:uppercase">Número de serie</div><div style="margin-top:4px;font-size:13px;line-height:19px;color:#304d51">${escaparHtmlServidor(d.numero_serie||'No registrado')}</div></td></tr><tr><td colspan="2" valign="top" style="padding-top:4px"><div style="font-size:10px;color:#819296;font-weight:bold;letter-spacing:.7px;text-transform:uppercase">Ubicación</div><div style="margin-top:4px;font-size:13px;line-height:19px;color:#304d51">${escaparHtmlServidor(d.ubicacion||'No registrada')}</div></td></tr></table></td></tr></table></td></tr>
        <tr><td style="padding:13px 28px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #e3ebed;border-radius:12px"><tr><td style="padding:16px 18px"><div style="font-size:11px;color:#3d6267;font-weight:bold;letter-spacing:.8px;text-transform:uppercase">Trabajo solicitado</div><div style="margin-top:9px;font-size:14px;line-height:23px;color:#354f53;white-space:pre-wrap">${escaparHtmlServidor(descripcion)}</div></td></tr></table></td></tr>
        ${protocolo?`<tr><td style="padding:12px 28px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#edfaf7;border:1px solid #d3efea;border-radius:12px"><tr><td style="padding:16px 18px"><div style="font-size:11px;color:#08736c;font-weight:bold;letter-spacing:.8px;text-transform:uppercase">Protocolo e instrucciones</div><div style="margin-top:9px;font-size:14px;line-height:23px;color:#355b5a;white-space:pre-wrap">${escaparHtmlServidor(protocolo)}</div></td></tr></table></td></tr>`:''}
        <tr><td align="center" style="padding:24px 28px 10px"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" bgcolor="#0d7377" style="border-radius:10px"><a href="${escaparHtmlServidor(enlace)}" style="display:inline-block;padding:14px 24px;border:1px solid #0d7377;border-radius:10px;color:#ffffff;font-size:14px;line-height:20px;font-weight:bold;text-decoration:none">Consultar y actualizar orden&nbsp;&nbsp;→</a></td></tr></table><div style="margin-top:12px;color:#6b8084;font-size:12px;line-height:19px">Use este acceso para aceptar la orden, informar el avance y adjuntar el reporte del servicio.</div></td></tr>
        <tr><td style="padding:10px 28px 24px"><div style="border-top:1px solid #e8eeee;padding-top:15px;color:#839397;font-size:11px;line-height:18px">Enlace personal válido durante 14 días. Por seguridad, no reenvíe este correo. Si no reconoce esta solicitud, comuníquese con la Clínica de los Ríos.</div></td></tr>
        </table><div style="padding:15px 12px 0;color:#8a9a9d;font-size:11px;line-height:17px;text-align:center">BioMant · Gestión de mantenimiento clínico</div></td></tr></table></body></html>`;
        const mailOk=Boolean(process.env.SMTP_HOST&&process.env.SMTP_USER&&process.env.SMTP_PASS);
        if(mailOk){const port=Number(process.env.SMTP_PORT||587), tr=nodemailer.createTransport({host:process.env.SMTP_HOST,port,secure:process.env.SMTP_SECURE?process.env.SMTP_SECURE==='true':port===465,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS},
            family: 4});await tr.sendMail({from:process.env.MAIL_FROM||process.env.SMTP_USER,to:d.correo,subject:`BioMant | Orden externa #${insert.insertId} · ${equipoId}`,text:`BioMant · Orden de trabajo externa #${insert.insertId}\n${tipo} · ${d.nombre_equipo}\nActivo: ${equipoId} · ${d.marca||''} ${d.modelo||''}\nSerie: ${d.numero_serie||'No registrada'}\nUbicación: ${d.ubicacion||'No registrada'}\n\nTrabajo solicitado:\n${descripcion}${protocolo?`\n\nProtocolo e instrucciones:\n${protocolo}`:''}\n\nConsultar y actualizar orden: ${enlace}\nEnlace personal válido durante 14 días.`,html});}
        await registrarAuditoria(req,{modulo:'mantenimientos',accion:'crear_orden_externa',entidad:'orden_externa',id_entidad:insert.insertId,resumen:`Creó orden externa #${insert.insertId} para ${equipoId}.`,nuevos:{id_proveedor:proveedor,id_equipo:equipoId,tipo,correo_enviado:mailOk}});
        res.status(201).json({id_orden:insert.insertId,correo_enviado:mailOk});
    }catch(e){console.error('No se pudo crear la orden externa:',e.message);res.status(500).json({error:'No se pudo crear o enviar la orden. Verifica migración y SMTP.'});}
});
app.get('/orden-proveedor/:token', async (req,res) => {
    const hash=crypto.createHash('sha256').update(String(req.params.token)).digest('hex');
    try {
        const r=await db.query(`SELECT o.id_orden,o.tipo,o.descripcion,o.protocolo,o.estado,o.vence_en,o.informe_proveedor,e.id_equipo,e.nombre_equipo,e.marca,e.modelo,e.numero_serie,e.ubicacion FROM ordenes_trabajo_externas o JOIN equipos e USING(id_equipo) WHERE o.token_hash=? AND o.vence_en>CURRENT_TIMESTAMP`,[hash]);
        if(!r.length)return res.status(404).send('El enlace venció o no es válido.');
        const o=r[0];
        const adjuntos = await db.query('SELECT id_archivo,nombre_archivo,ruta_storage,tipo_mime,tamano_bytes,subido_en FROM ordenes_trabajo_archivos WHERE id_orden = ? ORDER BY subido_en DESC', [o.id_orden]);
        const adjuntosHtml = await Promise.all(adjuntos.map(async (archivo) => {
            const { baseUrl, datos } = await solicitarStorage(`object/sign/${encodeURIComponent(SUPABASE_ORDENES_BUCKET)}/${rutaStorageCodificada(archivo.ruta_storage)}`, { method: 'POST', body: JSON.stringify({ expiresIn: 3600, download: archivo.nombre_archivo }) });
            const firmado = String(datos.signedURL || '');
            const url = /^https?:\/\//i.test(firmado) ? firmado : `${baseUrl}${firmado.startsWith('/storage/v1/') ? '' : '/storage/v1'}${firmado.startsWith('/') ? firmado : `/${firmado}`}`;
            return `<li style="padding:8px 0;border-bottom:1px solid #e8eeee"><a href="${escaparHtmlServidor(url)}" style="color:#0b7775;text-decoration:underline;font-weight:700">${escaparHtmlServidor(archivo.nombre_archivo)}</a><span style="display:block;color:#829397;font-size:11px">${(Number(archivo.tamano_bytes || 0) / 1024 / 1024).toFixed(2)} MB</span></li>`;
        })).then((items) => items.join(''));
        const fechaVencimiento=new Date(o.vence_en);
        const venceLegible=Number.isNaN(fechaVencimiento.getTime())?'14 días desde su emisión':fechaVencimiento.toLocaleString('es-CO',{dateStyle:'medium',timeStyle:'short',timeZone:'America/Bogota'});
        const marcaModelo=[o.marca,o.modelo].filter(Boolean).map(escaparHtmlServidor).join(' · ')||'No registrado';
        const estadoActual={enviada:'Pendiente de respuesta',aceptada:'Aceptada por el proveedor',en_proceso:'Servicio en proceso',completada:'Servicio reportado',cerrada:'Orden cerrada'}[o.estado]||'En seguimiento';
        const basePublica=String(process.env.APP_PUBLIC_URL||`${req.protocol}://${req.get('host')}`).replace(/\/$/,'');
        const enlaceOrden=`${basePublica}/orden-proveedor/${encodeURIComponent(req.params.token)}`;
        const qrOrden=await QRCode.toDataURL(enlaceOrden,{width:280,margin:2,errorCorrectionLevel:'M'});
        res.set('Cache-Control','no-store');
        res.type('html').send(`<!doctype html>
        <html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0b393b"><title>Orden BioMant #${escaparHtmlServidor(o.id_orden)}</title>
        <style>
          :root{color-scheme:light;--ink:#17383b;--muted:#60777b;--line:#dce8e9;--teal:#0d7377;--pale:#eff8f7}
          *{box-sizing:border-box}body{margin:0;background:#edf3f5;color:var(--ink);font:15px/1.55 Inter,"Segoe UI",Arial,sans-serif}
          .page{max-width:1000px;margin:40px auto;padding:0 20px}.top{overflow:hidden;border-radius:24px;background:linear-gradient(125deg,#092f32 0%,#0b5555 58%,#108581 100%);color:#fff;box-shadow:0 18px 45px rgba(17,55,59,.16)}
          .brand{display:flex;align-items:center;gap:13px;padding:22px 30px;border-bottom:1px solid rgba(255,255,255,.14)}.logo{display:grid;place-items:center;width:46px;height:46px;border-radius:15px;background:#087b7d;color:white;font-size:24px;font-weight:800}.brand-name{font-size:19px;font-weight:750;line-height:1.2}.brand-sub{margin-top:4px;color:#b9e6e2;font-size:11px;letter-spacing:.9px;text-transform:uppercase}.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;padding:28px 30px 32px}.eyebrow{color:#7be1d0;font-size:10px;font-weight:800;letter-spacing:1.7px;text-transform:uppercase}.hero h1{margin:9px 0 6px;font-size:clamp(24px,4vw,34px);line-height:1.15;letter-spacing:-.5px}.hero p{margin:0;max-width:620px;color:#d3e9e8;font-size:14px}.order-chip{flex:none;padding:9px 13px;border:1px solid rgba(255,255,255,.25);border-radius:999px;background:rgba(255,255,255,.1);font-size:12px;font-weight:700}
          .layout{display:grid;grid-template-columns:minmax(0,1.08fr) minmax(310px,.92fr);gap:20px;margin-top:20px}.stack{display:grid;align-content:start;gap:16px}.card{border:1px solid var(--line);border-radius:18px;background:#fff;box-shadow:0 5px 18px rgba(21,58,62,.045)}.card-head{padding:19px 21px 0}.label{color:#71868a;font-size:10px;font-weight:800;letter-spacing:1.15px;text-transform:uppercase}.card-body{padding:16px 21px 21px}.asset{padding:18px;border:1px solid #dceceb;border-radius:15px;background:linear-gradient(135deg,#f5fbfa,#eff7f7)}.asset-id{display:inline-flex;padding:5px 9px;border-radius:8px;background:#dff3ef;color:#096660;font:700 12px ui-monospace,Consolas,monospace}.asset h2{margin:10px 0 0;font-size:19px;line-height:1.35}.specs{display:grid;grid-template-columns:1fr 1fr;gap:14px 18px;margin-top:18px}.spec span{display:block;color:#839397;font-size:10px;font-weight:750;letter-spacing:.7px;text-transform:uppercase}.spec b{display:block;margin-top:4px;color:#2b4c50;font-size:13px;font-weight:600;overflow-wrap:anywhere}.section-title{display:flex;align-items:center;gap:9px;margin:0;color:#25484c;font-size:14px}.dot{width:8px;height:8px;border-radius:50%;background:#0c8b82}.copy{margin:10px 0 0;color:#526a6e;font-size:14px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}.protocol{background:#f0faf8;border-color:#d6efea}.protocol .dot{background:#23a487}
          .asset-layout{display:grid;grid-template-columns:minmax(0,1fr) 190px;gap:13px;align-items:stretch}.qr-card{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:14px 11px;border:1px solid #dce8e9;border-radius:15px;background:#fff;text-align:center}.qr-image{display:block;width:126px;height:126px;padding:7px;border:1px solid #e5eded;border-radius:12px;background:#fff}.qr-card h3{margin:11px 0 0;color:#21494c;font-size:12px}.qr-card p{margin:5px 0 0;color:#71868a;font-size:10px;line-height:1.45}.qr-exp{margin-top:9px!important;color:#0c7771!important;font-weight:700}.status{display:inline-flex;align-items:center;gap:8px;padding:7px 11px;border-radius:999px;background:#fff4d7;color:#89560a;font-size:11px;font-weight:750}.status:before{content:"";width:7px;height:7px;border-radius:50%;background:#e9a52b}.form-card{overflow:hidden}.form-intro{padding:20px 22px;border-bottom:1px solid #e8eeee;background:#fbfdfd}.form-intro h2{margin:0;font-size:17px}.form-intro p{margin:5px 0 0;color:var(--muted);font-size:12px}.form-body{padding:20px 22px 22px}.field{display:block;margin-bottom:16px}.field-label{display:block;margin-bottom:7px;color:#354f53;font-size:12px;font-weight:700}.control{display:block;width:100%;min-height:46px;padding:11px 13px;border:1px solid #cfdddf;border-radius:11px;background:#fff;color:#183b40;font:inherit;font-size:14px;outline:none;transition:border-color .15s,box-shadow .15s}.control:focus{border-color:#0d8582;box-shadow:0 0 0 3px rgba(13,115,119,.12)}textarea.control{min-height:170px;resize:vertical;line-height:1.6}.help{margin:6px 0 0;color:#829397;font-size:11px}.submit{display:flex;width:100%;align-items:center;justify-content:center;gap:9px;min-height:48px;margin-top:4px;border:0;border-radius:11px;background:linear-gradient(110deg,#0b686b,#0e8580);color:#fff;font-size:14px;font-weight:750;cursor:pointer;box-shadow:0 7px 15px rgba(13,115,119,.18);transition:transform .15s,box-shadow .15s}.submit:hover{transform:translateY(-1px);box-shadow:0 10px 20px rgba(13,115,119,.24)}.secure{display:flex;gap:9px;margin-top:16px;padding:12px;border-radius:11px;background:#f5f8f8;color:#718286;font-size:11px;line-height:1.5}.secure b{color:#3e5a5e}.footer{padding:18px 4px 4px;color:#829397;font-size:11px;text-align:center}
          @media(max-width:740px){.page{margin:16px auto;padding:0 12px}.brand{padding:17px 18px}.hero{align-items:flex-start;flex-direction:column;padding:22px 19px 24px}.layout{grid-template-columns:1fr;gap:14px;margin-top:14px}.card-head{padding:17px 17px 0}.card-body{padding:14px 17px 17px}.form-intro{padding:17px}.form-body{padding:17px}.specs{gap:13px}.order-chip{align-self:flex-start}}
          @media(max-width:540px){.asset-layout{grid-template-columns:1fr}.qr-card{flex-direction:row;justify-content:flex-start;gap:13px;text-align:left;padding:12px}.qr-image{width:94px;height:94px;flex:none}.qr-card h3{margin:0}.qr-exp{margin-top:5px!important}}
          @media(max-width:390px){.specs{grid-template-columns:1fr}.hero h1{font-size:25px}}
        </style></head><body><main class="page">
          <header class="top"><div class="brand"><div class="logo">B</div><div><div class="brand-name">BioMant</div><div class="brand-sub">Clínica de los Ríos · Portal de proveedores</div></div></div><div class="hero"><div><div class="eyebrow">Mantenimiento de activos clínicos</div><h1>Orden de trabajo</h1><p>Consulta el activo asignado, revisa el alcance del servicio y registra aquí el avance de la orden.</p></div><div class="order-chip">Orden #${escaparHtmlServidor(o.id_orden)}</div></div></header>
          <div class="layout"><div class="stack">
            <section class="card"><div class="card-head"><div class="label">Equipo asignado</div></div><div class="card-body"><div class="asset-layout"><div class="asset"><span class="asset-id">${escaparHtmlServidor(o.id_equipo)}</span><h2>${escaparHtmlServidor(o.nombre_equipo)}</h2><div class="specs"><div class="spec"><span>Tipo de servicio</span><b>${escaparHtmlServidor(o.tipo)}</b></div><div class="spec"><span>Marca y modelo</span><b>${marcaModelo}</b></div><div class="spec"><span>Número de serie</span><b>${escaparHtmlServidor(o.numero_serie||'No registrado')}</b></div><div class="spec"><span>Ubicación</span><b>${escaparHtmlServidor(o.ubicacion||'No registrada')}</b></div></div><div style="margin-top:15px"><span class="status">${escaparHtmlServidor(estadoActual)}</span></div></div><aside class="qr-card"><img class="qr-image" src="${qrOrden}" alt="Código QR de acceso seguro a la orden ${escaparHtmlServidor(o.id_orden)} del equipo ${escaparHtmlServidor(o.id_equipo)}"><div><h3>QR de acceso al equipo</h3><p>Escanéalo para abrir esta orden y consultar los datos del activo.</p><p class="qr-exp">Enlace válido hasta ${escaparHtmlServidor(venceLegible)}</p></div></aside></div></div></section>
            <section class="card"><div class="card-head"><h2 class="section-title"><span class="dot"></span>Trabajo solicitado</h2></div><div class="card-body"><p class="copy">${escaparHtmlServidor(o.descripcion)}</p></div></section>
            ${o.protocolo?`<section class="card protocol"><div class="card-head"><h2 class="section-title"><span class="dot"></span>Protocolo e instrucciones</h2></div><div class="card-body"><p class="copy">${escaparHtmlServidor(o.protocolo)}</p></div></section>`:''}
          </div><section class="card form-card"><div class="form-intro"><h2>Actualizar orden</h2><p>Indica el estado del servicio, registra el informe y adjunta soportes.</p></div><form class="form-body" method="post" enctype="multipart/form-data" action="/orden-proveedor/${encodeURIComponent(req.params.token)}"><label class="field"><span class="field-label">Estado del servicio</span><select class="control" name="estado" required><option value="" disabled${['aceptada','en_proceso','completada'].includes(o.estado)?'':' selected'}>Selecciona el estado del servicio</option><option value="aceptada"${o.estado==='aceptada'?' selected':''}>Aceptada · servicio programado</option><option value="en_proceso"${o.estado==='en_proceso'?' selected':''}>En proceso · trabajo iniciado</option><option value="completada"${o.estado==='completada'?' selected':''}>Completada · servicio realizado</option></select></label><label class="field"><span class="field-label">Informe del servicio</span><textarea class="control" name="informe" required minlength="10" maxlength="4000" placeholder="Describe el trabajo realizado, las verificaciones y los resultados obtenidos…">${o.informe_proveedor?escaparHtmlServidor(o.informe_proveedor):''}</textarea><p class="help">Mínimo 10 caracteres. Puedes incluir hallazgos, pruebas realizadas y recomendaciones.</p></label><label class="field"><span class="field-label">Archivos de soporte (opcional)</span><input class="control" type="file" name="archivos" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt"><p class="help">Hasta 5 archivos, máximo 20 MB cada uno: PDF, imágenes, Word, Excel, CSV o TXT.</p></label>${adjuntos.length ? `<section class="field"><span class="field-label">Archivos enviados anteriormente</span><ul style="margin:0;padding:10px 14px;list-style:none;border:1px solid #dce8e9;border-radius:12px;background:#f7fafa">${adjuntosHtml}</ul></section>` : ''}<button class="submit" type="submit">Enviar actualización <span aria-hidden="true">→</span></button><div class="secure"><span aria-hidden="true">🔒</span><span><b>Acceso seguro y personal.</b> Este enlace vence el ${escaparHtmlServidor(venceLegible)}. No lo compartas con terceros.</span></div></form></section></div>
          <footer class="footer">BioMant · Clínica de los Ríos · Gestión de mantenimiento clínico</footer></main></body></html>`);
    } catch(e){res.status(500).send('No se pudo cargar la orden.');}
});
app.post('/orden-proveedor/:token', (req, res) => {
    uploadAdjuntosOrden(req, res, async (errorCarga) => {
        if (errorCarga) {
            const mensaje = errorCarga.code === 'LIMIT_FILE_SIZE' ? 'Cada archivo debe pesar máximo 20 MB.' : errorCarga.code === 'LIMIT_FILE_COUNT' || errorCarga.code === 'LIMIT_UNEXPECTED_FILE' ? 'Puedes adjuntar hasta 5 archivos por actualización.' : 'No se pudieron recibir los archivos adjuntos.';
            return res.status(400).send(mensaje);
        }
        const hash = crypto.createHash('sha256').update(String(req.params.token)).digest('hex');
        const estado = String(req.body?.estado || ''), informe = String(req.body?.informe || '').trim();
        const archivos = req.files || [];
        if (!['aceptada', 'en_proceso', 'completada'].includes(estado) || informe.length < 10 || informe.length > 4000) return res.status(400).send('Completa un estado válido y un informe de al menos 10 caracteres.');
        const archivosValidados = archivos.map((archivo) => ({ archivo, datos: validarArchivoOrden(archivo) }));
        if (archivosValidados.some((item) => !item.datos)) return res.status(400).send('Uno o más archivos no coinciden con un formato permitido. Adjunta PDF, JPG, PNG, WebP, Word, Excel, CSV o TXT.');

        const rutasSubidas = [];
        try {
            const ordenes = await db.query("SELECT id_orden,estado FROM ordenes_trabajo_externas WHERE token_hash=? AND vence_en>CURRENT_TIMESTAMP", [hash]);
            if (!ordenes.length) return res.status(404).send('El enlace venció o no es válido.');
            if (ordenes[0].estado === 'cerrada') return res.status(409).send('Esta orden ya fue validada y cerrada. Comunícate con la Clínica de los Ríos si necesitas aportar información adicional.');
            const idOrden = ordenes[0].id_orden;

            if (archivosValidados.length) {
                await asegurarBucketOrdenes();
                for (const { archivo, datos } of archivosValidados) {
                    const nombreSeguro = `${crypto.randomUUID()}-${datos.nombre.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
                    const ruta = `${idOrden}/${nombreSeguro}`;
                    await solicitarStorage(`object/${encodeURIComponent(SUPABASE_ORDENES_BUCKET)}/${rutaStorageCodificada(ruta)}`, { method: 'POST', headers: { 'Content-Type': datos.mime, 'x-upsert': 'false' }, body: archivo.buffer });
                    rutasSubidas.push({ ruta, archivo, datos });
                }
            }

            await db.transaction(async (tx) => {
                const actualizado = await tx.query("UPDATE ordenes_trabajo_externas SET estado=?,informe_proveedor=?,actualizado_en=CURRENT_TIMESTAMP WHERE id_orden=? AND token_hash=? AND vence_en>CURRENT_TIMESTAMP AND estado <> 'cerrada' RETURNING id_orden", [estado, informe, idOrden, hash]);
                // El adaptador PostgreSQL devuelve { rowCount, affectedRows } para
                // UPDATE (también cuando lleva RETURNING), no un arreglo de filas.
                // Revisar `.length` aquí hacía fallar todas las respuestas válidas.
                if (!actualizado || actualizado.rowCount !== 1) { const error = new Error('La orden venció o fue cerrada mientras se enviaba la actualización.'); error.status = 409; throw error; }
                for (const item of rutasSubidas) await tx.query('INSERT INTO ordenes_trabajo_archivos (id_orden,ruta_storage,nombre_archivo,tipo_mime,tamano_bytes) VALUES (?,?,?,?,?)', [idOrden, item.ruta, item.datos.nombre, item.datos.mime, item.archivo.size]);
            });

            res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0b393b"><title>Actualización recibida · BioMant</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:#edf3f5;color:#17383b;font:15px/1.6 Inter,"Segoe UI",Arial,sans-serif}.card{width:min(100%,560px);padding:38px;border:1px solid #dce8e9;border-radius:24px;background:#fff;text-align:center;box-shadow:0 18px 45px rgba(17,55,59,.12)}.icon{display:grid;place-items:center;width:64px;height:64px;margin:0 auto 18px;border-radius:20px;background:#e1f7ef;color:#08785d;font-size:30px;font-weight:bold}.eyebrow{color:#0d8177;font-size:10px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase}h1{margin:9px 0;font-size:27px;line-height:1.25}p{margin:0;color:#60777b}.badge{display:inline-flex;margin-top:20px;padding:8px 13px;border-radius:999px;background:#eff8f7;color:#08736c;font-size:12px;font-weight:bold}.foot{margin-top:23px;padding-top:17px;border-top:1px solid #e8eeee;color:#8a9a9d;font-size:11px}@media(max-width:480px){.card{padding:28px 21px}}</style></head><body><main class="card"><div class="icon" aria-hidden="true">✓</div><div class="eyebrow">BioMant · Portal de proveedores</div><h1>Actualización recibida</h1><p>La respuesta de servicio quedó registrada${rutasSubidas.length ? ` junto con ${rutasSubidas.length} ${rutasSubidas.length === 1 ? 'archivo adjunto' : 'archivos adjuntos'}` : ''}. El equipo clínico revisará el estado, el informe y los soportes.</p><div class="badge">Puedes cerrar esta página</div><div class="foot">Clínica de los Ríos · Gestión de mantenimiento clínico</div></main></body></html>`);
        } catch (error) {
            for (const item of rutasSubidas) await solicitarStorage(`object/${encodeURIComponent(SUPABASE_ORDENES_BUCKET)}/${rutaStorageCodificada(item.ruta)}`, { method: 'DELETE' }).catch(() => {});
            console.error('No se pudo registrar respuesta o archivos de la orden:', error.message || error);
            res.status(error.status || 500).send(error.status ? error.message : 'No se pudo registrar la actualización. Verifica el acceso a Storage y vuelve a intentarlo.');
        }
    });
});

// =============================================================================
// AUTENTICACIÓN Y ROLES
// =============================================================================

const ROLES = ['Administrador', 'Tecnico'];

// Hash de relleno: permite comparar siempre contra un hash, exista o no el
// correo, para que el tiempo de respuesta no revele qué correos están registrados.
const HASH_RELLENO = bcrypt.hashSync('relleno-no-es-una-clave-real', 10);
const INTENTOS_LOGIN_MAXIMOS = 3;
const DURACION_BLOQUEO_LOGIN_MS = 15 * 60 * 1000;
const intentosLogin = new Map();
const claveIntentosLogin = (correo, ip) => `${ip}|${correo}`;
const limpiarIntentosLogin = setInterval(() => {
    const ahora = Date.now();
    for (const [clave, registro] of intentosLogin) {
        if (registro.bloqueadoHasta <= ahora && ahora - registro.ultimoIntento > DURACION_BLOQUEO_LOGIN_MS) intentosLogin.delete(clave);
    }
}, DURACION_BLOQUEO_LOGIN_MS);
limpiarIntentosLogin.unref();

// Exige una sesión válida (cabecera Authorization: Bearer <token>)
function verificarToken(req, res, next) {
    const cabecera = req.headers.authorization || '';
    const [esquema, token] = cabecera.split(' ');

    if (esquema !== 'Bearer' || !token) {
        res.status(401).json({ error: 'Debes iniciar sesión' });
        return;
    }

    jwt.verify(token, JWT_SECRET, (err, payload) => {
        if (err) {
            res.status(401).json({ error: 'Sesión inválida o vencida' });
            return;
        }

        req.usuario = {
            id_usuario: payload.id_usuario,
            nombre: payload.nombre,
            correo: payload.correo,
            rol: payload.rol
        };
        next();
    });
}

// Exige además rol Administrador. Siempre se usa DESPUÉS de verificarToken.
function soloAdministrador(req, res, next) {
    if (!req.usuario || req.usuario.rol !== 'Administrador') {
        res.status(403).json({ error: 'Esta acción es solo para el rol Administrador' });
        return;
    }
    next();
}

const CAMPOS_IMPORTACION = {
    id_equipo: ['id', 'idequipo', 'codigo', 'codigoequipo'],
    nombre_equipo: ['nombre', 'nombreequipo', 'equipo'],
    marca: ['marca', 'fabricante'],
    modelo: ['modelo'],
    numero_serie: ['serie', 'numeroserie', 'numeroserial', 'serial'],
    nivel_riesgo: ['riesgo', 'nivelriesgo', 'criticidad'],
    ubicacion: ['ubicacion', 'departamento', 'area', 'servicio'],
    estado: ['estado', 'estadoactual'],
    tipo_categoria: ['categoria', 'tipocategoria', 'tipo'],
    proximo_mto_preventivo: ['proximomantenimiento', 'fechaproximomantenimiento', 'proximomantenimientopreventivo', 'proximomtopreventivo', 'fechaproximomtopreventivo'],
    foto_equipo: ['foto', 'fotografia', 'fotoequipo', 'imagenequipo']
};
const CAMPOS_IMPORTACION_REQUERIDOS = ['id_equipo', 'nombre_equipo', 'marca', 'modelo', 'numero_serie', 'nivel_riesgo', 'ubicacion', 'estado', 'tipo_categoria'];

function normalizarEncabezado(valor) {
    return String(valor ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mapearEncabezados(encabezados) {
    const campos = encabezados.map((encabezado) => {
        const clave = normalizarEncabezado(encabezado);
        return Object.entries(CAMPOS_IMPORTACION).find(([, alias]) => alias.includes(clave))?.[0] || null;
    });
    const faltantes = CAMPOS_IMPORTACION_REQUERIDOS.filter((campo) => !campos.includes(campo));
    return { campos, faltantes };
}

function valorCeldaExcel(valor) {
    if (valor instanceof Date) return valor.toISOString().slice(0, 10);
    if (valor && typeof valor === 'object') {
        if (valor.text) return String(valor.text).trim();
        if (valor.result !== undefined) return String(valor.result).trim();
        return '';
    }
    return String(valor ?? '').trim();
}

async function extraerFilasExcel(buffer) {
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(buffer);
    const hoja = libro.worksheets[0];
    if (!hoja || hoja.rowCount < 2) throw new Error('El Excel debe incluir encabezados y al menos una fila de datos.');
    const encabezados = hoja.getRow(1).values.slice(1).map(valorCeldaExcel);
    const { campos, faltantes } = mapearEncabezados(encabezados);
    if (faltantes.length) throw new Error(`Faltan columnas requeridas: ${faltantes.join(', ')}.`);
    const filas = [];
    hoja.eachRow({ includeEmpty: false }, (fila, numero) => {
        if (numero === 1) return;
        const valores = fila.values.slice(1);
        if (!valores.some((valor) => valor !== null && valor !== undefined && valor !== '')) return;
        const registro = {};
        campos.forEach((campo, indice) => { if (campo) registro[campo] = valorCeldaExcel(valores[indice]); });
        filas.push({ numero, registro });
    });
    return filas;
}

async function extraerTextoPDF(buffer) {
    if (typeof pdfParse === 'function') return (await pdfParse(buffer)).text || '';
    if (pdfParse.PDFParse) {
        const parser = new pdfParse.PDFParse({ data: buffer });
        try {
            const resultado = await parser.getText();
            return resultado.text || '';
        } finally {
            await parser.destroy();
        }
    }
    throw new Error('La versión instalada de pdf-parse no tiene una API compatible.');
}

async function extraerFilasPDF(buffer) {
    const texto = await extraerTextoPDF(buffer);
    const lineas = texto.split(/\r?\n/).map((linea) => linea.trim()).filter(Boolean);
    const separar = (linea) => linea.split(/\s*\|\s*|\t+|;|\s{2,}/).map((valor) => valor.trim()).filter(Boolean);
    const indiceEncabezado = lineas.findIndex((linea) => {
        const mapping = mapearEncabezados(separar(linea));
        return mapping.campos.includes('id_equipo') && mapping.campos.includes('nombre_equipo');
    });
    if (indiceEncabezado < 0) throw new Error('No se encontró una tabla de texto con encabezados. Usa columnas separadas por |, punto y coma, tabulador o espacios múltiples; los PDF escaneados requieren OCR.');
    const encabezados = separar(lineas[indiceEncabezado]);
    const { campos, faltantes } = mapearEncabezados(encabezados);
    if (faltantes.length) throw new Error(`Faltan columnas requeridas: ${faltantes.join(', ')}.`);
    return lineas.slice(indiceEncabezado + 1).map((linea, indice) => {
        const valores = separar(linea);
        const registro = {};
        campos.forEach((campo, columna) => { if (campo) registro[campo] = valores[columna] || ''; });
        return { numero: indiceEncabezado + indice + 2, registro };
    }).filter(({ registro }) => Object.values(registro).some(Boolean));
}

// Iniciar sesión: devuelve un token JWT y los datos básicos del usuario
app.post('/api/login', (req, res) => {
    const { correo, password } = req.body || {};

    if (!correo || !password) {
        res.status(400).json({ error: 'Ingresa tu correo y tu contraseña' });
        return;
    }

    const correoNormalizado = String(correo).trim().toLowerCase();
    if (correoNormalizado.length > 254 || String(password).length > 128) {
        res.status(400).json({ error: 'El correo o la contraseña superan la longitud permitida' });
        return;
    }
    const claveIntento = claveIntentosLogin(correoNormalizado, req.ip || req.socket.remoteAddress || 'desconocida');
    const registroIntentos = intentosLogin.get(claveIntento);
    if (registroIntentos && registroIntentos.bloqueadoHasta > Date.now()) {
        const minutos = Math.ceil((registroIntentos.bloqueadoHasta - Date.now()) / 60000);
        res.status(429).json({ error: `Acceso bloqueado por demasiados intentos. Intenta de nuevo en ${minutos} minutos.` });
        return;
    }
    if (registroIntentos && registroIntentos.bloqueadoHasta > 0) intentosLogin.delete(claveIntento);

    const query = 'SELECT id_usuario, nombre, correo, password, rol FROM usuarios WHERE correo = ?';

    db.query(query, [correoNormalizado], (err, results) => {
        if (err) {
            console.error('Error al consultar el usuario:', err);
            res.status(500).json({ error: 'Error al iniciar sesión' });
            return;
        }

        const encontrado = results[0];
        const hash = encontrado ? encontrado.password : HASH_RELLENO;

        bcrypt.compare(String(password), hash, (errHash, coincide) => {
            if (errHash) {
                console.error('Error al verificar la contraseña:', errHash);
                res.status(500).json({ error: 'Error al iniciar sesión' });
                return;
            }

            if (!encontrado || !coincide) {
                const actual = intentosLogin.get(claveIntento) || { intentos: 0, bloqueadoHasta: 0 };
                actual.intentos += 1;
                actual.ultimoIntento = Date.now();
                if (actual.intentos >= INTENTOS_LOGIN_MAXIMOS) actual.bloqueadoHasta = Date.now() + DURACION_BLOQUEO_LOGIN_MS;
                intentosLogin.set(claveIntento, actual);
                if (actual.bloqueadoHasta > Date.now()) {
                    res.status(429).json({ error: 'Acceso bloqueado durante 15 minutos por superar los 3 intentos fallidos.' });
                    return;
                }
                const restantes = INTENTOS_LOGIN_MAXIMOS - actual.intentos;
                res.status(401).json({ error: `Correo o contraseña incorrectos. Te quedan ${restantes} ${restantes === 1 ? 'intento' : 'intentos'}.` });
                return;
            }

            intentosLogin.delete(claveIntento);

            const usuario = {
                id_usuario: encontrado.id_usuario,
                nombre: encontrado.nombre,
                correo: encontrado.correo,
                rol: encontrado.rol
            };

            const token = jwt.sign(usuario, JWT_SECRET, { expiresIn: JWT_EXPIRA });
            res.json({ token, usuario });
        });
    });
});

// Listar usuarios (solo Administrador). Nunca devuelve el hash.
app.get('/api/usuarios', verificarToken, soloAdministrador, (req, res) => {
    const query = 'SELECT id_usuario, nombre, correo, rol, creado_en FROM usuarios ORDER BY nombre';

    db.query(query, (err, results) => {
        if (err) {
            console.error('Error al listar usuarios:', err);
            res.status(500).json({ error: 'Error al obtener los usuarios' });
            return;
        }
        res.json(results);
    });
});

// Crear un usuario (solo Administrador). La contraseña se guarda con bcrypt.
app.post('/api/usuarios', verificarToken, soloAdministrador, (req, res) => {
    const { nombre, correo, password, rol } = req.body || {};
    const faltantes = ['nombre', 'correo', 'password', 'rol'].filter(
        (campo) => !req.body || !String(req.body[campo] ?? '').trim()
    );

    if (faltantes.length > 0) {
        res.status(400).json({ error: 'Faltan datos requeridos', campos_faltantes: faltantes });
        return;
    }

    if (!ROLES.includes(rol)) {
        res.status(400).json({ error: `El rol debe ser uno de: ${ROLES.join(', ')}` });
        return;
    }

    if (String(password).length < 8) {
        res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
        return;
    }

    bcrypt.hash(String(password), 10, (errHash, hash) => {
        if (errHash) {
            console.error('Error al cifrar la contraseña:', errHash);
            res.status(500).json({ error: 'Error al registrar el usuario' });
            return;
        }

        const query = 'INSERT INTO usuarios (nombre, correo, password, rol) VALUES (?, ?, ?, ?)';
        const valores = [String(nombre).trim(), String(correo).trim().toLowerCase(), hash, rol];

        db.query(query, valores, async (err, result) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') {
                    res.status(409).json({ error: 'Ya existe un usuario con ese correo' });
                    return;
                }
                console.error('Error al crear el usuario:', err);
                res.status(500).json({ error: 'Error al registrar el usuario' });
                return;
            }

            await registrarAuditoria(req, { modulo: 'usuarios', accion: 'crear', entidad: 'usuario', id_entidad: result.insertId, resumen: `Creó la cuenta ${String(correo).trim().toLowerCase()}.`, nuevos: { nombre: String(nombre).trim(), correo: String(correo).trim().toLowerCase(), rol } }).catch((e) => console.error('No se pudo guardar auditoría:', e.message));
            res.status(201).json({
                mensaje: 'Usuario registrado correctamente',
                id_usuario: result.insertId
            });
        });
    });
});

// Eliminar usuario (solo Administrador). Protege la cuenta propia y al último administrador.
app.delete('/api/usuarios/:id', verificarToken, soloAdministrador, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
        res.status(400).json({ error: 'El identificador del usuario no es válido' });
        return;
    }
    if (id === Number(req.usuario.id_usuario)) {
        res.status(400).json({ error: 'No puedes eliminar tu propia cuenta mientras tienes la sesión iniciada' });
        return;
    }

    db.query('SELECT rol FROM usuarios WHERE id_usuario = ?', [id], (errUsuario, usuariosEncontrados) => {
        if (errUsuario) {
            console.error('Error al consultar el usuario antes de eliminarlo:', errUsuario);
            res.status(500).json({ error: 'Error al eliminar el usuario' });
            return;
        }
        if (!usuariosEncontrados.length) {
            res.status(404).json({ error: 'Usuario no encontrado' });
            return;
        }
        const eliminarUsuario = () => db.query('DELETE FROM usuarios WHERE id_usuario = ?', [id], async (errEliminar, resultado) => {
            if (errEliminar) {
                console.error('Error al eliminar el usuario:', errEliminar);
                res.status(500).json({ error: 'No se pudo eliminar el usuario. Puede tener registros asociados.' });
                return;
            }
            if (!resultado.affectedRows) {
                res.status(404).json({ error: 'Usuario no encontrado' });
                return;
            }
            await registrarAuditoria(req, { modulo: 'usuarios', accion: 'eliminar', entidad: 'usuario', id_entidad: id, resumen: `Eliminó el usuario ${id}.`, anteriores: { rol: usuariosEncontrados[0].rol } }).catch((e) => console.error('No se pudo guardar auditoría:', e.message));
            res.json({ mensaje: 'Usuario eliminado correctamente', id_usuario: id });
        });

        if (usuariosEncontrados[0].rol !== 'Administrador') {
            eliminarUsuario();
            return;
        }
        db.query("SELECT COUNT(*) AS cantidad FROM usuarios WHERE rol = 'Administrador'", (errConteo, filas) => {
            if (errConteo) {
                console.error('Error al verificar administradores:', errConteo);
                res.status(500).json({ error: 'Error al verificar administradores' });
                return;
            }
            if (Number(filas[0].cantidad) <= 1) {
                res.status(400).json({ error: 'No se puede eliminar el último administrador del sistema' });
                return;
            }
            eliminarUsuario();
        });
    });
});

// =============================================================================
// INVENTARIO DE EQUIPOS
// =============================================================================

// Todo /api/equipos requiere sesión iniciada (cualquier rol).
// Las acciones que modifican el inventario además exigen rol Administrador.
app.use('/api/equipos', verificarToken);
app.use('/api/usuarios', verificarToken);
app.use('/api/mantenimientos', verificarToken);

const SELECT_EQUIPO = `
    SELECT e.*,
           EXISTS (
             SELECT 1 FROM tecnovigilancia_bloqueos b
             WHERE b.id_equipo = e.id_equipo AND b.activo
           ) AS en_cuarentena,
           DATE_FORMAT(e.proximo_mto_preventivo, '%Y-%m-%d') AS fecha_proximo_mto_preventivo,
           DATEDIFF(e.proximo_mto_preventivo, CURRENT_DATE) AS dias_hasta_preventivo,
           CASE
             WHEN e.proximo_mto_preventivo IS NULL THEN 'Sin programar'
             WHEN e.proximo_mto_preventivo < CURRENT_DATE THEN 'Vencido'
             WHEN e.proximo_mto_preventivo <= DATE_ADD(CURRENT_DATE, INTERVAL 15 DAY) THEN 'Próximo'
             ELSE 'Al día'
           END AS estado_mantenimiento_preventivo
    FROM equipos e`;

// Campos requeridos para crear o actualizar un equipo
const CAMPOS_EQUIPO = [
    'id_equipo',
    'nombre_equipo',
    'marca',
    'modelo',
    'numero_serie',
    'nivel_riesgo',
    'ubicacion',
    'estado',
    'tipo_categoria',
    'proximo_mto_preventivo'
];

const CAMPOS_ACTUALIZACION = CAMPOS_EQUIPO.filter((campo) => campo !== 'id_equipo');

function validarCamposRequeridos(datos, campos) {
    return campos.filter((campo) => {
        const valor = datos[campo];
        return valor === undefined || valor === null || String(valor).trim() === '';
    });
}

function fechaISOValidaOpcional(fecha) {
    if (fecha === undefined || fecha === null || fecha === '') return true;
    return typeof fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fecha) && !Number.isNaN(Date.parse(`${fecha}T00:00:00Z`)) && new Date(`${fecha}T00:00:00Z`).toISOString().slice(0, 10) === fecha;
}

// Ruta para obtener todos los equipos del inventario
app.get('/api/equipos', (req, res) => {
    const query = SELECT_EQUIPO;
    db.query(query, (err, results) => {
        if (err) {
            console.error('Error al consultar los equipos:', err);
            res.status(500).json({ error: 'Error al obtener el inventario' });
            return;
        }
        res.json(results);
    });
});

// Filtrar equipos por categoría (Biomédico o Tecnología)
// Se declara antes de /:id para evitar que "buscar" se interprete como identificador
app.get('/api/equipos/buscar/categoria/:tipo', (req, res) => {
    const { tipo } = req.params;
    const query = `${SELECT_EQUIPO} WHERE e.tipo_categoria = ?`;

    db.query(query, [tipo], (err, results) => {
        if (err) {
            console.error('Error al filtrar equipos por categoría:', err);
            res.status(500).json({ error: 'Error al buscar equipos por categoría' });
            return;
        }
        res.json(results);
    });
});

// Obtener un equipo específico por id_equipo
app.get('/api/equipos/:id', (req, res) => {
    const { id } = req.params;
    const query = `${SELECT_EQUIPO} WHERE e.id_equipo = ?`;

    db.query(query, [id], (err, results) => {
        if (err) {
            console.error('Error al consultar el equipo:', err);
            res.status(500).json({ error: 'Error al obtener el equipo' });
            return;
        }

        if (results.length === 0) {
            res.status(404).json({ error: 'Equipo no encontrado' });
            return;
        }

        res.json(results[0]);
    });
});

// Crear un nuevo equipo en el inventario (solo Administrador)
app.post('/api/equipos', soloAdministrador, (req, res) => {
    const faltantes = validarCamposRequeridos(req.body, CAMPOS_EQUIPO.filter((campo) => campo !== 'proximo_mto_preventivo'));

    if (faltantes.length > 0) {
        res.status(400).json({
            error: 'Faltan datos requeridos',
            campos_faltantes: faltantes
        });
        return;
    }

    if (!fechaISOValidaOpcional(req.body.proximo_mto_preventivo)) {
        res.status(400).json({ error: 'La fecha del próximo mantenimiento preventivo no es válida' });
        return;
    }

    const idEquipo = String(req.body.id_equipo || '').trim();
    const valores = CAMPOS_EQUIPO.map((campo) => campo === 'id_equipo'
        ? idEquipo
        : campo === 'proximo_mto_preventivo' ? (req.body[campo] || null) : req.body[campo]);
    const placeholders = CAMPOS_EQUIPO.map(() => '?').join(', ');
    const query = `INSERT INTO equipos (${CAMPOS_EQUIPO.join(', ')}) VALUES (${placeholders})`;

    db.query(query, valores, async (err) => {
        if (err) {
            console.error('Error al crear el equipo:', err);
            if (err.code === '23505') {
                res.status(409).json({ error: `El ID ${idEquipo} ya está registrado y no se puede reutilizar. Elige un ID diferente.` });
                return;
            }
            res.status(500).json({ error: 'Error al registrar el equipo' });
            return;
        }

        await registrarAuditoria(req, { modulo: 'equipos', accion: 'crear', entidad: 'equipo', id_entidad: idEquipo, resumen: `Registró el equipo ${idEquipo}.`, nuevos: Object.fromEntries(CAMPOS_EQUIPO.filter((campo) => campo !== 'foto_equipo').map((campo) => [campo, req.body[campo] || null])) }).catch((e) => console.error('No se pudo guardar auditoría:', e.message));
        res.status(201).json({
            mensaje: 'Equipo registrado correctamente',
            id_equipo: req.body.id_equipo
        });
    });
});

// Actualizar los datos de un equipo existente (solo Administrador)
function sinCuarentenaActiva(req, res, next) {
    db.query('SELECT id_bloqueo FROM tecnovigilancia_bloqueos WHERE id_equipo = ? AND activo LIMIT 1', [req.params.id], (err, filas) => {
        if (err) {
            console.error('Error al comprobar el bloqueo de tecnovigilancia:', err);
            res.status(503).json({ error: 'No se pudo comprobar si el equipo tiene una cuarentena activa.' });
            return;
        }
        if (filas.length) {
            res.status(423).json({ error: 'Equipo bloqueado por tecnovigilancia. Un Administrador debe cerrar los reportes abiertos y liberar la cuarentena.' });
            return;
        }
        next();
    });
}

function comprobarEquipoEnCuarentena(idEquipo, callback) {
    db.query('SELECT id_bloqueo FROM tecnovigilancia_bloqueos WHERE id_equipo = ? AND activo LIMIT 1', [idEquipo], (err, filas) => {
        callback(err, !err && filas.length > 0);
    });
}

app.put('/api/equipos/:id', soloAdministrador, sinCuarentenaActiva, (req, res) => {
    const { id } = req.params;
    const camposObligatorios = CAMPOS_ACTUALIZACION.filter((campo) => campo !== 'proximo_mto_preventivo');
    const faltantes = validarCamposRequeridos(req.body, camposObligatorios);

    if (faltantes.length > 0) {
        res.status(400).json({
            error: 'Faltan datos requeridos',
            campos_faltantes: faltantes
        });
        return;
    }

    if (!fechaISOValidaOpcional(req.body.proximo_mto_preventivo)) {
        res.status(400).json({ error: 'La fecha del próximo mantenimiento preventivo no es válida' });
        return;
    }

    const setClause = CAMPOS_ACTUALIZACION.map((campo) => `${campo} = ?`).join(', ');
    const valores = [...CAMPOS_ACTUALIZACION.map((campo) => campo === 'proximo_mto_preventivo' ? (req.body[campo] || null) : req.body[campo]), id];
    const query = `UPDATE equipos SET ${setClause} WHERE id_equipo = ? AND NOT EXISTS (SELECT 1 FROM tecnovigilancia_bloqueos b WHERE b.id_equipo = equipos.id_equipo AND b.activo)`;

    db.query(`SELECT ${CAMPOS_ACTUALIZACION.join(', ')} FROM equipos WHERE id_equipo = ?`, [id], (errPrevio, previos) => {
      if (errPrevio) { res.status(500).json({ error: 'No se pudo consultar el equipo antes de actualizarlo' }); return; }
      db.query(query, valores, async (err, result) => {
        if (err) {
            console.error('Error al actualizar el equipo:', err);
            res.status(500).json({ error: 'Error al actualizar el equipo' });
            return;
        }

        if (result.affectedRows === 0) {
            res.status(423).json({ error: 'Equipo no encontrado o bloqueado por tecnovigilancia.' });
            return;
        }

        const nuevos = Object.fromEntries(CAMPOS_ACTUALIZACION.map((campo) => [campo, req.body[campo] || null]));
        await registrarAuditoria(req, { modulo: 'equipos', accion: 'actualizar', entidad: 'equipo', id_entidad: id, resumen: `Actualizó el equipo ${id}.`, anteriores: previos[0] || {}, nuevos }).catch((e) => console.error('No se pudo guardar auditoría:', e.message));
        res.status(200).json({
            mensaje: 'Equipo actualizado correctamente',
            id_equipo: id
        });
      });
    });
});

// Eliminar un equipo por su id_equipo (solo Administrador)
app.delete('/api/equipos/:id', soloAdministrador, sinCuarentenaActiva, (req, res) => {
    const { id } = req.params;
    const query = 'DELETE FROM equipos WHERE id_equipo = ? AND NOT EXISTS (SELECT 1 FROM tecnovigilancia_bloqueos b WHERE b.id_equipo = equipos.id_equipo AND b.activo)';
    db.query('SELECT id_equipo, nombre_equipo, estado FROM equipos WHERE id_equipo = ?', [id], (errPrevio, previos) => {
      if (errPrevio) return res.status(500).json({ error: 'Error al consultar el equipo' });
      db.query(query, [id], async (err, result) => {
        if (err) {
            console.error('Error al eliminar el equipo:', err);
            res.status(500).json({ error: 'Error al eliminar el equipo' });
            return;
        }

        if (result.affectedRows === 0) {
            res.status(423).json({ error: 'Equipo no encontrado o bloqueado por tecnovigilancia.' });
            return;
        }

        await registrarAuditoria(req, { modulo: 'equipos', accion: 'eliminar', entidad: 'equipo', id_entidad: id, resumen: `Eliminó el equipo ${id}.`, anteriores: previos[0] || {} }).catch((e) => console.error('No se pudo guardar auditoría:', e.message));
        res.status(200).json({
            mensaje: 'Equipo eliminado correctamente',
            id_equipo: id
        });
      });
    });
});

// -----------------------------------------------------------------------------
// ESTADO DEL EQUIPO
// Administrador: cualquier estado. Técnico: solo alterna entre Operativo y
// En mantenimiento; dar de baja o reactivar un equipo fuera de servicio es del Administrador.
// -----------------------------------------------------------------------------
const ESTADOS_EQUIPO = ['Operativo', 'En mantenimiento', 'Fuera de servicio'];

app.patch('/api/equipos/:id/estado', sinCuarentenaActiva, (req, res) => {
    const { id } = req.params;
    const pedido = String((req.body && req.body.estado) ?? '').trim().toLowerCase();
    const nuevo = ESTADOS_EQUIPO.find((estado) => estado.toLowerCase() === pedido);

    if (!nuevo) {
        res.status(400).json({ error: `El estado debe ser uno de: ${ESTADOS_EQUIPO.join(', ')}` });
        return;
    }

    db.query('SELECT estado FROM equipos WHERE id_equipo = ?', [id], (err, results) => {
        if (err) {
            console.error('Error al consultar el estado del equipo:', err);
            res.status(500).json({ error: 'Error al cambiar el estado' });
            return;
        }

        if (results.length === 0) {
            res.status(404).json({ error: 'Equipo no encontrado' });
            return;
        }

        const actual = String(results[0].estado || '').toLowerCase();
        const afectaBaja = actual === 'fuera de servicio' || nuevo === 'Fuera de servicio';

        if (req.usuario.rol !== 'Administrador' && afectaBaja) {
            res.status(403).json({ error: 'Solo un Administrador puede dar de baja o reactivar un equipo' });
            return;
        }

        db.query("UPDATE equipos SET estado = ? WHERE id_equipo = ? AND NOT EXISTS (SELECT 1 FROM tecnovigilancia_bloqueos b WHERE b.id_equipo = equipos.id_equipo AND b.activo)", [nuevo, id], async (errUpdate, resultadoUpdate) => {
            if (errUpdate) {
                console.error('Error al cambiar el estado del equipo:', errUpdate);
                res.status(500).json({ error: 'Error al cambiar el estado' });
                return;
            }
            if (!resultadoUpdate.affectedRows) {
                res.status(423).json({ error: 'El equipo fue puesto en cuarentena por tecnovigilancia y no se puede cambiar su estado.' });
                return;
            }
            await registrarAuditoria(req, { modulo: 'equipos', accion: 'cambiar_estado', entidad: 'equipo', id_entidad: id, resumen: `Cambió el estado del equipo ${id}.`, anteriores: { estado: results[0].estado }, nuevos: { estado: nuevo } }).catch((e) => console.error('No se pudo guardar auditoría:', e.message));
            res.json({ mensaje: 'Estado actualizado correctamente', id_equipo: id, estado: nuevo });
        });
    });
});

// Programar o limpiar la fecha preventiva próxima (solo Administrador).
app.patch('/api/equipos/:id/proximo-preventivo', soloAdministrador, sinCuarentenaActiva, (req, res) => {
    const fecha = req.body && req.body.fecha_proximo_mto_preventivo;
    if (fecha !== null && fecha !== '' && (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha) || Number.isNaN(Date.parse(`${fecha}T00:00:00Z`)) || new Date(`${fecha}T00:00:00Z`).toISOString().slice(0, 10) !== fecha)) {
        res.status(400).json({ error: 'La fecha programada no es válida' });
        return;
    }
    db.query('SELECT proximo_mto_preventivo FROM equipos WHERE id_equipo = ?', [req.params.id], (errPrevio, previos) => {
      if (errPrevio) return res.status(500).json({ error: 'No se pudo consultar la fecha actual.' });
      db.query("UPDATE equipos SET proximo_mto_preventivo = ? WHERE id_equipo = ? AND NOT EXISTS (SELECT 1 FROM tecnovigilancia_bloqueos b WHERE b.id_equipo = equipos.id_equipo AND b.activo)", [fecha || null, req.params.id], async (err, result) => {
        if (err) {
            console.error('Error al actualizar la fecha preventiva:', err);
            res.status(500).json({ error: 'Error al actualizar la fecha preventiva. Verifica que ejecutaste database/migrations/alertas_analitica.sql.' });
            return;
        }
        if (!result.affectedRows) {
            res.status(423).json({ error: 'Equipo no encontrado o bloqueado por tecnovigilancia.' });
            return;
        }
        await registrarAuditoria(req, { modulo: 'equipos', accion: 'programar_preventivo', entidad: 'equipo', id_entidad: req.params.id, resumen: `Actualizó la programación preventiva del equipo ${req.params.id}.`, anteriores: previos[0] || {}, nuevos: { proximo_mto_preventivo: fecha || null } }).catch((e) => console.error('No se pudo guardar auditoría:', e.message));
        db.query(`${SELECT_EQUIPO} WHERE e.id_equipo = ?`, [req.params.id], (errEquipo, equipos) => {
            if (errEquipo) {
                res.status(500).json({ error: 'La fecha se guardó, pero no se pudo leer el equipo' });
                return;
            }
            res.json(equipos[0]);
        });
      });
    });
});

// Reprogramación justificada del preventivo, limitada a siete días desde la fecha vigente.
app.post('/api/equipos/:id/reprogramar-preventivo', verificarToken, sinCuarentenaActiva, async (req, res) => {
    const id = req.params.id;
    const nuevaFecha = String(req.body?.nueva_fecha || '');
    const motivo = String(req.body?.motivo || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nuevaFecha) || Number.isNaN(Date.parse(`${nuevaFecha}T00:00:00Z`)) || new Date(`${nuevaFecha}T00:00:00Z`).toISOString().slice(0, 10) !== nuevaFecha) return res.status(400).json({ error: 'Selecciona una fecha válida.' });
    if (motivo.length < 10 || motivo.length > 600) return res.status(400).json({ error: 'Escribe un motivo de al menos 10 caracteres.' });
    try {
        const reprogramacion = await db.transaction(async (tx) => {
            const equipos = await tx.query('SELECT id_equipo, nombre_equipo, ubicacion, proximo_mto_preventivo FROM equipos WHERE id_equipo = ? FOR UPDATE', [id]);
            if (!equipos.length) throw Object.assign(new Error('Equipo no encontrado.'), { status: 404 });
            const equipo = equipos[0];
            const fechaAnterior = equipo.proximo_mto_preventivo ? new Date(equipo.proximo_mto_preventivo).toISOString().slice(0, 10) : '';
            if (!fechaAnterior) throw Object.assign(new Error('Este equipo no tiene mantenimiento preventivo programado.'), { status: 409 });
            const diferencia = Math.round((Date.parse(`${nuevaFecha}T00:00:00Z`) - Date.parse(`${fechaAnterior}T00:00:00Z`)) / 86400000);
            if (diferencia < 1 || diferencia > 7) throw Object.assign(new Error('La nueva fecha debe ser de 1 a 7 días después de la fecha programada.'), { status: 400 });
            const bloqueo = await tx.query('SELECT id_equipo FROM tecnovigilancia_bloqueos WHERE id_equipo = ? AND activo FOR UPDATE', [id]);
            if (bloqueo.length) throw Object.assign(new Error('El equipo está bloqueado por Tecnovigilancia.'), { status: 423 });
            await tx.query('UPDATE equipos SET proximo_mto_preventivo = ? WHERE id_equipo = ?', [nuevaFecha, id]);
            const insertado = await tx.query(`INSERT INTO reprogramaciones_mantenimiento_preventivo
                (id_equipo, fecha_anterior, fecha_nueva, motivo, id_usuario, nombre_usuario)
                VALUES (?, ?, ?, ?, ?, ?) RETURNING id_reprogramacion`, [id, fechaAnterior, nuevaFecha, motivo, req.usuario.id_usuario, req.usuario.nombre]);
            await registrarAuditoria(req, { modulo: 'mantenimientos', accion: 'reprogramar_preventivo', entidad: 'equipo', id_entidad: id,
                resumen: `Reprogramó el mantenimiento preventivo de ${id} del ${fechaAnterior} al ${nuevaFecha}.`,
                anteriores: { proximo_mto_preventivo: fechaAnterior }, nuevos: { proximo_mto_preventivo: nuevaFecha, motivo, reprogramado_por: req.usuario.nombre } }, tx);
            return { id_reprogramacion: insertado.insertId, id_equipo: id, nombre_equipo: equipo.nombre_equipo, ubicacion: equipo.ubicacion, fecha_anterior: fechaAnterior, fecha_nueva: nuevaFecha, motivo, nombre_usuario: req.usuario.nombre };
        });
        let correo = 'pendiente_configuracion';
        const host = process.env.SMTP_HOST, usuarioSMTP = process.env.SMTP_USER, claveSMTP = process.env.SMTP_PASS, remitente = process.env.MAIL_FROM || usuarioSMTP;
        if (host && usuarioSMTP && claveSMTP && remitente) {
            try {
                const [admins] = await db.promise().query("SELECT correo FROM usuarios WHERE rol = 'Administrador' AND correo IS NOT NULL AND correo <> ''");
                const destinos = [...new Set(admins.map((u) => String(u.correo).trim()).filter((c) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)))];
                if (destinos.length) {
                    const puerto = Number(process.env.SMTP_PORT || 587);
                    const transporte = nodemailer.createTransport({ host, port: puerto, secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : puerto === 465, auth: { user: usuarioSMTP, pass: claveSMTP } });
                    const esc = escaparHtmlServidor;
                    const fechaBonita = (valor) => {
                        const [anio, mes, dia] = String(valor).slice(0, 10).split('-').map(Number);
                        return new Date(Date.UTC(anio, mes - 1, dia, 12)).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Bogota' });
                    };
                    const appUrl = String(process.env.APP_PUBLIC_URL || '').trim().replace(/\/$/, '');
                    const botonApp = /^https?:\/\//i.test(appUrl) ? `<div style="margin-top:26px"><a href="${esc(appUrl + '/#inventario')}" style="display:inline-block;padding:13px 19px;border-radius:10px;background:#0d7377;color:#fff;text-decoration:none;font-weight:700">Abrir inventario en BioMant</a></div>` : '';
                    await transporte.sendMail({ from: remitente, to: destinos, subject: `BioMant | Preventivo reprogramado · ${id}`,
                        text: `AVISO ADMINISTRATIVO · MANTENIMIENTO PREVENTIVO REPROGRAMADO\n\nEquipo: ${reprogramacion.nombre_equipo} (${id})\nUbicación: ${reprogramacion.ubicacion}\nFecha programada anterior: ${fechaBonita(reprogramacion.fecha_anterior)}\nNueva fecha acordada: ${fechaBonita(reprogramacion.fecha_nueva)}\nMotivo: ${motivo}\nReprogramado por: ${reprogramacion.nombre_usuario}\n\nEl cambio quedó registrado en la bitácora de BioMant.`,
                        html: `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:24px 12px;background:#edf3f5;font-family:Arial,Helvetica,sans-serif;color:#19363b"><div style="display:none;max-height:0;overflow:hidden;opacity:0">El mantenimiento preventivo de ${esc(id)} cambió de fecha. Consulta el motivo y el nuevo plazo.</div><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #dce7e9;border-radius:18px;overflow:hidden"><tr><td style="padding:26px 30px;background:#082f31;background-image:linear-gradient(120deg,#082f31,#0d7377);color:#fff"><table role="presentation" width="100%"><tr><td width="54" valign="middle"><div style="width:46px;height:46px;line-height:46px;text-align:center;border-radius:14px;background:#0d8587;color:#fff;font-size:25px;font-weight:bold">B</div></td><td style="padding-left:12px"><div style="font-size:21px;font-weight:700">BioMant</div><div style="margin-top:4px;font-size:12px;color:#b9e8e1">Gestión de mantenimiento clínico</div></td><td align="right" style="font-size:10px;line-height:1.5;letter-spacing:1px;color:#c9f7ed;font-weight:bold">AVISO<br>ADMINISTRATIVO</td></tr></table></td></tr><tr><td style="padding:30px"><div style="display:inline-block;padding:6px 10px;border-radius:20px;background:#fff5db;color:#98600a;font-size:11px;font-weight:bold;letter-spacing:.4px">PREVENTIVO · FECHA REPROGRAMADA</div><h1 style="margin:15px 0 8px;font-size:25px;line-height:1.2;color:#12383b">Se actualizó la fecha de mantenimiento</h1><p style="margin:0 0 22px;color:#607579;font-size:14px;line-height:1.6">Se registró un cambio en la programación preventiva. Revisa el motivo y la nueva fecha para coordinar el seguimiento.</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0;background:#f5f9fa;border:1px solid #e2ebed;border-radius:12px"><tr><td style="padding:16px 18px;border-bottom:1px solid #e2ebed"><div style="font-size:10px;font-weight:bold;letter-spacing:1px;color:#71868a">EQUIPO</div><div style="margin-top:6px;font-size:17px;font-weight:bold;color:#173d40">${esc(reprogramacion.nombre_equipo)}</div><div style="margin-top:3px;font-family:monospace;font-size:12px;color:#0d7377">${esc(id)}</div></td></tr><tr><td style="padding:14px 18px"><div style="font-size:10px;font-weight:bold;letter-spacing:1px;color:#71868a">UBICACIÓN</div><div style="margin-top:5px;font-size:14px;color:#19363b">${esc(reprogramacion.ubicacion || 'No especificada')}</div></td></tr></table><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;border-spacing:8px 0"><tr><td width="50%" valign="top" style="padding:14px;border:1px solid #f0dada;border-radius:11px;background:#fff7f6"><div style="font-size:10px;font-weight:bold;letter-spacing:.8px;color:#9a6262">FECHA ANTERIOR</div><div style="margin-top:8px;font-size:15px;color:#694848">${esc(fechaBonita(reprogramacion.fecha_anterior))}</div></td><td width="50%" valign="top" style="padding:14px;border:1px solid #c9e9de;border-radius:11px;background:#effaf5"><div style="font-size:10px;font-weight:bold;letter-spacing:.8px;color:#347765">NUEVA FECHA</div><div style="margin-top:8px;font-size:15px;font-weight:bold;color:#176653">${esc(fechaBonita(reprogramacion.fecha_nueva))}</div></td></tr></table><div style="margin-top:18px;padding:17px 18px;border-left:4px solid #e5a52b;border-radius:9px;background:#fff9eb"><div style="font-size:10px;font-weight:bold;letter-spacing:1px;color:#93651a">MOTIVO DEL CAMBIO</div><div style="margin-top:8px;font-size:14px;line-height:1.6;color:#493b20;white-space:pre-wrap">${esc(motivo)}</div></div><div style="margin-top:16px;padding:15px 18px;border:1px solid #e7edef;border-radius:10px"><div style="font-size:10px;font-weight:bold;letter-spacing:1px;color:#71868a">REPROGRAMADO POR</div><div style="margin-top:6px;font-size:14px;font-weight:bold;color:#19363b">${esc(reprogramacion.nombre_usuario)}</div></div>${botonApp}</td></tr><tr><td style="padding:17px 30px;background:#f7f9fa;border-top:1px solid #e8eef0;color:#839397;font-size:11px;line-height:1.5">Este cambio quedó registrado en la trazabilidad de BioMant. Mensaje automático para seguimiento administrativo.</td></tr></table></body></html>` });
                    correo = 'enviado';
                } else correo = 'sin_destinatarios';
            } catch (error) { console.error('Error al enviar aviso de reprogramación:', error.message); correo = 'fallido'; }
        }
        res.status(201).json({ mensaje: 'Mantenimiento reprogramado correctamente.', reprogramacion, correo });
    } catch (error) { res.status(error.status || 500).json({ error: error.message || 'No se pudo reprogramar el mantenimiento.' }); }
});

app.get('/api/equipos/:id/qr', async (req, res) => {
    db.query('SELECT id_equipo FROM equipos WHERE id_equipo = ?', [req.params.id], async (err, equipos) => {
        if (err) {
            res.status(500).json({ error: 'No se pudo generar el QR.' });
            return;
        }
        if (!equipos.length) {
            res.status(404).json({ error: 'Equipo no encontrado.' });
            return;
        }
        try {
            const baseUrl = (process.env.APP_PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
            const fichaUrl = `${baseUrl}/?equipo=${encodeURIComponent(equipos[0].id_equipo)}`;
            const qr = await QRCode.toDataURL(fichaUrl, { width: 320, margin: 2, errorCorrectionLevel: 'M' });
            res.json({ url: fichaUrl, qr });
        } catch (error) {
            console.error('Error al generar el QR:', error);
            res.status(500).json({ error: 'No se pudo generar el QR.' });
        }
    });
});

// Devuelve una URL temporal para visualizar una foto guardada en el bucket privado.
app.get('/api/equipos/:id/imagen-url', async (req, res) => {
    try {
        const equipos = await db.query('SELECT foto_equipo FROM equipos WHERE id_equipo = ?', [req.params.id]);
        if (!equipos.length) {
            res.status(404).json({ error: 'Equipo no encontrado.' });
            return;
        }
        const ruta = String(equipos[0].foto_equipo || '');
        const prefijoStorage = 'supabase-storage://';
        if (!ruta.startsWith(prefijoStorage)) {
            res.status(400).json({ error: 'El equipo no tiene una foto almacenada en Supabase Storage.' });
            return;
        }
        const objeto = ruta.slice(prefijoStorage.length);
        const { baseUrl, datos } = await solicitarStorage(
            `object/sign/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/${rutaStorageCodificada(objeto)}`,
            { method: 'POST', body: JSON.stringify({ expiresIn: 3600 }) }
        );
        const signedURL = String(datos.signedURL || '');
        const urlFirmada = /^https?:\/\//i.test(signedURL)
            ? signedURL
            : `${baseUrl}${signedURL.startsWith('/storage/v1/') ? '' : '/storage/v1'}${signedURL.startsWith('/') ? signedURL : `/${signedURL}`}`;
        res.json({ url: urlFirmada });
    } catch (error) {
        console.error('Error al preparar la imagen desde Supabase Storage:', error.message || error);
        res.status(500).json({ error: 'No se pudo obtener la imagen desde Supabase Storage.' });
    }
});

// Carga de foto: solo Administrador, formatos JPEG/PNG/WebP, máximo 5 MB.
app.post('/api/equipos/:id/imagen', soloAdministrador, sinCuarentenaActiva, (req, res) => {
    uploadImagenEquipo(req, res, (errUpload) => {
        if (errUpload) {
            res.status(400).json({ error: errUpload.code === 'LIMIT_FILE_SIZE' ? 'La imagen supera el límite de 5 MB.' : 'No se pudo procesar la imagen.' });
            return;
        }
        if (!req.file) {
            res.status(400).json({ error: 'Selecciona una imagen JPEG, PNG o WebP.' });
            return;
        }
        const firma = req.file.buffer;
        let extension = null;
        if (firma.length >= 3 && firma[0] === 0xff && firma[1] === 0xd8 && firma[2] === 0xff) extension = 'jpg';
        else if (firma.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) extension = 'png';
        else if (firma.length >= 12 && firma.toString('ascii', 0, 4) === 'RIFF' && firma.toString('ascii', 8, 12) === 'WEBP') extension = 'webp';
        if (!extension) {
            res.status(400).json({ error: 'El archivo no parece ser una imagen JPEG, PNG o WebP válida.' });
            return;
        }
        const mimeType = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[extension];
        (async () => {
            let rutaObjeto = null;
            try {
                await asegurarBucketStorage();
                rutaObjeto = `${req.params.id}/${crypto.randomUUID()}.${extension}`;
                await solicitarStorage(
                    `object/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/${rutaStorageCodificada(rutaObjeto)}`,
                    { method: 'POST', headers: { 'Content-Type': mimeType, 'x-upsert': 'false' }, body: firma }
                );
                const rutaGuardada = `supabase-storage://${rutaObjeto}`;
                const resultado = await db.query('UPDATE equipos SET foto_equipo = ? WHERE id_equipo = ?', [rutaGuardada, req.params.id]);
                if (!resultado.affectedRows) {
                    await solicitarStorage(
                        `object/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/${rutaStorageCodificada(rutaObjeto)}`,
                        { method: 'DELETE' }
                    ).catch(() => {});
                    res.status(404).json({ error: 'Equipo no encontrado.' });
                    return;
                }
                res.json({ foto_equipo: rutaGuardada });
            } catch (error) {
                if (rutaObjeto) {
                    await solicitarStorage(
                        `object/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/${rutaStorageCodificada(rutaObjeto)}`,
                        { method: 'DELETE' }
                    ).catch(() => {});
                }
                console.error('Error al guardar la imagen en Supabase Storage:', error.message || error);
                const faltaConfiguracion = /SUPABASE_(SECRET_KEY|SERVICE_ROLE_KEY|URL)/.test(error.message || '');
                res.status(faltaConfiguracion ? 503 : 502).json({
                    error: faltaConfiguracion
                        ? 'Configura SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el servidor para activar las fotos en Supabase Storage.'
                        : 'No se pudo guardar la imagen en Supabase Storage.'
                });
            }
        })();
    });
});

// Importar inventario desde Excel o PDF tabular (solo Administrador).
app.post('/api/equipos/importar', soloAdministrador, (req, res) => {
    uploadImportacion(req, res, async (errUpload) => {
        if (errUpload) {
            res.status(400).json({ error: errUpload.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera el límite de 15 MB.' : 'No se pudo procesar el archivo.' });
            return;
        }
        if (!req.file) {
            res.status(400).json({ error: 'Selecciona un archivo .xlsx o .pdf.' });
            return;
        }

        try {
            const extension = path.extname(req.file.originalname).toLowerCase();
            if (!['.xlsx', '.pdf'].includes(extension)) {
                res.status(400).json({ error: 'El formato debe ser Excel .xlsx o PDF.' });
                return;
            }
            const filas = extension === '.xlsx'
                ? await extraerFilasExcel(req.file.buffer)
                : await extraerFilasPDF(req.file.buffer);
            if (!filas.length) {
                res.status(400).json({ error: 'El archivo no contiene filas de equipos.' });
                return;
            }
            if (filas.length > 5000) {
                res.status(400).json({ error: 'El archivo supera el máximo de 5.000 filas por importación.' });
                return;
            }

            const insertSql = `INSERT IGNORE INTO equipos
                (id_equipo, nombre_equipo, marca, modelo, numero_serie, nivel_riesgo, ubicacion, estado, tipo_categoria, proximo_mto_preventivo, foto_equipo)
                VALUES ?`;
            const estadosValidos = ['Operativo', 'En mantenimiento', 'Fuera de servicio'];
            const categoriasValidas = ['Biomédico', 'Tecnología'];
            const riesgosValidos = new Map([
                ['i', 'I'], ['bajo', 'I'],
                ['iia', 'IIA'], ['moderado', 'IIA'], ['medio', 'IIA'],
                ['iib', 'IIB'], ['alto', 'IIB'],
                ['iii', 'III'], ['muyalto', 'III']
            ]);
            const errores = [];
            const registrosValidos = [];
            for (const fila of filas) {
                const registro = Object.fromEntries(Object.entries(fila.registro).map(([campo, valor]) => [campo, String(valor ?? '').trim()]));
                const faltantes = CAMPOS_IMPORTACION_REQUERIDOS.filter((campo) => !registro[campo]);
                const errorFila = (mensaje) => errores.push({ fila: fila.numero, error: mensaje });
                if (faltantes.length) { errorFila(`Faltan datos: ${faltantes.join(', ')}`); continue; }
                if (registro.id_equipo.length > 30 || registro.nombre_equipo.length > 255 || registro.marca.length > 100 || registro.modelo.length > 100 || registro.numero_serie.length > 100 || registro.ubicacion.length > 150 || (registro.foto_equipo && registro.foto_equipo.length > 255)) {
                    errorFila('Uno o más campos exceden la longitud permitida.'); continue;
                }
                if (registro.foto_equipo && !/^(https?:\/\/|\/uploads\/)/i.test(registro.foto_equipo)) {
                    errorFila('La fotografía debe usar una URL http(s) o una ruta /uploads/.'); continue;
                }
                const estado = estadosValidos.find((valor) => normalizarEncabezado(valor) === normalizarEncabezado(registro.estado));
                const categoria = categoriasValidas.find((valor) => normalizarEncabezado(valor) === normalizarEncabezado(registro.tipo_categoria));
                const riesgo = riesgosValidos.get(normalizarEncabezado(registro.nivel_riesgo));
                if (!estado || !categoria || !riesgo) {
                    const camposInvalidos = [!estado && 'estado', !categoria && 'categoría', !riesgo && 'nivel de riesgo'].filter(Boolean);
                    errorFila(`Valor no válido en ${camposInvalidos.join(', ')}. Riesgos aceptados: I/Bajo, IIA/Moderado/Medio, IIB/Alto, III/Muy Alto.`);
                    continue;
                }
                const fechaProxima = registro.proximo_mto_preventivo || null;
                if (!fechaISOValidaOpcional(fechaProxima)) { errorFila('La fecha próxima debe tener formato AAAA-MM-DD.'); continue; }
                registrosValidos.push({ numero: fila.numero, valores: [
                    registro.id_equipo, registro.nombre_equipo, registro.marca, registro.modelo,
                    registro.numero_serie, riesgo, registro.ubicacion, estado, categoria,
                    fechaProxima, registro.foto_equipo || null
                ] });
            }
            let insertados = 0;
            let duplicados = 0;
            for (let inicio = 0; inicio < registrosValidos.length; inicio += 250) {
                const lote = registrosValidos.slice(inicio, inicio + 250);
                try {
                    const [resultado] = await db.promise().query(insertSql, [lote.map((fila) => fila.valores)]);
                    insertados += resultado.affectedRows;
                    duplicados += lote.length - resultado.affectedRows;
                } catch (errLote) {
                    console.error('Error al guardar un lote de inventario:', errLote);
                    lote.forEach((fila) => errores.push({ fila: fila.numero, error: 'La fila no se pudo guardar en la base de datos.' }));
                }
            }
            await registrarAuditoria(req, { modulo: 'importacion', accion: 'importar_inventario', entidad: 'lote_inventario', id_entidad: req.file.originalname, resumen: `Importación de inventario: ${insertados} agregados, ${duplicados} duplicados y ${errores.length} rechazados.`, nuevos: { total: filas.length, insertados, duplicados, rechazados: errores.length } }).catch((e) => console.error('No se pudo guardar auditoría:', e.message));
            res.json({ total: filas.length, insertados, duplicados, rechazados: errores.length, errores: errores.slice(0, 50) });
        } catch (error) {
            console.error('Error al importar el inventario:', error);
            res.status(400).json({ error: error.message || 'No se pudo leer el archivo. Verifica su formato.' });
        }
    });
});

// =============================================================================
// TECNOVIGILANCIA · ETAPA 1: recepción y trazabilidad de reportes
// =============================================================================

app.use('/api/tecnovigilancia', verificarToken);

const TIPOS_REPORTE_TECNOVIGILANCIA = [
    'evento_adverso_serio',
    'evento_adverso_no_serio',
    'incidente_adverso'
];

const SELECT_REPORTE_TECNOVIGILANCIA = `
    SELECT t.id_reporte, t.id_equipo, e.nombre_equipo, e.marca, e.modelo,
           e.numero_serie, e.ubicacion AS ubicacion_equipo,
           t.tipo_reporte,
           TO_CHAR(t.fecha_evento AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD"T"HH24:MI') AS fecha_evento,
           t.lugar_evento, t.descripcion, t.consecuencias, t.acciones_inmediatas,
           t.id_reportante, t.nombre_reportante, t.persona_manejaba,
           t.cargo_persona_manejaba, t.persona_presente, t.estado, t.creado_en,
           (b.id_bloqueo IS NOT NULL) AS equipo_en_cuarentena, b.motivo_bloqueo,
           b.estado_previo AS estado_equipo_previo
    FROM reportes_tecnovigilancia t
    JOIN equipos e ON e.id_equipo = t.id_equipo
    LEFT JOIN tecnovigilancia_bloqueos b ON b.id_equipo = t.id_equipo AND b.activo`;

async function notificarResponsablesTecnovigilancia(reporte, baseAplicacion) {
    const host = process.env.SMTP_HOST;
    const usuarioSMTP = process.env.SMTP_USER;
    const claveSMTP = process.env.SMTP_PASS;
    const remitente = process.env.MAIL_FROM || usuarioSMTP;
    if (!host || !usuarioSMTP || !claveSMTP || !remitente) {
        console.warn('Alerta de tecnovigilancia registrada; correo prioritario pendiente de configuración SMTP.');
        return { resultado: 'pendiente_configuracion', cantidad_destinatarios: 0 };
    }
    try {
        const [administradores] = await db.promise().query("SELECT correo FROM usuarios WHERE rol = 'Administrador' AND correo IS NOT NULL AND correo <> ''");
        const destinatarios = [...new Set([
            ...administradores.map((fila) => String(fila.correo || '').trim()),
            ...String(process.env.TECNOVIGILANCIA_EMAILS || '').split(',').map((correo) => correo.trim())
        ].filter((correo) => correo && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)))];
        if (!destinatarios.length) {
            console.warn('Alerta de tecnovigilancia registrada; no hay destinatarios administrativos configurados.');
            return { resultado: 'sin_destinatarios', cantidad_destinatarios: 0 };
        }
        const puerto = Number(process.env.SMTP_PORT || 587);
        const transporter = nodemailer.createTransport({
            host, port: puerto,
            secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : puerto === 465,
            auth: { user: usuarioSMTP, pass: claveSMTP }
        });
        const escape = escaparHtmlServidor;
        const tiposLegibles = {
            evento_adverso_serio: 'Evento adverso serio',
            evento_adverso_no_serio: 'Evento adverso no serio',
            incidente_adverso: 'Incidente adverso'
        };
        const tipo = tiposLegibles[reporte.tipo_reporte] || reporte.tipo_reporte;
        const numeroReporte = `TV-${String(reporte.id_reporte).padStart(6, '0')}`;
        const base = String(process.env.APP_PUBLIC_URL || baseAplicacion || '').trim().replace(/\/$/, '');
        const urlBase = /^https?:\/\//i.test(base) ? base : '';
        const enlace = urlBase ? `<p style="margin:22px 0 0;text-align:center"><a href="${escape(urlBase + '/#tecnovigilancia')}" style="display:inline-block;background:#0b7775;color:#fff;text-decoration:none;padding:13px 20px;border-radius:10px;font-size:14px;font-weight:700">Abrir módulo de Tecnovigilancia&nbsp; →</a></p>` : '';
        const fechaEvento = reporte.fecha_evento ? new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota' }).format(new Date(reporte.fecha_evento)) : 'No registrada';
        const personaManejaba = [reporte.persona_manejaba, reporte.cargo_persona_manejaba].filter(Boolean).join(' · ') || 'No identificada';
        const qrUrl = `${urlBase || base || 'http://localhost:3000'}/?equipo=${encodeURIComponent(reporte.id_equipo)}`;
        const qrEquipo = await QRCode.toBuffer(qrUrl, { width: 360, margin: 2, errorCorrectionLevel: 'M', type: 'png' });
        const texto = `ALERTA PRIORITARIA DE TECNOVIGILANCIA · BIOMANT\n\n${numeroReporte} · ${tipo}\n\nEQUIPO EN CUARENTENA Y FUERA DE SERVICIO\nEl activo quedó bloqueado para cambios rutinarios hasta su liberación por un Administrador.\n\nEQUIPO\n${reporte.nombre_equipo} (${reporte.id_equipo})\nMarca y modelo: ${[reporte.marca, reporte.modelo].filter(Boolean).join(' ') || 'No registrados'}\nNúmero de serie: ${reporte.numero_serie || 'No registrado'}\nUbicación del equipo: ${reporte.ubicacion_equipo || 'No registrada'}\n\nREPORTE\nFecha del evento: ${fechaEvento}\nLugar del evento: ${reporte.lugar_evento || 'No especificado'}\nPersona que manejaba el equipo: ${personaManejaba}\nReportado por: ${reporte.nombre_reportante || 'No identificado'}\n\nDescripción: ${reporte.descripcion}\nConsecuencias: ${reporte.consecuencias || 'No especificadas'}\nAcciones inmediatas: ${reporte.acciones_inmediatas || 'No especificadas'}\n\nEl QR adjunto abre la ficha del equipo en BioMant.`;
        await transporter.sendMail({
            from: remitente,
            to: destinatarios,
            subject: `BioMant | Alerta prioritaria ${numeroReporte} · ${reporte.id_equipo}`,
            text: texto,
            attachments: [{ filename: `QR_${reporte.id_equipo}.png`, content: qrEquipo, contentType: 'image/png', cid: 'qr-equipo-biomant' }],
            html: `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:22px 10px;background:#eef3f5;font-family:Arial,Helvetica,sans-serif;color:#18383c"><div style="display:none;max-height:0;overflow:hidden;opacity:0">${escape(numeroReporte)} · ${escape(tipo)} · ${escape(reporte.nombre_equipo)} (${escape(reporte.id_equipo)}) quedó en cuarentena.</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto;background:#fff;border:1px solid #dce7e9;border-radius:20px;overflow:hidden"><tr><td style="padding:25px 28px;background:#073638;background-image:linear-gradient(125deg,#073638,#0b7775);color:#fff"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td width="54" valign="middle"><div style="width:46px;height:46px;line-height:46px;text-align:center;border-radius:14px;background:#0d8b87;color:#fff;font-size:25px;font-weight:bold">B</div></td><td style="padding-left:12px"><div style="font-size:22px;font-weight:700">BioMant</div><div style="margin-top:4px;font-size:12px;color:#c3ece5">Seguridad de dispositivos médicos</div></td><td align="right" style="font-size:10px;line-height:1.5;letter-spacing:1px;color:#d3fff4;font-weight:bold">AVISO<br>PRIORITARIO</td></tr></table></td></tr><tr><td style="padding:26px 28px 10px"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding:7px 11px;border-radius:20px;background:#fff2e9;color:#a33b20;font-size:11px;font-weight:bold;letter-spacing:.5px">${escape(tipo.toUpperCase())}</td><td style="padding-left:9px;color:#71868a;font-size:12px;font-weight:bold">${escape(numeroReporte)}</td></tr></table><h1 style="margin:15px 0 9px;color:#123b3e;font-size:25px;line-height:1.2">Equipo puesto en cuarentena</h1><p style="margin:0;color:#5c7175;font-size:14px;line-height:1.65">Se recibió un reporte de seguridad. El equipo quedó fuera de servicio y bloqueado para cambios rutinarios hasta que un Administrador evalúe el caso y autorice su liberación.</p></td></tr><tr><td style="padding:18px 28px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dce9e9;border-radius:14px;background:#f7fafa"><tr><td style="padding:17px 18px"><div style="font-size:10px;font-weight:bold;letter-spacing:1px;color:#74898d">ACTIVO BAJO CUARENTENA</div><div style="margin-top:7px;font-size:19px;font-weight:bold;color:#163d40">${escape(reporte.nombre_equipo || 'Equipo médico')}</div><div style="margin-top:4px;font-family:Arial,sans-serif;font-size:13px;color:#087873;font-weight:bold">${escape(reporte.id_equipo)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px"><tr><td width="50%" valign="top" style="padding:8px 8px 8px 0;border-top:1px solid #e5eeee"><div style="font-size:10px;color:#829397;font-weight:bold">MARCA / MODELO</div><div style="margin-top:4px;font-size:13px;color:#29494d">${escape([reporte.marca, reporte.modelo].filter(Boolean).join(' ') || 'No registrados')}</div></td><td width="50%" valign="top" style="padding:8px 0 8px 8px;border-top:1px solid #e5eeee"><div style="font-size:10px;color:#829397;font-weight:bold">NÚMERO DE SERIE</div><div style="margin-top:4px;font-size:13px;color:#29494d">${escape(reporte.numero_serie || 'No registrado')}</div></td></tr><tr><td width="50%" valign="top" style="padding:9px 8px 0 0"><div style="font-size:10px;color:#829397;font-weight:bold">UBICACIÓN DEL EQUIPO</div><div style="margin-top:4px;font-size:13px;color:#29494d">${escape(reporte.ubicacion_equipo || 'No registrada')}</div></td><td width="50%" valign="top" style="padding:9px 0 0 8px"><div style="font-size:10px;color:#829397;font-weight:bold">PERSONA QUE LO MANEJABA</div><div style="margin-top:4px;font-size:13px;color:#29494d">${escape(personaManejaba)}</div></td></tr></table></td></tr></table></td></tr><tr><td style="padding:14px 28px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dfe9eb;border-radius:13px"><tr><td style="padding:15px 17px"><div style="font-size:10px;font-weight:bold;letter-spacing:1px;color:#74898d">DATOS DEL EVENTO</div><div style="margin-top:11px;font-size:13px;line-height:1.7;color:#29494d"><b>Fecha y hora:</b> ${escape(fechaEvento)}<br><b>Lugar del evento:</b> ${escape(reporte.lugar_evento || 'No especificado')}<br><b>Reportado por:</b> ${escape(reporte.nombre_reportante || 'No identificado')}</div></td></tr></table></td></tr><tr><td style="padding:14px 28px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eadfc8;border-radius:13px;background:#fffcf6"><tr><td style="padding:15px 17px"><div style="font-size:10px;font-weight:bold;letter-spacing:1px;color:#937334">DESCRIPCIÓN INICIAL</div><div style="margin-top:8px;font-size:13px;line-height:1.65;color:#443d30;white-space:pre-wrap">${escape(reporte.descripcion || 'Sin descripción')}</div></td></tr></table></td></tr><tr><td style="padding:12px 28px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-spacing:8px 0"><tr><td width="50%" valign="top" style="padding:13px;border:1px solid #e3eaf0;border-radius:12px;background:#f7f9fb"><div style="font-size:10px;font-weight:bold;letter-spacing:.6px;color:#71868a">CONSECUENCIAS</div><div style="margin-top:7px;font-size:12px;line-height:1.6;color:#40585c;white-space:pre-wrap">${escape(reporte.consecuencias || 'No especificadas')}</div></td><td width="50%" valign="top" style="padding:13px;border:1px solid #cde9e2;border-radius:12px;background:#f1faf7"><div style="font-size:10px;font-weight:bold;letter-spacing:.6px;color:#418173">ACCIONES INMEDIATAS</div><div style="margin-top:7px;font-size:12px;line-height:1.6;color:#31574f;white-space:pre-wrap">${escape(reporte.acciones_inmediatas || 'No especificadas')}</div></td></tr></table></td></tr><tr><td style="padding:18px 28px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dce9e9;border-radius:14px;background:#f7fafa"><tr><td align="center" style="padding:17px 18px"><div style="font-size:13px;font-weight:bold;color:#173f42">QR del equipo</div><div style="margin-top:4px;font-size:11px;color:#71868a">Escanéalo para abrir la ficha del activo en BioMant.</div><img src="cid:qr-equipo-biomant" width="180" height="180" alt="Código QR del equipo ${escape(reporte.id_equipo)}" style="display:block;width:180px;height:180px;margin:12px auto 0;border:8px solid #fff;border-radius:12px"><div style="margin-top:7px;font-size:11px;color:#087873;font-weight:bold">${escape(reporte.id_equipo)}</div></td></tr></table></td></tr><tr><td style="padding:0 28px 26px">${enlace}</td></tr><tr><td style="padding:16px 28px;background:#f7f9fa;border-top:1px solid #e8eef0;color:#829397;font-size:11px;line-height:1.6">Notificación automática de BioMant · ${escape(numeroReporte)}. Este mensaje no incluye datos identificables del paciente. El QR dirige a la ficha del equipo y requiere acceso autorizado al sistema.</td></tr></table></body></html>`
        });
        return { resultado: 'enviada', cantidad_destinatarios: destinatarios.length };
    } catch (error) {
        console.error('No se pudo enviar la alerta prioritaria de tecnovigilancia:', error.message || error);
        return { resultado: 'fallida', cantidad_destinatarios: 0 };
    }
}

function obtenerReporteTecnovigilancia(id, callback) {
    db.query(`${SELECT_REPORTE_TECNOVIGILANCIA} WHERE t.id_reporte = ?`, [id], (err, resultados) => {
        callback(err, resultados && resultados[0]);
    });
}

app.get('/api/tecnovigilancia', (req, res) => {
    const filtroAutor = req.usuario.rol === 'Administrador' ? '' : ' WHERE t.id_reportante = ?';
    const parametros = filtroAutor ? [req.usuario.id_usuario] : [];
    db.query(`${SELECT_REPORTE_TECNOVIGILANCIA}${filtroAutor} ORDER BY t.creado_en DESC, t.id_reporte DESC LIMIT 200`, parametros, (err, resultados) => {
        if (err) {
            console.error('Error al listar reportes de tecnovigilancia:', err);
            res.status(500).json({ error: 'No se pudieron cargar los reportes. Verifica que estén aplicadas las migraciones de las etapas 1 y 2.' });
            return;
        }
        res.json(resultados);
    });
});

app.get('/api/tecnovigilancia/:id', (req, res) => {
    const id = String(req.params.id || '');
    if (!/^\d{1,18}$/.test(id) || BigInt(id) < 1n) {
        res.status(400).json({ error: 'El identificador del reporte no es válido.' });
        return;
    }
    const consulta = req.usuario.rol === 'Administrador'
        ? `${SELECT_REPORTE_TECNOVIGILANCIA} WHERE t.id_reporte = ?`
        : `${SELECT_REPORTE_TECNOVIGILANCIA} WHERE t.id_reporte = ? AND t.id_reportante = ?`;
    const parametrosReporte = req.usuario.rol === 'Administrador' ? [id] : [id, req.usuario.id_usuario];
    db.query(consulta, parametrosReporte, (err, resultados) => {
        if (err) {
            console.error('Error al consultar el reporte de tecnovigilancia:', err);
            res.status(500).json({ error: 'No se pudo consultar el reporte. Verifica que estén aplicadas las migraciones de tecnovigilancia.' });
            return;
        }
        const reporte = resultados && resultados[0];
        if (!reporte) {
            res.status(404).json({ error: 'No se encontró el reporte.' });
            return;
        }
        db.query('SELECT id_evento, nombre_usuario, accion, datos, creado_en FROM tecnovigilancia_auditoria WHERE id_reporte = ? ORDER BY creado_en, id_evento', [id], (errAuditoria, auditoria) => {
            if (errAuditoria) {
                console.error('Error al consultar la trazabilidad del reporte:', errAuditoria);
                res.status(500).json({ error: 'No se pudo consultar la trazabilidad del reporte.' });
                return;
            }
            db.query('SELECT estado_investigacion, responsable, metodologia, causa_clasificacion, analisis_causa, acciones_correctivas, acciones_preventivas, resultado_investigacion, actualizado_por, actualizado_en FROM tecnovigilancia_investigaciones WHERE id_reporte = ?', [id], (errInvestigacion, investigaciones) => {
                if (errInvestigacion) {
                    console.error('Error al consultar la investigación de tecnovigilancia:', errInvestigacion);
                    res.status(500).json({ error: 'No se pudo consultar la investigación. Verifica que esté aplicada la migración de la etapa 3.' });
                    return;
                }
                db.query('SELECT clasificacion_seriedad, fecha_conocimiento, estado_envio, fecha_envio, numero_radicado, observaciones, actualizado_en FROM tecnovigilancia_reportes_invima WHERE id_reporte = ?', [id], (errInvima, seguimientosInvima) => {
                    if (errInvima) {
                        if (errInvima.code === '42P01') {
                            res.json({ ...reporte, auditoria, investigacion: investigaciones && investigaciones[0] || null, gestion_invima: null, etapa4Pendiente: true });
                            return;
                        }
                        console.error('Error al consultar el seguimiento de notificación a Invima:', errInvima);
                        res.status(500).json({ error: 'No se pudo consultar el seguimiento Invima. Verifica que esté aplicada la migración de la etapa 4.' });
                        return;
                    }
                    res.json({ ...reporte, auditoria, investigacion: investigaciones && investigaciones[0] || null, gestion_invima: seguimientosInvima && seguimientosInvima[0] || null });
                });
            });
        });
    });
});

app.put('/api/tecnovigilancia/:id/investigacion', soloAdministrador, async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^\d{1,18}$/.test(id) || BigInt(id) < 1n) {
        res.status(400).json({ error: 'El identificador del reporte no es válido.' });
        return;
    }
    const datos = req.body || {};
    const estado = String(datos.estado_investigacion || '').trim();
    const responsable = String(datos.responsable || '').trim();
    const metodologia = String(datos.metodologia || '').trim();
    const causa = String(datos.causa_clasificacion || '').trim();
    const analisis = String(datos.analisis_causa || '').trim();
    const correctivas = String(datos.acciones_correctivas || '').trim();
    const preventivas = String(datos.acciones_preventivas || '').trim();
    const resultado = String(datos.resultado_investigacion || '').trim();
    if (!['pendiente', 'en_curso', 'concluida'].includes(estado) || !['pendiente', 'ishikawa', 'modelo_reason', 'otra'].includes(metodologia) || !['pendiente', 'dispositivo', 'uso_usuario', 'infraestructura', 'fabricante', 'otro', 'indeterminada'].includes(causa)) {
        res.status(400).json({ error: 'Selecciona un estado, metodología y causa válidos para la investigación.' });
        return;
    }
    if (responsable.length > 120 || [analisis, correctivas, preventivas, resultado].some((valor) => valor.length > 5000)) {
        res.status(400).json({ error: 'La persona responsable admite hasta 120 caracteres y cada campo de texto hasta 5.000.' });
        return;
    }
    if (estado === 'concluida' && (!responsable || metodologia === 'pendiente' || causa === 'pendiente' || analisis.length < 10 || resultado.length < 10)) {
        res.status(400).json({ error: 'Para concluir, indica responsable, metodología, causa, análisis (mínimo 10 caracteres) y resultado (mínimo 10 caracteres).' });
        return;
    }
    try {
        const respuesta = await db.transaction(async (tx) => {
            const reportes = await tx.query('SELECT id_reporte, estado FROM reportes_tecnovigilancia WHERE id_reporte = ? FOR UPDATE', [id]);
            if (!reportes.length) return { noExiste: true };
            if (['cerrado', 'descartado'].includes(reportes[0].estado)) return { noEditable: true };
            const existentes = await tx.query(`SELECT estado_investigacion, responsable, metodologia, causa_clasificacion,
                analisis_causa, acciones_correctivas, acciones_preventivas, resultado_investigacion
                FROM tecnovigilancia_investigaciones WHERE id_reporte = ? FOR UPDATE`, [id]);
            const anteriores = { estado_reporte: reportes[0].estado, ...(existentes[0] || {}) };
            const estadoReporteNuevo = reportes[0].estado === 'reportado' && estado !== 'pendiente' ? 'en_investigacion' : reportes[0].estado;
            const payload = { estado_investigacion: estado, responsable: responsable || null, metodologia, causa_clasificacion: causa, analisis_causa: analisis, acciones_correctivas: correctivas, acciones_preventivas: preventivas, resultado_investigacion: resultado, estado_reporte: estadoReporteNuevo };
            await tx.query(`
                INSERT INTO tecnovigilancia_investigaciones
                    (id_reporte, estado_investigacion, responsable, metodologia, causa_clasificacion,
                     analisis_causa, acciones_correctivas, acciones_preventivas, resultado_investigacion,
                     actualizado_por, actualizado_en)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT (id_reporte) DO UPDATE SET
                    estado_investigacion = EXCLUDED.estado_investigacion,
                    responsable = EXCLUDED.responsable,
                    metodologia = EXCLUDED.metodologia,
                    causa_clasificacion = EXCLUDED.causa_clasificacion,
                    analisis_causa = EXCLUDED.analisis_causa,
                    acciones_correctivas = EXCLUDED.acciones_correctivas,
                    acciones_preventivas = EXCLUDED.acciones_preventivas,
                    resultado_investigacion = EXCLUDED.resultado_investigacion,
                    actualizado_por = EXCLUDED.actualizado_por,
                    actualizado_en = CURRENT_TIMESTAMP`, [id, estado, responsable || null, metodologia, causa, analisis, correctivas, preventivas, resultado, req.usuario.id_usuario]);
            if (estadoReporteNuevo !== reportes[0].estado) {
                await tx.query("UPDATE reportes_tecnovigilancia SET estado = 'en_investigacion' WHERE id_reporte = ?", [id]);
            }
            await tx.query(`
                INSERT INTO tecnovigilancia_auditoria (id_reporte, id_usuario, nombre_usuario, accion, datos)
                VALUES (?, ?, ?, ?, ?::jsonb)`, [id, req.usuario.id_usuario, req.usuario.nombre, 'investigacion_actualizada', JSON.stringify(payload)]);
            await tx.query(`INSERT INTO auditoria_eventos (id_usuario, nombre_usuario, rol_usuario, modulo, accion, entidad, id_entidad, resumen, valores_anteriores, valores_nuevos) VALUES (?, ?, ?, 'tecnovigilancia', 'actualizar_investigacion', 'reporte_tecnovigilancia', ?, ?, ?::jsonb, ?::jsonb)`, [req.usuario.id_usuario, req.usuario.nombre, req.usuario.rol, String(id), `Actualizó investigación del reporte TV-${String(id).padStart(6, '0')}.`, JSON.stringify(anteriores), JSON.stringify(payload)]);
            return { guardada: true };
        });
        if (respuesta.noExiste) {
            res.status(404).json({ error: 'No se encontró el reporte.' });
            return;
        }
        if (respuesta.noEditable) {
            res.status(409).json({ error: 'La investigación no se puede modificar porque el reporte ya está cerrado o descartado.' });
            return;
        }
        res.json({ mensaje: 'Investigación guardada y añadida a la trazabilidad.' });
    } catch (error) {
        console.error('Error al guardar la investigación de tecnovigilancia:', error);
        res.status(500).json({ error: 'No se pudo guardar la investigación. Verifica que esté aplicada la migración de la etapa 3.' });
    }
});

app.put('/api/tecnovigilancia/:id/notificacion-invima', soloAdministrador, async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^\d{1,18}$/.test(id) || BigInt(id) < 1n) {
        res.status(400).json({ error: 'El identificador del reporte no es válido.' });
        return;
    }
    const datos = req.body || {};
    const estadoEnvio = String(datos.estado_envio || '').trim();
    const clasificacionRecibida = String(datos.clasificacion_seriedad || '').trim();
    const radicado = String(datos.numero_radicado || '').trim();
    const observaciones = String(datos.observaciones || '').trim();
    const fechaConocimientoLocal = String(datos.fecha_conocimiento || '').trim();
    if (!['pendiente', 'preparado', 'enviado'].includes(estadoEnvio) || radicado.length > 100 || observaciones.length > 2000) {
        res.status(400).json({ error: 'Revisa el estado del envío, el radicado (máximo 100) y las observaciones (máximo 2.000 caracteres).' });
        return;
    }
    let fechaConocimiento = null;
    if (fechaConocimientoLocal) {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(fechaConocimientoLocal)) {
            res.status(400).json({ error: 'La fecha de conocimiento institucional no es válida.' });
            return;
        }
        fechaConocimiento = new Date(`${fechaConocimientoLocal}:00-05:00`);
        if (Number.isNaN(fechaConocimiento.getTime())) {
            res.status(400).json({ error: 'La fecha de conocimiento institucional no es válida.' });
            return;
        }
    }
    try {
        const resultado = await db.transaction(async (tx) => {
            const filas = await tx.query('SELECT tipo_reporte FROM reportes_tecnovigilancia WHERE id_reporte = ? FOR UPDATE', [id]);
            if (!filas.length) return { noExiste: true };
            const seguimientosPrevios = await tx.query(`SELECT clasificacion_seriedad, fecha_conocimiento, estado_envio,
                numero_radicado, observaciones FROM tecnovigilancia_reportes_invima WHERE id_reporte = ? FOR UPDATE`, [id]);
            const valoresAnteriores = seguimientosPrevios[0] || {};
            const tipo = filas[0].tipo_reporte;
            let clasificacion;
            if (tipo === 'evento_adverso_serio') clasificacion = 'serio';
            else if (tipo === 'evento_adverso_no_serio') clasificacion = 'no_serio';
            else if (tipo === 'incidente_adverso' && ['serio', 'no_serio'].includes(clasificacionRecibida)) clasificacion = clasificacionRecibida;
            else if (tipo === 'incidente_adverso') return { requiereClasificacion: true };
            else clasificacion = 'no_aplica';
            if (clasificacion === 'serio' && estadoEnvio !== 'pendiente' && !fechaConocimiento) return { requiereFecha: true };
            await tx.query(`
                INSERT INTO tecnovigilancia_reportes_invima
                    (id_reporte, clasificacion_seriedad, fecha_conocimiento, estado_envio, fecha_envio,
                     numero_radicado, observaciones, actualizado_por, actualizado_en)
                VALUES (?, ?, ?, ?, CASE WHEN ? = 'enviado' THEN CURRENT_TIMESTAMP ELSE NULL END, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT (id_reporte) DO UPDATE SET
                    clasificacion_seriedad = EXCLUDED.clasificacion_seriedad,
                    fecha_conocimiento = EXCLUDED.fecha_conocimiento,
                    estado_envio = EXCLUDED.estado_envio,
                    fecha_envio = CASE WHEN EXCLUDED.estado_envio = 'enviado' THEN COALESCE(tecnovigilancia_reportes_invima.fecha_envio, CURRENT_TIMESTAMP) ELSE NULL END,
                    numero_radicado = EXCLUDED.numero_radicado,
                    observaciones = EXCLUDED.observaciones,
                    actualizado_por = EXCLUDED.actualizado_por,
                    actualizado_en = CURRENT_TIMESTAMP`, [id, clasificacion, fechaConocimiento ? fechaConocimiento.toISOString() : null, estadoEnvio, estadoEnvio, radicado || null, observaciones, req.usuario.id_usuario]);
            const bitacora = { clasificacion_seriedad: clasificacion, fecha_conocimiento: fechaConocimiento ? fechaConocimiento.toISOString() : null, estado_envio: estadoEnvio, numero_radicado: radicado || null, observaciones };
            await tx.query(`INSERT INTO tecnovigilancia_auditoria (id_reporte, id_usuario, nombre_usuario, accion, datos) VALUES (?, ?, ?, ?, ?::jsonb)`, [id, req.usuario.id_usuario, req.usuario.nombre, 'seguimiento_invima_actualizado', JSON.stringify(bitacora)]);
            await tx.query(`INSERT INTO auditoria_eventos (id_usuario, nombre_usuario, rol_usuario, modulo, accion, entidad, id_entidad, resumen, valores_anteriores, valores_nuevos) VALUES (?, ?, ?, 'tecnovigilancia', 'actualizar_seguimiento_invima', 'reporte_tecnovigilancia', ?, ?, ?::jsonb, ?::jsonb)`, [req.usuario.id_usuario, req.usuario.nombre, req.usuario.rol, String(id), `Actualizó seguimiento Invima del reporte TV-${String(id).padStart(6, '0')}.`, JSON.stringify(valoresAnteriores), JSON.stringify(bitacora)]);
            return { guardado: true };
        });
        if (resultado.noExiste) { res.status(404).json({ error: 'No se encontró el reporte.' }); return; }
        if (resultado.requiereClasificacion) { res.status(400).json({ error: 'Clasifica el incidente como serio o no serio antes de preparar su reporte a Invima.' }); return; }
        if (resultado.requiereFecha) { res.status(400).json({ error: 'Indica cuándo tuvo conocimiento la institución para calcular el plazo de notificación seria.' }); return; }
        res.json({ mensaje: 'Seguimiento Invima actualizado y añadido a la trazabilidad.' });
    } catch (error) {
        console.error('Error al actualizar el seguimiento Invima:', error);
        res.status(500).json({ error: 'No se pudo guardar el seguimiento Invima. Verifica que esté aplicada la migración de la etapa 4.' });
    }
});

app.post('/api/tecnovigilancia', async (req, res) => {
    const datos = req.body || {};
    const idEquipo = String(datos.id_equipo || '').trim();
    const tipoReporte = String(datos.tipo_reporte || '').trim();
    const fechaEventoLocal = String(datos.fecha_evento || '').trim();
    const lugarEvento = String(datos.lugar_evento || '').trim();
    const descripcion = String(datos.descripcion || '').trim();
    const consecuencias = String(datos.consecuencias || '').trim();
    const accionesInmediatas = String(datos.acciones_inmediatas || '').trim();
    const personaManejaba = String(datos.persona_manejaba || '').trim();
    const cargoPersonaManejaba = String(datos.cargo_persona_manejaba || '').trim();
    const personaPresente = String(datos.persona_presente || 'desconocido').trim();

    if (!idEquipo || !tipoReporte || !fechaEventoLocal || !lugarEvento || !descripcion || !consecuencias || !accionesInmediatas) {
        res.status(400).json({ error: 'Completa el equipo, tipo y fecha del evento, lugar, descripción, consecuencias y acciones inmediatas.' });
        return;
    }
    if (!TIPOS_REPORTE_TECNOVIGILANCIA.includes(tipoReporte)) {
        res.status(400).json({ error: 'Selecciona un tipo de reporte válido.' });
        return;
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(fechaEventoLocal)) {
        res.status(400).json({ error: 'Indica una fecha y hora válida para el evento.' });
        return;
    }
    const [parteFecha, parteHora] = fechaEventoLocal.split('T');
    const [anioEvento, mesEvento, diaEvento] = parteFecha.split('-').map(Number);
    const [horaEvento, minutoEvento] = parteHora.split(':').map(Number);
    const fechaValidacion = new Date(Date.UTC(anioEvento, mesEvento - 1, diaEvento, horaEvento, minutoEvento));
    const fechaEvento = new Date(`${fechaEventoLocal}:00-05:00`);
    if (Number.isNaN(fechaEvento.getTime()) || fechaValidacion.getUTCFullYear() !== anioEvento || fechaValidacion.getUTCMonth() !== mesEvento - 1 || fechaValidacion.getUTCDate() !== diaEvento || fechaValidacion.getUTCHours() !== horaEvento || fechaValidacion.getUTCMinutes() !== minutoEvento) {
        res.status(400).json({ error: 'La fecha y hora del evento no son válidas.' });
        return;
    }
    if (lugarEvento.length < 2 || lugarEvento.length > 200 || descripcion.length < 10 || descripcion.length > 10000 || consecuencias.length < 2 || consecuencias.length > 5000 || accionesInmediatas.length < 2 || accionesInmediatas.length > 5000) {
        res.status(400).json({ error: 'Revisa la longitud de los campos: descripción (10–10.000), lugar (2–200), consecuencias y acciones (2–5.000 caracteres).' });
        return;
    }
    if (personaManejaba.length > 150 || cargoPersonaManejaba.length > 120 || !['si', 'no', 'desconocido'].includes(personaPresente)) {
        res.status(400).json({ error: 'Revisa los datos de la persona que manejaba el equipo.' });
        return;
    }

    let faseRegistro = 'iniciar transacción';
    try {
        const resultado = await db.transaction(async (tx) => {
            faseRegistro = 'consultar equipo';
            const equipo = await tx.query('SELECT id_equipo, estado FROM equipos WHERE id_equipo = ? FOR UPDATE', [idEquipo]);
            if (!equipo.length) {
                const errorEquipo = new Error('El equipo seleccionado ya no está disponible en el inventario.');
                errorEquipo.code = '23503';
                errorEquipo.constraint = 'reportes_tecnovigilancia_id_equipo_fkey';
                throw errorEquipo;
            }
            faseRegistro = 'guardar reporte';
            const insertado = await tx.query(`
                INSERT INTO reportes_tecnovigilancia
                    (id_equipo, tipo_reporte, fecha_evento, lugar_evento, descripcion,
                     consecuencias, acciones_inmediatas, id_reportante, nombre_reportante,
                     persona_manejaba, cargo_persona_manejaba, persona_presente)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                idEquipo, tipoReporte, fechaEvento.toISOString(), lugarEvento, descripcion,
                consecuencias, accionesInmediatas, req.usuario.id_usuario, req.usuario.nombre,
                personaManejaba || null, cargoPersonaManejaba || null, personaPresente
            ]);
            faseRegistro = 'consultar cuarentena activa';
            const bloqueosActivos = await tx.query('SELECT id_bloqueo FROM tecnovigilancia_bloqueos WHERE id_equipo = ? AND activo FOR UPDATE', [idEquipo]);
            let cuarentenaIniciada = false;
            if (!bloqueosActivos.length) {
                faseRegistro = 'crear cuarentena';
                await tx.query(`
                    INSERT INTO tecnovigilancia_bloqueos (id_equipo, id_reporte, estado_previo)
                    VALUES (?, ?, ?)`, [idEquipo, insertado.insertId, equipo[0].estado]);
                faseRegistro = 'actualizar estado del equipo';
                await tx.query("UPDATE equipos SET estado = 'Fuera de servicio' WHERE id_equipo = ?", [idEquipo]);
                cuarentenaIniciada = true;
            }
            faseRegistro = 'guardar bitácora de Tecnovigilancia';
            await tx.query(`
                INSERT INTO tecnovigilancia_auditoria (id_reporte, id_usuario, nombre_usuario, accion, datos)
                VALUES (?, ?, ?, ?, ?::jsonb)`, [
                insertado.insertId, req.usuario.id_usuario, req.usuario.nombre,
                'reporte_creado', JSON.stringify({ tipo_reporte: tipoReporte, id_equipo: idEquipo })
            ]);
            if (cuarentenaIniciada) {
                faseRegistro = 'guardar evento de cuarentena';
                await tx.query(`
                    INSERT INTO tecnovigilancia_auditoria (id_reporte, id_usuario, nombre_usuario, accion, datos)
                    VALUES (?, ?, ?, ?, ?::jsonb)`, [
                    insertado.insertId, req.usuario.id_usuario, req.usuario.nombre,
                    'equipo_en_cuarentena', JSON.stringify({ estado_previo: equipo[0].estado, estado_actual: 'Fuera de servicio' })
                ]);
            }
            faseRegistro = 'guardar auditoría general';
            await registrarAuditoria(req, {
                modulo: 'tecnovigilancia', accion: 'crear_reporte', entidad: 'reporte_tecnovigilancia', id_entidad: insertado.insertId,
                resumen: `Registró reporte TV-${String(insertado.insertId).padStart(6, '0')} para ${idEquipo}; cuarentena ${cuarentenaIniciada ? 'iniciada' : 'ya activa'}.`,
                nuevos: {
                    id_equipo: idEquipo, tipo_reporte: tipoReporte, fecha_evento: fechaEvento.toISOString(), lugar_evento: lugarEvento,
                    descripcion, consecuencias, acciones_inmediatas: accionesInmediatas, persona_manejaba: personaManejaba || null,
                    cargo_persona_manejaba: cargoPersonaManejaba || null, persona_presente: personaPresente,
                    estado_reporte: 'reportado', estado_equipo: cuarentenaIniciada ? 'Fuera de servicio' : equipo[0].estado,
                    cuarentena_activa: true
                }
            }, tx);
            faseRegistro = 'confirmar transacción';
            return { id_reporte: insertado.insertId, cuarentenaIniciada };
        });
        obtenerReporteTecnovigilancia(resultado.id_reporte, (err, reporte) => {
            if (err || !reporte) {
                console.error('El reporte se guardó, pero no pudo leerse para responder:', err);
                res.status(201).json({ id_reporte: resultado.id_reporte, equipo_en_cuarentena: true, mensaje: 'Reporte registrado y equipo puesto en cuarentena.' });
                return;
            }
            const baseAplicacion = `${req.protocol}://${req.get('host')}`;
            notificarResponsablesTecnovigilancia(reporte, baseAplicacion).then((notificacion) => registrarAuditoria(req, {
                modulo: 'tecnovigilancia', accion: 'notificacion_prioritaria', entidad: 'reporte_tecnovigilancia', id_entidad: resultado.id_reporte,
                resumen: `Resultado de la alerta prioritaria del reporte TV-${String(resultado.id_reporte).padStart(6, '0')}: ${notificacion.resultado}.`,
                nuevos: { resultado: notificacion.resultado, cantidad_destinatarios: notificacion.cantidad_destinatarios }
            })).catch((error) => console.error('Error al registrar el resultado de la alerta de tecnovigilancia:', error.message || error));
            res.status(201).json({ ...reporte, equipo_en_cuarentena: true, cuarentena_iniciada: resultado.cuarentenaIniciada });
        });
    } catch (error) {
        const codigoError = String(error.code || '');
        console.error('Error al registrar un reporte de tecnovigilancia:', {
            fase: faseRegistro,
            tipo: error.name,
            mensaje: error.message,
            code: codigoError || undefined,
            constraint: error.constraint
        });
        if (codigoError === '23503' && String(error.constraint || '').includes('id_equipo')) {
            res.status(404).json({ error: 'El equipo seleccionado ya no está disponible en el inventario.' });
            return;
        }
        if (codigoError === '23503') {
            res.status(409).json({ error: 'No se pudo asociar el reporte con el usuario de la sesión. Cierra sesión, vuelve a ingresar e inténtalo otra vez.' });
            return;
        }
        if (codigoError === '42P01' || codigoError === '42703') {
            res.status(500).json({ error: 'La estructura de Tecnovigilancia en Supabase no coincide con el servidor. Revisa las migraciones de las etapas 1 y 2 y el registro del servidor.' });
            return;
        }
        if (codigoError === '23505') {
            res.status(409).json({ error: 'Ya existe un bloqueo activo para este equipo. Actualiza los reportes y vuelve a intentarlo.' });
            return;
        }
        if (codigoError === '23514' || codigoError === '23502') {
            res.status(400).json({ error: 'Algún dato del reporte no cumple las reglas de Supabase. Revisa el tipo, la fecha y los campos obligatorios.' });
            return;
        }
        if (codigoError === '42501') {
            res.status(503).json({ error: 'Supabase rechazó la operación por permisos. Revisa la conexión segura del servidor.' });
            return;
        }
        if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT'].includes(codigoError)) {
            res.status(503).json({ error: 'No se pudo conectar con Supabase en este momento. El reporte no se guardó; inténtalo de nuevo cuando el servicio esté disponible.' });
            return;
        }
        res.status(500).json({ error: 'No se pudo guardar el reporte. El servidor registró la fase exacta del error para corregirlo.' });
    }
});

app.post('/api/tecnovigilancia/:id/liberar', soloAdministrador, async (req, res) => {
    const id = String(req.params.id || '');
    const motivo = String((req.body && req.body.motivo_liberacion) || '').trim();
    const estadoFinal = String((req.body && req.body.estado_final) || '').trim();
    if (!/^\d{1,18}$/.test(id) || BigInt(id) < 1n) {
        res.status(400).json({ error: 'El identificador del reporte no es válido.' });
        return;
    }
    if (motivo.length < 15 || motivo.length > 3000) {
        res.status(400).json({ error: 'Registra un motivo de liberación de entre 15 y 3.000 caracteres.' });
        return;
    }
    if (!ESTADOS_EQUIPO.includes(estadoFinal)) {
        res.status(400).json({ error: `El estado final debe ser uno de: ${ESTADOS_EQUIPO.join(', ')}` });
        return;
    }
    try {
        const resultado = await db.transaction(async (tx) => {
            const reportes = await tx.query('SELECT id_reporte, id_equipo, estado FROM reportes_tecnovigilancia WHERE id_reporte = ? FOR UPDATE', [id]);
            if (!reportes.length) return { noExiste: true };
            const reporte = reportes[0];
            const equipos = await tx.query('SELECT id_equipo, estado FROM equipos WHERE id_equipo = ? FOR UPDATE', [reporte.id_equipo]);
            const estadoEquipoPrevio = equipos[0]?.estado || null;
            const bloqueos = await tx.query('SELECT id_bloqueo FROM tecnovigilancia_bloqueos WHERE id_equipo = ? AND activo FOR UPDATE', [reporte.id_equipo]);
            if (!bloqueos.length) return { yaLiberado: true };
            await tx.query("UPDATE reportes_tecnovigilancia SET estado = 'cerrado' WHERE id_reporte = ?", [id]);
            await tx.query(`
                INSERT INTO tecnovigilancia_auditoria (id_reporte, id_usuario, nombre_usuario, accion, datos)
                VALUES (?, ?, ?, ?, ?::jsonb)`, [id, req.usuario.id_usuario, req.usuario.nombre, 'caso_cerrado_por_administrador', JSON.stringify({ motivo_liberacion: motivo, estado_final: estadoFinal })]);
            const pendientes = await tx.query(`
                SELECT id_reporte FROM reportes_tecnovigilancia
                WHERE id_equipo = ? AND estado IN ('reportado', 'en_investigacion') AND id_reporte <> ?
                ORDER BY creado_en, id_reporte LIMIT 1`, [reporte.id_equipo, id]);
            if (pendientes.length) {
                await tx.query('UPDATE tecnovigilancia_bloqueos SET id_reporte = ? WHERE id_equipo = ? AND activo', [pendientes[0].id_reporte, reporte.id_equipo]);
                await tx.query(`
                    INSERT INTO tecnovigilancia_auditoria (id_reporte, id_usuario, nombre_usuario, accion, datos)
                    VALUES (?, ?, ?, ?, ?::jsonb)`, [pendientes[0].id_reporte, req.usuario.id_usuario, req.usuario.nombre, 'cuarentena_mantenida_por_otro_reporte', JSON.stringify({ id_reporte_cerrado: id })]);
                await registrarAuditoria(req, {
                    modulo: 'tecnovigilancia', accion: 'cerrar_reporte', entidad: 'reporte_tecnovigilancia', id_entidad: id,
                    resumen: `Cerró reporte TV-${String(id).padStart(6, '0')}; la cuarentena continúa por otro reporte abierto.`,
                    anteriores: { estado: reporte.estado, estado_equipo: estadoEquipoPrevio, cuarentena_activa: true },
                    nuevos: { estado: 'cerrado', estado_equipo: estadoEquipoPrevio, cuarentena_activa: true, id_reporte_pendiente: pendientes[0].id_reporte, motivo_liberacion: motivo }
                }, tx);
                await registrarAuditoria(req, {
                    modulo: 'tecnovigilancia', accion: 'mantener_cuarentena', entidad: 'equipo', id_entidad: reporte.id_equipo,
                    resumen: `Mantuvo en cuarentena ${reporte.id_equipo} porque sigue abierto el reporte TV-${String(pendientes[0].id_reporte).padStart(6, '0')}.`,
                    anteriores: { cuarentena_activa: true, id_reporte_bloqueante: id },
                    nuevos: { cuarentena_activa: true, id_reporte_bloqueante: pendientes[0].id_reporte }
                }, tx);
                return { cuarentenaActiva: true, id_reporte_pendiente: pendientes[0].id_reporte };
            }
            await tx.query(`
                UPDATE tecnovigilancia_bloqueos
                SET activo = false, liberado_por = ?, nombre_liberador = ?, estado_final = ?, motivo_liberacion = ?, liberado_en = CURRENT_TIMESTAMP
                WHERE id_equipo = ? AND activo`, [req.usuario.id_usuario, req.usuario.nombre, estadoFinal, motivo, reporte.id_equipo]);
            await tx.query('UPDATE equipos SET estado = ? WHERE id_equipo = ?', [estadoFinal, reporte.id_equipo]);
            await tx.query(`
                INSERT INTO tecnovigilancia_auditoria (id_reporte, id_usuario, nombre_usuario, accion, datos)
                VALUES (?, ?, ?, ?, ?::jsonb)`, [id, req.usuario.id_usuario, req.usuario.nombre, 'equipo_liberado_de_cuarentena', JSON.stringify({ estado_final: estadoFinal, motivo_liberacion: motivo })]);
            await registrarAuditoria(req, {
                modulo: 'tecnovigilancia', accion: 'cerrar_reporte', entidad: 'reporte_tecnovigilancia', id_entidad: id,
                resumen: `Cerró reporte TV-${String(id).padStart(6, '0')} y liberó la cuarentena de ${reporte.id_equipo}.`,
                anteriores: { estado: reporte.estado, estado_equipo: estadoEquipoPrevio, cuarentena_activa: true },
                nuevos: { estado: 'cerrado', estado_equipo: estadoFinal, cuarentena_activa: false, motivo_liberacion: motivo }
            }, tx);
            await registrarAuditoria(req, {
                modulo: 'tecnovigilancia', accion: 'liberar_cuarentena', entidad: 'equipo', id_entidad: reporte.id_equipo,
                resumen: `Liberó de cuarentena el equipo ${reporte.id_equipo}.`,
                anteriores: { estado: estadoEquipoPrevio, cuarentena_activa: true },
                nuevos: { estado: estadoFinal, cuarentena_activa: false, motivo_liberacion: motivo }
            }, tx);
            return { cuarentenaActiva: false, estado_final: estadoFinal };
        });
        if (resultado.noExiste) {
            res.status(404).json({ error: 'No se encontró el reporte.' });
            return;
        }
        if (resultado.yaLiberado) {
            res.status(409).json({ error: 'El equipo ya no tiene una cuarentena activa.' });
            return;
        }
        res.json({ mensaje: resultado.cuarentenaActiva ? 'Caso cerrado; el equipo continúa bloqueado porque hay otros reportes abiertos.' : 'Caso cerrado y cuarentena liberada.', ...resultado });
    } catch (error) {
        console.error('Error al liberar equipo de tecnovigilancia:', error);
        res.status(500).json({ error: 'No se pudo liberar el equipo. Verifica que esté aplicada la migración de la etapa 2.' });
    }
});

// =============================================================================
// MANTENIMIENTOS
// Cualquier usuario con sesión consulta y registra. Administradores y autores
// pueden editar o eliminar el registro.
// =============================================================================

// Deja trazabilidad de la descarga de informes de auditoría.
app.post('/api/auditoria/exportacion', verificarToken, soloAdministrador, async (req, res) => {
    const formato = String((req.body && req.body.formato) || '').toLowerCase();
    const idEvento = Number((req.body && req.body.id_evento) || 0);
    if (!['csv', 'pdf', 'xlsx'].includes(formato)) {
        res.status(400).json({ error: 'Formato de exportación no válido.' });
        return;
    }
    try {
        const individual = Number.isInteger(idEvento) && idEvento > 0;
        if (individual) {
            const existente = await db.query('SELECT id_evento FROM auditoria_eventos WHERE id_evento = ?', [idEvento]);
            if (!existente.length) {
                res.status(404).json({ error: 'No se encontró el evento de auditoría solicitado.' });
                return;
            }
        }
        await registrarAuditoria(req, {
            modulo: 'seguridad', accion: 'exportar', entidad: 'auditoria_eventos',
            resumen: individual
                ? `Descargó el reporte individual del evento de auditoría #${idEvento} en formato ${formato.toUpperCase()}.`
                : `Exportó el informe de auditoría en formato ${formato.toUpperCase()}.`,
            nuevos: { formato, alcance: individual ? 'evento_individual' : 'filtros_aplicados', ...(individual ? { id_evento: idEvento } : {}) }
        });
        res.status(201).json({ mensaje: 'Exportación registrada.' });
    } catch (error) {
        console.error('Error al registrar la exportación de auditoría:', error);
        res.status(500).json({ error: 'No se pudo registrar la exportación.' });
    }
});

// Consulta de auditoría: lectura administrativa, paginada y filtrable.
app.get('/api/auditoria', verificarToken, soloAdministrador, async (req, res) => {
    const pagina = Math.max(1, Number.parseInt(req.query.pagina, 10) || 1);
    const limite = Math.min(100, Math.max(1, Number.parseInt(req.query.limite, 10) || 25));
    const filtros = [];
    const valores = [];
    const agregar = (sql, valor) => { valores.push(valor); filtros.push(sql); };
    if (req.query.modulo) agregar('modulo = ?', String(req.query.modulo).slice(0, 40));
    if (req.query.accion) agregar('accion ILIKE ?', `%${String(req.query.accion).slice(0, 60)}%`);
    if (req.query.usuario) agregar('nombre_usuario ILIKE ?', `%${String(req.query.usuario).slice(0, 100)}%`);
    if (req.query.buscar) {
        const buscar = `%${String(req.query.buscar).slice(0, 120)}%`;
        filtros.push('(resumen ILIKE ? OR id_entidad ILIKE ? OR entidad ILIKE ?)');
        valores.push(buscar, buscar, buscar);
    }
    if (req.query.desde && /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde)) agregar('creado_en >= ?::date', req.query.desde);
    if (req.query.hasta && /^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta)) agregar('creado_en < (?::date + INTERVAL \'1 day\')', req.query.hasta);
    const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
    try {
        const conteo = await db.query(`SELECT COUNT(*)::int AS total FROM auditoria_eventos ${where}`, valores);
        const total = Number(conteo[0]?.total || 0);
        const filas = await db.query(`SELECT id_evento, id_usuario, nombre_usuario, rol_usuario, modulo, accion, entidad, id_entidad,
            resumen, valores_anteriores, valores_nuevos, metadatos, creado_en
            FROM auditoria_eventos ${where} ORDER BY creado_en DESC, id_evento DESC LIMIT ? OFFSET ?`,
            [...valores, limite, (pagina - 1) * limite]);
        res.json({ eventos: filas, total, pagina, limite, paginas: Math.ceil(total / limite) });
    } catch (error) {
        console.error('Error consultando auditoría:', error);
        res.status(500).json({ error: 'No se pudo consultar la auditoría.' });
    }
});

app.get('/api/analitica/dashboard', verificarToken, (req, res) => {
    const estadosSql = 'SELECT estado, COUNT(*) AS cantidad FROM equipos GROUP BY estado ORDER BY estado';
    const partesMes = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota', year: 'numeric', month: '2-digit'
    }).formatToParts(new Date());
    const anio = Number(partesMes.find((parte) => parte.type === 'year')?.value);
    const mes = Number(partesMes.find((parte) => parte.type === 'month')?.value);
    const desde = `${anio}-${String(mes).padStart(2, '0')}-01`;
    const siguienteMes = mes === 12 ? `${anio + 1}-01-01` : `${anio}-${String(mes + 1).padStart(2, '0')}-01`;
    const periodo = new Intl.DateTimeFormat('es-CO', {
        month: 'long', year: 'numeric', timeZone: 'UTC'
    }).format(new Date(`${desde}T12:00:00Z`));
    const mantenimientosSql = `SELECT tipo, COUNT(*) AS cantidad FROM mantenimientos
        WHERE fecha >= ? AND fecha < ? GROUP BY tipo ORDER BY tipo`;
    db.query(estadosSql, (errEstados, estados) => {
        if (errEstados) {
            console.error('Error al consultar estados para el panel:', errEstados);
            res.status(500).json({ error: 'No se pudo cargar la distribución por estado' });
            return;
        }
        db.query(mantenimientosSql, [desde, siguienteMes], (errMantenimientos, mantenimientos) => {
            if (errMantenimientos) {
                console.error('Error al consultar mantenimientos para el panel:', errMantenimientos);
                res.status(500).json({ error: 'No se pudo cargar la frecuencia de mantenimientos' });
                return;
            }
            res.json({ equiposPorEstado: estados, mantenimientosPorTipo: mantenimientos, periodo, mesActual: desde.slice(0, 7) });
        });
    });
});

const TIPOS_MANTENIMIENTO = ['Preventivo', 'Correctivo'];

const SELECT_MANTENIMIENTO = `
    SELECT m.id_mantenimiento, m.id_equipo, e.nombre_equipo, m.tipo,
           DATE_FORMAT(m.fecha, '%Y-%m-%d') AS fecha, m.detalle,
           m.modalidad_servicio, m.empresa_contratista, m.tecnico_contratista,
           m.orden_servicio, DATE_FORMAT(m.fecha_programada_atendida, '%Y-%m-%d') AS fecha_programada_atendida,
           m.id_usuario, u.nombre AS registrado_por
    FROM mantenimientos m
    JOIN equipos e ON e.id_equipo = m.id_equipo
    LEFT JOIN usuarios u ON u.id_usuario = m.id_usuario`;

function fechaHoy() {
    const ahora = new Date();
    return new Date(ahora.getTime() - ahora.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// Devuelve un mensaje de error, o null si la fecha (AAAA-MM-DD) es válida y no es futura
function errorDeFecha(fecha) {
    if (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        return 'La fecha debe tener el formato AAAA-MM-DD';
    }
    const parseada = new Date(`${fecha}T00:00:00Z`);
    if (Number.isNaN(parseada.getTime()) || parseada.toISOString().slice(0, 10) !== fecha) {
        return 'La fecha no es válida';
    }
    if (fecha < '2000-01-01') return 'La fecha es demasiado antigua';
    if (fecha > fechaHoy()) return 'La fecha no puede ser futura';
    return null;
}

function diasEntreFechasISO(desde, hasta) {
    if (typeof desde !== 'string' || typeof hasta !== 'string') return null;
    const parsear = (valor) => {
        const partes = valor.slice(0, 10).split('-').map(Number);
        if (partes.length !== 3 || partes.some(Number.isNaN)) return NaN;
        return Date.UTC(partes[0], partes[1] - 1, partes[2]);
    };
    const fechaDesde = parsear(desde);
    const fechaHasta = parsear(hasta);
    if (!Number.isFinite(fechaDesde) || !Number.isFinite(fechaHasta)) return null;
    return Math.round((fechaHasta - fechaDesde) / 86400000);
}

function obtenerMantenimiento(id, callback) {
    db.query(`${SELECT_MANTENIMIENTO} WHERE m.id_mantenimiento = ?`, [id], (err, results) => {
        callback(err, results && results[0]);
    });
}

// Listar todo el historial, del más reciente al más antiguo
app.get('/api/mantenimientos', (req, res) => {
    db.query(`${SELECT_MANTENIMIENTO} ORDER BY m.fecha DESC, m.id_mantenimiento DESC`, (err, results) => {
        if (err) {
            console.error('Error al listar mantenimientos:', err);
            res.status(500).json({ error: 'Error al obtener el historial' });
            return;
        }
        res.json(results);
    });
});

// Registrar un mantenimiento nuevo; responde con la fila completa para pintarla al instante
app.post('/api/mantenimientos', (req, res) => {
    const { id_equipo, tipo, fecha } = req.body || {};
    const detalle = String((req.body && req.body.detalle) ?? '').trim();
    const modalidadServicio = String(req.body?.modalidad_servicio || 'Interno');
    const empresaContratista = String(req.body?.empresa_contratista || '').trim();
    const tecnicoContratista = String(req.body?.tecnico_contratista || '').trim();
    const ordenServicio = String(req.body?.orden_servicio || '').trim();
    const proximoPreventivo = req.body && req.body.proximo_mto_preventivo
        ? req.body.proximo_mto_preventivo
        : null;

    if (!id_equipo || !tipo || !fecha || !detalle) {
        res.status(400).json({ error: 'Faltan datos requeridos (equipo, tipo, fecha y detalle)' });
        return;
    }
    if (!TIPOS_MANTENIMIENTO.includes(tipo)) {
        res.status(400).json({ error: `El tipo debe ser: ${TIPOS_MANTENIMIENTO.join(' o ')}` });
        return;
    }
    if (!['Interno', 'Externo'].includes(modalidadServicio)) {
        res.status(400).json({ error: 'La modalidad debe ser Interno o Externo.' });
        return;
    }
    if (modalidadServicio === 'Externo' && !empresaContratista) {
        res.status(400).json({ error: 'Indica la empresa contratista que realizó el mantenimiento.' });
        return;
    }
    if (empresaContratista.length > 160 || tecnicoContratista.length > 120 || ordenServicio.length > 80) {
        res.status(400).json({ error: 'Los datos del contratista superan la longitud permitida.' });
        return;
    }
    const errorFecha = errorDeFecha(fecha);
    if (errorFecha) {
        res.status(400).json({ error: errorFecha });
        return;
    }
    if (detalle.length < 10 || detalle.length > 2000) {
        res.status(400).json({ error: 'El detalle debe tener entre 10 y 2000 caracteres' });
        return;
    }
    if (tipo === 'Preventivo' && !fechaISOValidaOpcional(proximoPreventivo)) {
        res.status(400).json({ error: 'La próxima fecha de mantenimiento preventivo no es válida' });
        return;
    }
    if (tipo === 'Preventivo' && proximoPreventivo && proximoPreventivo <= fecha) {
        res.status(400).json({ error: 'La próxima fecha debe ser posterior a la fecha de la intervención' });
        return;
    }

    db.query(`SELECT e.id_equipo,
                     EXISTS (SELECT 1 FROM tecnovigilancia_bloqueos b WHERE b.id_equipo = e.id_equipo AND b.activo) AS en_cuarentena
              FROM equipos e WHERE e.id_equipo = ?`, [id_equipo], (err, existe) => {
        if (err) {
            console.error('Error al validar el equipo:', err);
            res.status(500).json({ error: 'Error al registrar el mantenimiento' });
            return;
        }
        if (existe.length === 0) {
            res.status(404).json({ error: 'El equipo no existe' });
            return;
        }
        if (existe[0].en_cuarentena) {
            res.status(423).json({ error: 'No se puede registrar mantenimiento: el equipo está bloqueado por tecnovigilancia hasta que un Administrador libere la cuarentena.' });
            return;
        }

        const insertar = `INSERT INTO mantenimientos
            (id_equipo, tipo, fecha, detalle, modalidad_servicio, empresa_contratista, tecnico_contratista, orden_servicio, fecha_programada_atendida, id_usuario)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        db.transaction(async (tx) => {
            const equiposBloqueados = await tx.query(`SELECT id_equipo, estado,
                TO_CHAR(proximo_mto_preventivo, 'YYYY-MM-DD') AS proximo_mto_preventivo
                FROM equipos WHERE id_equipo = ? FOR UPDATE`, [id_equipo]);
            if (!equiposBloqueados.length) throw Object.assign(new Error('El equipo no existe.'), { code: 'EQUIPO_NO_ENCONTRADO' });
            const equipoActual = equiposBloqueados[0];
            const bloqueoActual = await tx.query('SELECT id_bloqueo FROM tecnovigilancia_bloqueos WHERE id_equipo = ? AND activo LIMIT 1', [id_equipo]);
            if (bloqueoActual.length) {
                const errorBloqueo = new Error('Equipo bloqueado por tecnovigilancia.');
                errorBloqueo.code = 'TECNOVIGILANCIA_BLOQUEADO';
                throw errorBloqueo;
            }
            const fechaProgramadaAtendida = tipo === 'Preventivo' ? equipoActual.proximo_mto_preventivo : null;
            const diasAntes = fechaProgramadaAtendida ? diasEntreFechasISO(fecha, fechaProgramadaAtendida) : null;
            const fechaEnVentana = diasAntes !== null && diasAntes >= 0 && diasAntes <= 3;
            const estadoAnterior = equipoActual.estado;
            const normalizarEstadoEquipo = (valor) => String(valor || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
            const estadoPermiteLiberar = ['en mantenimiento', 'fuera de servicio'].includes(normalizarEstadoEquipo(estadoAnterior));
            const actualizarEstadoAutomaticamente = tipo === 'Preventivo' && fechaEnVentana && estadoPermiteLiberar;
            const modalidadPersistida = modalidadServicio;
            const result = await tx.query(insertar, [id_equipo, tipo, fecha, detalle, modalidadPersistida,
                modalidadServicio === 'Externo' ? empresaContratista : null,
                modalidadServicio === 'Externo' ? (tecnicoContratista || null) : null,
                modalidadServicio === 'Externo' ? (ordenServicio || null) : null,
                fechaProgramadaAtendida,
                req.usuario.id_usuario]);
            if (tipo === 'Preventivo') {
                await tx.query('UPDATE equipos SET proximo_mto_preventivo = ? WHERE id_equipo = ?', [proximoPreventivo, id_equipo]);
            }
            if (actualizarEstadoAutomaticamente) {
                await tx.query("UPDATE equipos SET estado = 'Operativo' WHERE id_equipo = ?", [id_equipo]);
            }
            await registrarAuditoria(req, {
                modulo: 'mantenimientos', accion: 'crear', entidad: 'mantenimiento', id_entidad: result.insertId,
                resumen: `Registró mantenimiento ${tipo} para ${id_equipo}.`,
                nuevos: { id_equipo, tipo, fecha, detalle, modalidad_servicio: modalidadPersistida,
                    ...(modalidadPersistida === 'Externo' ? { empresa_contratista: empresaContratista, tecnico_contratista: tecnicoContratista || null, orden_servicio: ordenServicio || null } : {}),
                    ...(fechaProgramadaAtendida ? { fecha_programada_atendida: fechaProgramadaAtendida, dias_antes_de_fecha_programada: diasAntes } : {}),
                    ...(tipo === 'Preventivo' ? { proximo_mto_preventivo: proximoPreventivo } : {}) }
            }, tx);
            if (actualizarEstadoAutomaticamente) {
                await registrarAuditoria(req, {
                    modulo: 'equipos', accion: 'cambiar_estado', entidad: 'equipo', id_entidad: id_equipo,
                    resumen: `El equipo ${id_equipo} volvió automáticamente a Operativo tras completar el mantenimiento preventivo programado.`,
                    anteriores: { estado: estadoAnterior },
                    nuevos: { estado: 'Operativo', motivo: 'Preventivo realizado en la fecha programada o hasta 3 días antes.', fecha_programada: fechaProgramadaAtendida, fecha_realizado: fecha }
                }, tx);
            }
            return { ...result, estado_actualizado_automaticamente: actualizarEstadoAutomaticamente, fecha_programada_atendida: fechaProgramadaAtendida };
        }).then(async (result) => {
            obtenerMantenimiento(result.insertId, (errFila, fila) => {
                if (errFila || !fila) {
                    console.error('Error al leer el mantenimiento creado:', errFila);
                    res.status(500).json({ error: 'El mantenimiento se guardó, pero no se pudo leer' });
                    return;
                }
                res.status(201).json({ ...fila, estado_actualizado_automaticamente: result.estado_actualizado_automaticamente, fecha_programada_atendida: fila.fecha_programada_atendida || result.fecha_programada_atendida });
            });
        }).catch((errInsert) => {
            if (errInsert.code === 'TECNOVIGILANCIA_BLOQUEADO') {
                res.status(423).json({ error: 'No se puede registrar mantenimiento: el equipo está bloqueado por tecnovigilancia.' });
                return;
            }
            console.error('Error al registrar el mantenimiento:', errInsert);
            res.status(500).json({ error: 'Error al registrar el mantenimiento' });
        });
    });
});

// Editar todos los campos del mantenimiento; el cambio y su auditoría son atómicos.
app.put('/api/mantenimientos/:id', async (req, res) => {
    const { id } = req.params;
    const { id_equipo, tipo, fecha } = req.body || {};
    const detalle = String((req.body && req.body.detalle) ?? '').trim();
    const modalidadServicio = String(req.body?.modalidad_servicio || 'Interno');
    const empresaContratista = String(req.body?.empresa_contratista || '').trim();
    const tecnicoContratista = String(req.body?.tecnico_contratista || '').trim();
    const ordenServicio = String(req.body?.orden_servicio || '').trim();
    const errorFecha = errorDeFecha(fecha);
    if (!/^\d+$/.test(id) || !id_equipo || !tipo || !fecha || !detalle) {
        res.status(400).json({ error: 'Faltan datos requeridos (equipo, tipo, fecha y detalle)' });
        return;
    }
    if (!TIPOS_MANTENIMIENTO.includes(tipo)) {
        res.status(400).json({ error: `El tipo debe ser: ${TIPOS_MANTENIMIENTO.join(' o ')}` });
        return;
    }
    if (!['Interno', 'Externo'].includes(modalidadServicio)) {
        res.status(400).json({ error: 'La modalidad debe ser Interno o Externo.' });
        return;
    }
    if (modalidadServicio === 'Externo' && !empresaContratista) {
        res.status(400).json({ error: 'Indica la empresa contratista que realizó el mantenimiento.' });
        return;
    }
    if (empresaContratista.length > 160 || tecnicoContratista.length > 120 || ordenServicio.length > 80) {
        res.status(400).json({ error: 'Los datos del contratista superan la longitud permitida.' });
        return;
    }
    if (errorFecha) {
        res.status(400).json({ error: errorFecha });
        return;
    }
    if (detalle.length < 10 || detalle.length > 2000) {
        res.status(400).json({ error: 'El detalle debe tener entre 10 y 2000 caracteres' });
        return;
    }

    try {
        const fila = await db.transaction(async (tx) => {
            const actuales = await tx.query('SELECT id_mantenimiento, id_equipo, tipo, fecha, detalle, modalidad_servicio, empresa_contratista, tecnico_contratista, orden_servicio, fecha_programada_atendida, id_usuario FROM mantenimientos WHERE id_mantenimiento = ? FOR UPDATE', [id]);
            if (!actuales.length) throw Object.assign(new Error('Mantenimiento no encontrado'), { code: 'MANTENIMIENTO_NO_ENCONTRADO' });
            const anterior = actuales[0];
            if (req.usuario.rol !== 'Administrador' && Number(anterior.id_usuario) !== Number(req.usuario.id_usuario)) {
                throw Object.assign(new Error('Solo puedes modificar los mantenimientos que tú registraste'), { code: 'MANTENIMIENTO_NO_AUTORIZADO' });
            }
            const equipos = await tx.query('SELECT id_equipo FROM equipos WHERE id_equipo IN (?, ?) ORDER BY id_equipo FOR UPDATE', [anterior.id_equipo, id_equipo]);
            if (!equipos.some((equipo) => equipo.id_equipo === id_equipo)) throw Object.assign(new Error('El equipo no existe'), { code: 'EQUIPO_NO_ENCONTRADO' });
            const bloqueos = await tx.query('SELECT id_equipo FROM tecnovigilancia_bloqueos WHERE activo AND id_equipo IN (?, ?) FOR UPDATE', [anterior.id_equipo, id_equipo]);
            if (bloqueos.length) throw Object.assign(new Error('No se puede modificar el mantenimiento: el equipo está bloqueado por tecnovigilancia.'), { code: 'EQUIPO_EN_CUARENTENA' });
            const actualizacion = await tx.query(`UPDATE mantenimientos SET id_equipo = ?, tipo = ?, fecha = ?, detalle = ?, modalidad_servicio = ?,
                empresa_contratista = ?, tecnico_contratista = ?, orden_servicio = ? WHERE id_mantenimiento = ?`, [
                id_equipo, tipo, fecha, detalle, modalidadServicio,
                modalidadServicio === 'Externo' ? empresaContratista : null,
                modalidadServicio === 'Externo' ? (tecnicoContratista || null) : null,
                modalidadServicio === 'Externo' ? (ordenServicio || null) : null,
                id
            ]);
            if (!actualizacion.affectedRows) throw Object.assign(new Error('El mantenimiento no se modificó.'), { code: 'MANTENIMIENTO_NO_ACTUALIZADO' });
            const nuevos = { id_equipo, tipo, fecha, detalle, modalidad_servicio: modalidadServicio,
                empresa_contratista: modalidadServicio === 'Externo' ? empresaContratista : null,
                tecnico_contratista: modalidadServicio === 'Externo' ? (tecnicoContratista || null) : null,
                orden_servicio: modalidadServicio === 'Externo' ? (ordenServicio || null) : null };
            const anteriores = { id_equipo: anterior.id_equipo, tipo: anterior.tipo, fecha: anterior.fecha, detalle: anterior.detalle,
                modalidad_servicio: anterior.modalidad_servicio || 'Interno', empresa_contratista: anterior.empresa_contratista,
                tecnico_contratista: anterior.tecnico_contratista, orden_servicio: anterior.orden_servicio };
            await registrarAuditoria(req, { modulo: 'mantenimientos', accion: 'actualizar', entidad: 'mantenimiento', id_entidad: id, resumen: `Actualizó mantenimiento ${id}.`, anteriores, nuevos }, tx);
            const filas = await tx.query(`${SELECT_MANTENIMIENTO} WHERE m.id_mantenimiento = ?`, [id]);
            return filas[0];
        });
        res.json(fila);
    } catch (error) {
        const codigos = { MANTENIMIENTO_NO_ENCONTRADO: 404, EQUIPO_NO_ENCONTRADO: 404, MANTENIMIENTO_NO_AUTORIZADO: 403, EQUIPO_EN_CUARENTENA: 423, MANTENIMIENTO_NO_ACTUALIZADO: 409 };
        if (codigos[error.code]) { res.status(codigos[error.code]).json({ error: error.message }); return; }
        console.error('Error al actualizar el mantenimiento:', error);
        res.status(500).json({ error: 'Error al actualizar el mantenimiento' });
    }
});

// Eliminar un mantenimiento conservando en la bitácora su ficha completa.
app.delete('/api/mantenimientos/:id', async (req, res) => {
    const { id } = req.params;
    if (!/^\d+$/.test(id)) {
        res.status(400).json({ error: 'Identificador de mantenimiento no válido' });
        return;
    }
    try {
        await db.transaction(async (tx) => {
            const actuales = await tx.query('SELECT id_mantenimiento, id_equipo, tipo, fecha, detalle, modalidad_servicio, empresa_contratista, tecnico_contratista, orden_servicio, fecha_programada_atendida, id_usuario FROM mantenimientos WHERE id_mantenimiento = ? FOR UPDATE', [id]);
            if (!actuales.length) throw Object.assign(new Error('Mantenimiento no encontrado'), { code: 'MANTENIMIENTO_NO_ENCONTRADO' });
            const anterior = actuales[0];
            if (req.usuario.rol !== 'Administrador' && Number(anterior.id_usuario) !== Number(req.usuario.id_usuario)) {
                throw Object.assign(new Error('Solo puedes modificar los mantenimientos que tú registraste'), { code: 'MANTENIMIENTO_NO_AUTORIZADO' });
            }
            await tx.query('SELECT id_equipo FROM equipos WHERE id_equipo = ? FOR UPDATE', [anterior.id_equipo]);
            const bloqueos = await tx.query('SELECT id_equipo FROM tecnovigilancia_bloqueos WHERE id_equipo = ? AND activo FOR UPDATE', [anterior.id_equipo]);
            if (bloqueos.length) throw Object.assign(new Error('No se puede eliminar el mantenimiento: el equipo está bloqueado por tecnovigilancia.'), { code: 'EQUIPO_EN_CUARENTENA' });
            const borrado = await tx.query('DELETE FROM mantenimientos WHERE id_mantenimiento = ?', [id]);
            if (!borrado.affectedRows) throw Object.assign(new Error('El mantenimiento no se eliminó.'), { code: 'MANTENIMIENTO_NO_ELIMINADO' });
            await registrarAuditoria(req, {
                modulo: 'mantenimientos', accion: 'eliminar', entidad: 'mantenimiento', id_entidad: id,
                resumen: `Eliminó el registro del mantenimiento #${id}.`,
                anteriores: { id_equipo: anterior.id_equipo, tipo: anterior.tipo, fecha: anterior.fecha, detalle: anterior.detalle,
                    modalidad_servicio: anterior.modalidad_servicio || 'Interno', empresa_contratista: anterior.empresa_contratista,
                    tecnico_contratista: anterior.tecnico_contratista, orden_servicio: anterior.orden_servicio,
                    fecha_programada_atendida: anterior.fecha_programada_atendida }
            }, tx);
        });
        res.json({ mensaje: 'Mantenimiento eliminado correctamente', id_mantenimiento: Number(id) });
    } catch (error) {
        const codigos = { MANTENIMIENTO_NO_ENCONTRADO: 404, MANTENIMIENTO_NO_AUTORIZADO: 403, EQUIPO_EN_CUARENTENA: 423, MANTENIMIENTO_NO_ELIMINADO: 409 };
        if (codigos[error.code]) { res.status(codigos[error.code]).json({ error: error.message }); return; }
        console.error('Error al eliminar el mantenimiento:', error);
        res.status(500).json({ error: 'Error al eliminar el mantenimiento' });
    }
});

// Compatibilidad con clientes anteriores que solo corregían la fecha
app.patch('/api/mantenimientos/:id/fecha', async (req, res) => {
    const { id } = req.params;
    const fecha = req.body && req.body.fecha;
    if (!/^\d+$/.test(id)) {
        res.status(400).json({ error: 'Identificador de mantenimiento no válido' });
        return;
    }
    const errorFecha = errorDeFecha(fecha);
    if (errorFecha) {
        res.status(400).json({ error: errorFecha });
        return;
    }
    try {
        const fila = await db.transaction(async (tx) => {
            const previos = await tx.query('SELECT id_mantenimiento, id_equipo, tipo, fecha, detalle, id_usuario FROM mantenimientos WHERE id_mantenimiento = ? FOR UPDATE', [id]);
            if (!previos.length) throw Object.assign(new Error('Mantenimiento no encontrado'), { code: 'MANTENIMIENTO_NO_ENCONTRADO' });
            const previo = previos[0];
            if (req.usuario.rol !== 'Administrador' && Number(previo.id_usuario) !== Number(req.usuario.id_usuario)) {
                throw Object.assign(new Error('Solo puedes modificar los mantenimientos que tú registraste'), { code: 'MANTENIMIENTO_NO_AUTORIZADO' });
            }
            await tx.query('SELECT id_equipo FROM equipos WHERE id_equipo = ? FOR UPDATE', [previo.id_equipo]);
            const bloqueos = await tx.query('SELECT id_equipo FROM tecnovigilancia_bloqueos WHERE id_equipo = ? AND activo FOR UPDATE', [previo.id_equipo]);
            if (bloqueos.length) throw Object.assign(new Error('No se puede modificar el mantenimiento: el equipo está bloqueado por tecnovigilancia.'), { code: 'EQUIPO_EN_CUARENTENA' });
            await tx.query('UPDATE mantenimientos SET fecha = ? WHERE id_mantenimiento = ?', [fecha, id]);
            await registrarAuditoria(req, {
                modulo: 'mantenimientos', accion: 'actualizar_fecha', entidad: 'mantenimiento', id_entidad: id,
                resumen: `Cambió la fecha del mantenimiento ${id}.`,
                anteriores: { id_equipo: previo.id_equipo, tipo: previo.tipo, fecha: previo.fecha, detalle: previo.detalle },
                nuevos: { id_equipo: previo.id_equipo, tipo: previo.tipo, fecha, detalle: previo.detalle }
            }, tx);
            const filas = await tx.query(`${SELECT_MANTENIMIENTO} WHERE m.id_mantenimiento = ?`, [id]);
            return filas[0];
        });
        res.json(fila);
    } catch (error) {
        const codigos = { MANTENIMIENTO_NO_ENCONTRADO: 404, MANTENIMIENTO_NO_AUTORIZADO: 403, EQUIPO_EN_CUARENTENA: 423 };
        if (codigos[error.code]) { res.status(codigos[error.code]).json({ error: error.message }); return; }
        console.error('Error al actualizar la fecha del mantenimiento:', error);
        res.status(500).json({ error: 'Error al actualizar la fecha' });
    }
});

function escaparHtmlServidor(valor) {
    return String(valor ?? '').replace(/[&<>"']/g, (caracter) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[caracter]));
}

function fechaLegibleCorreo(fechaISO) {
    const [anio, mes, dia] = String(fechaISO).split('-').map(Number);
    if (!anio || !mes || !dia) return String(fechaISO);
    return new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
        .format(new Date(Date.UTC(anio, mes - 1, dia, 12)));
}

function diasEtapaAlertaPreventiva(dias) {
    const diasRestantes = Number(dias);
    if ([15, 10, 5, 3, 1, 0, -1, -3, -5, -10, -15].includes(diasRestantes)) return diasRestantes;
    if (diasRestantes <= -16) return diasRestantes;
    return null;
}

function etiquetaEtapaAlertaPreventiva(dias) {
    const valor = Number(dias);
    if (valor > 0) return 'Faltan ' + valor + (valor === 1 ? ' día' : ' días');
    if (valor === 0) return 'Programado para hoy';
    const atraso = Math.abs(valor);
    return 'Vencido hace ' + atraso + (atraso === 1 ? ' día' : ' días') + (atraso >= 16 ? ' · seguimiento diario' : '');
}

async function enviarAlertasPreventivas() {
    const host = process.env.SMTP_HOST;
    const usuarioSMTP = process.env.SMTP_USER;
    const claveSMTP = process.env.SMTP_PASS;
    const remitente = process.env.MAIL_FROM || usuarioSMTP;
    if (!host || !usuarioSMTP || !claveSMTP || !remitente) {
        console.warn('Notificaciones por correo desactivadas: configura SMTP_HOST, SMTP_USER, SMTP_PASS y MAIL_FROM en .env.');
        return 0;
    }

    const [equiposCandidatos] = await db.promise().query(`
        SELECT e.id_equipo, e.nombre_equipo, e.ubicacion,
               DATE_FORMAT(e.proximo_mto_preventivo, '%Y-%m-%d') AS fecha_programada,
               DATEDIFF(e.proximo_mto_preventivo, CURRENT_DATE) AS dias,
               CASE WHEN e.proximo_mto_preventivo < CURRENT_DATE THEN 'vencido' ELSE 'proximo' END AS estado_alerta
        FROM equipos e
        WHERE e.proximo_mto_preventivo IS NOT NULL
          AND e.proximo_mto_preventivo <= DATE_ADD(CURRENT_DATE, INTERVAL 15 DAY)
          AND NOT EXISTS (
              SELECT 1 FROM mantenimientos m
              WHERE m.id_equipo = e.id_equipo
                AND m.tipo = 'Preventivo'
                AND m.fecha >= e.proximo_mto_preventivo
          )
        ORDER BY e.proximo_mto_preventivo, e.id_equipo`);
    const equiposAviso = equiposCandidatos
        .map((equipo) => ({ ...equipo, dias_alerta: diasEtapaAlertaPreventiva(equipo.dias) }))
        .filter((equipo) => equipo.dias_alerta !== null);
    if (!equiposAviso.length) return 0;

    const [usuariosDestino] = await db.promise().query(
        "SELECT DISTINCT correo FROM usuarios WHERE rol IN ('Administrador', 'Tecnico') AND correo IS NOT NULL AND correo <> ''"
    );
    const destinatarios = [...new Set(usuariosDestino.map((usuario) => String(usuario.correo).trim()).filter(Boolean))];
    if (!destinatarios.length) {
        console.warn('No se enviaron alertas: no hay usuarios con correo registrado.');
        return 0;
    }

    const ids = [...new Set(equiposAviso.map((equipo) => equipo.id_equipo))];
    const [enviadas] = await db.promise().query(
        'SELECT id_equipo, DATE_FORMAT(fecha_programada, \'%Y-%m-%d\') AS fecha_programada, estado_alerta, dias_alerta, correo_destinatario FROM notificaciones_mantenimiento_destinatarios WHERE id_equipo IN (?)',
        [ids]
    );
    const yaEnviadas = new Set(enviadas.map((fila) => `${fila.id_equipo}|${fila.fecha_programada}|${fila.dias_alerta}|${String(fila.correo_destinatario).toLowerCase()}`));

    const puerto = Number(process.env.SMTP_PORT || 587);
    const transporter = nodemailer.createTransport({
        host,
        port: puerto,
        secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : puerto === 465,
        auth: { user: usuarioSMTP, pass: claveSMTP },
        family: 4
    });
    let enviosCorrectos = 0;
    let equiposNotificados = 0;
    for (const correo of destinatarios) {
        const pendientes = equiposAviso.filter((equipo) => !yaEnviadas.has(`${equipo.id_equipo}|${equipo.fecha_programada}|${equipo.dias_alerta}|${correo.toLowerCase()}`));
        if (!pendientes.length) continue;
        const cantidadVencidos = pendientes.filter((equipo) => Number(equipo.dias) < 0).length;
        const cantidadProximos = pendientes.length - cantidadVencidos;
        const tarjetasHtml = pendientes.map((equipo) => {
            const vencido = Number(equipo.dias) < 0;
            const colorEstado = vencido ? '#b42318' : '#087e72';
            const fondoEstado = vencido ? '#fff1f0' : '#e8f7f3';
            const etiquetaEstado = etiquetaEtapaAlertaPreventiva(equipo.dias);
            return `<tr><td style="padding:0 0 12px">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dce8ea;border-radius:14px;border-collapse:separate;background:#ffffff;overflow:hidden">
                    <tr><td width="4" bgcolor="${colorEstado}" style="width:4px;font-size:0;line-height:0">&nbsp;</td><td style="padding:17px 17px 15px">
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
                            <td valign="top" style="font-family:Arial,sans-serif;color:#102f35;font-size:15px;font-weight:700;line-height:1.4">${escaparHtmlServidor(equipo.nombre_equipo)}<div style="margin-top:4px;color:#718096;font-size:11px;font-weight:400;letter-spacing:.3px">ID ${escaparHtmlServidor(equipo.id_equipo)}</div></td>
                            <td align="right" valign="top" style="padding-left:8px"><span style="display:inline-block;border-radius:999px;background:${fondoEstado};color:${colorEstado};padding:7px 10px;font-family:Arial,sans-serif;font-size:11px;font-weight:700;line-height:1.2">${escaparHtmlServidor(etiquetaEstado)}</span></td>
                        </tr></table>
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:15px;border-top:1px solid #edf2f4"><tr>
                            <td width="50%" valign="top" style="padding:12px 8px 0 0;font-family:Arial,sans-serif;color:#8997a8;font-size:10px;font-weight:700;letter-spacing:.7px;line-height:1.4">UBICACIÓN<br><span style="display:inline-block;margin-top:4px;color:#243b53;font-size:13px;font-weight:600;letter-spacing:0">${escaparHtmlServidor(equipo.ubicacion)}</span></td>
                            <td width="50%" valign="top" style="padding:12px 0 0 8px;font-family:Arial,sans-serif;color:#8997a8;font-size:10px;font-weight:700;letter-spacing:.7px;line-height:1.4">FECHA PROGRAMADA<br><span style="display:inline-block;margin-top:4px;color:#243b53;font-size:13px;font-weight:600;letter-spacing:0">${escaparHtmlServidor(fechaLegibleCorreo(equipo.fecha_programada))}</span></td>
                        </tr></table>
                    </td></tr>
                </table>
            </td></tr>`;
        }).join('');
        const textoPlano = [
            `BioMant · ${pendientes.length} alerta${pendientes.length === 1 ? '' : 's'} de mantenimiento preventivo`,
            `${cantidadVencidos} vencidos · ${cantidadProximos} próximos o programados para hoy`,
            '',
            ...pendientes.map((equipo) => `${equipo.nombre_equipo} (${equipo.id_equipo})\nEstado: ${etiquetaEtapaAlertaPreventiva(equipo.dias)}\nUbicación: ${equipo.ubicacion}\nFecha: ${fechaLegibleCorreo(equipo.fecha_programada)}`),
            '',
            'Mensaje automático de BioMant · Gestión de mantenimiento clínico.'
        ].join('\n');
        const basePublica = String(process.env.APP_PUBLIC_URL || '').trim().replace(/\/$/, '');
        const enlaceInventario = /^https?:\/\//i.test(basePublica)
            ? `<tr><td align="center" style="padding:6px 26px 26px"><a href="${escaparHtmlServidor(basePublica)}" style="display:inline-block;border-radius:10px;background:#0d7377;color:#ffffff;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:700;padding:14px 24px">Abrir BioMant&nbsp;&nbsp;→</a></td></tr>`
            : '';
        try {
            const resultadoCorreo = await transporter.sendMail({
                from: remitente,
                to: correo,
                subject: `BioMant | ${pendientes.length} alerta${pendientes.length === 1 ? '' : 's'} de mantenimiento preventivo`,
                text: textoPlano,
                html: `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head>
                <body style="margin:0;padding:0;background:#edf3f5;color:#243b53;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
                    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${pendientes.length} mantenimientos preventivos requieren seguimiento: ${cantidadVencidos} vencidos y ${cantidadProximos} próximos o programados para hoy.&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#edf3f5" style="width:100%;background:#edf3f5;padding:32px 12px"><tr><td align="center">
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;border:1px solid #dce7e9;border-radius:20px;border-collapse:separate;overflow:hidden;background:#ffffff;box-shadow:0 12px 36px rgba(15,61,62,.08)">
                            <tr><td bgcolor="#0b3436" style="background:#0b3436;background-image:linear-gradient(120deg,#0b2c2d 0%,#0d5557 100%);padding:23px 28px;color:#ffffff"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
                                <td width="48" valign="middle"><table role="presentation" width="42" height="42" cellpadding="0" cellspacing="0" bgcolor="#0d7377" style="width:42px;height:42px;border-radius:13px;background:#0d7377"><tr><td align="center" valign="middle" style="color:#ffffff;font-family:Arial,sans-serif;font-size:22px;font-weight:700">B</td></tr></table></td>
                                <td style="padding-left:12px"><div style="font-family:Arial,sans-serif;font-size:21px;font-weight:700;letter-spacing:.2px">BioMant</div><div style="margin-top:4px;color:#b9e6df;font-family:Arial,sans-serif;font-size:12px">Gestión de mantenimiento clínico</div></td>
                                <td align="right" valign="middle"><span style="display:inline-block;border:1px solid #66c9bd;background:#ffffff;color:#0b5555;border-radius:999px;padding:7px 10px;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:.8px">PREVENTIVO</span></td>
                            </tr></table></td></tr>
                            <tr><td bgcolor="#0d5557" style="height:4px;line-height:4px;font-size:0;background:#0d7377">&nbsp;</td></tr>
                            <tr><td style="padding:30px 28px 14px"><p style="margin:0 0 9px;color:#0d7377;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase">Resumen de mantenimiento</p><h1 style="margin:0;color:#102f35;font-family:Arial,sans-serif;font-size:26px;line-height:1.25;font-weight:700">Hay equipos que requieren seguimiento</h1><p style="margin:11px 0 0;color:#64748b;font-family:Arial,sans-serif;font-size:14px;line-height:1.65">Consulta las fechas programadas y coordina a tiempo las intervenciones preventivas de la clínica.</p></td></tr>
                            <tr><td style="padding:12px 28px 23px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
                                <td width="50%" valign="top" style="padding-right:6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#fff4f2" style="background:#fff4f2;border:1px solid #fee2dc;border-radius:13px"><tr><td style="padding:14px 16px 2px;color:#b42318;font-family:Arial,sans-serif;font-size:25px;font-weight:700;line-height:1.1">${cantidadVencidos}</td></tr><tr><td style="padding:4px 16px 14px;color:#8f2c27;font-family:Arial,sans-serif;font-size:12px;font-weight:600">Vencidos</td></tr></table></td>
                                <td width="50%" valign="top" style="padding-left:6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#eff9f6" style="background:#eff9f6;border:1px solid #d4eee6;border-radius:13px"><tr><td style="padding:14px 16px 2px;color:#087e72;font-family:Arial,sans-serif;font-size:25px;font-weight:700;line-height:1.1">${cantidadProximos}</td></tr><tr><td style="padding:4px 16px 14px;color:#14645e;font-family:Arial,sans-serif;font-size:12px;font-weight:600">Próximos o para hoy</td></tr></table></td>
                            </tr></table></td></tr>
                            <tr><td style="padding:0 28px 10px;color:#334155;font-family:Arial,sans-serif;font-size:13px;font-weight:700">Equipos incluidos <span style="color:#94a3b8;font-size:12px;font-weight:400">(${pendientes.length})</span></td></tr>
                            <tr><td style="padding:0 28px 14px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${tarjetasHtml}</table></td></tr>
                            ${enlaceInventario}
                            <tr><td bgcolor="#f8fafb" style="border-top:1px solid #e8edf0;background:#f8fafb;padding:19px 28px 22px;color:#8291a2;font-family:Arial,sans-serif;font-size:11px;line-height:1.65">Mensaje automático de BioMant. Esta dirección no recibe respuestas.<br><span style="color:#536575;font-weight:600">Clínica de los Ríos</span> · Gestión y trazabilidad de equipos clínicos.</td></tr>
                        </table>
                        <p style="margin:16px 0 0;color:#94a3b8;font-family:Arial,sans-serif;font-size:10px;line-height:1.5">BioMant · Sistema de gestión de mantenimiento clínico</p>
                    </td></tr></table>
                </body></html>`
            });
            const destinatarioAceptado = (resultadoCorreo.accepted || []).some((aceptado) =>
                String(aceptado.address || aceptado).toLowerCase() === correo.toLowerCase()
            );
            if (!destinatarioAceptado) throw new Error('El servidor SMTP no aceptó este destinatario.');
            const registros = pendientes.map((equipo) => [equipo.id_equipo, equipo.fecha_programada, equipo.estado_alerta, equipo.dias_alerta, correo]);
            await db.promise().query('INSERT IGNORE INTO notificaciones_mantenimiento_destinatarios (id_equipo, fecha_programada, estado_alerta, dias_alerta, correo_destinatario) VALUES ?', [registros]);
            enviosCorrectos += 1;
            equiposNotificados = Math.max(equiposNotificados, pendientes.length);
        } catch (error) {
            console.error(`No se pudieron enviar alertas a ${correo}:`, error.message || error);
        }
    }
    console.log(`Alertas preventivas enviadas a ${enviosCorrectos} destinatario(s); hasta ${equiposNotificados} equipo(s) por destinatario.`);
    return enviosCorrectos;
}

const tieneSMTP = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
if (tieneSMTP) {
    enviarAlertasPreventivas().catch((error) => console.error('Falló la revisión inicial de alertas preventivas:', error));
    cron.schedule(process.env.MAINTENANCE_ALERT_CRON || '0 8 * * *', () => {
        enviarAlertasPreventivas().catch((error) => console.error('Falló el envío de alertas preventivas:', error));
    }, { timezone: process.env.APP_TIMEZONE || 'America/Bogota' });
    console.log(`Alertas por correo programadas: ${process.env.MAINTENANCE_ALERT_CRON || '0 8 * * *'} (${process.env.APP_TIMEZONE || 'America/Bogota'}).`);
} else {
    console.warn('Notificaciones por correo desactivadas hasta configurar SMTP_HOST, SMTP_USER y SMTP_PASS.');
}

app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});

