require('dotenv').config(); // local dev; no Railway ignora

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');

/* ---------------------------------------------
   Firebase Admin
----------------------------------------------*/
const admin = require('firebase-admin');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
};

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
/* ---------------------------------------------
   Express Setup
----------------------------------------------*/
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// Chave secreta para JWT (adicione no seu .env)
const JWT_SECRET = process.env.JWT_SECRET || 'sua-chave-secreta-super-forte-aqui';

// Debug rápido de envs críticos (não loga secretos!)
console.log('🔧 CLIENT_ID:', process.env.CLIENT_ID ? 'OK' : 'MISSING');
console.log('🔧 MPESA_WALLET_ID:', process.env.MPESA_WALLET_ID ? 'OK' : 'MISSING');
console.log('🔧 EMOLA_WALLET_ID:', process.env.EMOLA_WALLET_ID ? 'OK' : 'MISSING');

/* ---------------------------------------------
   Nodemailer Setup
----------------------------------------------*/
const transporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

/* ---------------------------------------------
   Helpers
----------------------------------------------*/
function normalizePhone(n) {
  if (!n) return '';
  n = n.replace(/\D/g, '');
  return n.startsWith('+') ? n : `+${n}`;
}

/* ---------------------------------------------
   JWT Utils para Upsell
----------------------------------------------*/
function gerarUpsellToken(dadosCliente) {
  const payload = {
    msisdn: dadosCliente.phone,
    method: dadosCliente.metodo,
    email: dadosCliente.email,
    nome: dadosCliente.nome,
    whatsapp: dadosCliente.whatsapp,
    parentTxn: dadosCliente.reference,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (30 * 60) // 30 minutos
  };
  
  return jwt.sign(payload, JWT_SECRET);
}

function validarUpsellToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    throw new Error('Token inválido ou expirado');
  }
}

async function verificarTransacaoPrincipal(parentTxn) {
  try {
    const snapshot = await db.collection('compras')
      .where('reference', '==', parentTxn)
      .get();
    
    return !snapshot.empty;
  } catch (error) {
    console.error('Erro ao verificar transação principal:', error);
    return false;
  }
}

async function verificarUpsellJaProcessado(parentTxn, upsellLevel) {
  try {
    const colecao = `upsell${upsellLevel}_compras`;
    const snapshot = await db.collection(colecao)
      .where('parentTxn', '==', parentTxn)
      .get();
    
    return !snapshot.empty;
  } catch (error) {
    console.error('Erro ao verificar upsell processado:', error);
    return false;
  }
}

