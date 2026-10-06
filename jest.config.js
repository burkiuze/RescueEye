module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js'],
  // The Android environment cannot reliably fork worker processes.
  maxWorkers: 1,
  testTimeout: 20000,
  collectCoverageFrom: [
    'backend/**/*.ts',
    'drone/**/*.ts',
    'simulator/**/*.ts',
    'vision/**/*.ts',
    'shared/**/*.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
};
