module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  // Map firebase/functions dependencies so jest.mock() can intercept them
  // without needing the actual packages installed in the root node_modules
  moduleNameMapper: {
    '^firebase-functions$': '<rootDir>/__mocks__/firebase-functions.js',
    '^firebase-admin$': '<rootDir>/__mocks__/firebase-admin.js',
    '^nodemailer$': '<rootDir>/__mocks__/nodemailer.js',
    '^cors$': '<rootDir>/__mocks__/cors.js',
  },
};
