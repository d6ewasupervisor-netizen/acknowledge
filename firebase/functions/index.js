/**
 * Cloud Functions for Employee Handbook Fax Service
 * 
 * Functions:
 *   - sendFax: Send PDF to a store by store number
 *   - sendFaxDirect: Send PDF to a direct fax number
 *   - getStores: Get all stores (backup API for frontend)
 * 
 * Configuration (set via firebase functions:config:set):
 *   smtp.host, smtp.port, smtp.user, smtp.pass, smtp.from
 *   fax.gateway_email
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const cors = require('cors');

// Initialize Firebase Admin
admin.initializeApp();
const db = admin.firestore();

// CORS middleware - allow all origins for GitHub Pages
const corsHandler = cors({ origin: true });

// Get SMTP config from Firebase Functions config
const getSmtpConfig = () => {
  const config = functions.config();
  return {
    host: config.smtp?.host || process.env.SMTP_HOST,
    port: parseInt(config.smtp?.port || process.env.SMTP_PORT || '587'),
    secure: false, // true for 465, false for other ports
    auth: {
      user: config.smtp?.user || process.env.SMTP_USER,
      pass: config.smtp?.pass || process.env.SMTP_PASS
    }
  };
};

const getFromEmail = () => {
  const config = functions.config();
  return config.smtp?.from || process.env.SMTP_FROM || 'handbook@company.com';
};

const getFaxGatewayEmail = () => {
  const config = functions.config();
  return config.fax?.gateway_email || process.env.FAX_GATEWAY_EMAIL;
};

// Create nodemailer transporter
const createTransporter = () => {
  return nodemailer.createTransport(getSmtpConfig());
};

/**
 * sendFax - Send PDF to a store by store number
 * 
 * POST body:
 * {
 *   "storeNumber": "#023",
 *   "pdfBase64": "...",
 *   "fileName": "Handbook_Ack_John_Doe_20250204.pdf",
 *   "type": "blank" | "signed"
 * }
 */
exports.sendFax = functions.runWith({ memory: '512MB' }).https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    // Only allow POST
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
      const { storeNumber, pdfBase64, fileName, type } = req.body;

      // Validate required fields
      if (!storeNumber || !pdfBase64 || !fileName) {
        return res.status(400).json({ 
          error: 'Missing required fields: storeNumber, pdfBase64, fileName' 
        });
      }

      // Look up store in Firestore
      const storeDoc = await db.collection('stores').doc(storeNumber).get();
      
      if (!storeDoc.exists) {
        return res.status(404).json({ 
          error: `Store ${storeNumber} not found` 
        });
      }

      const store = storeDoc.data();
      const gatewayEmail = getFaxGatewayEmail();

      if (!gatewayEmail) {
        return res.status(500).json({ 
          error: 'Fax gateway email not configured' 
        });
      }

      // Create email with PDF attachment
      // Subject format: #023 - Power Automate extracts number after #
      const transporter = createTransporter();
      const trackingId = `WEB-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;

      // Create Pending doc for frontend to listen on
      await db.collection('faxJobs').doc(trackingId).set({
        trackingId,
        status: 'Pending',
        requesterEmail: getFromEmail(),
        storeNumber,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const mailOptions = {
        from: getFromEmail(),
        to: gatewayEmail,
        subject: `${storeNumber} ${trackingId}`,
        text: `Handbook Acknowledgement for ${store.location} (${storeNumber})`,
        attachments: [
          {
            filename: fileName,
            content: pdfBase64,
            encoding: 'base64',
            contentType: 'application/pdf'
          }
        ]
      };

      // Send email
      await transporter.sendMail(mailOptions);

      // Log to fax_log collection
      await db.collection('fax_log').add({
        storeNumber: storeNumber,
        location: store.location,
        faxNumber: store.faxNumber,
        fileName: fileName,
        type: type || 'unknown',
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'sent'
      });

      return res.status(200).json({
        success: true,
        message: `Fax sent to ${store.location} (${storeNumber})`,
        trackingId,
        store: {
          storeNumber: store.storeNumber,
          location: store.location
        }
      });

    } catch (error) {
      console.error('sendFax error:', error);
      return res.status(500).json({ 
        error: 'Failed to send fax',
        details: error.message 
      });
    }
  });
});

/**
 * sendFaxDirect - Send PDF to a direct fax number
 * 
 * POST body:
 * {
 *   "faxNumber": "15553412222",
 *   "pdfBase64": "...",
 *   "fileName": "Blank_Handbook_Acknowledgement.pdf",
 *   "type": "blank" | "signed"
 * }
 */
exports.sendFaxDirect = functions.runWith({ memory: '512MB' }).https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    // Only allow POST
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
      const { faxNumber, pdfBase64, fileName, type } = req.body;

      // Validate required fields
      if (!faxNumber || !pdfBase64 || !fileName) {
        return res.status(400).json({ 
          error: 'Missing required fields: faxNumber, pdfBase64, fileName' 
        });
      }

      // Strip non-digits from fax number
      const cleanFaxNumber = faxNumber.replace(/\D/g, '');

      if (cleanFaxNumber.length < 10) {
        return res.status(400).json({ 
          error: 'Invalid fax number - must be at least 10 digits' 
        });
      }

      const gatewayEmail = getFaxGatewayEmail();

      if (!gatewayEmail) {
        return res.status(500).json({ 
          error: 'Fax gateway email not configured' 
        });
      }

      // Create email with PDF attachment
      // Subject format: Fax#15553412222 - Power Automate extracts everything after #
      const transporter = createTransporter();
      const trackingId = `WEB-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;

      // Create Pending doc for frontend to listen on
      await db.collection('faxJobs').doc(trackingId).set({
        trackingId,
        status: 'Pending',
        faxNumber: cleanFaxNumber,
        requesterEmail: getFromEmail(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const mailOptions = {
        from: getFromEmail(),
        to: gatewayEmail,
        subject: `Fax#${cleanFaxNumber} ${trackingId}`,
        text: `Handbook Acknowledgement sent to fax number ${cleanFaxNumber}`,
        attachments: [
          {
            filename: fileName,
            content: pdfBase64,
            encoding: 'base64',
            contentType: 'application/pdf'
          }
        ]
      };

      // Send email
      await transporter.sendMail(mailOptions);

      // Log to fax_log collection
      await db.collection('fax_log').add({
        storeNumber: null,
        location: 'Direct Fax',
        faxNumber: cleanFaxNumber,
        fileName: fileName,
        type: type || 'unknown',
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'sent'
      });

      return res.status(200).json({
        success: true,
        message: `Fax sent to ${cleanFaxNumber}`,
        trackingId,
        faxNumber: cleanFaxNumber
      });

    } catch (error) {
      console.error('sendFaxDirect error:', error);
      return res.status(500).json({ 
        error: 'Failed to send fax',
        details: error.message 
      });
    }
  });
});

