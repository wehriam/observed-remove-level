"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

var _pQueue = _interopRequireDefault(require("p-queue"));

var _map = _interopRequireDefault(require("./map"));

var _verifier = _interopRequireDefault(require("./verifier"));

var _signedError = require("./signed-error");

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class SignedObservedRemoveMap extends _map.default {
  constructor(db, entries, options) {
    super(db, [], options);

    if (!options || !options.key) {
      throw new Error('Missing required options.key parameter');
    }

    this.verify = (0, _verifier.default)(options.key, options.format);

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

    this.signedProcessQueue = new _pQueue.default({
      concurrency: 1
    });
  }

  async dump() {
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
    await this.db.clear({
      gt: `${this.namespace}<`,
      lt: `${this.namespace}<${maxAgeString}`
    });
    await this.db.clear({
      gt: `${this.namespace}]`,
      lt: `${this.namespace}]${maxAgeString}`
    });
  }

  async processSigned(signedQueue, skipFlush = false) {
    return this.signedProcessQueue.add(() => this._processSigned(signedQueue, skipFlush)); // eslint-disable-line  no-underscore-dangle
  }

  async _processSigned(signedQueue, skipFlush = false) {
    // eslint-disable-line  no-underscore-dangle
    const [signedInsertQueue, signedDeleteQueue] = signedQueue;
    const insertQueue = [];
    const deleteQueue = [];

    for (const [signature, id, key, value] of signedInsertQueue) {
      if (!this.verify(signature, key, value, id)) {
        throw new _signedError.InvalidSignatureError(`Signature does not match for key "${key}" with value ${JSON.stringify(value)}`);
      }

      await this.db.put(`${this.namespace}[${id}`, signature);
      insertQueue.push([key, [id, value]]);
    }

    for (const [signature, id, key] of signedDeleteQueue) {
      if (!this.verify(signature, key, id)) {
        throw new _signedError.InvalidSignatureError(`Signature does not match for id ${JSON.stringify(id)}`);
      }

      await this.db.put(`${this.namespace}]${id}`, signature);
      deleteQueue.push([id, key]);
    }

    const queue = [insertQueue, deleteQueue];
    await super.process(queue, skipFlush);

    for (const [signature, id, key] of signedInsertQueue) {
      // eslint-disable-line no-unused-vars
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

  async setSigned(key, value, id, signature) {
    const message = [signature, id, key, value];
    await this.processSigned([[message], []], true);
    this.insertQueue.push(message);
    await this.dequeue();
    return this;
  }

  async deleteSigned(key, id, signature) {
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

  async shutdown() {
    await this.signedProcessQueue.onIdle();
    await super.shutdown();
  }

}

exports.default = SignedObservedRemoveMap;
//# sourceMappingURL=signed-map.js.map