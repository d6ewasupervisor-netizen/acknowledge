/**
 * Tests for firebase/functions/index.js Cloud Functions
 *
 * Strategy: mock firebase-admin, firebase-functions, nodemailer, and cors
 * so we can test the request-handling logic (validation, branching, responses)
 * without real infrastructure.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock Firestore document and collection
const mockDocSet = jest.fn().mockResolvedValue(undefined);
const mockDocGet = jest.fn();
const mockCollectionAdd = jest.fn().mockResolvedValue({ id: 'mock-doc-id' });
const mockOrderBy = jest.fn().mockReturnThis();
const mockCollectionGet = jest.fn();

const mockDoc = jest.fn(() => ({ set: mockDocSet, get: mockDocGet }));
const mockCollection = jest.fn(() => ({
  doc: mockDoc,
  add: mockCollectionAdd,
  orderBy: mockOrderBy,
  get: mockCollectionGet,
}));

jest.mock('firebase-admin', () => {
  const admin = {
    initializeApp: jest.fn(),
    firestore: jest.fn(() => ({ collection: mockCollection })),
  };
  admin.firestore.FieldValue = { serverTimestamp: jest.fn(() => 'MOCK_TS') };
  return admin;
});

jest.mock('firebase-functions', () => ({
  config: () => ({
    smtp: { host: 'smtp.test', port: '587', user: 'u', pass: 'p', from: 'test@test.com' },
    fax: { gateway_email: 'fax@gateway.test' },
  }),
  runWith: () => ({ https: { onRequest: (handler) => handler } }),
  https: { onRequest: (handler) => handler },
  pubsub: {
    schedule: () => ({ onRun: (handler) => handler }),
  },
}));

const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'mock-id' });
jest.mock('nodemailer', () => ({
  createTransport: () => ({ sendMail: mockSendMail }),
}));

// The Cloud Function handlers don't return the promise from corsHandler,
// so we capture it here and expose it for tests to await.
let _corsPromise;
jest.mock('cors', () => () => (req, res, cb) => {
  _corsPromise = Promise.resolve().then(() => cb());
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(method, body = {}, headers = {}) {
  return { method, body, headers, ip: '127.0.0.1' };
}

function makeRes() {
  const res = {
    _status: null,
    _body: null,
    _headers: {},
    set(key, value) {
      res._headers[key] = value;
      return res;
    },
    status(code) { res._status = code; return res; },
    json(data) { res._body = data; return res; },
    send(data) { res._body = data; return res; },
  };
  return res;
}

/** Call a Cloud Function handler and await its internal async work. */
async function callFn(fn, req, res) {
  fn(req, res);
  await _corsPromise;
}

// ── Load functions AFTER mocks are set up ────────────────────────────────────
const funcs = require('../firebase/functions/index');

// ── Tests ────────────────────────────────────────────────────────────────────

describe('sendFax', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects non-POST requests with 405', async () => {
    const res = makeRes();
    await callFn(funcs.sendFax, makeReq('GET'), res);
    expect(res._status).toBe(405);
  });

  test('returns 400 when required fields are missing', async () => {
    const res = makeRes();
    await callFn(funcs.sendFax, makeReq('POST', { storeNumber: '#001' }), res);
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/Missing required fields/);
  });

  test('returns 404 when store does not exist', async () => {
    mockDocGet.mockResolvedValueOnce({ exists: false });
    const res = makeRes();
    await callFn(
      funcs.sendFax,
      makeReq('POST', { storeNumber: '#999', pdfBase64: 'abc', fileName: 'f.pdf' }),
      res
    );
    expect(res._status).toBe(404);
    expect(res._body.error).toMatch(/not found/);
  });

  test('returns 200 and sends email on success', async () => {
    mockDocGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ storeNumber: '#001', location: 'Test Store', faxNumber: '5551234567' }),
    });
    const res = makeRes();
    await callFn(
      funcs.sendFax,
      makeReq('POST', { storeNumber: '#001', pdfBase64: 'abc', fileName: 'f.pdf', type: 'signed' }),
      res
    );
    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });
});

describe('sendFaxDirect', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects non-POST requests', async () => {
    const res = makeRes();
    await callFn(funcs.sendFaxDirect, makeReq('PUT'), res);
    expect(res._status).toBe(405);
  });

  test('returns 400 when fax number is too short', async () => {
    const res = makeRes();
    await callFn(
      funcs.sendFaxDirect,
      makeReq('POST', { faxNumber: '123', pdfBase64: 'abc', fileName: 'f.pdf' }),
      res
    );
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/at least 10 digits/);
  });

  test('strips non-digits and sends on valid number', async () => {
    const res = makeRes();
    await callFn(
      funcs.sendFaxDirect,
      makeReq('POST', { faxNumber: '(555) 123-4567', pdfBase64: 'abc', fileName: 'f.pdf' }),
      res
    );
    expect(res._status).toBe(200);
    expect(res._body.faxNumber).toBe('5551234567');
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });
});

