// @flow

const { EventEmitter } = require('events');
const generateId = require('./generate-id');
const { default: PQueue } = require('p-queue');

type Options = {
  maxAge?:number,
  bufferPublishing?:number,
  namespace?: string,
  format?: string
};

/**
 * Class representing a Observed Remove Map
 *
 * Implements all methods and iterators of the native `Map` object in addition to the following.
 * See: {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map}
 */
class ObservedRemoveMap<V> extends EventEmitter {
  maxAge: number;
  bufferPublishing: number;
  deleteQueue: Array<*>;
  insertQueue: Array<*>;
  publishTimeout: null | TimeoutID;
  readyPromise: Promise<void>;
  db: Object;
  namespace: string;
  prefixLength: number;
  size: number;
  processQueue: PQueue;

  constructor(db:Object, entries?: Iterable<[string, V]>, options?:Options = {}) {
    super();
    this.db = db;
    this.namespace = options.namespace || '';
    this.prefixLength = this.namespace.length + 1;
    this.maxAge = typeof options.maxAge === 'undefined' ? 5000 : options.maxAge;
    this.bufferPublishing = typeof options.bufferPublishing === 'undefined' ? 30 : options.bufferPublishing;
    this.publishTimeout = null;
    this.insertQueue = [];
    this.deleteQueue = [];
    this.size = 0;
    this.readyPromise = (async () => {
      await this.updateSize();
      const promises = [];
      if (entries) {
        for (const [key, value] of entries) {
          promises.push(this.set(key, value));
        }
      }
      await Promise.all(promises);
    })();
    this.processQueue = new PQueue({ concurrency: 1 });
  }

