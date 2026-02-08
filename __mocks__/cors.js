// Default manual mock – overridden by jest.mock() in test files
module.exports = () => (req, res, cb) => cb();
