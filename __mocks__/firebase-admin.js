// Default manual mock – overridden by jest.mock() in test files
const admin = {
  initializeApp: jest.fn(),
  firestore: jest.fn(() => ({ collection: jest.fn() })),
};
admin.firestore.FieldValue = { serverTimestamp: jest.fn(() => 'MOCK_TS') };
module.exports = admin;
