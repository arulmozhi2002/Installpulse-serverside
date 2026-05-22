const { Boom } = require('@hapi/boom')
const mongoose = require('mongoose')

// Baileys is ESM-only — use dynamic import and cache the module
let _baileys = null
async function baileys() {
    if (!_baileys) _baileys = await import('@whiskeysockets/baileys')
    return _baileys
}

const activeClients = new Map()
const sockQrReady = new Map()

// ── Silent logger ─────────────────────────────────────────────────────────
const logger = {
    level: 'silent',
    trace: () => {}, debug: () => {}, info: () => {},
    warn: () => {}, error: () => {}, fatal: () => {},
    child: function () { return this },
}

// ── MongoDB auth state ────────────────────────────────────────────────────

const authSchema = new mongoose.Schema({
    tenant_id: { type: String, required: true, unique: true },
    data:      { type: String, default: '{}' }
})

let AuthModel = null
function getAuthModel() {
    if (AuthModel) return AuthModel
    try { AuthModel = mongoose.model('BaileysAuth') }
    catch { AuthModel = mongoose.model('BaileysAuth', authSchema) }
    return AuthModel
}

async function useMongoAuthState(tenantId) {
    const { initAuthCreds, BufferJSON } = await baileys()
    const Model = getAuthModel()

    const doc = await Model.findOne({ tenant_id: tenantId })
    let cached = { creds: initAuthCreds(), keys: {} }
    if (doc?.data && doc.data !== '{}') {
        try { cached = JSON.parse(doc.data, BufferJSON.reviver) } catch {}
    }

    const persist = async () => {
        await Model.updateOne(
            { tenant_id: tenantId },
            { data: JSON.stringify(cached, BufferJSON.replacer) },
            { upsert: true }
        )
    }

    const state = {
        creds: cached.creds,
        keys: {
            get: async (type, ids) => {
                const result = {}
                for (const id of ids) result[id] = cached.keys[`${type}-${id}`]
                return result
            },
            set: async (data) => {
                for (const [type, values] of Object.entries(data)) {
                    for (const [id, value] of Object.entries(values || {})) {
                        const key = `${type}-${id}`
                        if (value != null) cached.keys[key] = value
                        else delete cached.keys[key]
                    }
                }
                await persist()
            }
        }
    }

    const saveCreds = async () => {
        cached.creds = state.creds
        await persist()
    }

    return { state, saveCreds }
}

// ── Profile pic cache ─────────────────────────────────────────────────────

const dpCache = new Map()
const DP_TTL = 10 * 60 * 1000

