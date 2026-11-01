const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { Pool } = require('pg');

const projectRoot = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(projectRoot, '.env') });

const MAGIC = Buffer.from('BIOMANTDB1');
const MAX_STORAGE_BYTES = 512 * 1024 * 1024;

function quoteIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function serializable(value) {
    if (Buffer.isBuffer(value)) return { __biomantBackupType: 'bytea', base64: value.toString('base64') };
    if (value instanceof Date) return { __biomantBackupType: 'date', iso: value.toISOString() };
    if (Array.isArray(value)) return value.map(serializable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializable(item)]));
    return value;
}

function fromSerializable(value) {
    if (Array.isArray(value)) return value.map(fromSerializable);
    if (value && typeof value === 'object') {
        if (value.__biomantBackupType === 'bytea') return Buffer.from(value.base64, 'base64');
        if (value.__biomantBackupType === 'date') return value.iso;
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fromSerializable(item)]));
    }
    return value;
}

function getBackupKey() {
    const key = Buffer.from(process.env.BIOMANT_BACKUP_KEY || '', 'base64');
    if (key.length !== 32) throw new Error('Ejecuta scripts/backup_supabase.ps1 para preparar la clave cifrada de este usuario de Windows.');
    return key;
}

function supabaseStorageConfig() {
    const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    let baseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
    if (!baseUrl) {
        const dbUrl = new URL(process.env.SUPABASE_DATABASE_URL || '');
        const projectRef = decodeURIComponent(dbUrl.username || '').match(/^postgres\.([a-z0-9]+)$/i)?.[1]
            || dbUrl.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i)?.[1];
        if (projectRef) baseUrl = `https://${projectRef}.supabase.co`;
    }
    if (!secret || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(baseUrl)) {
        throw new Error('Falta la configuración de servidor de Supabase Storage en .env.');
    }
    return { baseUrl, secret };
}

async function storageRequest(resource, options = {}) {
    const { baseUrl, secret } = supabaseStorageConfig();
    const headers = { apikey: secret };
    if (!secret.startsWith('sb_secret_')) headers.Authorization = `Bearer ${secret}`;
    if (options.body) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${baseUrl}/storage/v1/${resource}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
    if (!response.ok) throw new Error(`Supabase Storage respondió HTTP ${response.status}.`);
    return response;
}

