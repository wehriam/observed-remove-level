// @flow

const os = require('os');
const path = require('path');
const expect = require('expect');
const uuid = require('uuid');
const level = require('level');
const { ObservedRemoveMap } = require('../src');
const { generateValue } = require('./lib/values');
require('./lib/async-iterator-comparison');

describe('Map', () => {
  let db;

  beforeAll(async () => {
    const location = path.join(os.tmpdir(), uuid.v4());
    db = level(location, { valueEncoding: 'json' });
  });

  afterAll(async () => {
    await db.close();
  });

  test('Set and delete values', async () => {
    const keyA = uuid.v4();
    const keyB = uuid.v4();
    const valueA = generateValue();
    const valueB = generateValue();
    const map = new ObservedRemoveMap(db, [], { namespace: uuid.v4() });
    await map.readyPromise;
    expect(map.size).toEqual(0);
    await map.set(keyA, valueA);
    await expect(map.has(keyA)).resolves.toEqual(true);
    await expect(map.has(keyB)).resolves.toEqual(false);
    expect(map.size).toEqual(1);
    await map.set(keyB, valueB);
    await expect(map.has(keyA)).resolves.toEqual(true);
    await expect(map.has(keyB)).resolves.toEqual(true);
    expect(map.size).toEqual(2);
    await map.delete(keyB);
    await expect(map.has(keyA)).resolves.toEqual(true);
    await expect(map.has(keyB)).resolves.toEqual(false);
    expect(map.size).toEqual(1);
    await map.delete(keyA);
    await expect(map.has(keyA)).resolves.toEqual(false);
    await expect(map.has(keyB)).resolves.toEqual(false);
    expect(map.size).toEqual(0);
    await map.set(keyA, valueA);
    await expect(map.has(keyA)).resolves.toEqual(true);
    await expect(map.has(keyB)).resolves.toEqual(false);
    expect(map.size).toEqual(1);
    await map.set(keyB, valueB);
    await expect(map.has(keyA)).resolves.toEqual(true);
    await expect(map.has(keyB)).resolves.toEqual(true);
    expect(map.size).toEqual(2);
    await expect(map.values()).asyncIteratesTo(expect.arrayContaining([valueA, valueB]));
    await expect(map.keys()).asyncIteratesTo(expect.arrayContaining([keyA, keyB]));
    await expect(map).asyncIteratesTo(expect.arrayContaining([[keyA, valueA], [keyB, valueB]]));
    await expect(map.entries()).asyncIteratesTo(expect.arrayContaining([[keyA, valueA], [keyB, valueB]]));
    await map.shutdown();
  });


  test('Emit set and delete events', async () => {
    const keyA = uuid.v4();
    const keyB = uuid.v4();
    const valueA = generateValue();
    const valueB = generateValue();
    const map = new ObservedRemoveMap(db, [], { namespace: uuid.v4() });
    await map.readyPromise;
    const setAPromise = new Promise((resolve) => {
      map.on('set', (k, v) => {
        if (k === keyA) {
          expect(v).toEqual(valueA);
          resolve();
        }
      });
      map.set(keyA, valueA);
    });
    const setBPromise = new Promise((resolve) => {
      map.on('set', (k, v) => {
        if (k === keyB) {
          expect(v).toEqual(valueB);
          resolve();
        }
      });
      map.set(keyB, valueB);
    });
    await setAPromise;
    await setBPromise;
    const deleteAPromise = new Promise((resolve) => {
      map.on('delete', (k, v) => {
        if (k === keyA) {
          expect(v).toEqual(valueA);
          resolve();
        }
      });
      map.delete(keyA);
    });
    const deleteBPromise = new Promise((resolve) => {
      map.on('delete', (k, v) => {
        if (k === keyB) {
          expect(v).toEqual(valueB);
          resolve();
        }
      });
      map.delete(keyB);
    });
    await deleteAPromise;
    await deleteBPromise;
    await map.shutdown();
  });


  test('Iterate through values', async () => {
    const keyA = uuid.v4();
    const keyB = uuid.v4();
    const keyC = uuid.v4();
    const valueA = generateValue();
    const valueB = generateValue();
    const valueC = generateValue();
    const map = new ObservedRemoveMap(db, [[keyA, valueA], [keyB, valueB], [keyC, valueC]], { namespace: uuid.v4() });
    await map.readyPromise;
    for await (const [k, v] of map) { // eslint-disable-line no-restricted-syntax
      if (k === keyA) {
        expect(v).toEqual(valueA);
      } else if (k === keyB) {
        expect(v).toEqual(valueB);
      } else if (k === keyC) {
        expect(v).toEqual(valueC);
      } else {
        throw new Error(`Invalid key ${k}`);
      }
    }
    await map.forEach((v, k) => {
      if (k === keyA) {
        expect(v).toEqual(valueA);
      } else if (k === keyB) {
        expect(v).toEqual(valueB);
      } else if (k === keyC) {
        expect(v).toEqual(valueC);
      } else {
        throw new Error(`Invalid key ${k}`);
      }
    });
    await map.shutdown();
  });


  test('Clear values', async () => {
    const keyA = uuid.v4();
    const keyB = uuid.v4();
    const keyC = uuid.v4();
    const valueA = generateValue();
    const valueB = generateValue();
    const valueC = generateValue();
    const map = new ObservedRemoveMap(db, [[keyA, valueA], [keyB, valueB], [keyC, valueC]], { maxAge: 0, bufferPublishing: 0, namespace: uuid.v4() });
    await map.readyPromise;
    expect(map.size).toEqual(3);
    await map.clear();
    expect(map.size).toEqual(0);
    expect(map.insertQueue.length).toEqual(0);
    expect(map.deleteQueue.length).toEqual(0);
    expect((await map.deletions()).length).toEqual(3);
    await map.flush();
    expect(map.size).toEqual(0);
    expect(map.insertQueue.length).toEqual(0);
    expect(map.deleteQueue.length).toEqual(0);
    expect((await map.deletions()).length).toEqual(0);
    await map.shutdown();
  });

  test('Synchronize maps', async () => {
    const keyX = uuid.v4();
    const keyY = uuid.v4();
    const keyZ = uuid.v4();
    const valueX = generateValue();
    const valueY = generateValue();
    const valueZ = generateValue();
    const alice = new ObservedRemoveMap(db, [], { namespace: uuid.v4() });
    await alice.readyPromise;
    const bob = new ObservedRemoveMap(db, [], { namespace: uuid.v4() });
    await bob.readyPromise;
    let aliceAddCount = 0;
    let bobAddCount = 0;
    let aliceDeleteCount = 0;
    let bobDeleteCount = 0;
    alice.on('set', () => (aliceAddCount += 1));
    bob.on('set', () => (bobAddCount += 1));
    alice.on('delete', () => (aliceDeleteCount += 1));
    bob.on('delete', () => (bobDeleteCount += 1));
    alice.on('publish', (message) => {
      bob.process(message);
    });
    bob.on('publish', (message) => {
      alice.process(message);
    });
    await alice.set(keyX, valueX);
    await alice.set(keyY, valueY);
    await alice.set(keyZ, valueZ);
    while (aliceAddCount !== 3 || bobAddCount !== 3) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await expect(alice.get(keyX)).resolves.toEqual(valueX);
    await expect(alice.get(keyY)).resolves.toEqual(valueY);
    await expect(alice.get(keyZ)).resolves.toEqual(valueZ);
    await expect(bob.get(keyX)).resolves.toEqual(valueX);
    await expect(bob.get(keyY)).resolves.toEqual(valueY);
    await expect(bob.get(keyZ)).resolves.toEqual(valueZ);
    await expect(alice).asyncIteratesTo(expect.arrayContaining([[keyX, valueX], [keyY, valueY], [keyZ, valueZ]]));
    await expect(bob).asyncIteratesTo(expect.arrayContaining([[keyX, valueX], [keyY, valueY], [keyZ, valueZ]]));
    await bob.delete(keyX);
    await bob.delete(keyY);
    await bob.delete(keyZ);
    while (aliceDeleteCount !== 3 || bobDeleteCount !== 3) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await expect(alice.get(keyX)).resolves.toBeUndefined();
    await expect(alice.get(keyY)).resolves.toBeUndefined();
    await expect(alice.get(keyZ)).resolves.toBeUndefined();
    await expect(bob.get(keyX)).resolves.toBeUndefined();
    await expect(bob.get(keyY)).resolves.toBeUndefined();
    await expect(bob.get(keyZ)).resolves.toBeUndefined();
    await expect(alice).asyncIteratesTo(expect.arrayContaining([]));
    await expect(bob).asyncIteratesTo(expect.arrayContaining([]));
    await alice.shutdown();
    await bob.shutdown();
  });

  test('Flush deletions', async () => {
    const keyX = uuid.v4();
    const keyY = uuid.v4();
    const keyZ = uuid.v4();
    const valueX = generateValue();
    const valueY = generateValue();
    const valueZ = generateValue();
    const map = new ObservedRemoveMap(db, [[keyX, valueX], [keyY, valueY], [keyZ, valueZ]], { maxAge: 300, namespace: uuid.v4() });
    await map.readyPromise;
    await map.delete(keyX);
    await map.delete(keyY);
    await map.delete(keyZ);
    expect((await map.deletions()).length).toEqual(3);
    await map.flush();
    expect((await map.deletions()).length).toEqual(3);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await map.flush();
    expect((await map.deletions()).length).toEqual(0);
    await map.shutdown();
  });


  test('Synchronize set and delete events', async () => {
    const keyX = uuid.v4();
    const keyY = uuid.v4();
    const valueX = generateValue();
    const valueY = generateValue();
    const alice = new ObservedRemoveMap(db, [], { namespace: uuid.v4() });
    const bob = new ObservedRemoveMap(db, [], { namespace: uuid.v4() });
    await alice.readyPromise;
    await bob.readyPromise;
    alice.on('publish', (message) => {
      bob.process(message);
    });
    bob.on('publish', (message) => {
      alice.process(message);
    });
    const aliceSetXPromise = new Promise((resolve) => {
      alice.once('set', (key, value) => {
        expect(key).toEqual(keyX);
        expect(value).toEqual(valueX);
        resolve();
      });
    });
    const aliceDeleteXPromise = new Promise((resolve) => {
      alice.once('delete', (key, value) => {
        expect(key).toEqual(keyX);
        expect(value).toEqual(valueX);
        resolve();
      });
    });
    await bob.set(keyX, valueX);
    await aliceSetXPromise;
    await bob.delete(keyX);
    await aliceDeleteXPromise;
    const bobSetYPromise = new Promise((resolve) => {
      bob.once('set', (key, value) => {
        expect(key).toEqual(keyY);
        expect(value).toEqual(valueY);
        resolve();
      });
    });
    const bobDeleteYPromise = new Promise((resolve) => {
      bob.once('delete', (key, value) => {
        expect(key).toEqual(keyY);
        expect(value).toEqual(valueY);
        resolve();
      });
    });
    await alice.set(keyY, valueY);
    await bobSetYPromise;
    await alice.delete(keyY);
    await bobDeleteYPromise;
    await alice.shutdown();
    await bob.shutdown();
  });


  test('Should not emit events for remote set/delete combos on sync', async () => {
    const keyX = uuid.v4();
    const keyY = uuid.v4();
    const valueX = generateValue();
    const valueY = generateValue();
    const alice = new ObservedRemoveMap(db, [], { namespace: uuid.v4() });
    const bob = new ObservedRemoveMap(db, [], { namespace: uuid.v4() });
    await alice.readyPromise;
    await bob.readyPromise;
    await alice.set(keyX, valueX);
    await alice.delete(keyX);
    await bob.set(keyY, valueY);
    await bob.delete(keyY);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const bobPromise = new Promise((resolve, reject) => {
      bob.once('set', () => {
        reject(new Error('Bob should not receive set event'));
      });
      bob.once('delete', () => {
        reject(new Error('Bob should not receive delete event'));
      });
      setTimeout(resolve, 500);
    });
    const alicePromise = new Promise((resolve, reject) => {
      alice.once('set', () => {
        reject(new Error('Alice should not receive set event'));
      });
      alice.once('delete', () => {
        reject(new Error('Alice should not receive delete event'));
      });
      setTimeout(resolve, 500);
    });
    alice.on('publish', (message) => {
      bob.process(message);
    });
    bob.on('publish', (message) => {
      alice.process(message);
    });
    await alice.sync();
    await bob.sync();
    await bobPromise;
    await alicePromise;
    await expect(alice.get(keyX)).resolves.toBeUndefined();
    await expect(alice.get(keyY)).resolves.toBeUndefined();
    await expect(bob.get(keyX)).resolves.toBeUndefined();
    await expect(bob.get(keyY)).resolves.toBeUndefined();
    await alice.shutdown();
    await bob.shutdown();
  });


  test('Synchronize mixed maps using sync', async () => {
    const keyA = uuid.v4();
    const keyB = uuid.v4();
    const keyC = uuid.v4();
    const keyX = uuid.v4();
    const keyY = uuid.v4();
    const keyZ = uuid.v4();
    const valueA = generateValue();
    const valueB = generateValue();
    const valueC = generateValue();
    const valueX = generateValue();
    const valueY = generateValue();
    const valueZ = generateValue();
    const alice = new ObservedRemoveMap(db, [], { namespace: uuid.v4() });
    const bob = new ObservedRemoveMap(db, [], { namespace: uuid.v4() });
    await alice.readyPromise;
    await bob.readyPromise;
    await alice.set(keyA, valueA);
    await bob.set(keyX, valueX);
    await alice.set(keyB, valueB);
    await bob.set(keyY, valueY);
    await alice.set(keyC, valueC);
    await bob.set(keyZ, valueZ);
    let aliceAddCount = 0;
    let bobAddCount = 0;
    let aliceDeleteCount = 0;
    let bobDeleteCount = 0;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(alice).asyncIteratesTo(expect.arrayContaining([[keyA, valueA], [keyB, valueB], [keyC, valueC]]));
    await expect(bob).asyncIteratesTo(expect.arrayContaining([[keyX, valueX], [keyY, valueY], [keyZ, valueZ]]));
    alice.on('set', () => (aliceAddCount += 1));
    bob.on('set', () => (bobAddCount += 1));
    alice.on('delete', () => (aliceDeleteCount += 1));
    bob.on('delete', () => (bobDeleteCount += 1));
    alice.on('publish', (message) => {
      bob.process(message);
    });
    bob.on('publish', (message) => {
      alice.process(message);
    });
    await alice.sync();
    await bob.sync();
    while (aliceAddCount !== 3 || bobAddCount !== 3) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await expect(alice).asyncIteratesTo(expect.arrayContaining([[keyA, valueA], [keyX, valueX], [keyB, valueB], [keyY, valueY], [keyC, valueC], [keyZ, valueZ]]));
    await expect(bob).asyncIteratesTo(expect.arrayContaining([[keyA, valueA], [keyX, valueX], [keyB, valueB], [keyY, valueY], [keyC, valueC], [keyZ, valueZ]]));
    await alice.shutdown();
    await bob.shutdown();
  });


  test('Key-value pairs should not repeat', async () => {
    const key = uuid.v4();
    const value1 = generateValue();
    const value2 = generateValue();
    const alice = new ObservedRemoveMap(db, [], { namespace: uuid.v4() });
    await alice.readyPromise;
    await alice.set(key, value1);
    await alice.set(key, value2);
    await expect(alice).asyncIteratesTo(expect.arrayContaining([[key, value2]]));
    await expect(alice.entries()).asyncIteratesTo(expect.arrayContaining([[key, value2]]));
    await expect(alice.keys()).asyncIteratesTo(expect.arrayContaining([key]));
    await expect(alice.values()).asyncIteratesTo(expect.arrayContaining([value2]));
    await expect(alice.get(key)).resolves.toEqual(value2);
    await alice.shutdown();
  });


  test('Synchronizes 100 asynchrous maps', async () => {
    const keyA = uuid.v4();
    const keyB = uuid.v4();
    const keyC = uuid.v4();
    const valueA = generateValue();
    const valueB = generateValue();
    const valueC = generateValue();
    const maps = [];
    const callbacks = [];
    const publish = (sourceId:number, message:Buffer) => {
      for (let i = 0; i < callbacks.length; i += 1) {
        const [targetId, callback] = callbacks[i];
        if (targetId === sourceId) {
          continue;
        }
        setTimeout(() => callback(message), Math.round(1000 * Math.random()));
      }
    };
    const subscribe = (targetId: number, callback:Function) => {
      callbacks.push([targetId, callback]);
    };
    const getPair = () => {
      const mapA = maps[Math.floor(Math.random() * maps.length)];
      let mapB = mapA;
      while (mapB === mapA) {
        mapB = maps[Math.floor(Math.random() * maps.length)];
      }
      return [mapA, mapB];
    };
    for (let i = 0; i < 100; i += 1) {
      const map = new ObservedRemoveMap(db, [], { namespace: uuid.v4() });
      await map.readyPromise;
      map.on('publish', (message) => publish(i, message));
      subscribe(i, (message) => map.process(message));
      maps.push(map);
    }
    const [alice, bob] = getPair();
    let aliceAddCount = 0;
    let bobAddCount = 0;
    let aliceDeleteCount = 0;
    let bobDeleteCount = 0;
    alice.on('set', () => (aliceAddCount += 1));
    bob.on('set', () => (bobAddCount += 1));
    alice.on('delete', () => (aliceDeleteCount += 1));
    bob.on('delete', () => (bobDeleteCount += 1));
    await alice.set(keyA, valueA);
    await bob.set(keyB, valueB);
    await alice.set(keyC, valueC);
    while (aliceAddCount !== 3 || bobAddCount !== 3) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await bob.delete(keyC);
    await alice.delete(keyB);
    await bob.delete(keyA);
    while (aliceDeleteCount !== 3 || bobDeleteCount !== 3) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await expect(alice).asyncIteratesTo(expect.arrayContaining([]));
    await expect(bob).asyncIteratesTo(expect.arrayContaining([]));
    await alice.shutdown();
    await bob.shutdown();
  });

  test('Synchronize out of order sets', async () => {
    const alice = new ObservedRemoveMap(db, [], { namespace: uuid.v4() });
    const bob = new ObservedRemoveMap(db, [], { namespace: uuid.v4() });
    await alice.readyPromise;
    await bob.readyPromise;
    const key = uuid.v4();
    const value1 = generateValue();
    const value2 = generateValue();
    await alice.set(key, value1);
    const aliceDump1 = await alice.dump();
    await alice.set(key, value2);
    const aliceDump2 = await alice.dump();
    await bob.process(aliceDump2);
    await expect(bob.get(key)).resolves.toEqual(value2);
    await bob.delete(key);
    await expect(bob.get(key)).resolves.toBeUndefined();
    const bobDump1 = await bob.dump();
    await alice.process(bobDump1);
    await expect(alice.get(key)).resolves.toBeUndefined();
    await bob.process(aliceDump1);
    await expect(alice.get(key)).resolves.toBeUndefined();
    await expect(bob.get(key)).resolves.toBeUndefined();
    const bobDump2 = await bob.dump();
    await alice.process(bobDump2);
    await expect(alice.get(key)).resolves.toBeUndefined();
    await expect(bob.get(key)).resolves.toBeUndefined();
    await alice.shutdown();
    await bob.shutdown();
  });
});

