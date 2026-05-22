const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');

const activeClients = new Map();

async function initializeWhatsApp(tenantId, classifyFn, onInitError, onReady, onDisconnected) {
    console.log(`[${tenantId}] Initializing WhatsApp client...`);

    // Store session in MongoDB so it survives Render restarts and deploys
    const store = new MongoStore({ mongoose });

    const client = new Client({
        authStrategy: new RemoteAuth({
            clientId: tenantId,
            store,
            backupSyncIntervalMs: 60000
        }),
        puppeteer: {
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-software-rasterizer',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--mute-audio'
            ]
        }
    });

    let isDestroyed = false;
    const cleanup = async () => {
        if (isDestroyed) return;
        isDestroyed = true;
        activeClients.delete(tenantId);
        client.destroy().catch(() => {});
    };

    client.on('qr', async qr => {
        console.log(`[${tenantId}] QR received`);
        await mongoose.model('Tenant').updateOne(
            { tenant_id: tenantId },
            { status: 'disconnected', qr }
        );
    });

    client.on('authenticated', async () => {
        console.log(`[${tenantId}] Authenticated`);
        await mongoose.model('Tenant').updateOne(
            { tenant_id: tenantId },
            { status: 'authenticating', qr: null }
        );
    });

    client.on('auth_failure', async msg => {
        console.error(`[${tenantId}] Auth failure:`, msg);
        await mongoose.model('Tenant').updateOne(
            { tenant_id: tenantId },
            { status: 'disconnected', qr: null }
        );
        await cleanup();
        if (onDisconnected) onDisconnected();
    });

    client.on('disconnected', async reason => {
        console.log(`[${tenantId}] Disconnected:`, reason);
        await mongoose.model('Tenant').updateOne(
            { tenant_id: tenantId },
            { status: 'disconnected', qr: null }
        );
        await cleanup();
        if (onDisconnected) onDisconnected();
    });

    client.on('ready', async () => {
        console.log(`[${tenantId}] Client ready`);
        const number = client.info?.wid ? '+' + client.info.wid.user : 'Device Connected';
        await mongoose.model('Tenant').updateOne(
            { tenant_id: tenantId },
            { status: 'connected', qr: null, number }
        );
        if (onReady) onReady();

        // Sync recent messages on first connect
        try {
            const chats = await client.getChats();
            const MessageModel = mongoose.model('Message');
            const tenant = await mongoose.model('Tenant').findOne({ tenant_id: tenantId });
            const rules = tenant?.rules || [];

            for (const chat of chats.slice(0, 10)) {
                const msgs = await chat.fetchMessages({ limit: 15 });
                for (const msg of msgs) {
                    if (msg.fromMe) continue;
                    if (msg.from === 'status@broadcast' || msg.to === 'status@broadcast') continue;
                    const exists = await MessageModel.exists({ id: msg.id._serialized });
                    if (!exists) {
                        const contact = await msg.getContact();
                        const senderName = contact.name || contact.pushname || msg._data?.notifyName || msg.from.split('@')[0];
                        const dpUrl = await contact.getProfilePicUrl().catch(() => null);
                        // For DMs use the contact's name; for groups use the group name
                        const groupName = msg.from.includes('@g.us') ? chat.name : senderName;
                        const cls = classifyFn(msg.body || '', rules);
                        await new MessageModel({
                            id: msg.id._serialized,
                            tenant_id: tenantId,
                            sender: senderName,
                            sender_dp: dpUrl,
                            group_name: groupName,
                            message: msg.body || '',
                            time: new Date(msg.timestamp * 1000).toLocaleTimeString(),
                            severity: cls.severity,
                            ai_label: cls.label,
                            confidence: cls.confidence,
                            createdAt: new Date(msg.timestamp * 1000)
                        }).save().catch(() => {});
                    }
                }
            }
            console.log(`[${tenantId}] Past messages synced`);
        } catch (err) {
            console.error(`[${tenantId}] Sync error:`, err.message);
        }
    });

    client.on('message', async msg => {
        if (msg.fromMe) return;
        if (msg.from === 'status@broadcast' || msg.to === 'status@broadcast') return;
        console.log(`[${tenantId}] Message received:`, msg.body);

        const tenant = await mongoose.model('Tenant').findOne({ tenant_id: tenantId });
        const rules = tenant?.rules || [];
        const cls = classifyFn(msg.body, rules);

        const contact = await msg.getContact();
        const senderName = contact.name || contact.pushname || msg._data?.notifyName || msg.from.split('@')[0];
        const dpUrl = await contact.getProfilePicUrl().catch(() => null);
        const chat = await msg.getChat();
        // For DMs use the contact's name; for groups use the group name
        const groupName = msg.from.includes('@g.us') ? chat.name : senderName;

        try {
            await new (mongoose.model('Message'))({
                id: msg.id._serialized,
                tenant_id: tenantId,
                sender: senderName,
                sender_dp: dpUrl,
                group_name: groupName,
                message: msg.body,
                time: new Date().toLocaleTimeString(),
                severity: cls.severity,
                ai_label: cls.label,
                confidence: cls.confidence
            }).save();
        } catch (err) {
            console.error(`[${tenantId}] Save error:`, err.message);
        }
    });

    activeClients.set(tenantId, client);

    client.initialize().catch(async err => {
        console.error(`[${tenantId}] Init error:`, err.message);
        await mongoose.model('Tenant').updateOne(
            { tenant_id: tenantId },
            { status: 'disconnected', qr: null }
        );
        await cleanup();
        if (onInitError) onInitError();
    });
}

async function destroyClient(tenantId) {
    const client = activeClients.get(tenantId);
    if (client) {
        activeClients.delete(tenantId);
        await client.destroy().catch(() => {});
    }
}

async function destroyAllClients() {
    for (const [tenantId, client] of activeClients.entries()) {
        try {
            console.log(`[${tenantId}] Destroying...`);
            await client.destroy();
        } catch (e) {
            console.error(`[${tenantId}] Destroy error:`, e.message);
        }
    }
    activeClients.clear();
}

module.exports = { initializeWhatsApp, destroyClient, destroyAllClients };