  async updateSize() {
    let size = 0;
    const iterator = this.db.iterator({ gt: `${this.namespace}>`, lt: `${this.namespace}?`, values: false });
    while (true) {
      const key = await new Promise((resolve, reject) => {
        iterator.next((error:Error | void, k: string | void) => {
          if (error) {
            reject(error);
          } else {
            resolve(k);
          }
        });
      });
      if (key) {
        size += 1;
      } else {
        break;
      }
    }
    await new Promise((resolve, reject) => {
      iterator.end((error:Error | void) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    this.size = size;
  }

  async dequeue() {
    if (this.publishTimeout) {
      return;
    }
    if (this.bufferPublishing > 0) {
      this.publishTimeout = setTimeout(() => this.publish(), this.bufferPublishing);
    } else {
      await this.publish();
    }
  }

  async publish() {
    this.publishTimeout = null;
    const insertQueue = this.insertQueue;
    const deleteQueue = this.deleteQueue;
    this.insertQueue = [];
    this.deleteQueue = [];
    await this.sync([insertQueue, deleteQueue]);
  }

  async flush() {
    const maxAgeString = (Date.now() - this.maxAge).toString(36).padStart(9, '0');
    await this.db.clear({ gt: `${this.namespace}<`, lt: `${this.namespace}<${maxAgeString}` });
  }

  /**
   * Emit a 'publish' event containing a specified queue or all of the set's insertions and deletions.
   * @param {Array<Array<any>>} queue - Array of insertions and deletions
   * @return {void}
   */
  async sync(queue?: [Array<*>, Array<*>]) {
    if (queue) {
      this.emit('publish', queue);
    } else {
      this.emit('publish', await this.dump());
    }
  }

  async pairs():Promise<Array<[string, [string, V]]>> {
    const pairs:Array<[string, [string, V]]> = [];
    const iterator = this.db.iterator({ gt: `${this.namespace}>`, lt: `${this.namespace}?` });
    while (true) {
      const [key, pair] = await new Promise((resolve, reject) => {
        iterator.next((error:Error | void, k: string | void, v: [string, V] | void) => {
          if (error) {
            reject(error);
          } else {
            resolve([k, v]);
          }
        });
      });
      if (key && pair) {
        pairs.push([key.slice(this.prefixLength), pair]);
      } else {
        break;
      }
    }
    await new Promise((resolve, reject) => {
      iterator.end((error:Error | void) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    return pairs;
  }

  async deletions():Promise<Array<[string, string]>> {
    const deletions = [];
    const iterator = this.db.iterator({ gt: `${this.namespace}<`, lt: `${this.namespace}=` });
    while (true) {
      const [id, key] = await new Promise((resolve, reject) => {
        iterator.next((error:Error | void, k: string | void, v: string | void) => {
          if (error) {
            reject(error);
          } else {
            resolve([k, v]);
          }
        });
      });
      if (id && key) {
        deletions.push([id.slice(this.prefixLength), key]);
      } else {
        break;
      }
    }
    await new Promise((resolve, reject) => {
      iterator.end((error:Error | void) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    return deletions;
  }

  /**
   * Return an array containing all of the map's insertions and deletions.
   * @return {[Array<*>, Array<*>]>}
   */
  async dump():Promise<[Array<*>, Array<*>]> {
    return Promise.all([this.pairs(), this.deletions()]);
  }

  process(queue:[Array<*>, Array<*>], skipFlush?: boolean = false) {
    return this.processQueue.add(() => this._process(queue, skipFlush)); // eslint-disable-line no-underscore-dangle
  }

  async _process(queue:[Array<*>, Array<*>], skipFlush?: boolean = false) {
    const [insertions, deletions] = queue;
    for (const [id, key] of deletions) {
      await this.db.put(`${this.namespace}<${id}`, key);
    }
    for (const [key, [id, value]] of insertions) {
      try {
        await this.db.get(`${this.namespace}<${id}`);
        continue;
      } catch (error) {
        if (!error.notFound) {
          throw error;
        }
      }
      try {
        const pair = await this.db.get(`${this.namespace}>${key}`);
        if (pair[0] < id) {
          await this.db.put(`${this.namespace}>${key}`, [id, value]);
          this.emit('set', key, value, pair[1]);
        } else if (pair[0] === id) {
          this.emit('affirm', key, value, pair[1]);
        }
      } catch (error) {
        if (!error.notFound) {
          throw error;
        }
        await this.db.put(`${this.namespace}>${key}`, [id, value]);
        this.size += 1;
        this.emit('set', key, value, undefined);
      }
    }
    for (const [id, key] of deletions) {
      try {
        const pair = await this.db.get(`${this.namespace}>${key}`);
        if (pair[0] === id) {
          await this.db.del(`${this.namespace}>${key}`);
          this.size -= 1;
          this.emit('delete', key, pair[1]);
        }
      } catch (error) {
        if (!error.notFound) {
          throw error;
        }
      }
    }
    if (!skipFlush) {
      await this.flush();
    }
  }

  async set(key:string, value:V, id?: string = generateId()): Promise<void> {
    const insertMessage = typeof value === 'undefined' ? [key, [id]] : [key, [id, value]];
    try {
      const pair = await this.db.get(`${this.namespace}>${key}`);
      const deleteMessage = [pair[0], key];
      await this.process([[insertMessage], [deleteMessage]], true);
      this.deleteQueue.push(deleteMessage);
    } catch (error) {
      if (error.notFound) {
        await this.process([[insertMessage], []], true);
      } else {
        throw error;
      }
    }
    this.insertQueue.push(insertMessage);
    await this.dequeue();
  }

  async getPair(key:string): Promise<[string, V] | void> { // eslint-disable-line consistent-return
    try {
      const pair = await this.db.get(`${this.namespace}>${key}`);
      return pair;
    } catch (error) {
      if (error.notFound) {
        return; // eslint-disable-line consistent-return
      }
      throw error;
    }
  }

  async get(key:string): Promise<V | void> { // eslint-disable-line consistent-return
    try {
      const pair = await this.db.get(`${this.namespace}>${key}`);
      return pair[1];
    } catch (error) {
      if (error.notFound) {
        return; // eslint-disable-line consistent-return
      }
      throw error;
    }
  }

  async delete(key:string): Promise<void> {
    try {
      const pair = await this.db.get(`${this.namespace}>${key}`);
      const message = [pair[0], key];
      await this.process([[], [message]], true);
      this.deleteQueue.push(message);
      await this.dequeue();
    } catch (error) {
      if (error.notFound) {
        return;
      }
      throw error;
    }
  }

  async clear(): Promise<void> {
    for await (const key of this.keys()) {
      await this.delete(key);
    }
  }

  async forEach(callback:Function, thisArg?:any):Promise<void> {
    if (thisArg) {
      for await (const [key, value] of this.entries()) {
        callback.bind(thisArg)(value, key, this);
      }
    } else {
      for await (const [key, value] of this.entries()) {
        callback(value, key, this);
      }
    }
  }

  async has(key:string): Promise<boolean> {
    return !!(await this.get(key));
  }

  async* keys():AsyncGenerator<string, void, void> {
    const iterator = this.db.iterator({ gt: `${this.namespace}>`, lt: `${this.namespace}?`, values: false });
    while (true) {
      const key = await new Promise((resolve, reject) => {
        iterator.next((error:Error | void, k: string | void) => {
          if (error) {
            reject(error);
          } else {
            resolve(k);
          }
        });
      });
      if (key) {
        yield key.slice(this.prefixLength);
      } else {
        break;
      }
    }
    await new Promise((resolve, reject) => {
      iterator.end((error:Error | void) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async* entries():AsyncGenerator<[string, V], void, void> {
    const iterator = this.db.iterator({ gt: `${this.namespace}>`, lt: `${this.namespace}?` });
    while (true) {
      const [key, pair] = await new Promise((resolve, reject) => {
        iterator.next((error:Error | void, k: string | void, v: [string, V] | void) => {
          if (error) {
            reject(error);
          } else {
            resolve([k, v]);
          }
        });
      });
      if (key && pair) {
        yield [key.slice(this.prefixLength), pair[1]];
      } else {
        break;
      }
    }
    await new Promise((resolve, reject) => {
      iterator.end((error:Error | void) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /* :: @@asyncIterator(): AsyncIterator<[string, V]> { return ({}: any); } */
  // $FlowFixMe: computed property
  [Symbol.asyncIterator]() {
    return this.entries();
  }

  async* values():AsyncGenerator<V, void, void> {
    const iterator = this.db.iterator({ gt: `${this.namespace}>`, lt: `${this.namespace}?`, keys: false });
    while (true) {
      const pair = await new Promise((resolve, reject) => {
        iterator.next((error:Error | void, k: void, v: [string, V] | void) => {
          if (error) {
            reject(error);
          } else {
            resolve(v);
          }
        });
      });
      if (pair) {
        yield pair[1];
      } else {
        break;
      }
    }
    await new Promise((resolve, reject) => {
      iterator.end((error:Error | void) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async shutdown() {
    clearTimeout(this.publishTimeout);
    await this.processQueue.onIdle();
  }
}

module.exports = ObservedRemoveMap;
