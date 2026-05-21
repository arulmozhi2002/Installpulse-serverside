const { Client, LocalAuth } = require('whatsapp-web.js');

function initializeWhatsApp(tenantId, tenantData, classifyFn) {
    console.log(`Initializing WhatsApp Client for Tenant: ${tenantId}...`);
    
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: tenantId }),
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

    client.on('qr', qr => {
        console.log(`[${tenantId}] QR Code Received`);
        tenantData.status = 'disconnected';
        tenantData.qr = qr;
    });

    client.on('authenticated', () => {
        console.log(`[${tenantId}] AUTHENTICATED successfully!`);
        tenantData.status = 'authenticating';
        tenantData.qr = null;
    });

    client.on('auth_failure', msg => {
        console.error(`[${tenantId}] AUTHENTICATION FAILURE`, msg);
        tenantData.status = 'disconnected';
    });

    client.on('ready', async () => {
        console.log(`[${tenantId}] WhatsApp Client is ready!`);
        tenantData.status = 'connected';
        tenantData.qr = null;
        if (client.info && client.info.wid) {
            tenantData.number = '+' + client.info.wid.user;
        } else {
            tenantData.number = 'Device Connected';
        }
    });

    client.on('message', async msg => {
        // Ignore WhatsApp statuses
        if (msg.from === 'status@broadcast' || msg.to === 'status@broadcast') return;

        console.log(`[${tenantId}] MESSAGE RECEIVED:`, msg.body);
        
        // Use custom local rule classification specific to this tenant
        const classification = classifyFn(msg.body, tenantData.rules);
        
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
        
        tenantData.messages.unshift(newMsg);
        
        // Keep only last 100 messages in memory per tenant
        if (tenantData.messages.length > 100) {
            tenantData.messages.pop();
        }
    });

    client.initialize().catch(err => {
        console.error(`[${tenantId}] Initialization Error:`, err);
        tenantData.isInitializing = false;
    });
}

module.exports = { initializeWhatsApp };
