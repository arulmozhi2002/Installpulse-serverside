const OpenAI = require('openai');

const apiKey = process.env.OPENAI_API_KEY || 'dummy-key';
const openai = new OpenAI({
  apiKey: apiKey,
});


async function classifyMessage(text) {
    if (!process.env.OPENAI_API_KEY) {
        // Fallback rule engine if no API key
        const lowerText = text.toLowerCase();
        if (lowerText.includes('done') || lowerText.includes('success')) {
            return { severity: 'success', label: 'Success', confidence: 95 };
        }
        if (lowerText.includes('issue') || lowerText.includes('fail')) {
            return { severity: 'danger', label: 'Critical Issue', confidence: 90 };
        }
        return { severity: 'warning', label: 'Pending Info', confidence: 80 };
    }

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                {
                    "role": "system",
                    "content": "You are an AI assistant for a field service installation company. Classify the WhatsApp message into a JSON object with three properties: 'severity' (string: strictly 'success', 'warning', or 'danger'), 'label' (string: short 2-3 word description of the situation), and 'confidence' (number: 0-100). Examples: 'completed' -> success, 'delay' -> warning, 'complaint' -> danger."
                },
                {
                    "role": "user",
                    "content": text
                }
            ],
            response_format: { type: "json_object" }
        });

        const result = JSON.parse(response.choices[0].message.content);
        return result;
    } catch (error) {
        console.error("OpenAI Classification Error:", error);
        return { severity: 'warning', label: 'Unclassified', confidence: 0 };
    }
}

module.exports = { classifyMessage };
