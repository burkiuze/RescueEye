export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js'],
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
