// @flow

// const expect = require('expect');
const os = require('os');
const path = require('path');
const level = require('level');
const uuid = require('uuid');
const { ObservedRemoveMap } = require('../src');
const { generateValue } = require('./lib/values');

jest.setTimeout(60000);


const memoryDelta = (start:Object) => {
  const end = process.memoryUsage();
  const delta = {};
  Object.keys(end).forEach((key) => {
    const d = end[key] - start[key];
    delta[key] = Math.round(d / 1024 / 1024 * 100) / 100;
  });
  return delta;
};

describe('Map Memory Test', () => {
  let db;

  beforeAll(async () => {
    const location = path.join(os.tmpdir(), uuid.v4());
    db = level(location, { valueEncoding: 'json' });
  });

  afterAll(async () => {
    await db.close();
  });

  test('Set and delete values', async () => {
    const map = new ObservedRemoveMap(db);
    const startMemoryUsage = process.memoryUsage();
    for (let i = 0; i < 100000; i += 1) {
      const key = uuid.v4();
      const value = generateValue();
      await map.set(key, value);
      if (i % 1000 === 1) {
        await map.publish();
      }
    }
    await map.shutdown();
    console.log(JSON.stringify(memoryDelta(startMemoryUsage), null, 2));
  });
});

