/**
 * Cloud Functions for Employee Handbook Fax Service
 * 
 * Functions:
 *   - sendFax: Send PDF to a store by store number
 *   - sendFaxDirect: Send PDF to a direct fax number
 *   - getStores: Get all stores (backup API for frontend)
 *   - faxWebhook: HTTP callback for instant Power Automate status updates
 *   - saveAcknowledgement: Store signed acknowledgements in Firestore
 *   - sendEmail: Email signed PDF to admin and optionally to the employee
 *   - monitorFaxStatus: Polls Gmail for FAXDONE emails (fallback)
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
const FUNCTIONS_BUILD_ID = '2026-02-08-storage-save';

const getStorageBucketName = () => {
  const config = functions.config();
  return (
    config.storage?.bucket ||
    process.env.FIREBASE_STORAGE_BUCKET ||
    process.env.STORAGE_BUCKET ||
    (process.env.GCLOUD_PROJECT ? `${process.env.GCLOUD_PROJECT}.appspot.com` : '')
  );
};

// CORS middleware - allow all origins for GitHub Pages
const corsHandler = cors({ origin: true });

const applyCorsHeaders = (res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
};

const handleCorsPreflight = (req, res) => {
  applyCorsHeaders(res);
  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }
  return null;
};

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
exports.sendFax = functions.runWith({ memory: '512MB', minInstances: 1 }).https.onRequest((req, res) => {
  const preflight = handleCorsPreflight(req, res);
  if (preflight) return preflight;
  corsHandler(req, res, async () => {
    applyCorsHeaders(res);
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

      // Run Firestore write, email send, and log write in parallel for speed
      await Promise.all([
        db.collection('faxJobs').doc(trackingId).set({
          trackingId,
          status: 'Pending',
          requesterEmail: getFromEmail(),
          storeNumber,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }),
        transporter.sendMail(mailOptions),
        db.collection('fax_log').add({
          storeNumber: storeNumber,
          location: store.location,
          faxNumber: store.faxNumber,
          fileName: fileName,
          type: type || 'unknown',
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          status: 'sent'
        })
      ]);

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
exports.sendFaxDirect = functions.runWith({ memory: '512MB', minInstances: 1 }).https.onRequest((req, res) => {
  const preflight = handleCorsPreflight(req, res);
  if (preflight) return preflight;
  corsHandler(req, res, async () => {
    applyCorsHeaders(res);
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

      // Run Firestore write, email send, and log write in parallel for speed
      await Promise.all([
        db.collection('faxJobs').doc(trackingId).set({
          trackingId,
          status: 'Pending',
          faxNumber: cleanFaxNumber,
          requesterEmail: getFromEmail(),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }),
        transporter.sendMail(mailOptions),
        db.collection('fax_log').add({
          storeNumber: null,
          location: 'Direct Fax',
          faxNumber: cleanFaxNumber,
          fileName: fileName,
          type: type || 'unknown',
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          status: 'sent'
        })
      ]);

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
  const preflight = handleCorsPreflight(req, res);
  if (preflight) return preflight;
  corsHandler(req, res, async () => {
    applyCorsHeaders(res);
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
 * faxWebhook - Direct HTTP callback from Power Automate for instant status updates
 * 
 * This eliminates the email-polling delay entirely. Configure Power Automate
 * to POST to this endpoint when a fax completes instead of (or in addition to)
 * sending a FAXDONE email.
 * 
 * POST body:
 * {
 *   "trackingId": "WEB-20260205125013",
 *   "status": "Success" | "Failed",
 *   "faxKey": "20260205-125013"  (optional)
 * }
 */
exports.faxWebhook = functions.https.onRequest((req, res) => {
  const preflight = handleCorsPreflight(req, res);
  if (preflight) return preflight;
  corsHandler(req, res, async () => {
    applyCorsHeaders(res);
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
      const { trackingId, status, faxKey } = req.body;

      if (!trackingId || !status) {
        return res.status(400).json({
          error: 'Missing required fields: trackingId, status'
        });
      }

      const updateData = {
        status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };
      if (faxKey) updateData.faxKey = faxKey;

      // Update Firestore — frontend is listening in real-time on this doc
      const updates = [
        db.collection('faxJobs').doc(trackingId).set(updateData, { merge: true })
      ];

      // Also update by faxKey if provided
      if (faxKey) {
        updates.push(
          db.collection('faxJobs').doc(faxKey).set(updateData, { merge: true })
        );
      }

      await Promise.all(updates);

      console.log(`faxWebhook: ${trackingId} → ${status}`);
      return res.status(200).json({ success: true, trackingId, status });

    } catch (error) {
      console.error('faxWebhook error:', error);
      return res.status(500).json({
        error: 'Failed to process webhook',
        details: error.message
      });
    }
  });
});

