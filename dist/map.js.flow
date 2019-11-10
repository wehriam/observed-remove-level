// @flow

const { EventEmitter } = require('events');
const generateId = require('./generate-id');

type Options = {
  maxAge?:number,
  bufferPublishing?:number
};

/**
 * Class representing a Observed Remove Map
 *
 * Implements all methods and iterators of the native `Map` object in addition to the following.
 * See: {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map}
 */
class ObservedRemoveMap<K, V> extends EventEmitter {
  maxAge: number;
  bufferPublishing: number;
  pairs: Map<K, [string, V]>;
  deletions: Map<string, K>;
  deleteQueue: Array<*>;
  insertQueue: Array<*>;
  publishTimeout: null | TimeoutID;
  readyPromise: Promise<void>;

  constructor(entries?: Iterable<[K, V]>, options?:Options = {}) {
    super();
    this.maxAge = typeof options.maxAge === 'undefined' ? 5000 : options.maxAge;
    this.bufferPublishing = typeof options.bufferPublishing === 'undefined' ? 30 : options.bufferPublishing;
    this.publishTimeout = null;
    this.pairs = new Map();
    this.deletions = new Map();
    this.insertQueue = [];
    this.deleteQueue = [];
    if (!entries) {
      return;
    }
    const promises = [];
    for (const [key, value] of entries) {
      promises.push(this.set(key, value));
    }
    this.readyPromise = Promise.all(promises).then(() => {
      // Resolve to void
    }).catch((error) => {
      this.emit('error', error);
    });
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
    for (const [id] of this.deletions) {
      if (id < maxAgeString) {
        this.deletions.delete(id);
      }
    }
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

  /**
   * Return an array containing all of the map's insertions and deletions.
   * @return {[Array<*>, Array<*>]>}
   */
  async dump():Promise<[Array<*>, Array<*>]> {
    return Promise.resolve([[...this.pairs], [...this.deletions]]);
  }

  async process(queue:[Array<*>, Array<*>], skipFlush?: boolean = false) {
    const [insertions, deletions] = queue;
    for (const [id, key] of deletions) {
      this.deletions.set(id, key);
    }
    for (const [key, [id, value]] of insertions) {
      if (this.deletions.has(id)) {
        continue;
      }
      const pair = this.pairs.get(key);
      if (!pair || (pair && pair[0] < id)) {
        this.pairs.set(key, [id, value]);
        this.emit('set', key, value, pair ? pair[1] : undefined);
      }
    }
    for (const [id, key] of deletions) {
      const pair = this.pairs.get(key);
      if (pair && pair[0] === id) {
        this.pairs.delete(key);
        this.emit('delete', key, pair[1]);
      }
    }
    if (!skipFlush) {
      await this.flush();
    }
  }

  async set(key:K, value:V, id?: string = generateId()): Promise<void> {
    const pair = this.pairs.get(key);
    const insertMessage = typeof value === 'undefined' ? [key, [id]] : [key, [id, value]];
    if (pair) {
      const deleteMessage = [pair[0], key];
      await this.process([[insertMessage], [deleteMessage]], true);
      this.deleteQueue.push(deleteMessage);
    } else {
      await this.process([[insertMessage], []], true);
    }
    this.insertQueue.push(insertMessage);
    await this.dequeue();
  }

  async get(key:K): Promise<V | void> { // eslint-disable-line consistent-return
    const pair = this.pairs.get(key);
    if (pair) {
      return pair[1];
    }
  }

  async delete(key:K): Promise<void> {
    const pair = this.pairs.get(key);
    if (pair) {
      const message = [pair[0], key];
      await this.process([[], [message]], true);
      this.deleteQueue.push(message);
      await this.dequeue();
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

  async has(key:K): Promise<boolean> {
    return !!this.pairs.get(key);
  }

  async* keys():AsyncGenerator<K, void, void> {
    for (const key of this.pairs.keys()) {
      yield await Promise.resolve(key);
    }
  }

  async* entries():AsyncGenerator<[K, V], void, void> {
    for (const [key, [id, value]] of this.pairs) { // eslint-disable-line no-unused-vars
      yield await Promise.resolve([key, value]);
    }
  }

  /* :: @@asyncIterator(): AsyncIterator<[K, V]> { return ({}: any); } */
  // $FlowFixMe: computed property
  [Symbol.asyncIterator]() {
    return this.entries();
  }

  async* values():AsyncGenerator<V, void, void> {
    for (const [id, value] of this.pairs.values()) { // eslint-disable-line no-unused-vars
      yield await Promise.resolve(value);
    }
  }

  get size():number {
    return this.pairs.size;
  }
}

module.exports = ObservedRemoveMap;