/**
 * getStores - Get all stores from Firestore
 * 
 * GET request, returns array of stores ordered by storeNumber
 * Used as backup API - frontend embeds store data for instant load
 */
exports.getStores = functions.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    // Only allow GET
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
      const snapshot = await db.collection('stores')
        .orderBy('storeNumber')
        .get();

      const stores = [];
      snapshot.forEach(doc => {
        stores.push({
          id: doc.id,
          ...doc.data()
        });
      });

      return res.status(200).json({
        success: true,
        count: stores.length,
        stores: stores
      });

    } catch (error) {
      console.error('getStores error:', error);
      return res.status(500).json({ 
        error: 'Failed to fetch stores',
        details: error.message 
      });
    }
  });
});

/**
 * monitorFaxStatus - Polls Gmail for FAXDONE: bridge emails from Power Automate
 * Updates Firestore faxJobs collection so the web app gets real-time status
 * 
 * Subject format: FAXDONE:{FaxKey}:{Status}
 * Body: RequesterEmail
 */
exports.monitorFaxStatus = functions.pubsub
.schedule('every 1 minutes')
.onRun(async (context) => {
  const imapSimple = require('imap-simple');
  const config = functions.config();

  const imapConfig = {
    imap: {
      user: config.gmail.user,
      password: config.gmail.pass,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 10000
    }
  };

  let connection;
  try {
    connection = await imapSimple.connect(imapConfig);
    await connection.openBox('INBOX');

    const searchCriteria = ['UNSEEN', ['SUBJECT', 'FAXDONE:']];
    const fetchOptions = {
      bodies: ['HEADER', 'TEXT'],
      markSeen: true
    };

    const messages = await connection.search(searchCriteria, fetchOptions);

    if (messages.length === 0) {
      await connection.end();
      return null;
    }

    console.log(`Found ${messages.length} FAXDONE message(s)`);

    for (const message of messages) {
      try {
        const header = message.parts.find(p => p.which === 'HEADER');
        const textPart = message.parts.find(p => p.which === 'TEXT');

        const subject = (header.body.subject || [''])[0];
        const body = (textPart.body || '').trim();

        // Parse: FAXDONE:20260205-125013:Success
        const match = subject.match(/FAXDONE:([^:]+):(\w+)/);
        if (!match) {
          console.warn('Could not parse FAXDONE subject:', subject);
          continue;
        }

        const faxKey = match[1].trim();
        const status = match[2].trim();
        const firstLine = body.split('\n')[0].trim();
        // Strip HTML tags if present
        const cleanLine = firstLine.replace(/<[^>]*>/g, '');
        const parts = cleanLine.split('|');
        const requesterEmail = (parts[0] || '').trim();
        const trackingId = (parts[1] || '').trim().replace(/\.$/, ''); // Remove trailing period

        console.log('Parsed:', { requesterEmail, trackingId, rawBody: firstLine });

        // Update by FaxKey
        await db.collection('faxJobs').doc(faxKey).set({
          faxKey,
          status,
          requesterEmail,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        // Also update by trackingId if present (web app listens on this)
        if (trackingId) {
          await db.collection('faxJobs').doc(trackingId).set({
            faxKey,
            trackingId,
            status,
            requesterEmail,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        }

        console.log(`Updated faxJobs/${faxKey} → ${status}`);
      } catch (msgErr) {
        console.error('Error processing message:', msgErr);
      }
    }

    await connection.end();
  } catch (err) {
    console.error('monitorFaxStatus error:', err);
    if (connection) {
      try { await connection.end(); } catch (e) { /* ignore */ }
    }
  }

  return null;
});