/**
 * saveAcknowledgement - Store signed acknowledgement records
 *
 * POST body:
 * {
 *   "employeeName": "John Doe",
 *   "signDate": "2026-02-06",
 *   "signatureMode": "draw" | "type" | "upload" | "scan" | "fax",
 *   "signatureDataUrl": "<base64-png>",
 *   "scanImageUrl": "<base64-jpg>",
 *   "pdfBase64": "<full-pdf-base64>",
 *   "pdfFileName": "Doe_John_2026_02_06_Acknowledgement.pdf",
 *   "deliveryMethod": "digital" | "print-store" | "print-direct" | "scan",
 *   "storeNumber": "#023"
 * }
 */
exports.saveAcknowledgement = functions.runWith({ memory: '512MB' }).https.onRequest((req, res) => {
  const preflight = handleCorsPreflight(req, res);
  if (preflight) return preflight;
  corsHandler(req, res, async () => {
    applyCorsHeaders(res);
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
      console.log('saveAcknowledgement build:', FUNCTIONS_BUILD_ID);
      const {
        employeeName,
        signDate,
        signatureMode,
        signatureDataUrl,
        scanImageUrl,
        pdfBase64,
        pdfFileName,
        deliveryMethod,
        storeNumber
      } = req.body || {};

      if (!employeeName || !signDate || !pdfBase64 || !pdfFileName) {
        return res.status(400).json({
          error: 'Missing required fields: employeeName, signDate, pdfBase64, pdfFileName'
        });
      }

      const cleanPdfBase64 = String(pdfBase64).includes(',')
        ? String(pdfBase64).split(',')[1]
        : String(pdfBase64);

      const forwarded = req.headers['x-forwarded-for'];
      const ipAddress = forwarded ? String(forwarded).split(',')[0].trim() : (req.ip || null);
      const userAgent = req.headers['user-agent'] || null;

      const bucketName = getStorageBucketName();
      if (!bucketName) {
        throw new Error('Storage bucket not configured');
      }
      const bucket = admin.storage().bucket(bucketName);
      const safeFileName = String(pdfFileName).replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = `signedAcknowledgements/${Date.now()}_${safeFileName}`;
      const pdfBuffer = Buffer.from(cleanPdfBase64, 'base64');

      await bucket.file(storagePath).save(pdfBuffer, {
        contentType: 'application/pdf',
        metadata: { cacheControl: 'private, max-age=0' }
      });

      const docRef = await db.collection('signedAcknowledgements').add({
        employeeName,
        signDate,
        signatureMode: signatureMode || 'draw',
        signatureDataUrl: signatureDataUrl || null,
        scanImageUrl: scanImageUrl || null,
        pdfFileName,
        pdfStoragePath: storagePath,
        pdfSizeBytes: pdfBuffer.length,
        deliveryMethod: deliveryMethod || 'digital',
        storeNumber: storeNumber || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        ipAddress: ipAddress || null,
        userAgent: userAgent || null
      });

      return res.status(200).json({ success: true, docId: docRef.id, pdfStoragePath: storagePath });
    } catch (error) {
      console.error('saveAcknowledgement error:', error);
      return res.status(500).json({
        error: 'Failed to save acknowledgement',
        details: error.message
      });
    }
  });
});

/**
 * sendEmail - Email signed acknowledgement PDF to admin and optionally to the employee
 *
 * POST body:
 * {
 *   "pdfBase64": "<base64-encoded-pdf>",
 *   "pdfFileName": "Doe_John_2026_02_06_Acknowledgement.pdf",
 *   "employeeName": "John Doe",
 *   "employeeEmail": "john@example.com" (optional - sends copy to employee)
 * }
 */
