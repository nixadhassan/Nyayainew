const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { Cashfree } = require('cashfree-pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

// IMPORTANT: Raw body parser for webhook signature verification — must come before express.json()
app.use('/api/payment/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── Clients ────────────────────────────────────────────────────────────────────

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

// Cashfree configuration — use Cashfree.SANDBOX for testing, Cashfree.PRODUCTION when live
Cashfree.XClientId     = process.env.CASHFREE_CLIENT_ID;
Cashfree.XClientSecret = process.env.CASHFREE_CLIENT_SECRET;
Cashfree.XEnvironment  = process.env.NODE_ENV === 'production'
    ? Cashfree.PRODUCTION
    : Cashfree.SANDBOX;

const CREDITS_PER_PURCHASE = 5;   // credits granted after one ₹49 payment
const PAYMENT_AMOUNT        = 49;  // INR

// ── Payment Routes ─────────────────────────────────────────────────────────────

/**
 * POST /api/payment/create-order
 * Called by frontend when user wants to buy credits.
 * Returns a paymentSessionId that the Cashfree JS SDK uses to open the checkout.
 */
app.post('/api/payment/create-order', async (req, res) => {
    const { userId, customerName, customerEmail, customerPhone } = req.body;

    if (!userId || !customerEmail || !customerPhone) {
        return res.status(400).json({ success: false, error: 'Missing required fields.' });
    }

    try {
        // Unique order ID — Cashfree requires this to be idempotent
        const orderId = `NYAY_${userId}_${Date.now()}`;

        const orderRequest = {
            order_id:       orderId,
            order_amount:   PAYMENT_AMOUNT,
            order_currency: 'INR',
            customer_details: {
                customer_id:    userId,
                customer_name:  customerName  || 'User',
                customer_email: customerEmail,
                customer_phone: customerPhone,
            },
            order_meta: {
                // After payment, Cashfree redirects here; {order_id} is auto-replaced
                return_url: `${process.env.FRONTEND_URL}/payment-status?order_id={order_id}`,
                notify_url: `${process.env.BACKEND_URL}/api/payment/webhook`, // server-side webhook
            },
            order_note: 'Nyay AI — 5 document analysis credits',
        };

        const response = await Cashfree.PGCreateOrder('2023-08-01', orderRequest);
        const order    = response.data;

        // Persist the pending order in Supabase for later reconciliation
        await supabase.from('payment_orders').insert({
            order_id:           orderId,
            user_id:            userId,
            amount:             PAYMENT_AMOUNT,
            status:             'PENDING',
            cashfree_order_id:  order.cf_order_id,
        });

        return res.json({
            success:          true,
            orderId:          orderId,
            paymentSessionId: order.payment_session_id, // consumed by Cashfree JS SDK on frontend
        });

    } catch (error) {
        console.error('Cashfree order creation error:', error?.response?.data || error);
        return res.status(500).json({ success: false, error: 'Could not create payment order.' });
    }
});

/**
 * GET /api/payment/verify/:orderId
 * Called by the frontend after redirect-back to confirm payment status.
 */
app.get('/api/payment/verify/:orderId', async (req, res) => {
    const { orderId } = req.params;

    try {
        const response = await Cashfree.PGFetchOrder('2023-08-01', orderId);
        const order    = response.data;

        if (order.order_status === 'PAID') {
            await creditUserAndUpdateOrder(orderId, order.cf_order_id);
            return res.json({ success: true, status: 'PAID', message: 'Credits added successfully.' });
        }

        return res.json({ success: false, status: order.order_status });

    } catch (error) {
        console.error('Payment verification error:', error?.response?.data || error);
        return res.status(500).json({ success: false, error: 'Verification failed.' });
    }
});

/**
 * POST /api/payment/webhook
 * Cashfree posts signed events here. This is the reliable source of truth.
 * Signature is verified using the raw request body.
 */
app.post('/api/payment/webhook', async (req, res) => {
    try {
        const signature = req.headers['x-webhook-signature'];
        const timestamp = req.headers['x-webhook-timestamp'];
        const rawBody   = req.body; // Buffer, because of express.raw() above

        // Throws if signature is invalid — stops processing immediately
        Cashfree.PGVerifyWebhookSignature(signature, rawBody, timestamp);

        const event = JSON.parse(rawBody.toString());

        // Only act on successful payment events
        if (event.type === 'PAYMENT_SUCCESS_WEBHOOK') {
            const orderId      = event.data.order.order_id;
            const cfOrderId    = event.data.order.cf_order_id;
            await creditUserAndUpdateOrder(orderId, cfOrderId);
        }

        return res.status(200).json({ received: true });

    } catch (error) {
        console.error('Webhook error:', error.message);
        // Return 200 anyway — prevents Cashfree from retrying on validation failures
        return res.status(200).json({ received: false, error: error.message });
    }
});

// ── Helper ─────────────────────────────────────────────────────────────────────

/**
 * Idempotent — checks if order is already 'COMPLETED' before adding credits,
 * so duplicate webhook deliveries don't double-credit the user.
 */
async function creditUserAndUpdateOrder(orderId, cfOrderId) {
    // Check current order status to avoid double-crediting
    const { data: existingOrder } = await supabase
        .from('payment_orders')
        .select('status, user_id')
        .eq('order_id', orderId)
        .single();

    if (!existingOrder || existingOrder.status === 'COMPLETED') return;

    const userId = existingOrder.user_id;

    // Fetch current credit balance
    const { data: user } = await supabase
        .from('users')
        .select('free_analyses_left')
        .eq('id', userId)
        .single();

    if (!user) return;

    // Top up credits
    await supabase
        .from('users')
        .update({ free_analyses_left: user.free_analyses_left + CREDITS_PER_PURCHASE })
        .eq('id', userId);

    // Mark order as completed
    await supabase
        .from('payment_orders')
        .update({ status: 'COMPLETED', cashfree_order_id: cfOrderId })
        .eq('order_id', orderId);
}

// ── Existing Analysis Route (unchanged logic) ──────────────────────────────────

app.post('/api/analyze', async (req, res) => {
    const { filePath, userId, targetLanguage } = req.body;

    if (!filePath || !userId || !targetLanguage) {
        return res.status(400).json({ success: false, error: 'Missing required parameters.' });
    }

    try {
        const { data: user, error: userError } = await supabase
            .from('users')
            .select('free_analyses_left')
            .eq('id', userId)
            .single();

        if (userError || !user) {
            return res.status(404).json({ success: false, error: 'User record not found.' });
        }

        if (user.free_analyses_left <= 0) {
            return res.status(402).json({
                success: false,
                error:   'Insufficient credits. Please pay ₹49 to purchase 5 more analyses.',
                action:  'INITIATE_PAYMENT', // frontend reads this to trigger the payment flow
            });
        }

        const { data: fileBuffer, error: downloadError } = await supabase.storage
            .from('legal_documents')
            .download(filePath);

        if (downloadError || !fileBuffer) {
            return res.status(500).json({ success: false, error: 'Failed to retrieve file from secure vault.' });
        }

        const documentText = await fileBuffer.text();

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

        const response = await anthropic.messages.create({
            model:       'claude-sonnet-4-20250514', // updated to current model
            max_tokens:  4000,
            temperature: 0.1,
            system:      systemPrompt,
            messages:    [{ role: 'user', content: documentText }],
        });

        const rawText      = response.content[0].text;
        const jsonStart    = rawText.indexOf('{');
        const jsonEnd      = rawText.lastIndexOf('}') + 1;

        if (jsonStart === -1 || jsonEnd === 0) {
            throw new Error('Claude failed to return a valid JSON response.');
        }

        const reportJson = JSON.parse(rawText.substring(jsonStart, jsonEnd));

        await supabase
            .from('users')
            .update({ free_analyses_left: user.free_analyses_left - 1 })
            .eq('id', userId);

        await supabase
            .from('documents')
            .insert({
                user_id:       userId,
                document_type: reportJson.document_type,
                status:        'completed',
                report_json:   reportJson,
            });

        return res.json({ success: true, report: reportJson });

    } catch (error) {
        console.error('Analysis error:', error);
        return res.status(500).json({ success: false, error: 'Internal processing engine error.' });
    }
});

// ── Health Check ───────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.send('Nyay AI Engine Operating Normally.'));

app.listen(PORT, () => {
    console.log(`Nyay AI Operational Engine running on port ${PORT}`);
});
