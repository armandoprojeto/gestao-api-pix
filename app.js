// app.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import { criarPagamentoPix, obterPagamento } from './services/mercadopago.js';

//
// 🔑 Inicializa Firebase Admin
//
let serviceAccount;
try {
    if (!process.env.CHAVE_ADMIN_FIREBASE) {
        throw new Error('CHAVE_ADMIN_FIREBASE ausente nas variáveis de ambiente.');
    }
    serviceAccount = JSON.parse(process.env.CHAVE_ADMIN_FIREBASE);

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
    console.log('✅ Firebase Admin inicializado com sucesso.');
} catch (err) {
    console.error('❌ Erro ao inicializar Firebase Admin:', err.message);
    process.exit(1);
}

const db = admin.firestore();
const app = express();

//
// 🌐 CORS
//
app.use(
    cors({
        origin: [
            'http://localhost:3000',
            'https://gestaobancar.vercel.app',
        ],
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
    }),
);
app.options('*', cors());
app.use(express.json());

//
// 📝 Logger de requisições
//
app.use((req, res, next) => {
    const inicio = Date.now();
    res.on('finish', () => {
        console.log(
            `[req] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - inicio}ms)`,
        );
    });
    next();
});

//
// 🛡️ Middleware Firebase Auth
//
async function autenticarFirebase(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ ok: false, msg: 'Token ausente ou inválido' });
        }

        const token = authHeader.split(' ')[1];

        // 🔍 Log para depuração
        console.log('[auth] Token recebido:', token.substring(0, 20) + '...');

        const decoded = await admin.auth().verifyIdToken(token);
        req.user = decoded;
        next();
    } catch (e) {
        console.error('[auth error]', e.message);
        return res.status(401).json({ ok: false, msg: 'Token inválido ou expirado' });
    }
}

//
// 🌡️ Healthcheck
//
app.get('/health', (_req, res) => res.json({ ok: true, service: 'pix-api' }));

//
// 🔐 Checagem de variáveis de ambiente
//
app.get('/env-check', (_req, res) => {
    res.json({
        mpToken: !!process.env.MERCADO_PAGO_ACCESS_TOKEN,
        firebaseKey: !!process.env.FIREBASE_ADMIN_KEY,
        webhookUrl: process.env.MP_WEBHOOK_URL || null,
    });
});

//
// 💳 Criar cobrança PIX
//
app.post('/api/pix', autenticarFirebase, async (req, res) => {
    try {
        const { faturaId, descricao, valor, payerName, payerCpf, payerEmail } = req.body || {};
        if (!faturaId || typeof valor !== 'number') {
            return res.status(400).json({ ok: false, msg: 'faturaId e valor numérico são obrigatórios' });
        }

        const pagamento = await criarPagamentoPix({
            faturaId,
            descricao,
            valor,
            payerName,
            payerCpf,
            payerEmail,
        });

        return res.json({
            ok: true,
            faturaId,
            paymentId: pagamento.paymentId,
            status: pagamento.status,
            qr_copia_cola: pagamento.qr_copia_cola,
            qr_base64: pagamento.qr_base64,
        });
    } catch (e) {
        console.error('[/api/pix] erro:', e.message);
        return res.status(400).json({ ok: false, msg: e.message });
    }
});

//
// 📡 Consultar status PIX (com autenticação)
//
app.get('/pix/status/:paymentId', autenticarFirebase, async (req, res) => {
    try {
        const { paymentId } = req.params;
        console.log(`🔍 Consultando status do pagamento: ${paymentId}`);

        const pay = await obterPagamento(paymentId);

        res.json({
            ok: true,
            status: pay.status,
            detail: pay.status_detail,
            data: pay,
        });
    } catch (e) {
        console.error('[pix/status] erro:', e.message);
        res.status(400).json({ ok: false, msg: e.message });
    }
});

//
// 🌐 Webhook Mercado Pago (robusto)
//
app.post('/webhook/mercadopago', async (req, res) => {
    try {
        // MP novo (JSON) ou legado (query)
        const type = req.body?.type || req.query?.type || req.query?.topic;
        const paymentId =
            req.body?.data?.id ||
            req.query?.['data.id'] ||
            req.query?.id;

        if (type === 'payment' && paymentId) {
            const pay = await obterPagamento(paymentId);
            console.log('[webhook] pagamento recebido:', paymentId, pay.status);

            if (pay.status === 'approved') {
                const valorPago = pay.transaction_amount;
                const faturaId =
                    pay.metadata?.faturaId ||
                    pay.external_reference ||
                    pay.description?.replace('Fatura ', '');

                console.log(`✅ Pagamento aprovado | Fatura: ${faturaId} | Valor: R$${valorPago}`);

                // Atualiza fatura
                await db.collection('faturas').doc(faturaId).set({
                    status: 'pago',
                    paymentId: pay.id,
                    valorPago,
                    aprovadoEm: new Date(pay.date_approved),
                }, { merge: true });

                // Atualiza usuário
                const faturaSnap = await db.collection('faturas').doc(faturaId).get();
                const faturaData = faturaSnap.data();
                const userId = faturaData?.userId;
                const plano = faturaData?.plano;
                const valorPlano = faturaData?.valor;

                if (userId) {
                    const hoje = new Date();
                    const venc = new Date();
                    venc.setDate(venc.getDate() + 30);

                    await db.collection('usuarios').doc(userId).set({
                        status: 'ativo',
                        plano: plano || 'Mensal',
                        valorPlano: valorPlano || valorPago,
                        dataPagamento: hoje,
                        dataVencimento: venc,
                    }, { merge: true });

                    console.log(`👤 Usuário ${userId} ativado com plano ${plano || 'Mensal'}`);
                }
            }
        }

        res.sendStatus(200);
    } catch (e) {
        console.error('[webhook] erro:', e.message);
        res.sendStatus(200); // MP só precisa de 200 para parar retries
    }
});

//
// 🚀 Start
//
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ PIX API rodando na porta ${PORT}`));