describe('getStores', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects non-GET requests', async () => {
    const res = makeRes();
    await callFn(funcs.getStores, makeReq('POST'), res);
    expect(res._status).toBe(405);
  });

  test('returns store list on success', async () => {
    const mockDocs = [
      { id: '#001', data: () => ({ storeNumber: '#001', location: 'Store A' }) },
      { id: '#002', data: () => ({ storeNumber: '#002', location: 'Store B' }) },
    ];
    mockCollectionGet.mockResolvedValueOnce({ forEach: (cb) => mockDocs.forEach(cb) });
    const res = makeRes();
    await callFn(funcs.getStores, makeReq('GET'), res);
    expect(res._status).toBe(200);
    expect(res._body.count).toBe(2);
    expect(res._body.stores).toHaveLength(2);
  });
});

describe('faxWebhook', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects non-POST requests', async () => {
    const res = makeRes();
    await callFn(funcs.faxWebhook, makeReq('GET'), res);
    expect(res._status).toBe(405);
  });

  test('returns 400 when trackingId or status missing', async () => {
    const res = makeRes();
    await callFn(funcs.faxWebhook, makeReq('POST', { trackingId: 'abc' }), res);
    expect(res._status).toBe(400);
  });

  test('updates Firestore and returns 200', async () => {
    const res = makeRes();
    await callFn(
      funcs.faxWebhook,
      makeReq('POST', { trackingId: 'WEB-123', status: 'Success', faxKey: 'fk-1' }),
      res
    );
    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);
    // Should write both trackingId and faxKey docs
    expect(mockDocSet).toHaveBeenCalledTimes(2);
  });
});

describe('saveAcknowledgement', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects non-POST', async () => {
    const res = makeRes();
    await callFn(funcs.saveAcknowledgement, makeReq('GET'), res);
    expect(res._status).toBe(405);
  });

  test('returns 400 when required fields missing', async () => {
    const res = makeRes();
    await callFn(funcs.saveAcknowledgement, makeReq('POST', { employeeName: 'Test' }), res);
    expect(res._status).toBe(400);
  });

  test('strips data-url prefix from pdfBase64', async () => {
    const res = makeRes();
    await callFn(
      funcs.saveAcknowledgement,
      makeReq('POST', {
        employeeName: 'Jane',
        signDate: '2026-01-01',
        pdfBase64: 'data:application/pdf;base64,AAAA',
        pdfFileName: 'test.pdf',
      }),
      res
    );
    expect(res._status).toBe(200);
    // Verify the stored pdfBase64 had its prefix stripped
    const savedData = mockCollectionAdd.mock.calls[0][0];
    expect(savedData.pdfBase64).toBe('AAAA');
  });

  test('extracts client IP from x-forwarded-for header', async () => {
    const res = makeRes();
    await callFn(
      funcs.saveAcknowledgement,
      makeReq(
        'POST',
        { employeeName: 'Bob', signDate: '2026-01-01', pdfBase64: 'abc', pdfFileName: 'f.pdf' },
        { 'x-forwarded-for': '10.0.0.1, 10.0.0.2' }
      ),
      res
    );
    expect(res._status).toBe(200);
    const savedData = mockCollectionAdd.mock.calls[0][0];
    expect(savedData.ipAddress).toBe('10.0.0.1');
  });
});

describe('sendEmail', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects non-POST', async () => {
    const res = makeRes();
    await callFn(funcs.sendEmail, makeReq('GET'), res);
    expect(res._status).toBe(405);
  });

  test('returns 400 when required fields missing', async () => {
    const res = makeRes();
    await callFn(funcs.sendEmail, makeReq('POST', { pdfBase64: 'abc' }), res);
    expect(res._status).toBe(400);
  });

  test('returns 400 when employeeEmail or supervisorEmail missing', async () => {
    const res = makeRes();
    await callFn(
      funcs.sendEmail,
      makeReq('POST', { pdfBase64: 'abc', pdfFileName: 'f.pdf', employeeName: 'Test' }),
      res
    );
    expect(res._status).toBe(400);
  });

  test('sends to admin, employee, and supervisor', async () => {
    const res = makeRes();
    await callFn(
      funcs.sendEmail,
      makeReq('POST', {
        pdfBase64: 'abc',
        pdfFileName: 'f.pdf',
        employeeName: 'Test',
        employeeEmail: 'emp@test.com',
        supervisorEmail: 'sup@test.com',
        supervisorName: 'Supervisor Name'
      }),
      res
    );
    expect(res._status).toBe(200);
    expect(mockSendMail).toHaveBeenCalledTimes(3);
  });
});
