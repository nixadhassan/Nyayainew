const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// Enable Cross-Origin Resource Sharing so your Netlify frontend can talk to Render
app.use(cors());
app.use(express.json());

// Initialize Supabase Admin Client using the powerful Service Role Key
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Initialize Anthropic Claude Client
const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

// Primary Endpoint for Document Analysis
app.post('/api/analyze', async (req, res) => {
    const { filePath, userId, targetLanguage } = req.body;

    if (!filePath || !userId || !targetLanguage) {
        return res.status(400).json({ success: false, error: "Missing required parameters." });
    }

    try {
        // Step 1: Verify and Manage User Credits
        const { data: user, error: userError } = await supabase
            .from('users')
            .select('free_analyses_left')
            .eq('id', userId)
            .single();

        if (userError || !user) {
            return res.status(404).json({ success: false, error: "User record not found." });
        }

        if (user.free_analyses_left <= 0) {
            return res.status(402).json({ 
                success: false, 
                error: "Insufficient credits. Please pay ₹49 to proceed with this analysis." 
            });
        }

        // Step 2: Fetch Document from Supabase Storage Bucket
        const { data: fileBuffer, error: downloadError } = await supabase.storage
            .from('legal_documents')
            .download(filePath);

        if (downloadError || !fileBuffer) {
            console.error("Storage download error:", downloadError);
            return res.status(500).json({ success: false, error: "Failed to retrieve file from secure vault." });
        }

        // Convert file data to text format for Claude processing
        // Note: For advanced formats like native scanned PDFs/images, you can convert this buffer to base64
        const documentText = await fileBuffer.text();

        // Step 3: Construct the Prompt Framework for Claude
        const systemPrompt = `You are an expert Indian legal advisor. Analyze the document provided.
        1. First, use <thinking> tags to outline your analysis internally.
        2. STRICT RULE: If a risk or obligation is not explicitly stated, say "Not mentioned in the document."
        3. STRICT RULE: Quote the source text for every risk identified.
        4. Output the final report STRICTLY as a valid JSON object matching this schema, completely translated and localized into the ${targetLanguage} language:
        {
          "document_type": "string",
          "key_clauses": ["string"],
          "potential_risks": [{"risk_description": "string", "source_quote": "string"}],
          "summary": "string"
        }`;

        // Step 4: Interact with the Claude API
        const response = await anthropic.messages.create({
            model: "claude-3-sonnet-20240229",
            max_tokens: 4000,
            temperature: 0.1, // Near-zero value ensures factual, deterministic behavior
            system: systemPrompt,
            messages: [{ role: "user", content: documentText }]
        });

        const rawText = response.content[0].text;

        // Step 5: Isolate and Parse JSON Content from Claude's response
        const jsonStartIndex = rawText.indexOf('{');
        const jsonEndIndex = rawText.lastIndexOf('}') + 1;
        
        if (jsonStartIndex === -1 || jsonEndIndex === 0) {
            throw new Error("Claude failed to return a readable JSON matrix.");
        }

        const jsonString = rawText.substring(jsonStartIndex, jsonEndIndex);
        const reportJson = JSON.parse(jsonString);

        // Step 6: Update Database Records & Deduct Credit Token
        // Deduct 1 credit point from the user
        const newCreditCount = user.free_analyses_left - 1;
        await supabase
            .from('users')
            .update({ free_analyses_left: newCreditCount })
            .eq('id', userId);

        // Insert the structural report into the documents data log
        await supabase
            .from('documents')
            .insert({
                user_id: userId,
                document_type: reportJson.document_type,
                status: 'completed',
                report_json: reportJson
            });

        // Step 7: Push Structured Data Payload Back to Frontend
        return res.json({ success: true, report: reportJson });

    } catch (error) {
        console.error("In-depth Server Execution Error:", error);
        return res.status(500).json({ success: false, error: "Internal processing engine error." });
    }
});

// Health check endpoint for Render monitoring
app.get('/health', (req, res) => res.send('Nyay AI Engine Operating Normally.'));

app.listen(PORT, () => {
    console.log(`Nyay AI Operational Engine running securely on port ${PORT}`);
});
