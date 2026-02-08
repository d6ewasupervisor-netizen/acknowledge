// Default manual mock – overridden by jest.mock() in test files
module.exports = {
  createTransport: () => ({ sendMail: jest.fn().mockResolvedValue({}) }),
};
