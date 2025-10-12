// lib/firestore.js
import admin from 'firebase-admin';

let app;
export function getAdmin() {
    if (!app) {
        const pk = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
        app = admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: pk,
            }),
        });
    }
    return admin;
}

export async function marcarFaturaPaga({ faturaId, paymentId, valorPago, aprovadoEmISO, raw }) {
    if (!faturaId) throw new Error('falta faturaId');

    const adminSDK = getAdmin();
    const db = adminSDK.firestore();
    const now = adminSDK.firestore.FieldValue.serverTimestamp();

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

    const snap = await faturaRef.get();
    if (snap.exists) {
        const { cpf, competencia } = snap.data();
        if (cpf) {
            const ref = db.collection('clientes').doc(cpf).collection('faturas').doc(faturaId);
            batch.set(ref, patch, { merge: true });
        }
        if (competencia) {
            const ref = db.collection('competencias').doc(competencia).collection('faturas').doc(faturaId);
            batch.set(ref, patch, { merge: true });
        }
    }

    await batch.commit();
    return true;
}
