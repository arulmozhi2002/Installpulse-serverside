const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { classifyMessage } = require('./openai');

function initializeWhatsApp(dataStore, classifyFn) {
    const client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        }
    });

    client.on('qr', (qr) => {
        // qrcode.generate(qr, { small: true }); // Disabled terminal QR, sending to frontend
        dataStore.qr = qr;
        dataStore.status = 'qr_ready';
        console.log('QR Code generated for frontend.');
    });

    client.on('authenticated', () => {
        console.log('AUTHENTICATED successfully!');
        dataStore.status = 'authenticating';
        dataStore.qr = null;
    });

    client.on('auth_failure', msg => {
        console.error('AUTHENTICATION FAILURE', msg);
        dataStore.status = 'disconnected';
    });

    client.on('ready', async () => {
        console.log('WhatsApp Client is ready!');
        dataStore.status = 'connected';
        dataStore.qr = null;
        if (client.info && client.info.wid) {
            dataStore.number = '+' + client.info.wid.user;
        } else {
            dataStore.number = 'Device Connected';
        }
    });

    client.on('message', async msg => {
        // Ignore WhatsApp statuses
        if (msg.from === 'status@broadcast' || msg.to === 'status@broadcast') return;

        console.log('MESSAGE RECEIVED:', msg.body);
        
        // Use custom local rule classification
        const classification = classifyFn(msg.body);
        
        let senderName = msg._data?.notifyName || msg.from.split('@')[0];
        let groupName = msg.from.includes('@g.us') ? 'WhatsApp Group' : 'Direct Message';
        
        const newMsg = {
            id: msg.id._serialized,
            sender: senderName,
            group: groupName,
            message: msg.body,
            time: new Date().toLocaleTimeString(),
            severity: classification.severity,
            aiLabel: classification.label,
            confidence: classification.confidence
        };
        
        dataStore.messages.unshift(newMsg);
        
        // Keep only last 100 messages in memory
        if (dataStore.messages.length > 100) {
            dataStore.messages.pop();
        }
    });

    console.log('Initializing WhatsApp Client...');
    client.initialize().catch(err => console.error("Failed to initialize WhatsApp", err));
}

module.exports = { initializeWhatsApp };
