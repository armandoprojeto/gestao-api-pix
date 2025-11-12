// lib/firestore.js
import admin from 'firebase-admin';

let app;

/**
 * 🔒 Inicializa Firebase Admin apenas quando necessário (lazy init)
 */
export function getAdmin() {
    if (!admin.apps.length) {
        const pk = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
        app = admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: pk,
            }),
        });
        console.log('🔥 Firebase Admin inicializado (lazy)');
    }
    return admin;
}

/**
 * 💰 Marca uma fatura como paga de forma segura e sem leituras desnecessárias
 */
export async function marcarFaturaPaga({ faturaId, paymentId, valorPago, aprovadoEmISO, raw }) {
    if (!faturaId) throw new Error('falta faturaId');

    const adminSDK = getAdmin();
    const db = adminSDK.firestore();
    const now = adminSDK.firestore.FieldValue.serverTimestamp();

    // 🧩 Patch básico de atualização
    const patch = {
        statusPagamento: 'pago',
        status: 'paga',
        valorPago: valorPago ?? null,
        aprovadoEmISO: aprovadoEmISO ?? null,
        pix: { paymentId, pagoEm: new Date().toISOString() },
        updatedAt: now,
        webhookRaw: raw ?? adminSDK.firestore.FieldValue.delete(),
    };

    const batch = db.batch();
    const faturaRef = db.collection('faturas').doc(faturaId);
    batch.set(faturaRef, patch, { merge: true });

    try {
        // 🔍 Tenta ler apenas se precisar atualizar coleções filhas
        const snap = await faturaRef.get();
        if (snap.exists) {
            const { cpf, competencia } = snap.data();

            // Cria referências filhas apenas se existirem
            if (cpf) {
                const ref = db.collection('clientes').doc(cpf).collection('faturas').doc(faturaId);
                batch.set(ref, patch, { merge: true });
            }

            if (competencia) {
                const ref = db.collection('competencias').doc(competencia).collection('faturas').doc(faturaId);
                batch.set(ref, patch, { merge: true });
            }
        }
    } catch (err) {
        console.log('⚠️ Falha ao obter fatura principal (sem impacto):', err.message);
    }

    await batch.commit();
    console.log(`✅ Fatura ${faturaId} marcada como paga com sucesso.`);
    return true;
}
