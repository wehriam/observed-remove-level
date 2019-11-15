// @flow

const ObservedRemoveMap = require('./map');
const getVerifier = require('./verifier');
const { InvalidSignatureError } = require('./signed-error');

type Options = {
  maxAge?:number,
  bufferPublishing?:number,
  key: any,
  format?: string,
  namespace?: string
};

class SignedObservedRemoveMap<V> extends ObservedRemoveMap<V> {
  constructor(db:Object, entries?: Iterable<[string, V, string, string]>, options?:Options) {
    super(db, [], options);
    if (!options || !options.key) {
      throw new Error('Missing required options.key parameter');
    }
    this.verify = getVerifier(options.key, options.format);
    if (!entries) {
      return;
    }
    this.readyPromise = (async () => {
      await this.updateSize();
      const promises = [];
      if (entries) {
        for (const [key, value, id, signature] of entries) {
          promises.push(this.setSigned(key, value, id, signature));
        }
      }
      await Promise.all(promises);
    })();
  }

  insertionSignatureMap: Map<string, string>;
  deletionSignatureMap: Map<string, string>;
  verify: (string, ...Array<any>) => boolean;


  async dump():Promise<[Array<*>, Array<*>]> {
    const signedInsertQueue = [];
    const signedDeleteQueue = [];
    const [insertQueue, deleteQueue] = await super.dump();
    for (const [key, [id, value]] of insertQueue) {
      try {
        const signature = await this.db.get(`${this.namespace}[${id}`);
        signedInsertQueue.push([signature, id, key, value]);
      } catch (error) {
        if (error.notFound) {
          throw new Error(`Missing signature for insertion key "${JSON.stringify(key)}" with id "${id}" and value "${JSON.stringify(value)}"`);
        }
        throw error;
      }
    }
    for (const [id, key] of deleteQueue) {
      try {
        const signature = await this.db.get(`${this.namespace}]${id}`);
        signedDeleteQueue.push([signature, id, key]);
      } catch (error) {
        if (error.notFound) {
          throw new Error(`Missing signature for deletion key "${JSON.stringify(key)}" with id "${id}"`);
        }
        throw error;
      }
    }
    const queue = [signedInsertQueue, signedDeleteQueue];
    return queue;
  }

  async flush() {
    const maxAgeString = (Date.now() - this.maxAge).toString(36).padStart(9, '0');
    await Promise.all([
      this.db.clear({ gt: `${this.namespace}<`, lt: `${this.namespace}<${maxAgeString}` }),
      this.db.clear({ gt: `${this.namespace}]`, lt: `${this.namespace}]${maxAgeString}` }),
    ]);
  }

  async processSigned(signedQueue:[Array<*>, Array<*>], skipFlush?: boolean = false):Promise<void> {
    const [signedInsertQueue, signedDeleteQueue] = signedQueue;
    const insertQueue = [];
    const deleteQueue = [];
    for (const [signature, id, key, value] of signedInsertQueue) {
      if (!this.verify(signature, key, value, id)) {
        throw new InvalidSignatureError(`Signature does not match for key "${key}" with value ${JSON.stringify(value)}`);
      }
      await this.db.put(`${this.namespace}[${id}`, signature);
      insertQueue.push([key, [id, value]]);
    }
    for (const [signature, id, key] of signedDeleteQueue) {
      if (!this.verify(signature, key, id)) {
        throw new InvalidSignatureError(`Signature does not match for id ${JSON.stringify(id)}`);
      }
      await this.db.put(`${this.namespace}]${id}`, signature);
      deleteQueue.push([id, key]);
    }
    const queue = [insertQueue, deleteQueue];
    await super.process(queue, skipFlush);
    for (const [signature, id, key] of signedInsertQueue) { // eslint-disable-line no-unused-vars
      try {
        const pair = await this.db.get(`${this.namespace}>${key}`);
        if (pair[0] !== id) {
          await this.db.del(`${this.namespace}]${id}`);
        }
      } catch (error) {
        if (error.notFound) {
          await this.db.del(`${this.namespace}]${id}`);
        } else {
          throw error;
        }
      }
    }
  }

  async setSigned(key:string, value:V, id:string, signature:string) {
    const message = [signature, id, key, value];
    await this.processSigned([[message], []], true);
    this.insertQueue.push(message);
    await this.dequeue();
    return this;
  }

  async deleteSigned(key:string, id:string, signature:string) {
    const message = [signature, id, key];
    await this.processSigned([[], [message]], true);
    this.deleteQueue.push(message);
    await this.dequeue();
  }

  clear() {
    throw new Error('Unsupported method clear()');
  }

  set() {
    throw new Error('Unsupported method set(), use setSigned()');
  }

  delete() {
    throw new Error('Unsupported method delete(), use deleteSignedId()');
  }
}

module.exports = SignedObservedRemoveMap;