async function backupBucket(bucket) {
    const objects = [];
    let totalBytes = 0;

    async function listPrefix(prefix) {
        for (let offset = 0; ; offset += 100) {
            const response = await storageRequest(`object/list/${encodeURIComponent(bucket)}`, {
                method: 'POST', body: JSON.stringify({ prefix, limit: 100, offset, sortBy: { column: 'name', order: 'asc' } })
            });
            const items = await response.json();
            if (!Array.isArray(items)) throw new Error(`No se pudo enumerar el bucket ${bucket}.`);
            for (const item of items) {
                const current = prefix ? `${prefix}/${item.name}` : item.name;
                if (item.id == null && item.metadata == null) {
                    await listPrefix(current);
                    continue;
                }
                const objectResponse = await storageRequest(`object/authenticated/${encodeURIComponent(bucket)}/${current.split('/').map(encodeURIComponent).join('/')}`);
                const body = Buffer.from(await objectResponse.arrayBuffer());
                totalBytes += body.length;
                if (totalBytes > MAX_STORAGE_BYTES) throw new Error(`El contenido de Storage excede el límite de respaldo de ${MAX_STORAGE_BYTES / 1024 / 1024} MB.`);
                objects.push({ path: current, bytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex'), base64: body.toString('base64') });
            }
            if (items.length < 100) break;
        }
    }

    await listPrefix('');
    return { bucket, objectCount: objects.length, totalBytes, objects };
}

async function createSnapshot(pool) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const tablesResult = await client.query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
            ORDER BY table_name
        `);
        const tables = [];
        for (const { table_name: table } of tablesResult.rows) {
            const columnsResult = await client.query(`
                SELECT column_name, data_type, is_identity, identity_generation, is_generated
                FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = $1
                ORDER BY ordinal_position
            `, [table]);
            const columns = columnsResult.rows;
            const result = await client.query(`SELECT * FROM public.${quoteIdentifier(table)}`);
            tables.push({ table, columns, rows: result.rows.map(serializable) });
        }
        await client.query('COMMIT');
        return tables;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

function makeEncryptedBackup(payload, basePath, key) {
    const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const artifact = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
    const backupPath = `${basePath}.bmbackup`;
    fs.writeFileSync(backupPath, artifact, { flag: 'wx' });
    return { backupPath, encryptedBytes: artifact.length, sha256: crypto.createHash('sha256').update(artifact).digest('hex') };
}

function decryptBackup(backupPath, key) {
    const artifact = fs.readFileSync(backupPath);
    if (artifact.subarray(0, MAGIC.length).compare(MAGIC) !== 0 || artifact.length < MAGIC.length + 28) {
        throw new Error('El archivo de respaldo no tiene un formato válido.');
    }
    const iv = artifact.subarray(MAGIC.length, MAGIC.length + 12);
    const tag = artifact.subarray(MAGIC.length + 12, MAGIC.length + 28);
    const ciphertext = artifact.subarray(MAGIC.length + 28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
}

async function verifyRestore(pool, tables) {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
        await client.query('BEGIN');
        transactionOpen = true;
        let restoredRows = 0;
        for (let index = 0; index < tables.length; index += 1) {
            const { table, columns, rows } = tables[index];
            const temporary = `bm_recovery_${index}`;
            await client.query(`CREATE TEMP TABLE ${quoteIdentifier(temporary)} (LIKE public.${quoteIdentifier(table)} INCLUDING ALL) ON COMMIT DROP`);
            const writableColumns = columns.filter((column) => column.is_generated !== 'ALWAYS');
            const names = writableColumns.map((column) => column.column_name);
            const batchSize = Math.max(1, Math.floor(50000 / Math.max(1, names.length)));
            for (let start = 0; start < rows.length; start += batchSize) {
                const batch = rows.slice(start, start + batchSize);
                for (let rowStart = 0; rowStart < batch.length; rowStart += 100) {
                    const rowBatch = batch.slice(rowStart, rowStart + 100);
                    if (!names.length) {
                        for (const _row of rowBatch) await client.query(`INSERT INTO ${quoteIdentifier(temporary)} DEFAULT VALUES`);
                        continue;
                    }
                    const flat = [];
                    const tuples = rowBatch.map((row) => `(${names.map((name) => {
                        flat.push(fromSerializable(row[name]));
                        return `$${flat.length}`;
                    }).join(', ')})`);
                    const override = writableColumns.some((column) => column.is_identity === 'YES') ? ' OVERRIDING SYSTEM VALUE' : '';
                    await client.query(`INSERT INTO ${quoteIdentifier(temporary)} (${names.map(quoteIdentifier).join(', ')})${override} VALUES ${tuples.join(', ')}`, flat);
                }
            }
            const countResult = await client.query(`SELECT COUNT(*)::bigint AS count FROM ${quoteIdentifier(temporary)}`);
            const count = Number(countResult.rows[0].count);
            if (count !== rows.length) throw new Error(`La tabla ${table} recuperó ${count} de ${rows.length} filas.`);
            restoredRows += count;
        }
        await client.query('ROLLBACK');
        transactionOpen = false;
        return { restoredTables: tables.length, restoredRows };
    } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function main() {
    if (!process.env.SUPABASE_DATABASE_URL) throw new Error('Falta SUPABASE_DATABASE_URL en .env.');
    const key = getBackupKey();
    const pool = new Pool({ connectionString: process.env.SUPABASE_DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2, connectionTimeoutMillis: 15000 });
    try {
        const tables = await createSnapshot(pool);
        const buckets = [...new Set([process.env.SUPABASE_STORAGE_BUCKET || 'biomant-equipo-fotos', process.env.SUPABASE_ORDENES_BUCKET || 'biomant-ordenes-informes'])];
        const storage = [];
        for (const bucket of buckets) storage.push(await backupBucket(bucket));
        const payload = { format: 'biomant-supabase-logical-backup-v1', generatedAt: new Date().toISOString(), database: { schema: 'public', tables }, storage };
        const backupDirectory = path.join(projectRoot, 'backups');
        fs.mkdirSync(backupDirectory, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const basePath = path.join(backupDirectory, `biomant-${stamp}`);
        const files = makeEncryptedBackup(payload, basePath, key);
        const decrypted = decryptBackup(files.backupPath, key);
        for (const bucket of decrypted.storage) {
            for (const object of bucket.objects) {
                const content = Buffer.from(object.base64, 'base64');
                if (content.length !== object.bytes || crypto.createHash('sha256').update(content).digest('hex') !== object.sha256) {
                    throw new Error(`La verificación de integridad falló para un objeto del bucket ${bucket.bucket}.`);
                }
            }
        }
        const restore = await verifyRestore(pool, decrypted.database.tables);
        console.log(`Respaldo cifrado: ${path.relative(projectRoot, files.backupPath)}`);
        console.log('Clave del respaldo: protegida con Windows DPAPI para esta cuenta de Windows.');
        console.log(`SHA-256 del respaldo: ${files.sha256}`);
        console.log(`Verificación de recuperación: ${restore.restoredTables} tablas y ${restore.restoredRows} filas restauradas en tablas temporales; transacción revertida.`);
        for (const bucket of storage) console.log(`Storage ${bucket.bucket}: ${bucket.objectCount} objetos, ${bucket.totalBytes} bytes cifrados en el respaldo.`);
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(`Respaldo/verificación no completado: ${error.message || error}`);
    process.exitCode = 1;
});