async function getCachedDp(sock, jid) {
    const cached = dpCache.get(jid)
    if (cached && Date.now() - cached.ts < DP_TTL) return cached.url
    try {
        const url = await sock.profilePictureUrl(jid, 'image')
        dpCache.set(jid, { url, ts: Date.now() })
        return url
    } catch {
        dpCache.set(jid, { url: null, ts: Date.now() })
        return null
    }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function initializeWhatsApp(tenantId, classifyFn, onInitError, onReady, onDisconnected) {
    console.log(`[${tenantId}] Initializing WhatsApp client...`)

    const { default: makeWASocket, DisconnectReason, Browsers, fetchLatestBaileysVersion } = await baileys()

    let state, saveCreds
    try {
        ;({ state, saveCreds } = await useMongoAuthState(tenantId))
    } catch (err) {
        console.error(`[${tenantId}] Auth state error:`, err.message)
        if (onInitError) onInitError()
        return
    }

    // Fetch current WA Web version — old versions get a 405 rejection
    let version = [2, 3000, 1023473728]
    try {
        const result = await Promise.race([
            fetchLatestBaileysVersion(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
        ])
        version = result.version
        console.log(`[${tenantId}] WA version:`, version.join('.'))
    } catch {
        console.log(`[${tenantId}] Using fallback WA version`)
    }

    const sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        getMessage: async () => undefined,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60_000,
    })

    activeClients.set(tenantId, sock)
    sockQrReady.set(tenantId, false)
    sock.ev.on('creds.update', saveCreds)

    let qrSeen = false

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            qrSeen = true
            sockQrReady.set(tenantId, true)
            console.log(`[${tenantId}] QR received`)
            await mongoose.model('Tenant').updateOne(
                { tenant_id: tenantId },
                { status: 'disconnected', qr }
            ).catch(() => {})
        }

        if (connection === 'connecting' && qrSeen) {
            qrSeen = false
            await mongoose.model('Tenant').updateOne(
                { tenant_id: tenantId },
                { status: 'authenticating', qr: null }
            ).catch(() => {})
        }

        if (connection === 'open') {
            console.log(`[${tenantId}] Connected`)
            const number = sock.user?.id ? '+' + sock.user.id.split(':')[0] : 'Device Connected'
            await mongoose.model('Tenant').updateOne(
                { tenant_id: tenantId },
                { status: 'connected', qr: null, number }
            ).catch(() => {})
            if (onReady) onReady()
        }

        if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
            const loggedOut = statusCode === DisconnectReason.loggedOut
            console.log(`[${tenantId}] Disconnected, code:`, statusCode)

            await mongoose.model('Tenant').updateOne(
                { tenant_id: tenantId },
                { status: 'disconnected', qr: null }
            ).catch(() => {})

            activeClients.delete(tenantId)
            sockQrReady.delete(tenantId)

            if (loggedOut) {
                await getAuthModel().deleteOne({ tenant_id: tenantId }).catch(() => {})
                if (onDisconnected) onDisconnected()
            } else {
                // Delay reconnect to avoid rapid retry loops that trigger WhatsApp rate-limiting
                setTimeout(() => { if (onDisconnected) onDisconnected() }, 8000)
            }
        }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return

        let rules = []
        try {
            const tenant = await mongoose.model('Tenant').findOne({ tenant_id: tenantId })
            rules = tenant?.rules || []
        } catch {}

        for (const msg of messages) {
            if (msg.key.fromMe) continue
            const remoteJid = msg.key.remoteJid
            if (!remoteJid || remoteJid === 'status@broadcast') continue

            const body = msg.message?.conversation
                || msg.message?.extendedTextMessage?.text
                || msg.message?.imageMessage?.caption
                || msg.message?.videoMessage?.caption
                || ''

            if (!body) continue

            const isGroup = remoteJid.endsWith('@g.us')
            const senderJid = isGroup ? (msg.key.participant || remoteJid) : remoteJid
            const senderName = msg.pushName || senderJid.split('@')[0]

            let groupName = senderName
            if (isGroup) {
                try {
                    const meta = await sock.groupMetadata(remoteJid)
                    groupName = meta.subject
                } catch {
                    groupName = remoteJid.split('@')[0]
                }
            }

            const dpUrl = await getCachedDp(sock, senderJid)
            const cls = classifyFn(body, rules)
            console.log(`[${tenantId}] Message from ${senderName}:`, body)

            try {
                await new (mongoose.model('Message'))({
                    id: msg.key.id,
                    tenant_id: tenantId,
                    sender: senderName,
                    sender_dp: dpUrl,
                    group_name: groupName,
                    message: body,
                    time: new Date().toLocaleTimeString(),
                    severity: cls.severity,
                    ai_label: cls.label,
                    confidence: cls.confidence
                }).save()
            } catch (err) {
                if (err.code !== 11000) console.error(`[${tenantId}] Save error:`, err.message)
            }
        }
    })
}

async function requestPairingCode(tenantId, phoneNumber) {
    // Wait up to 30s for the socket to connect and emit the QR event (QR-ready state)
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
        const sock = activeClients.get(tenantId)
        if (sock && sockQrReady.get(tenantId)) {
            const digits = phoneNumber.replace(/\D/g, '')
            return await sock.requestPairingCode(digits)
        }
        await new Promise(r => setTimeout(r, 800))
    }
    throw new Error('Socket not ready — server may still be starting, please try again')
}

async function clearAuthState(tenantId) {
    await getAuthModel().deleteOne({ tenant_id: tenantId }).catch(() => {})
}

async function destroyClient(tenantId) {
    const sock = activeClients.get(tenantId)
    if (sock) {
        activeClients.delete(tenantId)
        sockQrReady.delete(tenantId)
        sock.ev.removeAllListeners()
        try { sock.end() } catch {}
    }
}

async function destroyAllClients() {
    for (const [tenantId, sock] of activeClients.entries()) {
        console.log(`[${tenantId}] Destroying...`)
        sock.ev.removeAllListeners()
        try { sock.end() } catch (e) {
            console.error(`[${tenantId}] Destroy error:`, e.message)
        }
    }
    activeClients.clear()
}

module.exports = { initializeWhatsApp, destroyClient, destroyAllClients, requestPairingCode, clearAuthState }
