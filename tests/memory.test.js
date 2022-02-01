// @flow

import os from 'os';
import path from 'path';
import level from 'level';
import { v4 as uuidv4 } from 'uuid';
import { ObservedRemoveMap } from '../src';
import { generateValue } from './lib/values';

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

  beforeEach(async () => {
    const location = path.join(os.tmpdir(), uuidv4());
    db = level(location, { valueEncoding: 'json' });
  });

  afterEach(async () => {
    await db.close();
  });

  test('Set and delete values', async () => {
    const map = new ObservedRemoveMap(db);
    const startMemoryUsage = process.memoryUsage();
    for (let i = 0; i < 100000; i += 1) {
      const key = uuidv4();
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

