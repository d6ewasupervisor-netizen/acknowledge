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
exports.sendFax = functions.https.onRequest((req, res) => {
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
      
      const mailOptions = {
        from: getFromEmail(),
        to: gatewayEmail,
        subject: storeNumber, // e.g., "#023"
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
exports.sendFaxDirect = functions.https.onRequest((req, res) => {
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
      
      const mailOptions = {
        from: getFromEmail(),
        to: gatewayEmail,
        subject: `Fax#${cleanFaxNumber}`,
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