/* ---------------------------------------------
   Rota Principal de Compra
----------------------------------------------*/
app.post('/api/comprar', async (req, res) => {
  const { phone, metodo, email, nome, whatsapp } = req.body;

  // 1) validações básicas
  if (!phone || !metodo || !email) {
    return res.status(400).json({ status: 'error', message: 'Campos obrigatórios: phone, metodo, email' });
  }

  if (!['mpesa', 'emola'].includes(metodo)) {
    return res.status(400).json({ status: 'error', message: 'Método deve ser mpesa ou emola' });
  }

  try {
    // 2) normalizar telefone
    const normalizedPhone = normalizePhone(phone);
    const nomeCliente = nome || 'Cliente';

    // 3) definir wallet e token conforme método
    let walletId, token;
    if (metodo === 'mpesa') {
      walletId = process.env.MPESA_WALLET_ID;
      token = process.env.MPESA_TOKEN;
    } else {
      walletId = process.env.EMOLA_WALLET_ID;
      token = process.env.EMOLA_TOKEN;
    }

    if (!walletId || !token) {
      return res.status(500).json({ status: 'error', message: 'Configuração de pagamento incompleta' });
    }

    // 4) gerar referência única
    const reference = `TXN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // 5) URL da API externa
    const url = `https://mpesaemolatech.com/v1/c2b/${metodo}-payment/${walletId}`;

    // 6) chamada para API externa
    const response = await axios.post(
      url,
      {
        client_id: process.env.CLIENT_ID,
        amount: '99',
        phone: normalizedPhone,
        reference,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      }
    );

    // 7) salvar no Firebase
    await db.collection('compras').add({
      nome: nomeCliente,
      email,
      phone: normalizedPhone,
      whatsapp: whatsapp || '',
      metodo,
      amount: 99,
      reference,
      created_at: new Date(),
    });

    // 8) enviar email de confirmação
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: 'Confirmação de Compra - Ebook Receitas',
        html: `
          <h2>Obrigado pela sua compra!</h2>
          <p>Olá ${nomeCliente},</p>
          <p>Sua compra foi processada com sucesso!</p>
          <p><strong>Referência:</strong> ${reference}</p>
          <p><strong>Valor:</strong> 99 MT</p>
          <p><strong>Método:</strong> ${metodo.toUpperCase()}</p>
          <p>Em breve você receberá o link para download do seu ebook.</p>
        `
      });
    } catch (emailErr) {
      console.error('❌ Erro ao enviar email:', emailErr.message);
    }

    // 9) resposta final ÚNICA
    // Gerar token de upsell após compra bem-sucedida
    const upsellToken = gerarUpsellToken({
      phone, metodo, email, nome: nomeCliente, whatsapp, reference
    });
    
    return res.json({ 
      status: 'ok', 
      data: response.data,
      upsellToken: upsellToken,
      redirectUrl: `https://seudominio.com/upsell1?token=${upsellToken}`
    });

  } catch (err) {
    console.error('❌ Erro na compra:', err.message);
    if (err.response) {
      console.error('❌ Response data:', err.response.data);
      console.error('❌ Response status:', err.response.status);
    }
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

/* ---------------------------------------------
   Função genérica: processarUpsell (ATUALIZADA)
----------------------------------------------*/
async function processarUpsell({ dadosToken, amount, upsellLevel, novaReference }) {
  const { msisdn: phone, method: metodo, email, nome, whatsapp } = dadosToken;
  
  let walletId, authToken;
  if (metodo === 'mpesa') {
    walletId = process.env.MPESA_WALLET_ID;
    authToken = process.env.MPESA_TOKEN;
  } else if (metodo === 'emola') {
    walletId = process.env.EMOLA_WALLET_ID;
    authToken = process.env.EMOLA_TOKEN;
  } else {
    throw new Error('Método inválido. Use mpesa ou emola.');
  }

  const url = `https://mpesaemolatech.com/v1/c2b/${metodo}-payment/${walletId}`;

  // chamada para API externa de pagamento
  const response = await axios.post(
    url,
    {
      client_id: process.env.CLIENT_ID,
      amount: amount.toString(),
      phone,
      reference: novaReference,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
    }
  );

  // salva compra no Firebase
  const colecao = `upsell${upsellLevel}_compras`;
  await db.collection(colecao).add({
    nome,
    email,
    phone,
    whatsapp: whatsapp || '',
    metodo,
    amount,
    reference: novaReference,
    parentTxn: dadosToken.parentTxn,
    created_at: new Date(),
  });

  // Gerar próximo token de upsell se não for o último
  let proximoToken = null;
  if (upsellLevel < 3) {
    proximoToken = gerarUpsellToken({
      phone, metodo, email, nome, whatsapp, 
      reference: dadosToken.parentTxn // mantém referência original
    });
  }

  return { 
    paymentData: response.data,
    proximoToken,
    proximoUpsell: upsellLevel < 3 ? upsellLevel + 1 : null
  };
}

/* ---------------------------------------------
   Rotas de Upsell (ATUALIZADAS COM JWT)
----------------------------------------------*/
app.post('/api/upsell1', async (req, res) => {
  const { token } = req.body;
  
  if (!token) {
    return res.status(400).json({ status: 'error', message: 'Token de upsell obrigatório' });
  }
  
  try {
    // Validar token
    const dadosToken = validarUpsellToken(token);
    
    // Verificar se transação principal existe
    const transacaoValida = await verificarTransacaoPrincipal(dadosToken.parentTxn);
    if (!transacaoValida) {
      return res.status(400).json({ status: 'error', message: 'Transação principal não encontrada' });
    }
    
    // Verificar se upsell já foi processado
    const jaProcessado = await verificarUpsellJaProcessado(dadosToken.parentTxn, 1);
    if (jaProcessado) {
      return res.status(400).json({ status: 'error', message: 'Upsell 1 já foi processado' });
    }
    
    const resultado = await processarUpsell({
      dadosToken,
      amount: 349,
      upsellLevel: 1,
      novaReference: `UPSELL1-${dadosToken.parentTxn}-${Date.now()}`
    });
    
    const response = { 
      status: 'ok', 
      data: resultado.paymentData 
    };
    
    // Adicionar próximo upsell se existir
    if (resultado.proximoToken) {
      response.proximoUpsellToken = resultado.proximoToken;
      response.proximoUpsellUrl = `https://seudominio.com/upsell${resultado.proximoUpsell}?token=${resultado.proximoToken}`;
    }
    
    res.json(response);
  } catch (err) {
    console.error('❌ Erro no upsell1:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/upsell2', async (req, res) => {
  const { token } = req.body;
  
  if (!token) {
    return res.status(400).json({ status: 'error', message: 'Token de upsell obrigatório' });
  }
  
  try {
    const dadosToken = validarUpsellToken(token);
    
    const transacaoValida = await verificarTransacaoPrincipal(dadosToken.parentTxn);
    if (!transacaoValida) {
      return res.status(400).json({ status: 'error', message: 'Transação principal não encontrada' });
    }
    
    const jaProcessado = await verificarUpsellJaProcessado(dadosToken.parentTxn, 2);
    if (jaProcessado) {
      return res.status(400).json({ status: 'error', message: 'Upsell 2 já foi processado' });
    }
    
    const resultado = await processarUpsell({
      dadosToken,
      amount: 250,
      upsellLevel: 2,
      novaReference: `UPSELL2-${dadosToken.parentTxn}-${Date.now()}`
    });
    
    const response = { 
      status: 'ok', 
      data: resultado.paymentData 
    };
    
    if (resultado.proximoToken) {
      response.proximoUpsellToken = resultado.proximoToken;
      response.proximoUpsellUrl = `https://seudominio.com/upsell${resultado.proximoUpsell}?token=${resultado.proximoToken}`;
    }
    
    res.json(response);
  } catch (err) {
    console.error('❌ Erro no upsell2:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/upsell3', async (req, res) => {
  const { token } = req.body;
  
  if (!token) {
    return res.status(400).json({ status: 'error', message: 'Token de upsell obrigatório' });
  }
  
  try {
    const dadosToken = validarUpsellToken(token);
    
    const transacaoValida = await verificarTransacaoPrincipal(dadosToken.parentTxn);
    if (!transacaoValida) {
      return res.status(400).json({ status: 'error', message: 'Transação principal não encontrada' });
    }
    
    const jaProcessado = await verificarUpsellJaProcessado(dadosToken.parentTxn, 3);
    if (jaProcessado) {
      return res.status(400).json({ status: 'error', message: 'Upsell 3 já foi processado' });
    }
    
    const resultado = await processarUpsell({
      dadosToken,
      amount: 149,
      upsellLevel: 3,
      novaReference: `UPSELL3-${dadosToken.parentTxn}-${Date.now()}`
    });
    
    // Último upsell - não há próximo
    res.json({ 
      status: 'ok', 
      data: resultado.paymentData,
      finalUpsell: true 
    });
  } catch (err) {
    console.error('❌ Erro no upsell3:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/* ---------------------------------------------
   Rota para validar token (opcional - para debug)
----------------------------------------------*/
app.post('/api/validate-token', async (req, res) => {
  const { token } = req.body;
  
  try {
    const dadosToken = validarUpsellToken(token);
    const transacaoValida = await verificarTransacaoPrincipal(dadosToken.parentTxn);
    
    res.json({
      status: 'ok',
      valid: true,
      dados: dadosToken,
      transacaoValida
    });
  } catch (err) {
    res.json({
      status: 'error',
      valid: false,
      message: err.message
    });
  }
});

/* ---------------------------------------------
   Start
----------------------------------------------*/
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
