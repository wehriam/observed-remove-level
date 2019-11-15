// @flow

const expect = require('expect');
const uuid = require('uuid');
const os = require('os');
const path = require('path');
const level = require('level');
const { InvalidSignatureError, SignedObservedRemoveMap, getSigner, generateId } = require('../src');
const { generateValue } = require('./lib/values');
const NodeRSA = require('node-rsa');
require('./lib/async-iterator-comparison');

const privateKey = new NodeRSA({ b: 512 });
const sign = getSigner(privateKey.exportKey('pkcs1-private-pem'));
const key = privateKey.exportKey('pkcs1-public-pem');

describe('Signed Map', () => {
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
    const map = new SignedObservedRemoveMap(db, [], { key, namespace: uuid.v4() });
    await map.readyPromise;
    expect(map.size).toEqual(0);
    const id1 = generateId();
    await map.setSigned(keyA, valueA, id1, sign(keyA, valueA, id1));
    await expect(map.has(keyA)).resolves.toEqual(true);
    await expect(map.has(keyB)).resolves.toEqual(false);
    expect(map.size).toEqual(1);
    const id2 = generateId();
    await map.setSigned(keyB, valueB, id2, sign(keyB, valueB, id2));
    await expect(map.has(keyA)).resolves.toEqual(true);
    await expect(map.has(keyB)).resolves.toEqual(true);
    expect(map.size).toEqual(2);
    await map.deleteSigned(keyB, id2, sign(keyB, id2));
    await expect(map.has(keyA)).resolves.toEqual(true);
    await expect(map.has(keyB)).resolves.toEqual(false);
    expect(map.size).toEqual(1);
    await map.deleteSigned(keyA, id1, sign(keyA, id1));
    await expect(map.has(keyA)).resolves.toEqual(false);
    await expect(map.has(keyB)).resolves.toEqual(false);
    expect(map.size).toEqual(0);
    const id3 = generateId();
    await map.setSigned(keyA, valueA, id3, sign(keyA, valueA, id3));
    await expect(map.has(keyA)).resolves.toEqual(true);
    await expect(map.has(keyB)).resolves.toEqual(false);
    expect(map.size).toEqual(1);
    const id4 = generateId();
    await map.setSigned(keyB, valueB, id4, sign(keyB, valueB, id4));
    await expect(map.has(keyA)).resolves.toEqual(true);
    await expect(map.has(keyB)).resolves.toEqual(true);
    expect(map.size).toEqual(2);
    await expect(map.values()).asyncIteratesTo(expect.arrayContaining([valueA, valueB]));
    await expect(map.keys()).asyncIteratesTo(expect.arrayContaining([keyA, keyB]));
    await expect(map).asyncIteratesTo(expect.arrayContaining([[keyA, valueA], [keyB, valueB]]));
    await expect(map.entries()).asyncIteratesTo(expect.arrayContaining([[keyA, valueA], [keyB, valueB]]));
    await map.shutdown();
  });

  test('Throw on invalid signatures', async () => {
    const keyA = uuid.v4();
    const valueA = generateValue();
    const map = new SignedObservedRemoveMap(db, [], { key, namespace: uuid.v4() });
    await map.readyPromise;
    const badMap = new SignedObservedRemoveMap(db, [[keyA, valueA, generateId(), '***']], { key, namespace: uuid.v4() });
    await expect(badMap.readyPromise).rejects.toThrowError(InvalidSignatureError);
    await expect(map.setSigned(keyA, valueA, generateId(), '***')).rejects.toThrowError(InvalidSignatureError);
    const id = generateId();
    await map.setSigned(keyA, valueA, id, sign(keyA, valueA, id));
    await await expect(map.deleteSigned(keyA, id, '***')).rejects.toThrowError(InvalidSignatureError);
    await map.shutdown();
  });

  test('Throw on clear', async () => {
    const map = new SignedObservedRemoveMap(db, [], { key, namespace: uuid.v4() });
    await map.readyPromise;
    expect(() => {
      map.clear();
    }).toThrow();
    await map.shutdown();
  });


  test('Throw on invalid synchronization', async () => {
    const alicePrivateKey = new NodeRSA({ b: 512 });
    const aliceSign = getSigner(alicePrivateKey.exportKey('pkcs1-private-pem'));
    const aliceKey = alicePrivateKey.exportKey('pkcs1-public-pem');
    const bobPrivateKey = new NodeRSA({ b: 512 });
    const bobSign = getSigner(bobPrivateKey.exportKey('pkcs1-private-pem'));
    const bobKey = bobPrivateKey.exportKey('pkcs1-public-pem');
    const keyX = uuid.v4();
    const keyY = uuid.v4();
    const valueX = generateValue();
    const valueY = generateValue();
    const alice = new SignedObservedRemoveMap(db, [], { key: aliceKey });
    const bob = new SignedObservedRemoveMap(db, [], { key: bobKey });
    await Promise.all([alice.readyPromise, bob.readyPromise]);
    const id1 = generateId();
    const bobMessage1 = await new Promise((resolve) => {
      bob.on('publish', (message) => {
        resolve(message);
      });
      bob.setSigned(keyX, valueX, id1, bobSign(keyX, valueX, id1));
    });
    await expect(alice.processSigned(bobMessage1)).rejects.toThrowError(InvalidSignatureError);
    const id2 = generateId();
    const aliceMessage1 = await new Promise((resolve) => {
      alice.on('publish', (message) => {
        resolve(message);
      });
      alice.setSigned(keyY, valueY, id2, aliceSign(keyY, valueY, id2));
    });
    await expect(bob.processSigned(aliceMessage1)).rejects.toThrowError(InvalidSignatureError);
    const bobMessage2 = await new Promise((resolve) => {
      bob.on('publish', (message) => {
        resolve(message);
      });
      bob.deleteSigned(keyX, id1, bobSign(keyX, id1));
    });
    await expect(alice.processSigned(bobMessage2)).rejects.toThrowError(InvalidSignatureError);
    const aliceMessage2 = await new Promise((resolve) => {
      alice.on('publish', (message) => {
        resolve(message);
      });
      alice.deleteSigned(keyY, id2, aliceSign(keyY, id2));
    });
    await expect(bob.processSigned(aliceMessage2)).rejects.toThrowError(InvalidSignatureError);
    await Promise.all([alice.shutdown(), bob.shutdown()]);
  });

  test('Emit set and delete events', async () => {
    const keyA = uuid.v4();
    const keyB = uuid.v4();
    const valueA = generateValue();
    const valueB = generateValue();
    const map = new SignedObservedRemoveMap(db, [], { key, namespace: uuid.v4() });
    await map.readyPromise;
    const id1 = generateId();
    const setAPromise = new Promise((resolve) => {
      map.on('set', (k, v) => {
        if (k === keyA) {
          expect(v).toEqual(valueA);
          resolve();
        }
      });
      map.setSigned(keyA, valueA, id1, sign(keyA, valueA, id1));
    });
    const id2 = generateId();
    const setBPromise = new Promise((resolve) => {
      map.on('set', (k, v) => {
        if (k === keyB) {
          expect(v).toEqual(valueB);
          resolve();
        }
      });
      map.setSigned(keyB, valueB, id2, sign(keyB, valueB, id2));
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
      map.deleteSigned(keyA, id1, sign(keyA, id1));
    });
    const deleteBPromise = new Promise((resolve) => {
      map.on('delete', (k, v) => {
        if (k === keyB) {
          expect(v).toEqual(valueB);
          resolve();
        }
      });
      map.deleteSigned(keyB, id2, sign(keyB, id2));
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
    const idA = generateId();
    const idB = generateId();
    const idC = generateId();
    const map = new SignedObservedRemoveMap(db, [[keyA, valueA, idA, sign(keyA, valueA, idA)], [keyB, valueB, idB, sign(keyB, valueB, idB)], [keyC, valueC, idC, sign(keyC, valueC, idC)]], { key, namespace: uuid.v4() });
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

  test('Synchronize maps', async () => {
    const keyX = uuid.v4();
    const keyY = uuid.v4();
    const keyZ = uuid.v4();
    const valueX = generateValue();
    const valueY = generateValue();
    const valueZ = generateValue();
    const alice = new SignedObservedRemoveMap(db, [], { key, namespace: uuid.v4() });
    const bob = new SignedObservedRemoveMap(db, [], { key, namespace: uuid.v4() });
    await Promise.all([alice.readyPromise, bob.readyPromise]);
    let aliceAddCount = 0;
    let bobAddCount = 0;
    let aliceDeleteCount = 0;
    let bobDeleteCount = 0;
    alice.on('set', () => (aliceAddCount += 1));
    bob.on('set', () => (bobAddCount += 1));
    alice.on('delete', () => (aliceDeleteCount += 1));
    bob.on('delete', () => (bobDeleteCount += 1));
    alice.on('publish', (message) => {
      bob.processSigned(message);
    });
    bob.on('publish', (message) => {
      alice.processSigned(message);
    });
    const id1 = generateId();
    await alice.setSigned(keyX, valueX, id1, sign(keyX, valueX, id1));
    const id2 = generateId();
    await alice.setSigned(keyY, valueY, id2, sign(keyY, valueY, id2));
    const id3 = generateId();
    await alice.setSigned(keyZ, valueZ, id3, sign(keyZ, valueZ, id3));
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
    await bob.deleteSigned(keyX, id1, sign(keyX, id1));
    await bob.deleteSigned(keyY, id2, sign(keyY, id2));
    await bob.deleteSigned(keyZ, id3, sign(keyZ, id3));
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
    await Promise.all([alice.shutdown(), bob.shutdown()]);
  });

  test('Flush deletions', async () => {
    const keyX = uuid.v4();
    const keyY = uuid.v4();
    const keyZ = uuid.v4();
    const valueX = generateValue();
    const valueY = generateValue();
    const valueZ = generateValue();
    const idX = generateId();
    const idY = generateId();
    const idZ = generateId();
    const map = new SignedObservedRemoveMap(db, [[keyX, valueX, idX, sign(keyX, valueX, idX)], [keyY, valueY, idY, sign(keyY, valueY, idY)], [keyZ, valueZ, idZ, sign(keyZ, valueZ, idZ)]], { maxAge: 300, key, namespace: uuid.v4() });
    await map.readyPromise;
    await map.deleteSigned(keyX, idX, sign(keyX, idX));
    await map.deleteSigned(keyY, idY, sign(keyY, idY));
    await map.deleteSigned(keyZ, idZ, sign(keyZ, idZ));
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
    const alice = new SignedObservedRemoveMap(db, [], { key, namespace: uuid.v4() });
    const bob = new SignedObservedRemoveMap(db, [], { key, namespace: uuid.v4() });
    await Promise.all([alice.readyPromise, bob.readyPromise]);
    alice.on('publish', (message) => {
      bob.processSigned(message);
    });
    bob.on('publish', (message) => {
      alice.processSigned(message);
    });
    const aliceSetXPromise = new Promise((resolve) => {
      alice.once('set', (k, v) => {
        expect(k).toEqual(keyX);
        expect(v).toEqual(valueX);
        resolve();
      });
    });
    const aliceDeleteXPromise = new Promise((resolve) => {
      alice.once('delete', (k, v) => {
        expect(k).toEqual(keyX);
        expect(v).toEqual(valueX);
        resolve();
      });
    });
    const id1 = generateId();
    await bob.setSigned(keyX, valueX, id1, sign(keyX, valueX, id1));
    await aliceSetXPromise;
    await bob.deleteSigned(keyX, id1, sign(keyX, id1));
    await aliceDeleteXPromise;
    const bobSetYPromise = new Promise((resolve) => {
      bob.once('set', (k, v) => {
        expect(k).toEqual(keyY);
        expect(v).toEqual(valueY);
        resolve();
      });
    });
    const bobDeleteYPromise = new Promise((resolve) => {
      bob.once('delete', (k, v) => {
        expect(k).toEqual(keyY);
        expect(v).toEqual(valueY);
        resolve();
      });
    });
    const id2 = generateId();
    await alice.setSigned(keyY, valueY, id2, sign(keyY, valueY, id2));
    await bobSetYPromise;
    await alice.deleteSigned(keyY, id2, sign(keyY, id2));
    await bobDeleteYPromise;
    await Promise.all([alice.shutdown(), bob.shutdown()]);
  });

  test('Should not emit events for remote set/delete combos on sync', async () => {
    const keyX = uuid.v4();
    const keyY = uuid.v4();
    const valueX = generateValue();
    const valueY = generateValue();
    const alice = new SignedObservedRemoveMap(db, [], { key, namespace: uuid.v4() });
    const bob = new SignedObservedRemoveMap(db, [], { key, namespace: uuid.v4() });
    await Promise.all([alice.readyPromise, bob.readyPromise]);
    const id1 = generateId();
    await alice.setSigned(keyX, valueX, id1, sign(keyX, valueX, id1));
    await alice.deleteSigned(keyX, id1, sign(keyX, id1));
    const id2 = generateId();
    await bob.setSigned(keyY, valueY, id2, sign(keyY, valueY, id2));
    await bob.deleteSigned(keyY, id2, sign(keyY, id2));
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
      bob.processSigned(message);
    });
    bob.on('publish', (message) => {
      alice.processSigned(message);
    });
    alice.sync();
    bob.sync();
    await bobPromise;
    await alicePromise;
    await expect(alice.get(keyX)).resolves.toBeUndefined();
    await expect(alice.get(keyY)).resolves.toBeUndefined();
    await expect(bob.get(keyX)).resolves.toBeUndefined();
    await expect(bob.get(keyY)).resolves.toBeUndefined();
    await Promise.all([alice.shutdown(), bob.shutdown()]);
  });

  test('Synchronize mixed maps using sync', async () => {
    let id;
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
    const alice = new SignedObservedRemoveMap(db, [], { key, namespace: uuid.v4() });
    const bob = new SignedObservedRemoveMap(db, [], { key, namespace: uuid.v4() });
    await Promise.all([alice.readyPromise, bob.readyPromise]);
    id = generateId();
    await alice.setSigned(keyA, valueA, id, sign(keyA, valueA, id));
    id = generateId();
    await bob.setSigned(keyX, valueX, id, sign(keyX, valueX, id));
    id = generateId();
    await alice.setSigned(keyB, valueB, id, sign(keyB, valueB, id));
    id = generateId();
    await bob.setSigned(keyY, valueY, id, sign(keyY, valueY, id));
    id = generateId();
    await alice.setSigned(keyC, valueC, id, sign(keyC, valueC, id));
    id = generateId();
    await bob.setSigned(keyZ, valueZ, id, sign(keyZ, valueZ, id));
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
      bob.processSigned(message);
    });
    bob.on('publish', (message) => {
      alice.processSigned(message);
    });
    alice.sync();
    bob.sync();
    while (aliceAddCount !== 3 || bobAddCount !== 3) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await expect(alice).asyncIteratesTo(expect.arrayContaining([[keyA, valueA], [keyX, valueX], [keyB, valueB], [keyY, valueY], [keyC, valueC], [keyZ, valueZ]]));
    await expect(bob).asyncIteratesTo(expect.arrayContaining([[keyA, valueA], [keyX, valueX], [keyB, valueB], [keyY, valueY], [keyC, valueC], [keyZ, valueZ]]));
    await Promise.all([alice.shutdown(), bob.shutdown()]);
  });

  test('Key-value pairs should not repeat', async () => {
    let id;
    const k = uuid.v4();
    const value1 = generateValue();
    const value2 = generateValue();
    const alice = new SignedObservedRemoveMap(db, [], { key, namespace: uuid.v4() });
    await alice.readyPromise;
    id = generateId();
    await alice.setSigned(k, value1, id, sign(k, value1, id));
    id = generateId();
    await alice.setSigned(k, value2, id, sign(k, value2, id));
    await expect(alice).asyncIteratesTo(expect.arrayContaining([[k, value2]]));
    await expect(alice.entries()).asyncIteratesTo(expect.arrayContaining([[k, value2]]));
    await expect(alice.keys()).asyncIteratesTo(expect.arrayContaining([k]));
    await expect(alice.values()).asyncIteratesTo(expect.arrayContaining([value2]));
    await expect(alice.get(k)).resolves.toEqual(value2);
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
      const map = new SignedObservedRemoveMap(db, [], { key, namespace: uuid.v4() });
      await map.readyPromise;
      map.on('publish', (message) => publish(i, message));
      subscribe(i, (message) => map.processSigned(message));
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
    const id1 = generateId();
    await alice.setSigned(keyA, valueA, id1, sign(keyA, valueA, id1));
    const id2 = generateId();
    await bob.setSigned(keyB, valueB, id2, sign(keyB, valueB, id2));
    const id3 = generateId();
    await alice.setSigned(keyC, valueC, id3, sign(keyC, valueC, id3));
    while (aliceAddCount !== 3 || bobAddCount !== 3) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await bob.deleteSigned(keyC, id3, sign(keyC, id3));
    await alice.deleteSigned(keyB, id2, sign(keyB, id2));
    await bob.deleteSigned(keyA, id1, sign(keyA, id1));
    while (aliceDeleteCount !== 3 || bobDeleteCount !== 3) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await expect(alice).asyncIteratesTo(expect.arrayContaining([]));
    await expect(bob).asyncIteratesTo(expect.arrayContaining([]));
    await Promise.all([alice.shutdown(), bob.shutdown()]);
  });
});
