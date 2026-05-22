const { Client, LocalAuth } = require('whatsapp-web.js');
const mongoose = require('mongoose');

const activeClients = new Map();

function initializeWhatsApp(tenantId, classifyFn, onInitError, onReady, onDisconnected) {
    console.log(`Initializing WhatsApp Client for Tenant: ${tenantId}...`);

    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: tenantId,
            dataPath: './.wwebjs_auth'
        }),
        puppeteer: {
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

    // Guard: prevents double-cleanup if multiple error events fire
    let isDestroyed = false;
    const cleanup = async () => {
        if (isDestroyed) return;
        isDestroyed = true;
        activeClients.delete(tenantId);
        client.destroy().catch(() => {});
    };

    client.on('qr', async qr => {
        console.log(`[${tenantId}] QR Code Received`);
        await mongoose.model('Tenant').updateOne({ tenant_id: tenantId }, { status: 'disconnected', qr });
    });

    client.on('authenticated', async () => {
        console.log(`[${tenantId}] AUTHENTICATED successfully!`);
        await mongoose.model('Tenant').updateOne({ tenant_id: tenantId }, { status: 'authenticating', qr: null });
    });

    client.on('auth_failure', async msg => {
        console.error(`[${tenantId}] AUTHENTICATION FAILURE`, msg);
        await mongoose.model('Tenant').updateOne({ tenant_id: tenantId }, { status: 'disconnected', qr: null });
        await cleanup();
        if (onDisconnected) onDisconnected();
    });

    client.on('disconnected', async (reason) => {
        console.log(`[${tenantId}] Client disconnected:`, reason);
        await mongoose.model('Tenant').updateOne({ tenant_id: tenantId }, { status: 'disconnected', qr: null });
        await cleanup();
        if (onDisconnected) onDisconnected();
    });

    client.on('ready', async () => {
        console.log(`[${tenantId}] WhatsApp Client is ready!`);
        const number = client.info?.wid ? '+' + client.info.wid.user : 'Device Connected';
        await mongoose.model('Tenant').updateOne({ tenant_id: tenantId }, { status: 'connected', qr: null, number });
        if (onReady) onReady();

        console.log(`[${tenantId}] Syncing past messages...`);
        try {
            const chats = await client.getChats();
            const MessageModel = mongoose.model('Message');
            const tenant = await mongoose.model('Tenant').findOne({ tenant_id: tenantId });
            const rules = tenant?.rules || [];

            for (const chat of chats.slice(0, 10)) {
                const messages = await chat.fetchMessages({ limit: 15 });
                for (const msg of messages) {
                    if (msg.from === 'status@broadcast' || msg.to === 'status@broadcast') continue;
                    const exists = await MessageModel.findOne({ id: msg.id._serialized });
                    if (!exists) {
                        const contact = await msg.getContact();
                        const senderName = contact.name || contact.pushname || msg._data?.notifyName || msg.from.split('@')[0];
                        const dpUrl = await contact.getProfilePicUrl().catch(() => null);
                        const groupName = msg.from.includes('@g.us') ? chat.name : 'Direct Message';
                        const classification = classifyFn(msg.body || '', rules);
                        const newMsg = new MessageModel({
                            id: msg.id._serialized,
                            tenant_id: tenantId,
                            sender: senderName,
                            sender_dp: dpUrl,
                            group_name: groupName,
                            message: msg.body || '',
                            time: new Date(msg.timestamp * 1000).toLocaleTimeString(),
                            severity: classification.severity,
                            ai_label: classification.label,
                            confidence: classification.confidence,
                            createdAt: new Date(msg.timestamp * 1000)
                        });
                        await newMsg.save().catch(() => {});
                    }
                }
            }
            console.log(`[${tenantId}] Past messages synced!`);
        } catch (err) {
            console.error(`[${tenantId}] Error syncing past messages:`, err.message);
        }
    });

    client.on('message', async msg => {
        if (msg.from === 'status@broadcast' || msg.to === 'status@broadcast') return;
        console.log(`[${tenantId}] MESSAGE RECEIVED:`, msg.body);

        const tenant = await mongoose.model('Tenant').findOne({ tenant_id: tenantId });
        const rules = tenant?.rules || [];
        const classification = classifyFn(msg.body, rules);

        const contact = await msg.getContact();
        const senderName = contact.name || contact.pushname || msg._data?.notifyName || msg.from.split('@')[0];
        const dpUrl = await contact.getProfilePicUrl().catch(() => null);
        const chat = await msg.getChat();
        const groupName = msg.from.includes('@g.us') ? chat.name : 'Direct Message';

        const MessageModel = mongoose.model('Message');
        const newMsg = new MessageModel({
            id: msg.id._serialized,
            tenant_id: tenantId,
            sender: senderName,
            sender_dp: dpUrl,
            group_name: groupName,
            message: msg.body,
            time: new Date().toLocaleTimeString(),
            severity: classification.severity,
            ai_label: classification.label,
            confidence: classification.confidence
        });
        try {
            await newMsg.save();
        } catch (error) {
            console.error(`[${tenantId}] Error saving message:`, error.message);
        }
    });

    activeClients.set(tenantId, client);

    client.initialize().catch(async err => {
        console.error(`[${tenantId}] Initialization Error:`, err.message);
        await mongoose.model('Tenant').updateOne({ tenant_id: tenantId }, { status: 'disconnected', qr: null });
        await cleanup();
        if (onInitError) onInitError();
    });
}

async function destroyAllClients() {
    for (const [tenantId, client] of activeClients.entries()) {
        try {
            console.log(`[${tenantId}] Destroying client...`);
            await client.destroy();
        } catch (e) {
            console.error(`[${tenantId}] Error destroying client:`, e.message);
        }
    }
    activeClients.clear();
}

module.exports = { initializeWhatsApp, destroyAllClients };
