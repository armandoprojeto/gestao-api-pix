// services/mercadopago.js
const MP_API = 'https://api.mercadopago.com';

function getToken() {
    return process.env.MERCADO_PAGO_ACCESS_TOKEN || '';
}
function authHeaders() {
    const token = getToken();
    if (!token) throw new Error('Configuração ausente: MERCADO_PAGO_ACCESS_TOKEN');
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function fetchWithTimeout(url, options = {}, ms = 15000) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), ms);
    try {
        return await fetch(url, { ...options, signal: ctrl.signal });
    } finally {
        clearTimeout(id);
    }
}
const onlyDigits = (s = '') => String(s).replace(/\D/g, '');
const round2 = (n) => Math.round(Number(n) * 100) / 100;

export async function criarPagamentoPix({
    faturaId, descricao, valor, vencimentoISO, idempotencyKey,
    payerName, payerCpf, payerEmail, externalReference,
}) {
    const headers = { ...authHeaders(), 'X-Idempotency-Key': idempotencyKey || faturaId };

    const payer = {
        type: 'customer',
        first_name: payerName || 'Cliente',
        email: payerEmail,
        identification: onlyDigits(payerCpf) ? { type: 'CPF', number: onlyDigits(payerCpf) } : undefined,
    };

    const body = {
        description: descricao || `Fatura ${faturaId}`,
        transaction_amount: round2(valor),
        payment_method_id: 'pix',
        payer,
        date_of_expiration: vencimentoISO || undefined,
        metadata: { faturaId },
        external_reference: externalReference || faturaId,
        notification_url: process.env.MP_WEBHOOK_URL || undefined, // webhook do MP
    };

    const r = await fetchWithTimeout(`${MP_API}/v1/payments`, {
        method: 'POST', headers, body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));

    if (!r.ok || data.error || data.message === 'bad_request') {
        const cause = Array.isArray(data?.cause) && data.cause.length
            ? ` | cause: ${data.cause.map(c => c.description || c.code).join('; ')}`
            : '';
        console.error('[MP] erro criar pagamento:', JSON.stringify(data));
        throw new Error(`Erro Mercado Pago: ${data.message || r.status}${cause}`);
    }

    const tx = data.point_of_interaction?.transaction_data;
    return {
        paymentId: data.id,
        status: data.status,
        qr_copia_cola: tx?.qr_code,
        qr_base64: tx?.qr_code_base64,
        raw: data,
    };
}

export async function obterPagamento(paymentId) {
    const r = await fetchWithTimeout(`${MP_API}/v1/payments/${paymentId}`, { headers: authHeaders() });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Falha ao consultar pagamento: HTTP ${r.status}`);
    return data;
}