exports.sendEmail = functions.runWith({ memory: '512MB' }).https.onRequest((req, res) => {
  const preflight = handleCorsPreflight(req, res);
  if (preflight) return preflight;
  corsHandler(req, res, async () => {
    applyCorsHeaders(res);
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
      const { pdfBase64, pdfFileName, employeeName, employeeEmail } = req.body;

      if (!pdfBase64 || !pdfFileName || !employeeName) {
        return res.status(400).json({
          error: 'Missing required fields: pdfBase64, pdfFileName, employeeName'
        });
      }

      const ADMIN_EMAIL = 'tyson.a.gauthier@gmail.com';
      const transporter = createTransporter();
      const fromEmail = getFromEmail();

      const cleanPdf = String(pdfBase64).includes(',')
        ? String(pdfBase64).split(',')[1]
        : String(pdfBase64);

      // Always send to admin
      const adminMailOptions = {
        from: fromEmail,
        to: ADMIN_EMAIL,
        subject: `Signed Acknowledgement — ${employeeName}`,
        text: `${employeeName} has submitted a signed Employee Handbook Acknowledgement.\n\nSee attached PDF.`,
        html: `<p><strong>${employeeName}</strong> has submitted a signed Employee Handbook Acknowledgement.</p><p>See attached PDF.</p>`,
        attachments: [{
          filename: pdfFileName,
          content: cleanPdf,
          encoding: 'base64',
          contentType: 'application/pdf'
        }]
      };

      const emailPromises = [transporter.sendMail(adminMailOptions)];

      // Optionally send copy to employee
      if (employeeEmail && employeeEmail.trim()) {
        const employeeMailOptions = {
          from: fromEmail,
          to: employeeEmail.trim(),
          subject: `Your Signed Acknowledgement — ${employeeName}`,
          text: `Hi ${employeeName},\n\nAttached is a copy of your signed Employee Handbook Acknowledgement for your records.\n\nThank you.`,
          html: `<p>Hi ${employeeName},</p><p>Attached is a copy of your signed Employee Handbook Acknowledgement for your records.</p><p>Thank you.</p>`,
          attachments: [{
            filename: pdfFileName,
            content: cleanPdf,
            encoding: 'base64',
            contentType: 'application/pdf'
          }]
        };
        emailPromises.push(transporter.sendMail(employeeMailOptions));
      }

      await Promise.all(emailPromises);

      return res.status(200).json({
        success: true,
        message: `Email sent to ${ADMIN_EMAIL}` + (employeeEmail ? ` and ${employeeEmail.trim()}` : ''),
        adminEmail: ADMIN_EMAIL,
        employeeEmail: employeeEmail ? employeeEmail.trim() : null
      });

    } catch (error) {
      console.error('sendEmail error:', error);
      return res.status(500).json({
        error: 'Failed to send email',
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

  // Gmail IMAP credentials — check firebase config first, then .env, then fall back to SMTP creds
  // (since the SMTP account and IMAP inbox are typically the same Gmail account)
  const gmailUser = config.gmail?.user || process.env.GMAIL_USER || config.smtp?.user || process.env.SMTP_USER;
  const gmailPass = config.gmail?.pass || process.env.GMAIL_PASS || config.smtp?.pass || process.env.SMTP_PASS;

  if (!gmailUser || !gmailPass) {
    console.error('monitorFaxStatus: No Gmail/IMAP credentials configured. Set gmail.user & gmail.pass, or GMAIL_USER & GMAIL_PASS in .env, or fall back to SMTP credentials.');
    return null;
  }

  const imapConfig = {
    imap: {
      user: gmailUser,
      password: gmailPass,
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
        // Extract between FAXDATA: and :ENDFAXDATA markers
        const markerMatch = body.match(/FAXDATA:(.*?):ENDFAXDATA/s);
        let requesterEmail = '';
        let trackingId = '';
        
        if (markerMatch) {
          const rawData = markerMatch[1];
          // Strip HTML tags
          const cleanData = rawData.replace(/<[^>]*>/g, '').trim();
          const parts = cleanData.split('|');
          requesterEmail = (parts[0] || '').trim();
          trackingId = (parts[1] || '').trim().replace(/\.$/, '');
        }

        console.log('Parsed:', { requesterEmail, trackingId });

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
