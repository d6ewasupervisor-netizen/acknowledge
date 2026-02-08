// Default manual mock – overridden by jest.mock() in test files
module.exports = {
  config: () => ({}),
  runWith: () => ({ https: { onRequest: (h) => h } }),
  https: { onRequest: (h) => h },
  pubsub: { schedule: () => ({ onRun: (h) => h }) },
};
